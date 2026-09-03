import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { BallotContract, MerkleRootStore, VoteRegistry } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  buildPadronMerkleTree,
  getMerkleProof,
  hashVotante,
  toBytes32Hex,
} from "./helpers/merkle";
import { castSignedVote, VoteFields } from "./helpers/vote";

/**
 * US-339 — Cryptographic validation of the voter on-chain (Merkle eligibility).
 * Since VOTAR-377 the Merkle-only `castVote` path is gone: every vote goes through
 * `castSignedVote`, which still runs the same Merkle check (after the institutional
 * signature check), so these UATs are exercised through the production path.
 */
describe("BallotContract — US-339 UATs (Merkle eligibility via castSignedVote)", () => {
  const ELECTION_ID = 339n;
  const VOTER_DNI = "30222333";
  const VOTER_EMAIL = "bruno@frvm.utn.edu.ar";
  const VOTER_HASH = hashVotante(VOTER_DNI, VOTER_EMAIL);
  const VOTER_LEAF = toBytes32Hex(VOTER_HASH);
  const NULLIFIER =
    "0x2222222222222222222222222222222222222222222222222222222222222222";
  const SELECTION_HASH =
    "0x3333333333333333333333333333333333333333333333333333333333333333";
  const CANDIDATE_ID = 101n;
  const TIMESTAMP = 1_700_000_000n;
  const ElectionState = {
    DRAFT: 0,
    CONFIGURED: 1,
    OPEN: 2,
    CLOSED: 3,
    TALLIED: 4,
  };

  let store: MerkleRootStore;
  let registry: VoteRegistry;
  let ballot: BallotContract;
  let admin: HardhatEthersSigner;
  let merkleUpdater: HardhatEthersSigner;
  let ephemeralSigner: HardhatEthersSigner;
  let validator: HardhatEthersSigner;
  let gasPayer: HardhatEthersSigner;
  let merkleRoot: string;
  let voterLeafIndex: number;
  let validProof: string[];

  function fields(overrides: Partial<VoteFields> = {}): VoteFields {
    return {
      electionId: ELECTION_ID,
      voterLeaf: VOTER_LEAF,
      nullifier: NULLIFIER,
      selectionHash: SELECTION_HASH,
      candidateId: CANDIDATE_ID,
      timestamp: TIMESTAMP,
      expectedSigner: ephemeralSigner.address,
      ...overrides,
    };
  }

  async function openElectionWindow(
    electionId: bigint,
    durationSeconds = 3600,
  ) {
    const now = await time.latest();
    await store
      .connect(admin)
      .setElectionWindow(electionId, now, now + durationSeconds);
    await store.connect(admin).setElectionState(electionId, ElectionState.OPEN);
  }

  async function deployFixture() {
    const [admin, merkleUpdater, ephemeralSigner, validator, gasPayer] =
      await ethers.getSigners();

    const store = await (
      await ethers.getContractFactory("MerkleRootStore")
    ).deploy(admin.address);
    await store.waitForDeployment();

    const registry = await (
      await ethers.getContractFactory("VoteRegistry")
    ).deploy(admin.address, false);
    await registry.waitForDeployment();

    const ballot = await (
      await ethers.getContractFactory("BallotContract")
    ).deploy(
      admin.address,
      await store.getAddress(),
      await registry.getAddress(),
      1,
      0,
      0, // TallyPolicy.LAST_VOTE_WINS
    );
    await ballot.waitForDeployment();

    await ballot
      .connect(admin)
      .grantRole(await ballot.VALIDATOR_ROLE(), validator.address);

    await registry
      .connect(admin)
      .grantRole(await registry.BALLOT_ROLE(), await ballot.getAddress());
    await registry
      .connect(admin)
      .grantRole(await registry.ELECTION_ADMIN_ROLE(), admin.address);
    await registry.connect(admin).registerCandidates(ELECTION_ID, [101n, 102n]);

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
      hashVotante("30444555", "diego@frvm.utn.edu.ar"),
    ];
    const { merkleRoot, sortedHashes, tree } = buildPadronMerkleTree(hashes);
    const voterLeafIndex = sortedHashes.indexOf(VOTER_HASH);
    const validProof = getMerkleProof(tree, voterLeafIndex);

    await store.connect(merkleUpdater).publishRoot(ELECTION_ID, merkleRoot);
    const now = await time.latest();
    await store.connect(admin).setElectionWindow(ELECTION_ID, now, now + 3600);
    await store.connect(admin).setElectionState(ELECTION_ID, ElectionState.OPEN);

    return {
      store,
      registry,
      ballot,
      admin,
      merkleUpdater,
      ephemeralSigner,
      validator,
      gasPayer,
      merkleRoot,
      voterLeafIndex,
      validProof,
    };
  }

  beforeEach(async () => {
    ({
      store,
      registry,
      ballot,
      admin,
      merkleUpdater,
      ephemeralSigner,
      validator,
      gasPayer,
      merkleRoot,
      voterLeafIndex,
      validProof,
    } = await loadFixture(deployFixture));
  });

  describe("UAT-01: rechazo de voto con prueba manipulada", () => {
    it("reverts InvalidMerkleProof when a proof character is tampered", async () => {
      const tamperedProof = [...validProof];
      const original = tamperedProof[0];
      tamperedProof[0] = original.endsWith("a")
        ? `${original.slice(0, -1)}b`
        : `${original.slice(0, -1)}a`;

      await expect(
        castSignedVote(
          ballot,
          { gasPayer, ephemeralSigner, validator, fields: fields(), merkleProof: validProof },
          { merkleProof: tamperedProof },
        ),
      ).to.be.revertedWithCustomError(ballot, "InvalidMerkleProof");

      expect(await ballot.hasVoted(ELECTION_ID, VOTER_LEAF)).to.equal(false);
    });

    it("reverts InvalidMerkleProof when using another voter's proof", async () => {
      const foreignIndex = voterLeafIndex === 0 ? 1 : 0;
      const foreignProof = getMerkleProof(
        buildPadronMerkleTree([
          hashVotante("30111222", "ana@frvm.utn.edu.ar"),
          VOTER_HASH,
          hashVotante("30333444", "carla@frvm.utn.edu.ar"),
          hashVotante("30444555", "diego@frvm.utn.edu.ar"),
        ]).tree,
        foreignIndex,
      );

      await expect(
        castSignedVote(
          ballot,
          { gasPayer, ephemeralSigner, validator, fields: fields(), merkleProof: validProof },
          { merkleProof: foreignProof },
        ),
      ).to.be.revertedWithCustomError(ballot, "InvalidMerkleProof");
    });
  });

  describe("UAT-02: procesamiento exitoso con prueba legítima", () => {
    it("records hasVoted and delegates the anonymous tally to VoteRegistry", async () => {
      await castSignedVote(ballot, {
        gasPayer,
        ephemeralSigner,
        validator,
        fields: fields(),
        merkleProof: validProof,
      });

      expect(await ballot.hasVoted(ELECTION_ID, VOTER_LEAF)).to.equal(true);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_ID)).to.equal(1n);
      // The registry is keyed by the anonymous nullifier, never the voter leaf.
      const [, hasVotedByLeaf] = await registry.getVoterState(
        ELECTION_ID,
        VOTER_LEAF,
      );
      expect(hasVotedByLeaf).to.equal(false);
    });

    it("VOTAR-451 — rechaza un segundo voto del mismo leaf con nuevo nullifier", async () => {
      await castSignedVote(ballot, {
        gasPayer,
        ephemeralSigner,
        validator,
        fields: fields(),
        merkleProof: validProof,
      });

      await expect(
        castSignedVote(ballot, {
          gasPayer,
          ephemeralSigner,
          validator,
          fields: fields({
            nullifier:
              "0x4444444444444444444444444444444444444444444444444444444444444444",
          }),
          merkleProof: validProof,
        }),
      ).to.be.revertedWithCustomError(ballot, "AlreadyVoted");
    });
  });

  describe("validation rules", () => {
    it("reverts MerkleRootNotPublished when root is not anchored", async () => {
      const unpublishedElectionId = 999n;
      await openElectionWindow(unpublishedElectionId);
      await expect(
        castSignedVote(ballot, {
          gasPayer,
          ephemeralSigner,
          validator,
          fields: fields({ electionId: unpublishedElectionId }),
          merkleProof: validProof,
        }),
      )
        .to.be.revertedWithCustomError(ballot, "MerkleRootNotPublished")
        .withArgs(unpublishedElectionId);
    });

    it("reverts when contract is paused", async () => {
      await ballot
        .connect(admin)
        .grantRole(await ballot.PAUSER_ROLE(), admin.address);
      await ballot.connect(admin).pause();

      await expect(
        castSignedVote(ballot, {
          gasPayer,
          ephemeralSigner,
          validator,
          fields: fields(),
          merkleProof: validProof,
        }),
      ).to.be.revertedWithCustomError(ballot, "EnforcedPause");
    });

    it("reads the anchored root from MerkleRootStore", async () => {
      const [storedRoot] = await store.getMerkleRoot(ELECTION_ID);
      expect(storedRoot).to.equal(merkleRoot);
    });
  });

  describe("VOTAR-321 — cierre on-chain ElectionClosed", () => {
    it("reverts ElectionClosed when election state is CLOSED (manual close)", async () => {
      await store
        .connect(admin)
        .setElectionState(ELECTION_ID, ElectionState.CLOSED);

      await expect(
        castSignedVote(ballot, {
          gasPayer,
          ephemeralSigner,
          validator,
          fields: fields(),
          merkleProof: validProof,
        }),
      )
        .to.be.revertedWithCustomError(ballot, "ElectionClosed")
        .withArgs(ELECTION_ID);
    });

    it("reverts ElectionClosed autonomously when block.timestamp >= endTime", async () => {
      const endTime = await store.getElectionEndTime(ELECTION_ID);
      await time.increaseTo(endTime);

      await expect(
        castSignedVote(ballot, {
          gasPayer,
          ephemeralSigner,
          validator,
          fields: fields(),
          merkleProof: validProof,
        }),
      )
        .to.be.revertedWithCustomError(ballot, "ElectionClosed")
        .withArgs(ELECTION_ID);
    });

    it("reverts ElectionClosed when election is not OPEN", async () => {
      await store
        .connect(admin)
        .setElectionState(ELECTION_ID, ElectionState.CONFIGURED);

      await expect(
        castSignedVote(ballot, {
          gasPayer,
          ephemeralSigner,
          validator,
          fields: fields(),
          merkleProof: validProof,
        }),
      )
        .to.be.revertedWithCustomError(ballot, "ElectionClosed")
        .withArgs(ELECTION_ID);
    });
  });
});
