import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { VoteRegistry } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("VoteRegistry — VOTAR-346 VoteCast UATs", () => {
  const ELECTION_ID = 346n;
  const VOTER_HASH =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const CANDIDATE_A = 101n;
  const CANDIDATE_B = 202n;

  let registry: VoteRegistry;
  let admin: HardhatEthersSigner;
  let ballotRole: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let VOTO_BLANCO: bigint;
  let VOTO_NULO: bigint;

  async function deployFixture() {
    const [admin, ballotRole, stranger] = await ethers.getSigners();

    const registryFactory = await ethers.getContractFactory("VoteRegistry");
    const registry = await registryFactory.deploy(admin.address);
    await registry.waitForDeployment();

    await registry.connect(admin).grantRole(await registry.BALLOT_ROLE(), ballotRole.address);

    const VOTO_BLANCO = await registry.VOTO_BLANCO();
    const VOTO_NULO = await registry.VOTO_NULO();

    return { registry, admin, ballotRole, stranger, VOTO_BLANCO, VOTO_NULO };
  }

  beforeEach(async () => {
    ({ registry, admin, ballotRole, stranger, VOTO_BLANCO, VOTO_NULO } =
      await loadFixture(deployFixture));
  });

  describe("event structure and indexing", () => {
    it("emits VoteCast with electionId, voterHash, candidateId and isOverwrite=false", async () => {
      await expect(registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A))
        .to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, VOTER_HASH, CANDIDATE_A, false);

      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(1n);
      const [candidateId, hasVoted] = await registry.getVoterState(ELECTION_ID, VOTER_HASH);
      expect(candidateId).to.equal(CANDIDATE_A);
      expect(hasVoted).to.equal(true);
    });

    it("indexes only electionId and voterHash (candidateId and isOverwrite are data)", async () => {
      const fragment = registry.interface.getEvent("VoteCast");
      expect(fragment).to.not.equal(null);
      const indexed = fragment!.inputs.filter((input) => input.indexed).map((input) => input.name);
      expect(indexed).to.deep.equal(["electionId", "voterHash"]);
      expect(fragment!.inputs.map((input) => input.name)).to.deep.equal([
        "electionId",
        "voterHash",
        "candidateId",
        "isOverwrite",
      ]);
    });
  });

  describe("blank and null reserved ids", () => {
    it("emits VoteCast for VOTO_BLANCO and increments its tally", async () => {
      await expect(registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, VOTO_BLANCO))
        .to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, VOTER_HASH, VOTO_BLANCO, false);

      expect(await registry.getTally(ELECTION_ID, VOTO_BLANCO)).to.equal(1n);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(0n);
    });

    it("emits VoteCast for VOTO_NULO and increments its tally", async () => {
      const otherHash =
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      await expect(registry.connect(ballotRole).recordVote(ELECTION_ID, otherHash, VOTO_NULO))
        .to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, otherHash, VOTO_NULO, false);

      expect(await registry.getTally(ELECTION_ID, VOTO_NULO)).to.equal(1n);
    });
  });

  describe("overwrite flag and atomic tally updates", () => {
    it("emits isOverwrite=true and adjusts tallies when candidate changes", async () => {
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A);

      await expect(registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_B))
        .to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, VOTER_HASH, CANDIDATE_B, true);

      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(0n);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_B)).to.equal(1n);
    });

    it("keeps tallies stable when overwriting with the same candidateId", async () => {
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A);

      await expect(registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A))
        .to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, VOTER_HASH, CANDIDATE_A, true);

      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(1n);
    });
  });

  describe("access control and pause", () => {
    it("reverts when caller lacks BALLOT_ROLE", async () => {
      await expect(
        registry.connect(stranger).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("reverts when paused", async () => {
      await registry.connect(admin).grantRole(await registry.PAUSER_ROLE(), admin.address);
      await registry.connect(admin).pause();

      await expect(
        registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A),
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");
    });
  });

  describe("UAT-02: event filter matches on-chain tallies", () => {
    it("sums VoteCast events by electionId to match getTally", async () => {
      const hash2 =
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
      const hash3 =
        "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A);
      await registry.connect(ballotRole).recordVote(ELECTION_ID, hash2, CANDIDATE_A);
      await registry.connect(ballotRole).recordVote(ELECTION_ID, hash3, VOTO_BLANCO);
      // overwrite one vote away from A
      await registry.connect(ballotRole).recordVote(ELECTION_ID, hash2, CANDIDATE_B);

      const filter = registry.filters.VoteCast(ELECTION_ID);
      const events = await registry.queryFilter(filter);

      const counts = new Map<bigint, number>();
      const lastByVoter = new Map<string, bigint>();
      for (const ev of events) {
        lastByVoter.set(ev.args.voterHash, ev.args.candidateId);
      }
      for (const candidateId of lastByVoter.values()) {
        counts.set(candidateId, (counts.get(candidateId) ?? 0) + 1);
      }

      expect(counts.get(CANDIDATE_A)).to.equal(1);
      expect(counts.get(CANDIDATE_B)).to.equal(1);
      expect(counts.get(VOTO_BLANCO)).to.equal(1);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(1n);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_B)).to.equal(1n);
      expect(await registry.getTally(ELECTION_ID, VOTO_BLANCO)).to.equal(1n);
    });
  });
});
