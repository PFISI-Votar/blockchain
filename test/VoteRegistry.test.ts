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
    // Overwrite UATs require revote enabled (LAST_VOTE_WINS path / VOTAR-344).
    const registry = await registryFactory.deploy(admin.address, true);
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
      expect(await registry.revoteEnabled()).to.equal(true);
      await expect(registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A))
        .to.emit(registry, "VoteUpdated")
        .withArgs(ELECTION_ID, VOTER_HASH, await registry.SIN_VOTO_PREVIO(), CANDIDATE_A);

      await expect(registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_B))
        .to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, VOTER_HASH, CANDIDATE_B, true)
        .and.to.emit(registry, "VoteUpdated")
        .withArgs(ELECTION_ID, VOTER_HASH, CANDIDATE_A, CANDIDATE_B);

      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(0n);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_B)).to.equal(1n);
    });

    it("keeps tallies stable when overwriting with the same candidateId", async () => {
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A);

      await expect(registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A))
        .to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, VOTER_HASH, CANDIDATE_A, true)
        .and.to.emit(registry, "VoteUpdated")
        .withArgs(ELECTION_ID, VOTER_HASH, CANDIDATE_A, CANDIDATE_A);

      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(1n);
    });
  });

  describe("VOTAR-326: política LAST_WINS — VoteUpdated y protección de underflow", () => {
    it("UAT-01 — tres votos secuenciales del mismo votante emiten 3 VoteUpdated y solo el último cuenta", async () => {
      await expect(registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A))
        .to.emit(registry, "VoteUpdated")
        .withArgs(ELECTION_ID, VOTER_HASH, await registry.SIN_VOTO_PREVIO(), CANDIDATE_A);

      const CANDIDATE_C = 303n;
      await expect(registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_B))
        .to.emit(registry, "VoteUpdated")
        .withArgs(ELECTION_ID, VOTER_HASH, CANDIDATE_A, CANDIDATE_B);
      await expect(registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_C))
        .to.emit(registry, "VoteUpdated")
        .withArgs(ELECTION_ID, VOTER_HASH, CANDIDATE_B, CANDIDATE_C);

      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(0n);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_B)).to.equal(0n);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_C)).to.equal(1n);

      const [totalVotes] = await registry.getParticipationStats(ELECTION_ID);
      expect(totalVotes).to.equal(1n);
    });

    it("UAT-02 — sumando incrementos/decrementos de VoteUpdated se reconstruye getTally exactamente", async () => {
      const hash2 =
        "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      const CANDIDATE_C = 303n;

      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A);
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_B);
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_C);
      await registry.connect(ballotRole).recordVote(ELECTION_ID, hash2, CANDIDATE_A);

      const sinVotoPrevio = await registry.SIN_VOTO_PREVIO();
      const filter = registry.filters.VoteUpdated(ELECTION_ID);
      const events = await registry.queryFilter(filter);

      const reconstructed = new Map<bigint, bigint>();
      const bump = (candidateId: bigint, delta: bigint) =>
        reconstructed.set(candidateId, (reconstructed.get(candidateId) ?? 0n) + delta);

      for (const ev of events) {
        const { oldCandidate, newCandidate } = ev.args;
        if (oldCandidate !== sinVotoPrevio) bump(oldCandidate, -1n);
        bump(newCandidate, 1n);
      }

      for (const candidateId of [CANDIDATE_A, CANDIDATE_B, CANDIDATE_C]) {
        expect(reconstructed.get(candidateId) ?? 0n).to.equal(
          await registry.getTally(ELECTION_ID, candidateId),
        );
      }
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(1n);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_B)).to.equal(0n);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_C)).to.equal(1n);
    });

    it("UAT-03 — revierte con TallyUnderflow en vez de envolver el contador a un valor negativo", async () => {
      // El flujo público de recordVote nunca deja hasVoted=true con tally[candidateId]=0
      // (la primera vez que hasVoted pasa a true, el tally del mismo candidato ya se
      // incrementó). Para probar el guard de seguridad ante una inconsistencia de
      // estado (el escenario que UAT-03 pide inyectar), se fuerza esa combinación
      // inválida directamente en storage.
      // Slot 0: AccessControl._roles, slot 1: Pausable._paused (heredados vía
      // VotarAccessControl, que no agrega storage propio) — `_votes` es la primera
      // variable de storage declarada en VoteRegistry, slot 2.
      const votesSlot = 2n;
      const electionSlot = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [ELECTION_ID, votesSlot]),
      );
      const voterStateSlot = BigInt(
        ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [VOTER_HASH, electionSlot]),
        ),
      );
      // VoterState { uint256 candidateId; bool hasVoted; } -> 2 slots.
      const candidateIdSlot = ethers.toBeHex(voterStateSlot, 32);
      const hasVotedSlot = ethers.toBeHex(voterStateSlot + 1n, 32);

      await ethers.provider.send("hardhat_setStorageAt", [
        await registry.getAddress(),
        candidateIdSlot,
        ethers.toBeHex(CANDIDATE_A, 32),
      ]);
      await ethers.provider.send("hardhat_setStorageAt", [
        await registry.getAddress(),
        hasVotedSlot,
        ethers.toBeHex(1, 32),
      ]);

      // Invariante forzada: hasVoted=true pero getTally(CANDIDATE_A) sigue en 0.
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(0n);
      const [, hasVoted] = await registry.getVoterState(ELECTION_ID, VOTER_HASH);
      expect(hasVoted).to.equal(true);

      await expect(
        registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_B),
      )
        .to.be.revertedWithCustomError(registry, "TallyUnderflow")
        .withArgs(ELECTION_ID, CANDIDATE_A);

      // La transacción revertida no debe haber tocado ningún contador.
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(0n);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_B)).to.equal(0n);
    });
  });

  describe("VOTAR-341: RevoteDisabled when revote is off", () => {
    it("reverts RevoteDisabled on second recordVote for the same nullifier", async () => {
      const [adminSigner, ballotSigner] = await ethers.getSigners();
      const factory = await ethers.getContractFactory("VoteRegistry");
      const disabledRegistry = await factory.deploy(adminSigner.address, false);
      await disabledRegistry.waitForDeployment();
      await disabledRegistry
        .connect(adminSigner)
        .grantRole(await disabledRegistry.BALLOT_ROLE(), ballotSigner.address);

      await disabledRegistry
        .connect(ballotSigner)
        .recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A);

      await expect(
        disabledRegistry.connect(ballotSigner).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_B),
      ).to.be.revertedWithCustomError(disabledRegistry, "RevoteDisabled");

      expect(await disabledRegistry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(1n);
      expect(await disabledRegistry.getTally(ELECTION_ID, CANDIDATE_B)).to.equal(0n);
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

    it("keeps VOTAR-350 view helpers readable while paused", async () => {
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A);
      await registry.connect(admin).grantRole(await registry.PAUSER_ROLE(), admin.address);
      await registry.connect(admin).pause();

      const [totalVotes, blankVotes, nullVotes] =
        await registry.getParticipationStats(ELECTION_ID);
      expect(totalVotes).to.equal(1n);
      expect(blankVotes).to.equal(0n);
      expect(nullVotes).to.equal(0n);
      expect(await registry.getVotesByCandidate(ELECTION_ID, CANDIDATE_A)).to.equal(1n);
      expect(await registry.verifyReceipt(VOTER_HASH)).to.equal(true);
    });
  });

  describe("VOTAR-350 participation and receipt views", () => {
    it("aggregates total/blank/null and verifies receipt inclusion", async () => {
      const hash2 =
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A);
      await registry.connect(ballotRole).recordVote(ELECTION_ID, hash2, VOTO_BLANCO);

      let [totalVotes, blankVotes, nullVotes] =
        await registry.getParticipationStats(ELECTION_ID);
      expect(totalVotes).to.equal(2n);
      expect(blankVotes).to.equal(1n);
      expect(nullVotes).to.equal(0n);
      expect(await registry.verifyReceipt(VOTER_HASH)).to.equal(true);
      expect(await registry.verifyReceipt(hash2)).to.equal(true);

      await registry.connect(ballotRole).recordVote(ELECTION_ID, hash2, VOTO_NULO);
      [totalVotes, blankVotes, nullVotes] =
        await registry.getParticipationStats(ELECTION_ID);
      expect(totalVotes).to.equal(2n);
      expect(blankVotes).to.equal(0n);
      expect(nullVotes).to.equal(1n);
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
