import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { AccessControlHarness } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * RBAC tests mapped 1:1 to the user-story UATs.
 * - UAT-01: cross-role rejection
 * - UAT-02: admin-only role management
 * - UAT-03: RoleGranted auditability (role, account, sender)
 * - UAT-04: self renounceRole
 */
describe("VotarAccessControl (RBAC) — UATs", () => {
  let contract: AccessControlHarness;
  let admin: HardhatEthersSigner;
  let pauser: HardhatEthersSigner;
  let merkleUpdater: HardhatEthersSigner;
  let ballot: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  let DEFAULT_ADMIN_ROLE: string;
  let PAUSER_ROLE: string;
  let MERKLE_UPDATER_ROLE: string;
  let BALLOT_ROLE: string;

  async function deployFixture() {
    const [admin, pauser, merkleUpdater, ballot, attacker] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("AccessControlHarness");
    const contract = await factory.deploy(admin.address);
    await contract.waitForDeployment();

    // Admin (DEFAULT_ADMIN_ROLE holder) provisions the operational roles.
    await contract.connect(admin).grantRole(await contract.PAUSER_ROLE(), pauser.address);
    await contract
      .connect(admin)
      .grantRole(await contract.MERKLE_UPDATER_ROLE(), merkleUpdater.address);
    await contract.connect(admin).grantRole(await contract.BALLOT_ROLE(), ballot.address);

    return { contract, admin, pauser, merkleUpdater, ballot, attacker };
  }

  beforeEach(async () => {
    ({ contract, admin, pauser, merkleUpdater, ballot, attacker } =
      await loadFixture(deployFixture));
    DEFAULT_ADMIN_ROLE = await contract.DEFAULT_ADMIN_ROLE();
    PAUSER_ROLE = await contract.PAUSER_ROLE();
    MERKLE_UPDATER_ROLE = await contract.MERKLE_UPDATER_ROLE();
    BALLOT_ROLE = await contract.BALLOT_ROLE();
  });

  describe("Setup / centralized administration", () => {
    it("grants DEFAULT_ADMIN_ROLE to the admin passed at deployment", async () => {
      expect(await contract.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
    });

    it("reverts deployment when admin is the zero address", async () => {
      const factory = await ethers.getContractFactory("AccessControlHarness");
      await expect(factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        factory,
        "AdminIsZeroAddress",
      );
    });

    it("makes DEFAULT_ADMIN_ROLE the admin of every operational role", async () => {
      expect(await contract.getRoleAdmin(PAUSER_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
      expect(await contract.getRoleAdmin(MERKLE_UPDATER_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
      expect(await contract.getRoleAdmin(BALLOT_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
    });
  });

  describe("UAT-01 — cross-role rejection", () => {
    it("blocks a MERKLE_UPDATER_ROLE account from calling pause()", async () => {
      await expect(contract.connect(merkleUpdater).pause())
        .to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount")
        .withArgs(merkleUpdater.address, PAUSER_ROLE);
    });

    it("allows the PAUSER_ROLE account to call pause()", async () => {
      await expect(contract.connect(pauser).pause()).to.not.be.reverted;
      expect(await contract.paused()).to.equal(true);
    });

    it("pause(): emits Paused(address,string) with an empty reason", async () => {
      // Overloaded event name — must reference the qualified signature (see
      // VotarAccessControl.sol NatSpec), or Chai/ethers report it as ambiguous.
      await expect(contract.connect(pauser).pause())
        .to.emit(contract, "Paused(address,string)")
        .withArgs(pauser.address, "");
    });

    it("pause(reason): PAUSER_ROLE account pauses with an audit reason and emits Paused(address,string)", async () => {
      const reason = "Actividad sospechosa detectada";
      await expect(contract.connect(pauser)["pause(string)"](reason))
        .to.emit(contract, "Paused(address,string)")
        .withArgs(pauser.address, reason);
      expect(await contract.paused()).to.equal(true);
    });

    it("pause(reason): reverts for an account without PAUSER_ROLE", async () => {
      await expect(contract.connect(merkleUpdater)["pause(string)"]("x"))
        .to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount")
        .withArgs(merkleUpdater.address, PAUSER_ROLE);
    });
  });

  describe("unpause — VOTAR-347 follow-up (reanudación tras incidente)", () => {
    it("UAT-01: PAUSER_ROLE reanuda un contrato pausado y emite Unpaused(address)", async () => {
      await contract.connect(pauser).pause();
      expect(await contract.paused()).to.equal(true);

      await expect(contract.connect(pauser).unpause())
        .to.emit(contract, "Unpaused")
        .withArgs(pauser.address);
      expect(await contract.paused()).to.equal(false);
    });

    it("UAT-01: tras reanudar, las operaciones bloqueadas vuelven a aceptarse", async () => {
      await contract.connect(pauser).pause();
      await expect(
        contract.connect(ballot).recordBallotOp(11),
      ).to.be.revertedWithCustomError(contract, "EnforcedPause");

      await contract.connect(pauser).unpause();

      await expect(contract.connect(ballot).recordBallotOp(11)).to.not.be.reverted;
      expect(await contract.lastBallotValue()).to.equal(11n);
    });

    it("UAT-02: reverts cuando una cuenta sin PAUSER_ROLE invoca unpause()", async () => {
      await contract.connect(pauser).pause();

      await expect(contract.connect(merkleUpdater).unpause())
        .to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount")
        .withArgs(merkleUpdater.address, PAUSER_ROLE);
      expect(await contract.paused()).to.equal(true);
    });

    it("UAT-03: reanudación redundante — revierte con ExpectedPause y no emite Unpaused", async () => {
      expect(await contract.paused()).to.equal(false);

      await expect(
        contract.connect(pauser).unpause(),
      ).to.be.revertedWithCustomError(contract, "ExpectedPause");
    });
  });

  describe("UAT-02 — admin-only role management", () => {
    it("denies a non-admin granting BALLOT_ROLE", async () => {
      await expect(contract.connect(attacker).grantRole(BALLOT_ROLE, attacker.address))
        .to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount")
        .withArgs(attacker.address, DEFAULT_ADMIN_ROLE);
    });

    it("allows the admin to grant BALLOT_ROLE", async () => {
      await contract.connect(admin).grantRole(BALLOT_ROLE, attacker.address);
      expect(await contract.hasRole(BALLOT_ROLE, attacker.address)).to.equal(true);
    });
  });

  describe("UAT-03 — role auditability (RoleGranted)", () => {
    it("emits RoleGranted(role, account, sender) on grant", async () => {
      await expect(contract.connect(admin).grantRole(BALLOT_ROLE, attacker.address))
        .to.emit(contract, "RoleGranted")
        .withArgs(BALLOT_ROLE, attacker.address, admin.address);
    });

    it("emits RoleRevoked(role, account, sender) on revoke", async () => {
      await expect(contract.connect(admin).revokeRole(BALLOT_ROLE, ballot.address))
        .to.emit(contract, "RoleRevoked")
        .withArgs(BALLOT_ROLE, ballot.address, admin.address);
    });
  });

  describe("UAT-04 — self renounceRole", () => {
    it("lets an account renounce its own role without the admin", async () => {
      await expect(contract.connect(ballot).renounceRole(BALLOT_ROLE, ballot.address))
        .to.emit(contract, "RoleRevoked")
        .withArgs(BALLOT_ROLE, ballot.address, ballot.address);
      expect(await contract.hasRole(BALLOT_ROLE, ballot.address)).to.equal(false);
    });

    it("forbids renouncing a role on behalf of another account", async () => {
      await expect(
        contract.connect(attacker).renounceRole(BALLOT_ROLE, ballot.address),
      ).to.be.revertedWithCustomError(contract, "AccessControlBadConfirmation");
    });
  });

  describe("Operation isolation — guarded functions", () => {
    const root = ethers.keccak256(ethers.toUtf8Bytes("root-v1"));

    it("updateMerkleRoot: reverts without MERKLE_UPDATER_ROLE, succeeds with it", async () => {
      await expect(contract.connect(attacker).updateMerkleRoot(root))
        .to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount")
        .withArgs(attacker.address, MERKLE_UPDATER_ROLE);

      await contract.connect(merkleUpdater).updateMerkleRoot(root);
      expect(await contract.lastMerkleRoot()).to.equal(root);
    });

    it("recordBallotOp: reverts without BALLOT_ROLE, succeeds with it", async () => {
      await expect(contract.connect(attacker).recordBallotOp(42))
        .to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount")
        .withArgs(attacker.address, BALLOT_ROLE);

      await contract.connect(ballot).recordBallotOp(42);
      expect(await contract.lastBallotValue()).to.equal(42n);
    });

    it("recordBallotOp: reverts while paused even with BALLOT_ROLE", async () => {
      await contract.connect(pauser).pause();
      await expect(contract.connect(ballot).recordBallotOp(7)).to.be.revertedWithCustomError(
        contract,
        "EnforcedPause",
      );
    });
  });
});
