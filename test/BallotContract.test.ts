import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { BallotContract, MerkleRootStore } from "../typechain-types";
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

  let store: MerkleRootStore;
  let ballot: BallotContract;
  let admin: HardhatEthersSigner;
  let merkleUpdater: HardhatEthersSigner;
  let voter: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;
  let merkleRoot: string;
  let voterLeafIndex: number;
  let validProof: string[];

  async function deployFixture() {
    const [admin, merkleUpdater, voter, attacker] = await ethers.getSigners();

    const storeFactory = await ethers.getContractFactory("MerkleRootStore");
    const store = await storeFactory.deploy(admin.address);
    await store.waitForDeployment();

    const ballotFactory = await ethers.getContractFactory("BallotContract");
    const ballot = await ballotFactory.deploy(admin.address, await store.getAddress());
    await ballot.waitForDeployment();

    await store.connect(admin).grantRole(await store.MERKLE_UPDATER_ROLE(), merkleUpdater.address);

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

    return {
      store,
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

      await expect(ballot.connect(voter).castVote(ELECTION_ID, VOTER_LEAF, tamperedProof))
        .to.be.revertedWithCustomError(ballot, "InvalidMerkleProof");

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

      await expect(ballot.connect(voter).castVote(ELECTION_ID, VOTER_LEAF, foreignProof))
        .to.be.revertedWithCustomError(ballot, "InvalidMerkleProof");
    });
  });

  describe("UAT-02: procesamiento exitoso con prueba legítima", () => {
    it("records the vote and emits VoteCast when Merkle proof is valid", async () => {
      await expect(ballot.connect(voter).castVote(ELECTION_ID, VOTER_LEAF, validProof))
        .to.emit(ballot, "VoteCast")
        .withArgs(ELECTION_ID, VOTER_LEAF, voter.address);

      expect(await ballot.hasVoted(ELECTION_ID, VOTER_LEAF)).to.equal(true);
    });
  });

  describe("validation rules", () => {
    it("reverts MerkleRootNotPublished when root is not anchored", async () => {
      const unpublishedElectionId = 999n;
      await expect(
        ballot.connect(voter).castVote(unpublishedElectionId, VOTER_LEAF, validProof),
      )
        .to.be.revertedWithCustomError(ballot, "MerkleRootNotPublished")
        .withArgs(unpublishedElectionId);
    });

    it("reverts when contract is paused", async () => {
      const PAUSER_ROLE = await ballot.PAUSER_ROLE();
      await ballot.connect(admin).grantRole(PAUSER_ROLE, admin.address);
      await ballot.connect(admin).pause();

      await expect(ballot.connect(voter).castVote(ELECTION_ID, VOTER_LEAF, validProof))
        .to.be.revertedWithCustomError(ballot, "EnforcedPause");
    });

    it("reads the anchored root from MerkleRootStore", async () => {
      const [storedRoot] = await store.getMerkleRoot(ELECTION_ID);
      expect(storedRoot).to.equal(merkleRoot);
    });
  });
});
