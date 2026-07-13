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

describe("BallotContract — US-339 UATs", () => {
  const ELECTION_ID = 339n;
  const VOTER_DNI = "30222333";
  const VOTER_EMAIL = "bruno@frvm.utn.edu.ar";
  const VOTER_HASH = hashVotante(VOTER_DNI, VOTER_EMAIL);
  const VOTER_LEAF = toBytes32Hex(VOTER_HASH);
  const CANDIDATE_ID = 101n;
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
  let voter: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;
  let merkleRoot: string;
  let voterLeafIndex: number;
  let validProof: string[];

  async function openElectionWindow(
    store: MerkleRootStore,
    admin: HardhatEthersSigner,
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
    const [admin, merkleUpdater, voter, attacker] = await ethers.getSigners();

    const storeFactory = await ethers.getContractFactory("MerkleRootStore");
    const store = await storeFactory.deploy(admin.address);
    await store.waitForDeployment();

    const registryFactory = await ethers.getContractFactory("VoteRegistry");
    const registry = await registryFactory.deploy(admin.address);
    await registry.waitForDeployment();

    const ballotFactory = await ethers.getContractFactory("BallotContract");
    const ballot = await ballotFactory.deploy(
      admin.address,
      await store.getAddress(),
      await registry.getAddress(),
    );
    await ballot.waitForDeployment();

    await registry
      .connect(admin)
      .grantRole(await registry.BALLOT_ROLE(), await ballot.getAddress());

    await store.connect(admin).grantRole(await store.MERKLE_UPDATER_ROLE(), merkleUpdater.address);
    await store.connect(admin).grantRole(await store.ELECTION_ADMIN_ROLE(), admin.address);

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
    await openElectionWindow(store, admin, ELECTION_ID);

    return {
      store,
      registry,
      ballot,
      admin,
      merkleUpdater,
      voter,
      attacker,
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
      voter,
      attacker,
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
        ballot.connect(voter).castVote(ELECTION_ID, VOTER_LEAF, tamperedProof, CANDIDATE_ID),
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
        ballot.connect(voter).castVote(ELECTION_ID, VOTER_LEAF, foreignProof, CANDIDATE_ID),
      ).to.be.revertedWithCustomError(ballot, "InvalidMerkleProof");
    });
  });

  describe("UAT-02: procesamiento exitoso con prueba legítima", () => {
    it("records the vote and emits VoteCast via VoteRegistry when Merkle proof is valid", async () => {
      await expect(
        ballot.connect(voter).castVote(ELECTION_ID, VOTER_LEAF, validProof, CANDIDATE_ID),
      )
        .to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, VOTER_LEAF, CANDIDATE_ID, false);

      expect(await ballot.hasVoted(ELECTION_ID, VOTER_LEAF)).to.equal(true);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_ID)).to.equal(1n);
    });
  });

  describe("validation rules", () => {
    it("reverts MerkleRootNotPublished when root is not anchored", async () => {
      const unpublishedElectionId = 999n;
      await openElectionWindow(store, admin, unpublishedElectionId);
      await expect(
        ballot
          .connect(voter)
          .castVote(unpublishedElectionId, VOTER_LEAF, validProof, CANDIDATE_ID),
      )
        .to.be.revertedWithCustomError(ballot, "MerkleRootNotPublished")
        .withArgs(unpublishedElectionId);
    });

    it("reverts when contract is paused", async () => {
      const PAUSER_ROLE = await ballot.PAUSER_ROLE();
      await ballot.connect(admin).grantRole(PAUSER_ROLE, admin.address);
      await ballot.connect(admin).pause();

      await expect(
        ballot.connect(voter).castVote(ELECTION_ID, VOTER_LEAF, validProof, CANDIDATE_ID),
      ).to.be.revertedWithCustomError(ballot, "EnforcedPause");
    });

    it("reads the anchored root from MerkleRootStore", async () => {
      const [storedRoot] = await store.getMerkleRoot(ELECTION_ID);
      expect(storedRoot).to.equal(merkleRoot);
    });
  });

  describe("VOTAR-321 — cierre on-chain ElectionClosed", () => {
    it("reverts ElectionClosed when election state is CLOSED (manual close)", async () => {
      await store.connect(admin).setElectionState(ELECTION_ID, ElectionState.CLOSED);

      await expect(
        ballot.connect(voter).castVote(ELECTION_ID, VOTER_LEAF, validProof, CANDIDATE_ID),
      )
        .to.be.revertedWithCustomError(ballot, "ElectionClosed")
        .withArgs(ELECTION_ID);
    });

    it("reverts ElectionClosed autonomously when block.timestamp >= endTime", async () => {
      const endTime = await store.getElectionEndTime(ELECTION_ID);
      await time.increaseTo(endTime);

      await expect(
        ballot.connect(voter).castVote(ELECTION_ID, VOTER_LEAF, validProof, CANDIDATE_ID),
      )
        .to.be.revertedWithCustomError(ballot, "ElectionClosed")
        .withArgs(ELECTION_ID);
    });

    it("reverts ElectionClosed when election is not OPEN", async () => {
      await store
        .connect(admin)
        .setElectionState(ELECTION_ID, ElectionState.CONFIGURED);

      await expect(
        ballot.connect(voter).castVote(ELECTION_ID, VOTER_LEAF, validProof, CANDIDATE_ID),
      )
        .to.be.revertedWithCustomError(ballot, "ElectionClosed")
        .withArgs(ELECTION_ID);
    });
  });

  describe("VOTAR-346 — privacy of VoteCast", () => {
    it("does not index the submitting wallet address on VoteCast", async () => {
      const tx = await ballot
        .connect(voter)
        .castVote(ELECTION_ID, VOTER_LEAF, validProof, CANDIDATE_ID);
      const receipt = await tx.wait();
      expect(receipt).to.not.equal(null);

      const voteCastTopic = registry.interface.getEvent("VoteCast")!.topicHash;
      const voteCastLog = receipt!.logs.find((log) => log.topics[0] === voteCastTopic);
      expect(voteCastLog).to.not.equal(undefined);

      // topics[0]=sig, topics[1]=electionId, topics[2]=voterHash — no address topic
      expect(voteCastLog!.topics.length).to.equal(3);
      const voterAddressTopic = ethers.zeroPadValue(voter.address, 32).toLowerCase();
      expect(voteCastLog!.topics.map((t) => t.toLowerCase())).to.not.include(voterAddressTopic);
    });
  });
});
