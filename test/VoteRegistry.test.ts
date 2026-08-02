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
    await registry.connect(admin).grantRole(await registry.ELECTION_ADMIN_ROLE(), admin.address);

    const VOTO_BLANCO = await registry.VOTO_BLANCO();
    const VOTO_NULO = await registry.VOTO_NULO();

    // VOTAR-345 — seal the candidate set (CANDIDATE_A/B/C) before any recordVote,
    // otherwise every recordVote below reverts with CandidateSetNotRegistered.
    await registry.connect(admin).registerCandidates(ELECTION_ID, [101n, 202n, 303n]);

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
        .connect(adminSigner)
        .grantRole(await disabledRegistry.ELECTION_ADMIN_ROLE(), adminSigner.address);
      await disabledRegistry.connect(adminSigner).registerCandidates(ELECTION_ID, [CANDIDATE_A, CANDIDATE_B]);

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

  describe("VOTAR-345 — IDs reservados y sellado del set de candidatos", () => {
    it("UAT-01 — voto en blanco incrementa solo el contador de blancos", async () => {
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, VOTO_BLANCO);

      expect(await registry.getTally(ELECTION_ID, VOTO_BLANCO)).to.equal(1n);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(0n);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_B)).to.equal(0n);
    });

    it("UAT-02 — voto nulo incrementa solo el contador de nulos y no afecta votos válidos", async () => {
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A);
      const hash2 = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00";
      await registry.connect(ballotRole).recordVote(ELECTION_ID, hash2, VOTO_NULO);

      expect(await registry.getTally(ELECTION_ID, VOTO_NULO)).to.equal(1n);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(1n);
      const [totalVotes, , nullVotes] = await registry.getParticipationStats(ELECTION_ID);
      expect(totalVotes).to.equal(2n);
      expect(nullVotes).to.equal(1n);
    });

    it("UAT-03 — registerCandidates rechaza VOTO_BLANCO, VOTO_NULO y SIN_VOTO_PREVIO", async () => {
      const sinVotoPrevio = await registry.SIN_VOTO_PREVIO();
      const electionId2 = ELECTION_ID + 1n;

      await expect(
        registry.connect(admin).registerCandidates(electionId2, [VOTO_BLANCO]),
      )
        .to.be.revertedWithCustomError(registry, "ReservedCandidateId")
        .withArgs(VOTO_BLANCO);
      await expect(
        registry.connect(admin).registerCandidates(electionId2, [VOTO_NULO]),
      )
        .to.be.revertedWithCustomError(registry, "ReservedCandidateId")
        .withArgs(VOTO_NULO);
      await expect(
        registry.connect(admin).registerCandidates(electionId2, [sinVotoPrevio]),
      )
        .to.be.revertedWithCustomError(registry, "ReservedCandidateId")
        .withArgs(sinVotoPrevio);
    });

    it("UAT-03 — recordVote rechaza un id que no pertenece al set sellado", async () => {
      const unregisteredId = 999n;
      await expect(
        registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, unregisteredId),
      )
        .to.be.revertedWithCustomError(registry, "InvalidCandidateId")
        .withArgs(ELECTION_ID, unregisteredId);
    });

    it("UAT-03 — recordVote rechaza votos antes de sellar el set de la elección", async () => {
      const electionId2 = ELECTION_ID + 2n;
      await expect(
        registry.connect(ballotRole).recordVote(electionId2, VOTER_HASH, CANDIDATE_A),
      )
        .to.be.revertedWithCustomError(registry, "CandidateSetNotRegistered")
        .withArgs(electionId2);
    });

    it("UAT-03 — registerCandidates no puede llamarse dos veces para la misma elección", async () => {
      await expect(
        registry.connect(admin).registerCandidates(ELECTION_ID, [CANDIDATE_A]),
      )
        .to.be.revertedWithCustomError(registry, "CandidateSetSealed")
        .withArgs(ELECTION_ID);
    });

    it("UAT-03 — registerCandidates requiere ELECTION_ADMIN_ROLE", async () => {
      const electionId2 = ELECTION_ID + 3n;
      await expect(
        registry.connect(stranger).registerCandidates(electionId2, [CANDIDATE_A]),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("UAT-03 — registerCandidates rechaza un set vacío", async () => {
      const electionId2 = ELECTION_ID + 4n;
      await expect(
        registry.connect(admin).registerCandidates(electionId2, []),
      ).to.be.revertedWithCustomError(registry, "EmptyCandidateSet");
    });

    it("UAT-04 — re-voto candidato→blanco decrementa el candidato e incrementa blancos", async () => {
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A);
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, VOTO_BLANCO);

      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(0n);
      expect(await registry.getTally(ELECTION_ID, VOTO_BLANCO)).to.equal(1n);
      const [totalVotes] = await registry.getParticipationStats(ELECTION_ID);
      expect(totalVotes).to.equal(1n);
    });

    it("UAT-04 — re-voto blanco→candidato decrementa blancos e incrementa el candidato", async () => {
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, VOTO_BLANCO);
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A);

      expect(await registry.getTally(ELECTION_ID, VOTO_BLANCO)).to.equal(0n);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(1n);
    });

    it("UAT-04 — re-voto blanco→nulo se refleja en ambos contadores reservados", async () => {
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, VOTO_BLANCO);
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, VOTO_NULO);

      expect(await registry.getTally(ELECTION_ID, VOTO_BLANCO)).to.equal(0n);
      expect(await registry.getTally(ELECTION_ID, VOTO_NULO)).to.equal(1n);
      const [totalVotes] = await registry.getParticipationStats(ELECTION_ID);
      expect(totalVotes).to.equal(1n);
    });

    it("UAT-04 — el replay de VoteUpdated reconstruye tallies incluyendo blanco/nulo", async () => {
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, CANDIDATE_A);
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, VOTO_BLANCO);
      await registry.connect(ballotRole).recordVote(ELECTION_ID, VOTER_HASH, VOTO_NULO);

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

      for (const candidateId of [CANDIDATE_A, VOTO_BLANCO, VOTO_NULO]) {
        expect(reconstructed.get(candidateId) ?? 0n).to.equal(
          await registry.getTally(ELECTION_ID, candidateId),
        );
      }
    });

    it("expone isVotableCandidate e isCandidateSetSealed", async () => {
      expect(await registry.isCandidateSetSealed(ELECTION_ID)).to.equal(true);
      expect(await registry.isVotableCandidate(ELECTION_ID, CANDIDATE_A)).to.equal(true);
      expect(await registry.isVotableCandidate(ELECTION_ID, VOTO_BLANCO)).to.equal(true);
      expect(await registry.isVotableCandidate(ELECTION_ID, VOTO_NULO)).to.equal(true);
      expect(await registry.isVotableCandidate(ELECTION_ID, 999n)).to.equal(false);

      const unsealedElection = ELECTION_ID + 5n;
      expect(await registry.isCandidateSetSealed(unsealedElection)).to.equal(false);
    });
  });

  describe("VOTAR-344 — UAT-04: 5 re-votos concurrentes sin race conditions", () => {
    const CANDIDATE_C = 303n;

    it("los tallies finales reflejan exactamente las 5 transiciones aunque se envíen simultáneamente", async () => {
      const voters = Array.from({ length: 5 }, (_, i) =>
        ethers.keccak256(ethers.toUtf8Bytes(`uat04-voter-${i}`)),
      );

      // Voto inicial (secuencial, fuera del escenario bajo prueba): 3 votantes
      // por CANDIDATE_A y 2 por CANDIDATE_B.
      for (let i = 0; i < voters.length; i++) {
        await registry
          .connect(ballotRole)
          .recordVote(ELECTION_ID, voters[i], i < 3 ? CANDIDATE_A : CANDIDATE_B);
      }

      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(3n);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_B)).to.equal(2n);

      // Re-voto simultáneo: se desactiva el automine para que las 5 txs queden
      // encoladas en el mempool a la vez (nonces explícitos) y se minan juntas en
      // un único bloque, en vez de esperarse secuencialmente una a otra.
      // Los 3 votantes de A cambian a C, los 2 votantes de B cambian a A.
      const newChoices = [CANDIDATE_C, CANDIDATE_C, CANDIDATE_C, CANDIDATE_A, CANDIDATE_A];
      const startNonce = await ethers.provider.getTransactionCount(ballotRole.address);
      await ethers.provider.send("evm_setAutomine", [false]);
      try {
        await Promise.all(
          voters.map((voterHash, i) =>
            registry
              .connect(ballotRole)
              .recordVote(ELECTION_ID, voterHash, newChoices[i], { nonce: startNonce + i }),
          ),
        );
        await ethers.provider.send("evm_mine", []);
      } finally {
        await ethers.provider.send("evm_setAutomine", [true]);
      }

      expect(await registry.getTally(ELECTION_ID, CANDIDATE_A)).to.equal(2n);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_B)).to.equal(0n);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_C)).to.equal(3n);

      // Los re-votos (overwrites) no crean nuevos votantes únicos.
      const [totalVotes] = await registry.getParticipationStats(ELECTION_ID);
      expect(totalVotes).to.equal(5n);

      for (let i = 0; i < voters.length; i++) {
        const [candidateId, hasVoted] = await registry.getVoterState(ELECTION_ID, voters[i]);
        expect(hasVoted).to.equal(true);
        expect(candidateId).to.equal(newChoices[i]);
      }
    });
  });
});
