import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  BallotContract,
  MerkleRootStore,
  VoteRegistry,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  buildPadronMerkleTree,
  getMerkleProof,
  hashVotante,
  toBytes32Hex,
} from "./helpers/merkle";
import {
  signValidation,
  signVote,
  toSignedVoteInput,
  VoteFields,
} from "./helpers/vote";

/**
 * Mirrors front `computeSelectionHash`: keccak256(JSON.stringify(normalizedPayload)).
 */
function computeSelectionHash(payload: {
  votoEnBlanco?: boolean;
  votoNulo?: boolean;
  selecciones: Array<{ idCategoria: number; idCandidato: number }>;
}): string {
  const normalized = {
    votoEnBlanco: payload.votoEnBlanco === true,
    votoNulo: payload.votoNulo === true,
    selecciones: [...payload.selecciones].sort(
      (a, b) => a.idCategoria - b.idCategoria || a.idCandidato - b.idCandidato
    ),
  };
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(normalized)));
}

describe("BallotContract — VOTAR-357 / VOTAR-346 / VOTAR-377 EIP-712 UATs", () => {
  const ELECTION_ID = 357n;
  const VOTER_DNI = "30222333";
  const VOTER_EMAIL = "bruno@frvm.utn.edu.ar";
  const VOTER_HASH = hashVotante(VOTER_DNI, VOTER_EMAIL);
  const VOTER_LEAF = toBytes32Hex(VOTER_HASH);
  const TIMESTAMP = 1_700_000_000n;
  const CANDIDATE_ID = 101n;

  let store: MerkleRootStore;
  let registry: VoteRegistry;
  let ballot: BallotContract;
  let admin: HardhatEthersSigner;
  let merkleUpdater: HardhatEthersSigner;
  let ephemeralSigner: HardhatEthersSigner;
  let validator: HardhatEthersSigner;
  let voter: HardhatEthersSigner;
  let validProof: string[];
  let nullifier: string;
  let selectionHash: string;
  let VOTO_BLANCO: bigint;
  let VOTO_NULO: bigint;

  async function deployFixture(
    options: {
      revoteEnabled?: boolean;
      maxVotesPerVoter?: number;
      minIntervalSeconds?: number;
    } = {}
  ) {
    const [admin, merkleUpdater, ephemeralSigner, validator, voter] =
      await ethers.getSigners();

    const storeFactory = await ethers.getContractFactory("MerkleRootStore");
    const store = await storeFactory.deploy(admin.address);
    await store.waitForDeployment();

    const registryFactory = await ethers.getContractFactory("VoteRegistry");
    // VOTAR-341 — default production policy: revote disabled.
    const registry = await registryFactory.deploy(
      admin.address,
      options.revoteEnabled ?? false
    );
    await registry.waitForDeployment();

    const ballotFactory = await ethers.getContractFactory("BallotContract");
    // VOTAR-324 — generous default so pre-existing tests never hit MaxVotesReached.
    // VOTAR-325 — default 0 (no cooldown) so pre-existing back-to-back casts never
    // hit RetryTooSoon.
    const ballot = await ballotFactory.deploy(
      admin.address,
      await store.getAddress(),
      await registry.getAddress(),
      options.maxVotesPerVoter ?? 10,
      options.minIntervalSeconds ?? 0,
      0 // TallyPolicy.LAST_VOTE_WINS
    );
    await ballot.waitForDeployment();

    // VOTAR-377 — grant VALIDATOR_ROLE to the Entidad de Firmas Digitales signer.
    await ballot
      .connect(admin)
      .grantRole(await ballot.VALIDATOR_ROLE(), validator.address);

    await registry
      .connect(admin)
      .grantRole(await registry.BALLOT_ROLE(), await ballot.getAddress());
    await registry
      .connect(admin)
      .grantRole(await registry.ELECTION_ADMIN_ROLE(), admin.address);
    // VOTAR-345 — seal the candidate set (all non-reserved ids used across this
    // suite) before any castSignedVote, otherwise recordVote reverts with
    // CandidateSetNotRegistered.
    await registry
      .connect(admin)
      .registerCandidates(ELECTION_ID, [101n, 102n, 103n]);

    await store
      .connect(admin)
      .grantRole(await store.MERKLE_UPDATER_ROLE(), merkleUpdater.address);
    await store
      .connect(admin)
      .grantRole(await store.ELECTION_ADMIN_ROLE(), admin.address);

    const hashes = [
      hashVotante("30111222", "ana@frvm.utn.edu.ar"),
      VOTER_HASH,
      hashVotante("30333444", "carla@frvm.utn.edu.ar"),
    ];
    const { merkleRoot, sortedHashes, tree } = buildPadronMerkleTree(hashes);
    const voterLeafIndex = sortedHashes.indexOf(VOTER_HASH);
    const validProof = getMerkleProof(tree, voterLeafIndex);

    await store.connect(merkleUpdater).publishRoot(ELECTION_ID, merkleRoot);

    const now = Math.floor(Date.now() / 1000);
    await store.connect(admin).setElectionWindow(ELECTION_ID, now, now + 3600);
    await store.connect(admin).setElectionState(ELECTION_ID, 2); // OPEN

    const nullifier =
      "0x1111111111111111111111111111111111111111111111111111111111111111";

    const selectionHash = computeSelectionHash({
      selecciones: [
        { idCategoria: 1, idCandidato: 101 },
        { idCategoria: 2, idCandidato: 201 },
      ],
    });

    const VOTO_BLANCO = await registry.VOTO_BLANCO();
    const VOTO_NULO = await registry.VOTO_NULO();

    return {
      store,
      registry,
      ballot,
      admin,
      merkleUpdater,
      ephemeralSigner,
      validator,
      voter,
      validProof,
      nullifier,
      selectionHash,
      VOTO_BLANCO,
      VOTO_NULO,
    };
  }

  type Fixture = Awaited<ReturnType<typeof deployFixture>>;

  interface CastOptions {
    /** Ephemeral session key producing the `Vote` signature. */
    voteSigner?: HardhatEthersSigner;
    /** Institutional signer producing the `Validation` signature. */
    validatorSigner?: HardhatEthersSigner;
    /** Gas payer / tx sender (platform transmitter in production). */
    from?: HardhatEthersSigner;
    voterLeaf?: string;
    merkleProof?: string[];
    electionId?: bigint;
    nullifier?: string;
    selectionHash?: string;
    candidateIds?: bigint[];
    timestamp?: bigint;
    expectedSigner?: string;
    /** Raw override for the ephemeral `Vote` signature (integrity tests). */
    signature?: string;
    /** Raw override for the institutional `Validation` signature (UAT-01/03). */
    validatorSignature?: string;
  }

  /** Signs (ephemeral + validator) and submits a vote against `fx.ballot`. */
  async function cast(fx: Fixture, opts: CastOptions = {}) {
    const voteSigner = opts.voteSigner ?? fx.ephemeralSigner;
    const validatorSigner = opts.validatorSigner ?? fx.validator;
    const from = opts.from ?? fx.voter;
    const fields: VoteFields = {
      electionId: opts.electionId ?? ELECTION_ID,
      voterLeaf: opts.voterLeaf ?? VOTER_LEAF,
      nullifier: opts.nullifier ?? fx.nullifier,
      selectionHash: opts.selectionHash ?? fx.selectionHash,
      candidateIds: opts.candidateIds ?? [CANDIDATE_ID],
      timestamp: opts.timestamp ?? TIMESTAMP,
      expectedSigner: opts.expectedSigner ?? voteSigner.address,
    };
    const signature =
      opts.signature ?? (await signVote(voteSigner, fx.ballot, fields));
    const validatorSignature =
      opts.validatorSignature ??
      (await signValidation(validatorSigner, fx.ballot, fields));
    return fx.ballot
      .connect(from)
      .castSignedVote(
        toSignedVoteInput(fields),
        opts.merkleProof ?? fx.validProof,
        signature,
        validatorSignature
      );
  }

  let fx: Fixture;

  beforeEach(async () => {
    fx = await loadFixture(deployFixture);
    ({
      store,
      registry,
      ballot,
      admin,
      merkleUpdater,
      ephemeralSigner,
      validator,
      voter,
      validProof,
      nullifier,
      selectionHash,
      VOTO_BLANCO,
      VOTO_NULO,
    } = fx);
  });

  describe("UAT-01: domain separator", () => {
    it("exposes an EIP-712 domain separator tied to this deployment", async () => {
      const separator = await ballot.domainSeparator();
      expect(separator).to.not.equal(ethers.ZeroHash);
    });
  });

  describe("VOTAR-377: enforcement de la Entidad de Firmas Digitales", () => {
    it("UAT-01 — revierte MissingValidatorSignature cuando la firma institucional está ausente", async () => {
      await expect(
        cast(fx, { validatorSignature: "0x" })
      ).to.be.revertedWithCustomError(ballot, "MissingValidatorSignature");

      expect(await ballot.hasVoted(ELECTION_ID, VOTER_LEAF)).to.equal(false);
    });

    it("UAT-01 — revierte InvalidValidatorSignature cuando el firmante no tiene VALIDATOR_ROLE", async () => {
      // `voter` never received VALIDATOR_ROLE.
      await expect(
        cast(fx, { validatorSigner: voter })
      ).to.be.revertedWithCustomError(ballot, "InvalidValidatorSignature");

      expect(await ballot.hasVoted(ELECTION_ID, VOTER_LEAF)).to.equal(false);
    });

    it("UAT-03 — revierte InvalidValidatorSignature si se altera el payload conservando la firma original", async () => {
      const original: VoteFields = {
        electionId: ELECTION_ID,
        voterLeaf: VOTER_LEAF,
        nullifier,
        selectionHash,
        candidateIds: [CANDIDATE_ID],
        timestamp: TIMESTAMP,
        expectedSigner: ephemeralSigner.address,
      };
      const validatorSignature = await signValidation(
        validator,
        ballot,
        original
      );
      const tamperedSelectionHash =
        `0x${"bb".repeat(32)}`;

      await expect(
        cast(fx, {
          selectionHash: tamperedSelectionHash,
          validatorSignature,
        })
      ).to.be.revertedWithCustomError(ballot, "InvalidValidatorSignature");
    });

    it("acepta el voto y emite SignedVoteCast con firma institucional válida", async () => {
      await expect(cast(fx))
        .to.emit(ballot, "SignedVoteCast")
        .withArgs(ELECTION_ID, nullifier, selectionHash, ephemeralSigner.address)
        .and.to.emit(registry, "VoteCast");
    });

    it("rotación de clave — tras revocar VALIDATOR_ROLE los votos posteriores revierten", async () => {
      await cast(fx, {
        nullifier:
          "0x1010101010101010101010101010101010101010101010101010101010101010",
        voteSigner: ephemeralSigner,
        voterLeaf: VOTER_LEAF,
      });

      await ballot
        .connect(admin)
        .revokeRole(await ballot.VALIDATOR_ROLE(), validator.address);

      const otherHash = hashVotante("30333444", "carla@frvm.utn.edu.ar");
      const { sortedHashes, tree } = buildPadronMerkleTree([
        hashVotante("30111222", "ana@frvm.utn.edu.ar"),
        VOTER_HASH,
        otherHash,
      ]);
      const otherProof = getMerkleProof(
        tree,
        sortedHashes.indexOf(otherHash)
      );

      await expect(
        cast(fx, {
          voterLeaf: toBytes32Hex(otherHash),
          merkleProof: otherProof,
          nullifier:
            "0x2020202020202020202020202020202020202020202020202020202020202020",
        })
      ).to.be.revertedWithCustomError(ballot, "InvalidValidatorSignature");
    });

    it("replay cross-elección — una firma institucional de otro ballot es rechazada", async () => {
      const other = await deployFixture();
      const fields: VoteFields = {
        electionId: ELECTION_ID,
        voterLeaf: VOTER_LEAF,
        nullifier,
        selectionHash,
        candidateIds: [CANDIDATE_ID],
        timestamp: TIMESTAMP,
        expectedSigner: ephemeralSigner.address,
      };
      // Institutional signature bound to the *other* ballot's EIP-712 domain.
      const foreignValidatorSignature = await signValidation(
        other.validator,
        other.ballot,
        fields
      );

      await expect(
        cast(fx, { validatorSignature: foreignValidatorSignature })
      ).to.be.revertedWithCustomError(ballot, "InvalidValidatorSignature");
    });
  });

  describe("VOTAR-326: tallyPolicy inyectada e inmutable", () => {
    it("expone tallyPolicy=LAST_VOTE_WINS (0) tras el despliegue", async () => {
      expect(await ballot.tallyPolicy()).to.equal(0n);
    });

    // Nota: TallyPolicy tiene un único miembro (LAST_VOTE_WINS=0). Tanto Solidity
    // (Panic 0x21 al decodificar el enum) como ethers (valida el rango del enum
    // antes de encodear la transacción) rechazan cualquier otro valor antes de que
    // el guard {InvalidTallyPolicy} del constructor pueda ejecutarse — no hay vía
    // externa real para alcanzarlo hoy. Se mantiene como defensa en profundidad
    // para cuando el enum crezca con nuevas políticas.

    it("lastVoteIndex refleja el índice 0-based del último sufragio firmado", async () => {
      const fixture = await deployFixture({
        revoteEnabled: true,
        maxVotesPerVoter: 3,
      });

      await expect(
        fixture.ballot.lastVoteIndex(ELECTION_ID, fixture.nullifier)
      ).to.be.revertedWithCustomError(fixture.ballot, "NullifierHasNotVoted");

      await cast(fixture, { candidateIds: [101n] });
      expect(
        await fixture.ballot.lastVoteIndex(ELECTION_ID, fixture.nullifier)
      ).to.equal(0n);

      await cast(fixture, { candidateIds: [102n] });
      await cast(fixture, { candidateIds: [103n] });
      expect(
        await fixture.ballot.lastVoteIndex(ELECTION_ID, fixture.nullifier)
      ).to.equal(2n);
    });
  });

  describe("UAT-02: integridad del payload", () => {
    it("reverts InvalidSignature when selectionHash is tampered", async () => {
      const good: VoteFields = {
        electionId: ELECTION_ID,
        voterLeaf: VOTER_LEAF,
        nullifier,
        selectionHash,
        candidateIds: [CANDIDATE_ID],
        timestamp: TIMESTAMP,
        expectedSigner: ephemeralSigner.address,
      };
      const signature = await signVote(ephemeralSigner, ballot, good);
      const tamperedSelectionHash =
        `0x${"bb".repeat(32)}`;

      await expect(
        cast(fx, { selectionHash: tamperedSelectionHash, signature })
      ).to.be.revertedWithCustomError(ballot, "InvalidSignature");
    });

    it("reverts InvalidSignature when candidateIds is tampered (VOTAR-346 / VOTAR-474)", async () => {
      const good: VoteFields = {
        electionId: ELECTION_ID,
        voterLeaf: VOTER_LEAF,
        nullifier,
        selectionHash,
        candidateIds: [CANDIDATE_ID],
        timestamp: TIMESTAMP,
        expectedSigner: ephemeralSigner.address,
      };
      const signature = await signVote(ephemeralSigner, ballot, good);

      await expect(
        cast(fx, { candidateIds: [999n], signature })
      ).to.be.revertedWithCustomError(ballot, "InvalidSignature");
    });
  });

  describe("UAT-03: protección contra replay / unicidad sin revoto (VOTAR-341)", () => {
    it("reverts RevoteDisabled on duplicate signed vote submission", async () => {
      await expect(cast(fx)).to.emit(ballot, "SignedVoteCast");
      await expect(cast(fx)).to.be.revertedWithCustomError(
        ballot,
        "RevoteDisabled"
      );
    });
  });

  describe("VOTAR-341: control de unicidad sin re-voto", () => {
    it("UAT-01 — bloquea el segundo voto con RevoteDisabled cuando revoto está apagado", async () => {
      expect(await registry.revoteEnabled()).to.equal(false);

      await cast(fx);
      await expect(cast(fx)).to.be.revertedWithCustomError(
        ballot,
        "RevoteDisabled"
      );
    });

    it("UAT-02 — el tally no cambia tras un segundo intento fallido de doble voto", async () => {
      await cast(fx);

      expect(await registry.getTally(ELECTION_ID, CANDIDATE_ID)).to.equal(1n);
      const [totalBefore] = await registry.getParticipationStats(ELECTION_ID);
      expect(totalBefore).to.equal(1n);

      await expect(cast(fx)).to.be.revertedWithCustomError(
        ballot,
        "RevoteDisabled"
      );

      expect(await registry.getTally(ELECTION_ID, CANDIDATE_ID)).to.equal(1n);
      const [totalAfter] = await registry.getParticipationStats(ELECTION_ID);
      expect(totalAfter).to.equal(1n);
      const [, hasVoted] = await registry.getVoterState(ELECTION_ID, nullifier);
      expect(hasVoted).to.equal(true);
    });
  });

  describe("VOTAR-451: anti doble voto por leaf (nullifier efímero nuevo)", () => {
    it("UAT-01 — rechaza un segundo castSignedVote con nullifier distinto y no infla participación", async () => {
      await cast(fx);

      const signers = await ethers.getSigners();
      const altSigner = signers[6];
      const altNullifier = ethers.keccak256(
        ethers.toUtf8Bytes(`alt-nullifier:${altSigner.address}`)
      );

      await expect(
        cast(fx, { voteSigner: altSigner, nullifier: altNullifier })
      ).to.be.revertedWithCustomError(ballot, "AlreadyVoted");

      expect(await ballot.hasVoted(ELECTION_ID, VOTER_LEAF)).to.equal(true);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_ID)).to.equal(1n);
      const [totalVotes] = await registry.getParticipationStats(ELECTION_ID);
      expect(totalVotes).to.equal(1n);
      expect(await ballot.isNullifierUsed(ELECTION_ID, altNullifier)).to.equal(
        false
      );
    });

    it("permite re-voto con el mismo nullifier cuando revoteEnabled=true", async () => {
      const fixture = await deployFixture({
        revoteEnabled: true,
        maxVotesPerVoter: 2,
      });

      await expect(cast(fixture)).to.emit(fixture.ballot, "SignedVoteCast");
      await expect(cast(fixture)).to.emit(fixture.ballot, "SignedVoteCast");
      const [totalVotes] = await fixture.registry.getParticipationStats(
        ELECTION_ID
      );
      expect(totalVotes).to.equal(1n);
    });
  });

  describe("VOTAR-324: límite de sufragios por votante on-chain", () => {
    it("UAT-03 — rechaza el tercer voto firmado cuando maxVotesPerVoter=2 con re-voto habilitado", async () => {
      const fixture = await deployFixture({
        revoteEnabled: true,
        maxVotesPerVoter: 2,
      });

      await expect(cast(fixture)).to.emit(fixture.ballot, "SignedVoteCast");
      await expect(cast(fixture)).to.emit(fixture.ballot, "SignedVoteCast");
      await expect(cast(fixture))
        .to.be.revertedWithCustomError(fixture.ballot, "MaxVotesReached")
        .withArgs(ELECTION_ID, 2);
    });

    it("reverts InvalidMaxVotesPerVoter when constructed with zero", async () => {
      const { store, registry, admin } = await deployFixture();
      const ballotFactory = await ethers.getContractFactory("BallotContract");
      await expect(
        ballotFactory.deploy(
          admin.address,
          await store.getAddress(),
          await registry.getAddress(),
          0,
          0,
          0 // TallyPolicy.LAST_VOTE_WINS
        )
      ).to.be.revertedWithCustomError(ballotFactory, "InvalidMaxVotesPerVoter");
    });

    it("still reverts RevoteDisabled (not MaxVotesReached) when maxVotesPerVoter=1 and revote is off", async () => {
      const fixture = await deployFixture({
        revoteEnabled: false,
        maxVotesPerVoter: 1,
      });

      await expect(cast(fixture)).to.emit(fixture.ballot, "SignedVoteCast");
      await expect(cast(fixture)).to.be.revertedWithCustomError(
        fixture.ballot,
        "RevoteDisabled"
      );
    });
  });

  describe("VOTAR-325: intervalo mínimo entre re-votos (cooldown anti coerción)", () => {
    it("UAT-01 — rechaza el segundo voto con RetryTooSoon antes de cumplirse el intervalo", async () => {
      const fixture = await deployFixture({
        revoteEnabled: true,
        maxVotesPerVoter: 5,
        minIntervalSeconds: 300,
      });

      await cast(fixture);
      const voteTimestamp = await time.latest();
      const nextTimestamp = voteTimestamp + 1;
      await ethers.provider.send("evm_setNextBlockTimestamp", [nextTimestamp]);
      const expectedRemaining = 300 - (nextTimestamp - voteTimestamp);

      await expect(cast(fixture))
        .to.be.revertedWithCustomError(fixture.ballot, "RetryTooSoon")
        .withArgs(ELECTION_ID, expectedRemaining);
    });

    it("UAT-02 — acepta el segundo voto una vez transcurrido minIntervalSeconds, ignorando el reloj local del cliente", async () => {
      const fixture = await deployFixture({
        revoteEnabled: true,
        maxVotesPerVoter: 5,
        minIntervalSeconds: 300,
      });

      await expect(cast(fixture)).to.emit(fixture.ballot, "SignedVoteCast");
      await time.increase(300);
      await expect(cast(fixture)).to.emit(fixture.ballot, "SignedVoteCast");
    });

    it("VOTAR-452 — acepta el tercer voto tras dos intervalos (maxRevotos=3)", async () => {
      const fixture = await deployFixture({
        revoteEnabled: true,
        maxVotesPerVoter: 3,
        minIntervalSeconds: 20,
      });

      await expect(cast(fixture)).to.emit(fixture.ballot, "SignedVoteCast");
      await time.increase(20);
      await expect(cast(fixture)).to.emit(fixture.ballot, "SignedVoteCast");
      await time.increase(20);
      await expect(cast(fixture)).to.emit(fixture.ballot, "SignedVoteCast");

      const state = await fixture.ballot.getVoterState(
        ELECTION_ID,
        fixture.nullifier
      );
      expect(state.votesUsed).to.equal(3n);
      expect(state.cooldownRemaining).to.equal(20n);
    });

    it("precedencia: revierte RevoteDisabled (no RetryTooSoon) cuando el re-voto está apagado", async () => {
      const fixture = await deployFixture({
        revoteEnabled: false,
        maxVotesPerVoter: 5,
        minIntervalSeconds: 300,
      });

      await expect(cast(fixture)).to.emit(fixture.ballot, "SignedVoteCast");
      await expect(cast(fixture)).to.be.revertedWithCustomError(
        fixture.ballot,
        "RevoteDisabled"
      );
    });

    it("getVoterState refleja votesUsed, lastVoteAt, cooldownRemaining decreciente y blockTimestamp del nodo", async () => {
      const fixture = await deployFixture({
        revoteEnabled: true,
        maxVotesPerVoter: 5,
        minIntervalSeconds: 300,
      });

      const beforeVote = await fixture.ballot.getVoterState(
        ELECTION_ID,
        fixture.nullifier
      );
      expect(beforeVote.votesUsed).to.equal(0n);
      expect(beforeVote.lastVoteAt).to.equal(0n);
      expect(beforeVote.cooldownRemaining).to.equal(0n);

      await cast(fixture);
      const voteTimestamp = await time.latest();

      const afterVote = await fixture.ballot.getVoterState(
        ELECTION_ID,
        fixture.nullifier
      );
      expect(afterVote.votesUsed).to.equal(1n);
      expect(afterVote.lastVoteAt).to.equal(BigInt(voteTimestamp));
      expect(afterVote.cooldownRemaining).to.equal(300n);
      expect(afterVote.blockTimestamp).to.equal(BigInt(voteTimestamp));

      await time.increase(120);
      const midCooldown = await fixture.ballot.getVoterState(
        ELECTION_ID,
        fixture.nullifier
      );
      expect(midCooldown.cooldownRemaining).to.equal(180n);

      await time.increase(180);
      const unlocked = await fixture.ballot.getVoterState(
        ELECTION_ID,
        fixture.nullifier
      );
      expect(unlocked.cooldownRemaining).to.equal(0n);
    });

    it("minIntervalSeconds=0 (default) no bloquea votos consecutivos", async () => {
      const fixture = await deployFixture({
        revoteEnabled: true,
        maxVotesPerVoter: 5,
      });

      await expect(cast(fixture)).to.emit(fixture.ballot, "SignedVoteCast");
      await expect(cast(fixture)).to.emit(fixture.ballot, "SignedVoteCast");
    });

    it("VOTAR-449: el cooldown de un nullifier no bloquea a otro nullifier de otro leaf", async () => {
      // VOTAR-451: same leaf + different nullifier is AlreadyVoted; isolation is
      // across distinct padron leaves (two voters), not two ephemeral sessions.
      const fixture = await deployFixture({
        revoteEnabled: true,
        maxVotesPerVoter: 5,
        minIntervalSeconds: 300,
      });
      await cast(fixture);

      const otherHash = hashVotante("30111222", "ana@frvm.utn.edu.ar");
      const otherLeaf = toBytes32Hex(otherHash);
      const hashes = [
        otherHash,
        VOTER_HASH,
        hashVotante("30333444", "carla@frvm.utn.edu.ar"),
      ];
      const { sortedHashes, tree } = buildPadronMerkleTree(hashes);
      const otherProof = getMerkleProof(tree, sortedHashes.indexOf(otherHash));

      const otherNullifier =
        "0x2222222222222222222222222222222222222222222222222222222222222222";
      const [, , , , , otherSigner] = await ethers.getSigners();

      await expect(
        cast(fixture, {
          voteSigner: otherSigner,
          voterLeaf: otherLeaf,
          merkleProof: otherProof,
          nullifier: otherNullifier,
        })
      ).to.emit(fixture.ballot, "SignedVoteCast");

      const stateA = await fixture.ballot.getVoterState(
        ELECTION_ID,
        fixture.nullifier
      );
      const stateB = await fixture.ballot.getVoterState(
        ELECTION_ID,
        otherNullifier
      );
      expect(stateA.cooldownRemaining).to.be.greaterThan(0n);
      expect(stateB.votesUsed).to.equal(1n);
      // B acaba de votar: su cooldown arranca independiente del de A.
      expect(stateB.cooldownRemaining).to.equal(300n);
      expect(stateB.lastVoteAt).to.not.equal(stateA.lastVoteAt);
    });
  });

  describe("signed vote acceptance", () => {
    it("records the vote when Merkle proof and EIP-712 signature are valid", async () => {
      await expect(cast(fx))
        .to.emit(ballot, "SignedVoteCast")
        .withArgs(ELECTION_ID, nullifier, selectionHash, ephemeralSigner.address)
        .and.to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, nullifier, CANDIDATE_ID, false);

      expect(await ballot.hasVoted(ELECTION_ID, VOTER_LEAF)).to.equal(true);
      expect(await ballot.isNullifierUsed(ELECTION_ID, nullifier)).to.equal(
        true
      );
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_ID)).to.equal(1n);
    });

    it("reverts InvalidSignature when recovered signer does not match expectedSigner", async () => {
      const good: VoteFields = {
        electionId: ELECTION_ID,
        voterLeaf: VOTER_LEAF,
        nullifier,
        selectionHash,
        candidateIds: [CANDIDATE_ID],
        timestamp: TIMESTAMP,
        expectedSigner: ephemeralSigner.address,
      };
      const signature = await signVote(ephemeralSigner, ballot, good);

      // expectedSigner claims to be `voter` but the signature is ephemeralSigner's.
      await expect(
        cast(fx, { expectedSigner: voter.address, signature })
      ).to.be.revertedWithCustomError(ballot, "InvalidSignature");
    });

    it("accepts selectionHash produced with the same JSON canonicalization as the BUD", async () => {
      const frontAlignedHash = computeSelectionHash({
        votoEnBlanco: false,
        votoNulo: false,
        selecciones: [
          { idCategoria: 2, idCandidato: 201 },
          { idCategoria: 1, idCandidato: 101 },
        ],
      });
      expect(frontAlignedHash).to.equal(selectionHash);

      await expect(
        cast(fx, { selectionHash: frontAlignedHash })
      ).to.emit(ballot, "SignedVoteCast");
    });

    it("emits VoteCast with reserved VOTO_BLANCO id for blank ballots", async () => {
      const blankHash = computeSelectionHash({
        votoEnBlanco: true,
        selecciones: [],
      });

      await expect(
        cast(fx, { selectionHash: blankHash, candidateIds: [VOTO_BLANCO] })
      )
        .to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, nullifier, VOTO_BLANCO, false);

      expect(await registry.getTally(ELECTION_ID, VOTO_BLANCO)).to.equal(1n);
    });

    it("emits VoteCast with reserved VOTO_NULO id for null ballots", async () => {
      const nullHash = computeSelectionHash({
        votoNulo: true,
        selecciones: [],
      });

      await expect(
        cast(fx, { selectionHash: nullHash, candidateIds: [VOTO_NULO] })
      )
        .to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, nullifier, VOTO_NULO, false);
    });

    it("VOTAR-345 — reverts InvalidCandidateId for a signed vote with an unregistered candidateId", async () => {
      const unregisteredId = 999n;

      await expect(cast(fx, { candidateIds: [unregisteredId] }))
        .to.be.revertedWithCustomError(registry, "InvalidCandidateId")
        .withArgs(ELECTION_ID, unregisteredId);
    });
  });

  describe("VOTAR-346 — privacy and atomicity", () => {
    it("SignedVoteCast does not include voterLeaf (no leaf↔nullifier join)", async () => {
      const fragment = ballot.interface.getEvent("SignedVoteCast");
      expect(fragment).to.not.equal(null);
      expect(fragment!.inputs.map((input) => input.name)).to.deep.equal([
        "electionId",
        "nullifier",
        "selectionHash",
        "signer",
      ]);
      expect(
        fragment!.inputs.some((input) => input.name === "voterLeaf")
      ).to.equal(false);
    });

    it("VoteCast topics do not include the submitting wallet address", async () => {
      const tx = await cast(fx);
      const receipt = await tx.wait();
      expect(receipt).to.not.equal(null);

      const voteCastTopic = registry.interface.getEvent("VoteCast")!.topicHash;
      const voteCastLog = receipt!.logs.find(
        (log) => log.topics[0] === voteCastTopic
      );
      expect(voteCastLog).to.not.equal(undefined);
      expect(voteCastLog!.topics.length).to.equal(3);

      const voterAddressTopic = ethers
        .zeroPadValue(voter.address, 32)
        .toLowerCase();
      expect(voteCastLog!.topics.map((t) => t.toLowerCase())).to.not.include(
        voterAddressTopic
      );
    });

    it("reverts the whole cast when VoteRegistry.recordVote cannot run (paused)", async () => {
      await registry
        .connect(admin)
        .grantRole(await registry.PAUSER_ROLE(), admin.address);
      await registry.connect(admin).pause();

      await expect(cast(fx)).to.be.revertedWithCustomError(
        registry,
        "EnforcedPause"
      );

      expect(await ballot.hasVoted(ELECTION_ID, VOTER_LEAF)).to.equal(false);
      expect(await ballot.isNullifierUsed(ELECTION_ID, nullifier)).to.equal(
        false
      );
    });
  });

  describe("VOTAR-474 — multi-category EIP-712 ballots", () => {
    it("casts a multi-candidate ballot and increments every tally", async () => {
      const candidateIds = [101n, 102n, 103n];
      const multiSelectionHash = computeSelectionHash({
        selecciones: [
          { idCategoria: 1, idCandidato: 101 },
          { idCategoria: 2, idCandidato: 102 },
          { idCategoria: 3, idCandidato: 103 },
        ],
      });

      await expect(
        cast(fx, {
          selectionHash: multiSelectionHash,
          candidateIds,
        })
      )
        .to.emit(ballot, "SignedVoteCast")
        .and.to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, nullifier, 101n, false);

      expect(await registry.getTally(ELECTION_ID, 101n)).to.equal(1n);
      expect(await registry.getTally(ELECTION_ID, 102n)).to.equal(1n);
      expect(await registry.getTally(ELECTION_ID, 103n)).to.equal(1n);
      const [totalVotes] = await registry.getParticipationStats(ELECTION_ID);
      expect(totalVotes).to.equal(1n);
    });

    it("reverts InvalidSignature when cast candidateIds differ from the signed set", async () => {
      const good: VoteFields = {
        electionId: ELECTION_ID,
        voterLeaf: VOTER_LEAF,
        nullifier,
        selectionHash,
        candidateIds: [CANDIDATE_ID],
        timestamp: TIMESTAMP,
        expectedSigner: ephemeralSigner.address,
      };
      const signature = await signVote(ephemeralSigner, ballot, good);

      await expect(
        cast(fx, { candidateIds: [102n], signature })
      ).to.be.revertedWithCustomError(ballot, "InvalidSignature");
    });
  });
});
