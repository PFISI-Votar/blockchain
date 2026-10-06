import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { MerkleRootStore } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("MerkleRootStore — US-335 & US-336 UATs", () => {
  let store: MerkleRootStore;
  let admin: HardhatEthersSigner;
  let merkleUpdater: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  const ELECTION_ID = 42n;
  const ROOT = ethers.id("merkle-root-test");

  // Election states enum values (must match contract)
  const ElectionState = {
    DRAFT: 0,
    CONFIGURED: 1,
    OPEN: 2,
    CLOSED: 3,
    TALLIED: 4,
  };

  async function deployFixture() {
    const [admin, merkleUpdater, attacker] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("MerkleRootStore");
    const store = await factory.deploy(admin.address);
    await store.waitForDeployment();
    await store
      .connect(admin)
      .grantRole(await store.MERKLE_UPDATER_ROLE(), merkleUpdater.address);
    await store
      .connect(admin)
      .grantRole(await store.ELECTION_ADMIN_ROLE(), admin.address);
    return { store, admin, merkleUpdater, attacker };
  }

  beforeEach(async () => {
    ({ store, admin, merkleUpdater, attacker } = await loadFixture(
      deployFixture,
    ));
  });

  describe("UAT-01: publishRoot success and RootPublished event", () => {
    it("emits RootPublished with correct electionId and root", async () => {
      const tx = await store
        .connect(merkleUpdater)
        .publishRoot(ELECTION_ID, ROOT);
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
        .to.be.revertedWithCustomError(
          store,
          "AccessControlUnauthorizedAccount",
        )
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
      await expect(
        store.connect(merkleUpdater).publishRoot(ELECTION_ID, otherRoot),
      )
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

  describe("US-336: Hermetic seal — padron locked when voting is open", () => {
    describe("UAT-01: Attempt to re-publish root in open election", () => {
      it("reverts with RootLocked when election is OPEN", async () => {
        // Set election to OPEN state
        await store
          .connect(admin)
          .setElectionState(ELECTION_ID, ElectionState.OPEN);

        // Attempt to publish root should fail with RootLocked
        await expect(
          store.connect(merkleUpdater).publishRoot(ELECTION_ID, ROOT),
        )
          .to.be.revertedWithCustomError(store, "RootLocked")
          .withArgs(ELECTION_ID);
      });

      it("reverts with RootLocked when election is CLOSED", async () => {
        // Set election to CLOSED state
        await store
          .connect(admin)
          .setElectionState(ELECTION_ID, ElectionState.CLOSED);

        // Attempt to publish root should fail
        await expect(
          store.connect(merkleUpdater).publishRoot(ELECTION_ID, ROOT),
        )
          .to.be.revertedWithCustomError(store, "RootLocked")
          .withArgs(ELECTION_ID);
      });

      it("reverts with RootLocked when election is TALLIED", async () => {
        // Set election to TALLIED state
        await store
          .connect(admin)
          .setElectionState(ELECTION_ID, ElectionState.TALLIED);

        // Attempt to publish root should fail
        await expect(
          store.connect(merkleUpdater).publishRoot(ELECTION_ID, ROOT),
        )
          .to.be.revertedWithCustomError(store, "RootLocked")
          .withArgs(ELECTION_ID);
      });

      it("allows publishing when election is DRAFT (default state)", async () => {
        // Default state is DRAFT (0)
        const tx = await store
          .connect(merkleUpdater)
          .publishRoot(ELECTION_ID, ROOT);
        await expect(tx).to.emit(store, "RootPublished");

        const [storedRoot] = await store.getMerkleRoot(ELECTION_ID);
        expect(storedRoot).to.equal(ROOT);
      });

      it("allows publishing when election is CONFIGURED", async () => {
        const otherElectionId = 99n;
        await store
          .connect(admin)
          .setElectionState(otherElectionId, ElectionState.CONFIGURED);

        const tx = await store
          .connect(merkleUpdater)
          .publishRoot(otherElectionId, ROOT);
        await expect(tx).to.emit(store, "RootPublished");

        const [storedRoot] = await store.getMerkleRoot(otherElectionId);
        expect(storedRoot).to.equal(ROOT);
      });
    });

    describe("setElectionState access control", () => {
      it("allows ELECTION_ADMIN to set election state", async () => {
        const tx = await store
          .connect(admin)
          .setElectionState(ELECTION_ID, ElectionState.OPEN);
        await expect(tx)
          .to.emit(store, "ElectionStateChanged")
          .withArgs(ELECTION_ID, ElectionState.OPEN);

        expect(await store.getElectionState(ELECTION_ID)).to.equal(
          ElectionState.OPEN,
        );
      });

      it("reverts when non-admin tries to set election state", async () => {
        const ELECTION_ADMIN_ROLE = await store.ELECTION_ADMIN_ROLE();
        await expect(
          store
            .connect(attacker)
            .setElectionState(ELECTION_ID, ElectionState.OPEN),
        )
          .to.be.revertedWithCustomError(
            store,
            "AccessControlUnauthorizedAccount",
          )
          .withArgs(attacker.address, ELECTION_ADMIN_ROLE);
      });
    });

    describe("getElectionState", () => {
      it("returns DRAFT by default", async () => {
        expect(await store.getElectionState(ELECTION_ID)).to.equal(
          ElectionState.DRAFT,
        );
      });

      it("returns the updated state after setElectionState", async () => {
        await store
          .connect(admin)
          .setElectionState(ELECTION_ID, ElectionState.CONFIGURED);
        expect(await store.getElectionState(ELECTION_ID)).to.equal(
          ElectionState.CONFIGURED,
        );

        await store
          .connect(admin)
          .setElectionState(ELECTION_ID, ElectionState.OPEN);
        expect(await store.getElectionState(ELECTION_ID)).to.equal(
          ElectionState.OPEN,
        );
      });
    });

    describe("setElectionWindow — VOTAR-321", () => {
      it("stores and returns the voting window", async () => {
        const startTime = 1_700_000_000n;
        const endTime = 1_700_003_600n;

        await expect(
          store.connect(admin).setElectionWindow(ELECTION_ID, startTime, endTime),
        )
          .to.emit(store, "ElectionWindowSet")
          .withArgs(ELECTION_ID, startTime, endTime);

        expect(await store.getElectionEndTime(ELECTION_ID)).to.equal(endTime);
        const [storedStart, storedEnd] = await store.getElectionWindow(ELECTION_ID);
        expect(storedStart).to.equal(startTime);
        expect(storedEnd).to.equal(endTime);
      });

      it("reverts InvalidElectionWindow when endTime <= startTime", async () => {
        await expect(
          store.connect(admin).setElectionWindow(ELECTION_ID, 100n, 100n),
        ).to.be.revertedWithCustomError(store, "InvalidElectionWindow");
      });
    });

    describe("lockConfig — VOTAR-327", () => {
      it("emits ConfigurationLocked and sets isConfigLocked=true", async () => {
        expect(await store.isConfigLocked(ELECTION_ID)).to.equal(false);

        await expect(store.connect(admin).lockConfig(ELECTION_ID))
          .to.emit(store, "ConfigurationLocked")
          .withArgs(ELECTION_ID);

        expect(await store.isConfigLocked(ELECTION_ID)).to.equal(true);
      });

      it("reverts with ConfigLocked on second call", async () => {
        await store.connect(admin).lockConfig(ELECTION_ID);

        await expect(store.connect(admin).lockConfig(ELECTION_ID))
          .to.be.revertedWithCustomError(store, "ConfigLocked")
          .withArgs(ELECTION_ID);
      });

      it("reverts when non-admin tries to lock config", async () => {
        const ELECTION_ADMIN_ROLE = await store.ELECTION_ADMIN_ROLE();
        await expect(store.connect(attacker).lockConfig(ELECTION_ID))
          .to.be.revertedWithCustomError(
            store,
            "AccessControlUnauthorizedAccount",
          )
          .withArgs(attacker.address, ELECTION_ADMIN_ROLE);
      });

      it("setElectionWindow reverts with ConfigLocked once locked, even in DRAFT state", async () => {
        // Locking is independent of ElectionState — default state here is DRAFT.
        expect(await store.getElectionState(ELECTION_ID)).to.equal(
          ElectionState.DRAFT,
        );
        await store.connect(admin).lockConfig(ELECTION_ID);

        await expect(
          store.connect(admin).setElectionWindow(ELECTION_ID, 100n, 200n),
        )
          .to.be.revertedWithCustomError(store, "ConfigLocked")
          .withArgs(ELECTION_ID);
      });

      it("setElectionState keeps working normally after lockConfig (lifecycle must still advance)", async () => {
        await store.connect(admin).lockConfig(ELECTION_ID);

        await expect(
          store.connect(admin).setElectionState(ELECTION_ID, ElectionState.OPEN),
        ).to.not.be.reverted;
        expect(await store.getElectionState(ELECTION_ID)).to.equal(
          ElectionState.OPEN,
        );

        await expect(
          store.connect(admin).setElectionState(ELECTION_ID, ElectionState.CLOSED),
        ).to.not.be.reverted;
        expect(await store.getElectionState(ELECTION_ID)).to.equal(
          ElectionState.CLOSED,
        );
      });
    });
  });

  describe("pause — VOTAR-347", () => {
    beforeEach(async () => {
      await store.connect(admin).grantRole(await store.PAUSER_ROLE(), admin.address);
      await store.connect(admin).pause();
    });

    it("setElectionState reverts with EnforcedPause while paused", async () => {
      await expect(
        store.connect(admin).setElectionState(ELECTION_ID, ElectionState.CONFIGURED),
      ).to.be.revertedWithCustomError(store, "EnforcedPause");
    });

    it("setElectionWindow reverts with EnforcedPause while paused", async () => {
      await expect(
        store.connect(admin).setElectionWindow(ELECTION_ID, 1_000, 2_000),
      ).to.be.revertedWithCustomError(store, "EnforcedPause");
    });

    it("lockConfig reverts with EnforcedPause while paused", async () => {
      await expect(
        store.connect(admin).lockConfig(ELECTION_ID),
      ).to.be.revertedWithCustomError(store, "EnforcedPause");
    });

    it("publishRoot reverts with EnforcedPause while paused", async () => {
      await expect(
        store.connect(merkleUpdater).publishRoot(ELECTION_ID, ROOT),
      ).to.be.revertedWithCustomError(store, "EnforcedPause");
    });

    it("getters keep responding while paused (AC4 — observers can still audit)", async () => {
      await expect(store.getElectionState(ELECTION_ID)).to.not.be.reverted;
      await expect(store.getMerkleRoot(ELECTION_ID)).to.not.be.reverted;
      await expect(store.isPublished(ELECTION_ID)).to.not.be.reverted;
      await expect(store.getElectionWindow(ELECTION_ID)).to.not.be.reverted;
      await expect(store.getElectionEndTime(ELECTION_ID)).to.not.be.reverted;
      await expect(store.isConfigLocked(ELECTION_ID)).to.not.be.reverted;
    });
  });
});
