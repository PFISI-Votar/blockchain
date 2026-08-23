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

const VOTE_TYPE = {
  Vote: [
    { name: "electionId", type: "uint256" },
    { name: "nullifier", type: "bytes32" },
    { name: "selectionHash", type: "bytes32" },
    { name: "candidateId", type: "uint256" },
    { name: "timestamp", type: "uint256" },
  ],
};

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

describe("BallotContract — VOTAR-357 / VOTAR-346 EIP-712 UATs", () => {
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
    const [admin, merkleUpdater, ephemeralSigner, voter] =
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
      voter,
      validProof,
      nullifier,
      selectionHash,
      VOTO_BLANCO,
      VOTO_NULO,
    };
  }

  async function signVote(
    signer: HardhatEthersSigner,
    overrides?: Partial<{
      electionId: bigint;
      nullifier: string;
      selectionHash: string;
      candidateId: bigint;
      timestamp: bigint;
    }>
  ) {
    const domain = {
      name: "VOTAR",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await ballot.getAddress(),
    };

    const message = {
      electionId: overrides?.electionId ?? ELECTION_ID,
      nullifier: overrides?.nullifier ?? nullifier,
      selectionHash: overrides?.selectionHash ?? selectionHash,
      candidateId: overrides?.candidateId ?? CANDIDATE_ID,
      timestamp: overrides?.timestamp ?? TIMESTAMP,
    };

    return signer.signTypedData(domain, VOTE_TYPE, message);
  }

  beforeEach(async () => {
    ({
      store,
      registry,
      ballot,
      admin,
      merkleUpdater,
      ephemeralSigner,
      voter,
      validProof,
      nullifier,
      selectionHash,
      VOTO_BLANCO,
      VOTO_NULO,
    } = await loadFixture(deployFixture));
  });

  describe("UAT-01: domain separator", () => {
    it("exposes an EIP-712 domain separator tied to this deployment", async () => {
      const separator = await ballot.domainSeparator();
      expect(separator).to.not.equal(ethers.ZeroHash);
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

      const cast = async (candidateId: bigint) => {
        const domain = {
          name: "VOTAR",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await fixture.ballot.getAddress(),
        };
        const message = {
          electionId: ELECTION_ID,
          nullifier: fixture.nullifier,
          selectionHash: fixture.selectionHash,
          candidateId,
          timestamp: TIMESTAMP,
        };
        const signature = await fixture.voter.signTypedData(
          domain,
          VOTE_TYPE,
          message
        );
        return fixture.ballot
          .connect(fixture.voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            fixture.validProof,
            fixture.nullifier,
            fixture.selectionHash,
            TIMESTAMP,
            fixture.voter.address,
            signature,
            candidateId
          );
      };

      await cast(101n);
      expect(
        await fixture.ballot.lastVoteIndex(ELECTION_ID, fixture.nullifier)
      ).to.equal(0n);

      await cast(102n);
      await cast(103n);
      expect(
        await fixture.ballot.lastVoteIndex(ELECTION_ID, fixture.nullifier)
      ).to.equal(2n);
    });
  });

  describe("UAT-02: integridad del payload", () => {
    it("reverts InvalidSignature when selectionHash is tampered", async () => {
      const signature = await signVote(ephemeralSigner);
      const tamperedSelectionHash =
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            tamperedSelectionHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            CANDIDATE_ID
          )
      ).to.be.revertedWithCustomError(ballot, "InvalidSignature");
    });

    it("reverts InvalidSignature when candidateId is tampered (VOTAR-346)", async () => {
      const signature = await signVote(ephemeralSigner, {
        candidateId: CANDIDATE_ID,
      });

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            selectionHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            999n
          )
      ).to.be.revertedWithCustomError(ballot, "InvalidSignature");
    });
  });

  describe("UAT-03: protección contra replay / unicidad sin revoto (VOTAR-341)", () => {
    it("reverts RevoteDisabled on duplicate signed vote submission", async () => {
      const signature = await signVote(ephemeralSigner);

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            selectionHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            CANDIDATE_ID
          )
      ).to.emit(ballot, "SignedVoteCast");

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            selectionHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            CANDIDATE_ID
          )
      ).to.be.revertedWithCustomError(ballot, "RevoteDisabled");
    });
  });

  describe("VOTAR-341: control de unicidad sin re-voto", () => {
    it("UAT-01 — bloquea el segundo voto con RevoteDisabled cuando revoto está apagado", async () => {
      expect(await registry.revoteEnabled()).to.equal(false);

      const signature = await signVote(ephemeralSigner);
      await ballot
        .connect(voter)
        .castSignedVote(
          ELECTION_ID,
          VOTER_LEAF,
          validProof,
          nullifier,
          selectionHash,
          TIMESTAMP,
          ephemeralSigner.address,
          signature,
          CANDIDATE_ID
        );

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            selectionHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            CANDIDATE_ID
          )
      ).to.be.revertedWithCustomError(ballot, "RevoteDisabled");
    });

    it("UAT-02 — el tally no cambia tras un segundo intento fallido de doble voto", async () => {
      const signature = await signVote(ephemeralSigner);
      await ballot
        .connect(voter)
        .castSignedVote(
          ELECTION_ID,
          VOTER_LEAF,
          validProof,
          nullifier,
          selectionHash,
          TIMESTAMP,
          ephemeralSigner.address,
          signature,
          CANDIDATE_ID
        );

      expect(await registry.getTally(ELECTION_ID, CANDIDATE_ID)).to.equal(1n);
      const [totalBefore] = await registry.getParticipationStats(ELECTION_ID);
      expect(totalBefore).to.equal(1n);

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            selectionHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            CANDIDATE_ID
          )
      ).to.be.revertedWithCustomError(ballot, "RevoteDisabled");

      expect(await registry.getTally(ELECTION_ID, CANDIDATE_ID)).to.equal(1n);
      const [totalAfter] = await registry.getParticipationStats(ELECTION_ID);
      expect(totalAfter).to.equal(1n);
      const [, hasVoted] = await registry.getVoterState(ELECTION_ID, nullifier);
      expect(hasVoted).to.equal(true);
    });
  });

  describe("VOTAR-451: anti doble voto por leaf (nullifier efímero nuevo)", () => {
    it("UAT-01 — rechaza un segundo castSignedVote con nullifier distinto y no infla participación", async () => {
      const firstSignature = await signVote(ephemeralSigner);
      await ballot
        .connect(voter)
        .castSignedVote(
          ELECTION_ID,
          VOTER_LEAF,
          validProof,
          nullifier,
          selectionHash,
          TIMESTAMP,
          ephemeralSigner.address,
          firstSignature,
          CANDIDATE_ID
        );

      const signers = await ethers.getSigners();
      const altSigner = signers[4];
      const altNullifier = ethers.keccak256(
        ethers.toUtf8Bytes(`alt-nullifier:${altSigner.address}`)
      );
      const altSignature = await signVote(altSigner, {
        nullifier: altNullifier,
      });

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            altNullifier,
            selectionHash,
            TIMESTAMP,
            altSigner.address,
            altSignature,
            CANDIDATE_ID
          )
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
      const domain = {
        name: "VOTAR",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await fixture.ballot.getAddress(),
      };
      const message = {
        electionId: ELECTION_ID,
        nullifier: fixture.nullifier,
        selectionHash: fixture.selectionHash,
        candidateId: CANDIDATE_ID,
        timestamp: TIMESTAMP,
      };
      const signature = await fixture.ephemeralSigner.signTypedData(
        domain,
        VOTE_TYPE,
        message
      );
      const cast = () =>
        fixture.ballot
          .connect(fixture.voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            fixture.validProof,
            fixture.nullifier,
            fixture.selectionHash,
            TIMESTAMP,
            fixture.ephemeralSigner.address,
            signature,
            CANDIDATE_ID
          );

      await expect(cast()).to.emit(fixture.ballot, "SignedVoteCast");
      await expect(cast()).to.emit(fixture.ballot, "SignedVoteCast");
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
      const {
        ballot: limitedBallot,
        voter: limitedVoter,
        ephemeralSigner: limitedSigner,
        validProof: limitedProof,
        nullifier: limitedNullifier,
        selectionHash: limitedSelectionHash,
      } = fixture;

      // signVote is bound to the outer-scope fixture; sign directly against this
      // fixture's ballot address (its EIP-712 domain differs).
      const domain = {
        name: "VOTAR",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await limitedBallot.getAddress(),
      };
      const message = {
        electionId: ELECTION_ID,
        nullifier: limitedNullifier,
        selectionHash: limitedSelectionHash,
        candidateId: CANDIDATE_ID,
        timestamp: TIMESTAMP,
      };
      const signature = await limitedSigner.signTypedData(
        domain,
        VOTE_TYPE,
        message
      );

      const cast = () =>
        limitedBallot
          .connect(limitedVoter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            limitedProof,
            limitedNullifier,
            limitedSelectionHash,
            TIMESTAMP,
            limitedSigner.address,
            signature,
            CANDIDATE_ID
          );

      await expect(cast()).to.emit(limitedBallot, "SignedVoteCast");
      await expect(cast()).to.emit(limitedBallot, "SignedVoteCast");
      await expect(cast())
        .to.be.revertedWithCustomError(limitedBallot, "MaxVotesReached")
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
      const domain = {
        name: "VOTAR",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await fixture.ballot.getAddress(),
      };
      const message = {
        electionId: ELECTION_ID,
        nullifier: fixture.nullifier,
        selectionHash: fixture.selectionHash,
        candidateId: CANDIDATE_ID,
        timestamp: TIMESTAMP,
      };
      const signature = await fixture.ephemeralSigner.signTypedData(
        domain,
        VOTE_TYPE,
        message
      );
      const cast = () =>
        fixture.ballot
          .connect(fixture.voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            fixture.validProof,
            fixture.nullifier,
            fixture.selectionHash,
            TIMESTAMP,
            fixture.ephemeralSigner.address,
            signature,
            CANDIDATE_ID
          );

      await expect(cast()).to.emit(fixture.ballot, "SignedVoteCast");
      await expect(cast()).to.be.revertedWithCustomError(
        fixture.ballot,
        "RevoteDisabled"
      );
    });
  });

  describe("VOTAR-325: intervalo mínimo entre re-votos (cooldown anti coerción)", () => {
    async function signForFixture(
      fixture: Awaited<ReturnType<typeof deployFixture>>,
      signer: HardhatEthersSigner
    ) {
      const domain = {
        name: "VOTAR",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await fixture.ballot.getAddress(),
      };
      const message = {
        electionId: ELECTION_ID,
        nullifier: fixture.nullifier,
        selectionHash: fixture.selectionHash,
        candidateId: CANDIDATE_ID,
        timestamp: TIMESTAMP,
      };
      const signature = await signer.signTypedData(domain, VOTE_TYPE, message);
      const cast = () =>
        fixture.ballot
          .connect(fixture.voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            fixture.validProof,
            fixture.nullifier,
            fixture.selectionHash,
            TIMESTAMP,
            signer.address,
            signature,
            CANDIDATE_ID
          );
      return cast;
    }

    it("UAT-01 — rechaza el segundo voto con RetryTooSoon antes de cumplirse el intervalo", async () => {
      const fixture = await deployFixture({
        revoteEnabled: true,
        maxVotesPerVoter: 5,
        minIntervalSeconds: 300,
      });
      const cast = await signForFixture(fixture, fixture.ephemeralSigner);

      await cast();
      const voteTimestamp = await time.latest();
      const nextTimestamp = voteTimestamp + 1;
      await ethers.provider.send("evm_setNextBlockTimestamp", [nextTimestamp]);
      const expectedRemaining = 300 - (nextTimestamp - voteTimestamp);

      await expect(cast())
        .to.be.revertedWithCustomError(fixture.ballot, "RetryTooSoon")
        .withArgs(ELECTION_ID, expectedRemaining);
    });

    it("UAT-02 — acepta el segundo voto una vez transcurrido minIntervalSeconds, ignorando el reloj local del cliente", async () => {
      const fixture = await deployFixture({
        revoteEnabled: true,
        maxVotesPerVoter: 5,
        minIntervalSeconds: 300,
      });
      const cast = await signForFixture(fixture, fixture.ephemeralSigner);

      await expect(cast()).to.emit(fixture.ballot, "SignedVoteCast");
      await time.increase(300);
      await expect(cast()).to.emit(fixture.ballot, "SignedVoteCast");
    });

    it("precedencia: revierte RevoteDisabled (no RetryTooSoon) cuando el re-voto está apagado", async () => {
      const fixture = await deployFixture({
        revoteEnabled: false,
        maxVotesPerVoter: 5,
        minIntervalSeconds: 300,
      });
      const cast = await signForFixture(fixture, fixture.ephemeralSigner);

      await expect(cast()).to.emit(fixture.ballot, "SignedVoteCast");
      await expect(cast()).to.be.revertedWithCustomError(
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
      const cast = await signForFixture(fixture, fixture.ephemeralSigner);

      const beforeVote = await fixture.ballot.getVoterState(
        ELECTION_ID,
        fixture.nullifier
      );
      expect(beforeVote.votesUsed).to.equal(0n);
      expect(beforeVote.lastVoteAt).to.equal(0n);
      expect(beforeVote.cooldownRemaining).to.equal(0n);

      await cast();
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
      const cast = await signForFixture(fixture, fixture.ephemeralSigner);

      await expect(cast()).to.emit(fixture.ballot, "SignedVoteCast");
      await expect(cast()).to.emit(fixture.ballot, "SignedVoteCast");
    });

    it("VOTAR-449: el cooldown de un nullifier no bloquea a otro nullifier de otro leaf", async () => {
      // VOTAR-451: same leaf + different nullifier is AlreadyVoted; isolation is
      // across distinct padron leaves (two voters), not two ephemeral sessions.
      const fixture = await deployFixture({
        revoteEnabled: true,
        maxVotesPerVoter: 5,
        minIntervalSeconds: 300,
      });
      const castA = await signForFixture(fixture, fixture.ephemeralSigner);
      await castA();

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
      const [, , , , otherSigner] = await ethers.getSigners();
      const domain = {
        name: "VOTAR",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await fixture.ballot.getAddress(),
      };
      const message = {
        electionId: ELECTION_ID,
        nullifier: otherNullifier,
        selectionHash: fixture.selectionHash,
        candidateId: CANDIDATE_ID,
        timestamp: TIMESTAMP,
      };
      const signature = await otherSigner.signTypedData(
        domain,
        VOTE_TYPE,
        message
      );

      await expect(
        fixture.ballot
          .connect(fixture.voter)
          .castSignedVote(
            ELECTION_ID,
            otherLeaf,
            otherProof,
            otherNullifier,
            fixture.selectionHash,
            TIMESTAMP,
            otherSigner.address,
            signature,
            CANDIDATE_ID
          )
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
      const signature = await signVote(ephemeralSigner);

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            selectionHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            CANDIDATE_ID
          )
      )
        .to.emit(ballot, "SignedVoteCast")
        .withArgs(
          ELECTION_ID,
          nullifier,
          selectionHash,
          ephemeralSigner.address
        )
        .and.to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, nullifier, CANDIDATE_ID, false);

      expect(await ballot.hasVoted(ELECTION_ID, VOTER_LEAF)).to.equal(true);
      expect(await ballot.isNullifierUsed(ELECTION_ID, nullifier)).to.equal(
        true
      );
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_ID)).to.equal(1n);
    });

    it("reverts InvalidSignature when recovered signer does not match expectedSigner", async () => {
      const signature = await signVote(ephemeralSigner);

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            selectionHash,
            TIMESTAMP,
            voter.address,
            signature,
            CANDIDATE_ID
          )
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

      const signature = await signVote(ephemeralSigner, {
        selectionHash: frontAlignedHash,
      });

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            frontAlignedHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            CANDIDATE_ID
          )
      ).to.emit(ballot, "SignedVoteCast");
    });

    it("emits VoteCast with reserved VOTO_BLANCO id for blank ballots", async () => {
      const blankHash = computeSelectionHash({
        votoEnBlanco: true,
        selecciones: [],
      });
      const signature = await signVote(ephemeralSigner, {
        selectionHash: blankHash,
        candidateId: VOTO_BLANCO,
      });

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            blankHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            VOTO_BLANCO
          )
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
      const signature = await signVote(ephemeralSigner, {
        selectionHash: nullHash,
        candidateId: VOTO_NULO,
      });

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            nullHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            VOTO_NULO
          )
      )
        .to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, nullifier, VOTO_NULO, false);
    });

    it("VOTAR-345 — reverts InvalidCandidateId for a signed vote with an unregistered candidateId", async () => {
      const unregisteredId = 999n;
      const signature = await signVote(ephemeralSigner, {
        candidateId: unregisteredId,
      });

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            selectionHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            unregisteredId
          )
      )
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
      const signature = await signVote(ephemeralSigner);
      const tx = await ballot
        .connect(voter)
        .castSignedVote(
          ELECTION_ID,
          VOTER_LEAF,
          validProof,
          nullifier,
          selectionHash,
          TIMESTAMP,
          ephemeralSigner.address,
          signature,
          CANDIDATE_ID
        );
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

      const signature = await signVote(ephemeralSigner);

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            selectionHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            CANDIDATE_ID
          )
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");

      expect(await ballot.hasVoted(ELECTION_ID, VOTER_LEAF)).to.equal(false);
      expect(await ballot.isNullifierUsed(ELECTION_ID, nullifier)).to.equal(
        false
      );
    });
  });
});
