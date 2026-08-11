import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  AuditViewContract,
  MerkleRootStore,
  VoteRegistry,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("AuditViewContract — VOTAR-350 public view UATs", () => {
  const ELECTION_ID = 350n;
  const RECEIPT_HASH =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const OTHER_RECEIPT =
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const UNKNOWN_RECEIPT =
    "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  const CANDIDATE_A = 101n;
  const UNKNOWN_CANDIDATE = 999_999n;
  const ElectionState = {
    DRAFT: 0,
    CONFIGURED: 1,
    OPEN: 2,
    CLOSED: 3,
    TALLIED: 4,
  };

  let store: MerkleRootStore;
  let registry: VoteRegistry;
  let auditView: AuditViewContract;
  let admin: HardhatEthersSigner;
  let ballotRole: HardhatEthersSigner;
  let emptyWallet: HardhatEthersSigner;
  let VOTO_BLANCO: bigint;
  let VOTO_NULO: bigint;

  async function deployFixture() {
    const [admin, ballotRole, emptyWallet] = await ethers.getSigners();

    const storeFactory = await ethers.getContractFactory("MerkleRootStore");
    const store = await storeFactory.deploy(admin.address);
    await store.waitForDeployment();

    const registryFactory = await ethers.getContractFactory("VoteRegistry");
    // Audit overwrite scenarios need LAST_VOTE_WINS (revote enabled).
    const registry = await registryFactory.deploy(admin.address, true);
    await registry.waitForDeployment();

    await registry.connect(admin).grantRole(await registry.BALLOT_ROLE(), ballotRole.address);
    await registry.connect(admin).grantRole(await registry.ELECTION_ADMIN_ROLE(), admin.address);
    await store.connect(admin).grantRole(await store.ELECTION_ADMIN_ROLE(), admin.address);
    // VOTAR-345 — seal the candidate set before any recordVote in this suite.
    await registry.connect(admin).registerCandidates(ELECTION_ID, [CANDIDATE_A]);

    const auditFactory = await ethers.getContractFactory("AuditViewContract");
    const auditView = await auditFactory.deploy(
      await store.getAddress(),
      await registry.getAddress(),
    );
    await auditView.waitForDeployment();

    const VOTO_BLANCO = await registry.VOTO_BLANCO();
    const VOTO_NULO = await registry.VOTO_NULO();

    return {
      store,
      registry,
      auditView,
      admin,
      ballotRole,
      emptyWallet,
      VOTO_BLANCO,
      VOTO_NULO,
    };
  }

  beforeEach(async () => {
    ({
      store,
      registry,
      auditView,
      admin,
      ballotRole,
      emptyWallet,
      VOTO_BLANCO,
      VOTO_NULO,
    } = await loadFixture(deployFixture));
  });

  describe("constructor guards", () => {
    it("reverts when MerkleRootStore is zero address", async () => {
      const factory = await ethers.getContractFactory("AuditViewContract");
      await expect(
        factory.deploy(ethers.ZeroAddress, await registry.getAddress()),
      ).to.be.revertedWithCustomError(factory, "MerkleRootStoreIsZeroAddress");
    });

    it("reverts when VoteRegistry is zero address", async () => {
      const factory = await ethers.getContractFactory("AuditViewContract");
      await expect(
        factory.deploy(await store.getAddress(), ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(factory, "VoteRegistryIsZeroAddress");
    });
  });

  describe("getElectionState", () => {
    it("returns CONFIGURED / OPEN / CLOSED lifecycle states", async () => {
      expect(await auditView.getElectionState(ELECTION_ID)).to.equal(ElectionState.DRAFT);

      await store.connect(admin).setElectionState(ELECTION_ID, ElectionState.CONFIGURED);
      expect(await auditView.getElectionState(ELECTION_ID)).to.equal(ElectionState.CONFIGURED);

      await store.connect(admin).setElectionState(ELECTION_ID, ElectionState.OPEN);
      expect(await auditView.getElectionState(ELECTION_ID)).to.equal(ElectionState.OPEN);

      await store.connect(admin).setElectionState(ELECTION_ID, ElectionState.CLOSED);
      expect(await auditView.getElectionState(ELECTION_ID)).to.equal(ElectionState.CLOSED);
    });
  });

  describe("UAT-01: gas-free access from empty wallet", () => {
    it("returns participation stats via static call without consuming gas", async () => {
      await registry.connect(ballotRole).recordVote(ELECTION_ID, RECEIPT_HASH, CANDIDATE_A);
      await registry.connect(ballotRole).recordVote(ELECTION_ID, OTHER_RECEIPT, VOTO_BLANCO);

      const balanceBefore = await ethers.provider.getBalance(emptyWallet.address);
      const [totalVotes, blankVotes, nullVotes] = await auditView
        .connect(emptyWallet)
        .getParticipationStats.staticCall(ELECTION_ID);
      const balanceAfter = await ethers.provider.getBalance(emptyWallet.address);

      expect(totalVotes).to.equal(2n);
      expect(blankVotes).to.equal(1n);
      expect(nullVotes).to.equal(0n);
      expect(balanceAfter).to.equal(balanceBefore);
    });
  });

  describe("UAT-02: verifyReceipt", () => {
    it("returns true for a receipt hash recorded on-chain", async () => {
      expect(await auditView.verifyReceipt(RECEIPT_HASH)).to.equal(false);

      await registry.connect(ballotRole).recordVote(ELECTION_ID, RECEIPT_HASH, CANDIDATE_A);

      expect(await auditView.verifyReceipt(RECEIPT_HASH)).to.equal(true);
      expect(await registry.verifyReceipt(RECEIPT_HASH)).to.equal(true);
    });

    it("returns false for an unknown receipt without reverting", async () => {
      expect(await auditView.verifyReceipt(UNKNOWN_RECEIPT)).to.equal(false);
    });
  });

  describe("UAT-03: unknown candidate id", () => {
    it("returns 0 for getVotesByCandidate with an unregistered candidateId", async () => {
      await registry.connect(ballotRole).recordVote(ELECTION_ID, RECEIPT_HASH, CANDIDATE_A);

      expect(await auditView.getVotesByCandidate(ELECTION_ID, UNKNOWN_CANDIDATE)).to.equal(0n);
      expect(await auditView.getVotesByCandidate(ELECTION_ID, CANDIDATE_A)).to.equal(1n);
    });
  });

  describe("UAT-04: reads remain available while paused", () => {
    it("serves view functions after VoteRegistry pause", async () => {
      await registry.connect(ballotRole).recordVote(ELECTION_ID, RECEIPT_HASH, CANDIDATE_A);
      await store.connect(admin).setElectionState(ELECTION_ID, ElectionState.OPEN);

      await registry.connect(admin).grantRole(await registry.PAUSER_ROLE(), admin.address);
      await registry.connect(admin).pause();

      await expect(
        registry.connect(ballotRole).recordVote(ELECTION_ID, OTHER_RECEIPT, VOTO_NULO),
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");

      expect(await auditView.getElectionState(ELECTION_ID)).to.equal(ElectionState.OPEN);
      const [totalVotes, blankVotes, nullVotes] =
        await auditView.getParticipationStats(ELECTION_ID);
      expect(totalVotes).to.equal(1n);
      expect(blankVotes).to.equal(0n);
      expect(nullVotes).to.equal(0n);
      expect(await auditView.getVotesByCandidate(ELECTION_ID, CANDIDATE_A)).to.equal(1n);
      expect(await auditView.verifyReceipt(RECEIPT_HASH)).to.equal(true);
    });
  });

  describe("VOTAR-329: getRevoteStats", () => {
    it("returns totalRevotes, uniqueVoters and overwriteRatio (UAT-01)", async () => {
      const voters = Array.from({ length: 70 }, (_, i) =>
        ethers.id(`voter-${i}`),
      );
      for (const hash of voters) {
        await registry.connect(ballotRole).recordVote(ELECTION_ID, hash, CANDIDATE_A);
      }
      for (let i = 0; i < 30; i++) {
        await registry
          .connect(ballotRole)
          .recordVote(ELECTION_ID, voters[i], VOTO_BLANCO);
      }

      const [totalRevotes, uniqueVoters, overwriteRatioWad] =
        await auditView.getRevoteStats(ELECTION_ID);

      expect(totalRevotes).to.equal(30n);
      expect(uniqueVoters).to.equal(70n);
      expect(overwriteRatioWad).to.equal((30n * 10n ** 18n) / 100n);
    });

    it("is callable gas-free from an empty wallet", async () => {
      await registry.connect(ballotRole).recordVote(ELECTION_ID, RECEIPT_HASH, CANDIDATE_A);
      await registry.connect(ballotRole).recordVote(ELECTION_ID, RECEIPT_HASH, VOTO_BLANCO);

      const balanceBefore = await ethers.provider.getBalance(emptyWallet.address);
      await auditView.connect(emptyWallet).getRevoteStats.staticCall(ELECTION_ID);
      const balanceAfter = await ethers.provider.getBalance(emptyWallet.address);

      expect(balanceAfter).to.equal(balanceBefore);
    });
  });

  describe("privacy and participation aggregates", () => {
    it("tracks blank/null and does not expose identity beyond receipt hash", async () => {
      await registry.connect(ballotRole).recordVote(ELECTION_ID, RECEIPT_HASH, VOTO_BLANCO);
      await registry.connect(ballotRole).recordVote(ELECTION_ID, OTHER_RECEIPT, VOTO_NULO);
      // overwrite blank → candidate (totalVotes stays 2)
      await registry.connect(ballotRole).recordVote(ELECTION_ID, RECEIPT_HASH, CANDIDATE_A);

      const [totalVotes, blankVotes, nullVotes] =
        await auditView.getParticipationStats(ELECTION_ID);
      expect(totalVotes).to.equal(2n);
      expect(blankVotes).to.equal(0n);
      expect(nullVotes).to.equal(1n);
      expect(await auditView.getVotesByCandidate(ELECTION_ID, CANDIDATE_A)).to.equal(1n);

      // ABI surface must not return wallet / leaf identity fields for these views
      const statsFragment = auditView.interface.getFunction("getParticipationStats");
      expect(statsFragment!.outputs.map((o) => o.name)).to.deep.equal([
        "totalVotes",
        "blankVotes",
        "nullVotes",
      ]);
      const receiptFragment = auditView.interface.getFunction("verifyReceipt");
      expect(receiptFragment!.outputs.map((o) => o.type)).to.deep.equal(["bool"]);
    });
  });
});
