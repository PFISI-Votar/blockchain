import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { MerkleRootStore } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("MerkleRootStore — US-335 UATs", () => {
  let store: MerkleRootStore;
  let admin: HardhatEthersSigner;
  let merkleUpdater: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  const ELECTION_ID = 42n;
  const ROOT = ethers.id("merkle-root-test");

  async function deployFixture() {
    const [admin, merkleUpdater, attacker] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("MerkleRootStore");
    const store = await factory.deploy(admin.address);
    await store.waitForDeployment();
    await store.connect(admin).grantRole(await store.MERKLE_UPDATER_ROLE(), merkleUpdater.address);
    return { store, admin, merkleUpdater, attacker };
  }

  beforeEach(async () => {
    ({ store, admin, merkleUpdater, attacker } = await loadFixture(deployFixture));
  });

  describe("UAT-01: publishRoot success and RootPublished event", () => {
    it("emits RootPublished with correct electionId and root", async () => {
      const tx = await store.connect(merkleUpdater).publishRoot(ELECTION_ID, ROOT);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      await expect(tx)
        .to.emit(store, "RootPublished")
        .withArgs(ELECTION_ID, ROOT, block!.timestamp);

      const [storedRoot, timestamp] = await store.getMerkleRoot(ELECTION_ID);
      expect(storedRoot).to.equal(ROOT);
      expect(timestamp).to.equal(block!.timestamp);
      expect(await store.isPublished(ELECTION_ID)).to.equal(true);
    });
  });

  describe("UAT-02: unauthorized publisher rejected", () => {
    it("reverts when caller lacks MERKLE_UPDATER_ROLE", async () => {
      const MERKLE_UPDATER_ROLE = await store.MERKLE_UPDATER_ROLE();
      await expect(store.connect(attacker).publishRoot(ELECTION_ID, ROOT))
        .to.be.revertedWithCustomError(store, "AccessControlUnauthorizedAccount")
        .withArgs(attacker.address, MERKLE_UPDATER_ROLE);
    });
  });

  describe("validation rules", () => {
    it("reverts on zero root", async () => {
      await expect(
        store.connect(merkleUpdater).publishRoot(ELECTION_ID, ethers.ZeroHash),
      ).to.be.revertedWithCustomError(store, "RootIsZero");
    });

    it("reverts on double publication for the same electionId", async () => {
      await store.connect(merkleUpdater).publishRoot(ELECTION_ID, ROOT);
      const otherRoot = ethers.id("other-root");
      await expect(store.connect(merkleUpdater).publishRoot(ELECTION_ID, otherRoot))
        .to.be.revertedWithCustomError(store, "RootAlreadyPublished")
        .withArgs(ELECTION_ID);
    });

    it("returns zero root for unpublished election", async () => {
      const [root, timestamp] = await store.getMerkleRoot(999n);
      expect(root).to.equal(ethers.ZeroHash);
      expect(timestamp).to.equal(0n);
      expect(await store.isPublished(999n)).to.equal(false);
    });
  });
});
