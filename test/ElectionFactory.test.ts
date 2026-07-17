import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  ElectionFactory,
  MerkleRootStore,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("ElectionFactory — VOTAR-337", () => {
  const ELECTION_ID = 337n;

  const DEFAULT_REVOTE = {
    enabled: true,
    maxVotesPerVoter: 3,
    minIntervalSeconds: 60,
    policy: 0, // TallyPolicy.LAST_VOTE_WINS
  };

  let factory: ElectionFactory;
  let merkleStore: MerkleRootStore;
  let admin: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  async function deployFixture() {
    const [admin, stranger] = await ethers.getSigners();

    const storeFactory = await ethers.getContractFactory("MerkleRootStore");
    const merkleStore = await storeFactory.deploy(admin.address);
    await merkleStore.waitForDeployment();

    const factoryFactory = await ethers.getContractFactory("ElectionFactory");
    const factory = await factoryFactory.deploy(
      admin.address,
      await merkleStore.getAddress(),
    );
    await factory.waitForDeployment();

    return { factory, merkleStore, admin, stranger };
  }

  beforeEach(async () => {
    ({ factory, merkleStore, admin, stranger } =
      await loadFixture(deployFixture));
  });

  describe("deployment", () => {
    it("stores admin and shared MerkleRootStore", async () => {
      expect(await factory.admin()).to.equal(admin.address);
      expect(await factory.merkleRootStore()).to.equal(
        await merkleStore.getAddress(),
      );
    });

    it("reverts when MerkleRootStore is zero address", async () => {
      const factoryFactory = await ethers.getContractFactory("ElectionFactory");
      await expect(
        factoryFactory.deploy(admin.address, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(factoryFactory, "MerkleRootStoreIsZeroAddress");
    });

    it("reverts when admin is zero address", async () => {
      const factoryFactory = await ethers.getContractFactory("ElectionFactory");
      await expect(
        factoryFactory.deploy(ethers.ZeroAddress, await merkleStore.getAddress()),
      ).to.be.revertedWithCustomError(factoryFactory, "AdminIsZeroAddress");
    });
  });

  describe("createElection", () => {
    it("deploys ballot, registry and audit view and emits ElectionCreated", async () => {
      await expect(factory.connect(admin).createElection(ELECTION_ID, DEFAULT_REVOTE))
        .to.emit(factory, "ElectionCreated")
        .withArgs(
          ELECTION_ID,
          (ballot: string) => ethers.isAddress(ballot) && ballot !== ethers.ZeroAddress,
          (registry: string) =>
            ethers.isAddress(registry) && registry !== ethers.ZeroAddress,
          (audit: string) => ethers.isAddress(audit) && audit !== ethers.ZeroAddress,
          (config: {
            enabled: boolean;
            maxVotesPerVoter: bigint;
            minIntervalSeconds: bigint;
            policy: bigint;
          }) =>
            config.enabled === true &&
            config.maxVotesPerVoter === 3n &&
            config.minIntervalSeconds === 60n &&
            config.policy === 0n,
        );

      const deployment = await factory.getElection(ELECTION_ID);
      expect(deployment.exists).to.equal(true);
      expect(deployment.ballot).to.properAddress;
      expect(deployment.voteRegistry).to.properAddress;
      expect(deployment.auditView).to.properAddress;
      expect(deployment.revoteConfig.enabled).to.equal(true);
      expect(deployment.revoteConfig.maxVotesPerVoter).to.equal(3);
      expect(await factory.electionCount()).to.equal(1n);
      expect(await factory.electionIdAt(0)).to.equal(ELECTION_ID);
    });

    it("wires BallotContract to shared MerkleRootStore and grants BALLOT_ROLE", async () => {
      await factory.connect(admin).createElection(ELECTION_ID, DEFAULT_REVOTE);
      const deployment = await factory.getElection(ELECTION_ID);

      const ballot = await ethers.getContractAt("BallotContract", deployment.ballot);
      const registry = await ethers.getContractAt(
        "VoteRegistry",
        deployment.voteRegistry,
      );

      expect(await ballot.merkleRootStore()).to.equal(
        await merkleStore.getAddress(),
      );
      expect(await ballot.voteRegistry()).to.equal(deployment.voteRegistry);
      expect(await ballot.hasRole(await ballot.DEFAULT_ADMIN_ROLE(), admin.address))
        .to.equal(true);

      const ballotRole = await registry.BALLOT_ROLE();
      expect(await registry.hasRole(ballotRole, deployment.ballot)).to.equal(true);
      expect(await registry.hasRole(await registry.DEFAULT_ADMIN_ROLE(), admin.address))
        .to.equal(true);
      expect(
        await registry.hasRole(
          await registry.DEFAULT_ADMIN_ROLE(),
          await factory.getAddress(),
        ),
      ).to.equal(false);
      // VOTAR-341 — RevoteConfig.enabled is frozen into VoteRegistry.revoteEnabled.
      expect(await registry.revoteEnabled()).to.equal(DEFAULT_REVOTE.enabled);
    });

    it("deploys VoteRegistry with revoteEnabled=false when RevoteConfig.enabled is false", async () => {
      const disabledRevote = {
        ...DEFAULT_REVOTE,
        enabled: false,
      };
      await factory.connect(admin).createElection(ELECTION_ID, disabledRevote);
      const deployment = await factory.getElection(ELECTION_ID);
      const registry = await ethers.getContractAt(
        "VoteRegistry",
        deployment.voteRegistry,
      );
      expect(await registry.revoteEnabled()).to.equal(false);
    });

    it("reverts when electionId already exists", async () => {
      await factory.connect(admin).createElection(ELECTION_ID, DEFAULT_REVOTE);
      await expect(
        factory.connect(admin).createElection(ELECTION_ID, DEFAULT_REVOTE),
      )
        .to.be.revertedWithCustomError(factory, "ElectionAlreadyExists")
        .withArgs(ELECTION_ID);
    });

    it("reverts when caller lacks DEFAULT_ADMIN_ROLE", async () => {
      await expect(
        factory.connect(stranger).createElection(ELECTION_ID, DEFAULT_REVOTE),
      ).to.be.revertedWithCustomError(
        factory,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts when factory is paused", async () => {
      await factory.connect(admin).grantRole(await factory.PAUSER_ROLE(), admin.address);
      await factory.connect(admin).pause();

      await expect(
        factory.connect(admin).createElection(ELECTION_ID, DEFAULT_REVOTE),
      ).to.be.revertedWithCustomError(factory, "EnforcedPause");
    });
  });
});
