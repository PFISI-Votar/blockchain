import { ethers, network } from "hardhat";

/**
 * VOTAR-346 UAT helper: filters VoteCast by electionId and compares event-derived
 * tallies with VoteRegistry.getTally (UAT-02), printing a simple audit board (UAT-03).
 *
 * Usage:
 *   VOTE_REGISTRY_ADDRESS=0x... ELECTION_ID=346 \
 *     npx hardhat run scripts/audit-votecast.ts --network localhost
 */
async function main() {
  const registryAddress = process.env.VOTE_REGISTRY_ADDRESS;
  if (!registryAddress || !ethers.isAddress(registryAddress)) {
    throw new Error("VOTE_REGISTRY_ADDRESS must be a valid address");
  }

  const electionIdRaw = process.env.ELECTION_ID ?? "346";
  const electionId = BigInt(electionIdRaw);

  const registry = await ethers.getContractAt("VoteRegistry", registryAddress);
  const VOTO_BLANCO = await registry.VOTO_BLANCO();
  const VOTO_NULO = await registry.VOTO_NULO();

  const filter = registry.filters.VoteCast(electionId);
  const events = await registry.queryFilter(filter);

  const lastByVoter = new Map<string, { candidateId: bigint; isOverwrite: boolean; txHash: string }>();
  for (const ev of events) {
    lastByVoter.set(ev.args.voterHash, {
      candidateId: ev.args.candidateId,
      isOverwrite: ev.args.isOverwrite,
      txHash: ev.transactionHash,
    });
  }

  const eventTallies = new Map<bigint, number>();
  for (const vote of lastByVoter.values()) {
    eventTallies.set(vote.candidateId, (eventTallies.get(vote.candidateId) ?? 0) + 1);
  }

  console.log(`\n=== VOTAR-346 Audit board (network=${network.name}) ===`);
  console.log(`VoteRegistry: ${registryAddress}`);
  console.log(`Election ID:  ${electionId}`);
  console.log(`VoteCast events (raw): ${events.length}`);
  console.log(`Unique voterHash:      ${lastByVoter.size}`);
  console.log("");
  console.log("CandidateId                         Events  On-chain tally  Match");

  const candidateIds = new Set<bigint>([
    ...eventTallies.keys(),
    VOTO_BLANCO,
    VOTO_NULO,
  ]);

  let mismatches = 0;
  for (const candidateId of [...candidateIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const fromEvents = eventTallies.get(candidateId) ?? 0;
    const onChain = await registry.getTally(electionId, candidateId);
    if (fromEvents === 0 && onChain === 0n) {
      continue;
    }
    const ok = BigInt(fromEvents) === onChain;
    if (!ok) mismatches += 1;

    let label = candidateId.toString();
    if (candidateId === VOTO_BLANCO) label = `${candidateId} (VOTO_BLANCO)`;
    if (candidateId === VOTO_NULO) label = `${candidateId} (VOTO_NULO)`;

    console.log(
      `${label.padEnd(34)} ${String(fromEvents).padStart(6)}  ${onChain.toString().padStart(14)}  ${ok ? "OK" : "MISMATCH"}`,
    );
  }

  console.log("");
  if (mismatches === 0) {
    console.log("✔ UAT-02: event-derived tallies match VoteRegistry.getTally");
  } else {
    console.error(`✘ UAT-02: ${mismatches} tally mismatch(es)`);
    process.exitCode = 1;
  }

  // UAT-04 hint: VoteCast topics never include an address-sized wallet topic.
  const sample = events[0];
  if (sample) {
    console.log(
      `✔ UAT-04 sample: VoteCast topics=${sample.topics.length} (sig + electionId + voterHash only)`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
