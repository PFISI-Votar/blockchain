import { ethers } from "hardhat";

/**
 * VOTAR-350 — Local/Hardhat smoke for gas-free audit views (UAT-01..04).
 * Requires MERKLE_ROOT_STORE_ADDRESS, VOTE_REGISTRY_ADDRESS, AUDIT_VIEW_ADDRESS
 * (and a funded BALLOT_ROLE signer when seeding votes).
 *
 * Usage (after deploy-local):
 *   npx hardhat run scripts/uat-audit-views.ts --network localhost
 */
async function main() {
  const auditAddress = process.env.AUDIT_VIEW_ADDRESS;
  const registryAddress = process.env.VOTE_REGISTRY_ADDRESS;

  if (!auditAddress || !ethers.isAddress(auditAddress)) {
    throw new Error(`AUDIT_VIEW_ADDRESS is missing or invalid: ${auditAddress}`);
  }
  if (!registryAddress || !ethers.isAddress(registryAddress)) {
    throw new Error(`VOTE_REGISTRY_ADDRESS is missing or invalid: ${registryAddress}`);
  }

  const [admin] = await ethers.getSigners();
  const emptyWallet = ethers.Wallet.createRandom().connect(ethers.provider);

  const auditView = await ethers.getContractAt("AuditViewContract", auditAddress);
  const registry = await ethers.getContractAt("VoteRegistry", registryAddress);

  const electionId = 350n;
  const receiptHash = ethers.id("votar-350-uat-receipt");
  const unknownCandidate = 999_999n;
  const candidateId = 101n;

  const pass = (label: string) => console.log(`✔ ${label}`);

  // Seed one vote if registry accepts admin as BALLOT_ROLE (local deploys grant ballot).
  const ballotRole = await registry.BALLOT_ROLE();
  if (await registry.hasRole(ballotRole, admin.address)) {
    const [, hasVoted] = await registry.getVoterState(electionId, receiptHash);
    if (!hasVoted) {
      await (await registry.connect(admin).recordVote(electionId, receiptHash, candidateId)).wait();
    }
  }

  // UAT-01 — empty wallet static call
  const balanceBefore = await ethers.provider.getBalance(emptyWallet.address);
  const stats = await auditView.connect(emptyWallet).getParticipationStats.staticCall(electionId);
  const balanceAfter = await ethers.provider.getBalance(emptyWallet.address);
  if (balanceAfter !== balanceBefore) {
    throw new Error("UAT-01 failed: empty wallet balance changed");
  }
  pass(`UAT-01: getParticipationStats from empty wallet → total=${stats[0]} blank=${stats[1]} null=${stats[2]}`);

  // UAT-02 — receipt verification
  const included = await auditView.verifyReceipt(receiptHash);
  if (!included) {
    throw new Error("UAT-02 failed: expected receipt to be included (seed a vote first)");
  }
  pass(`UAT-02: verifyReceipt(${receiptHash}) = true`);

  // UAT-03 — unknown candidate
  const unknownVotes = await auditView.getVotesByCandidate(electionId, unknownCandidate);
  if (unknownVotes !== 0n) {
    throw new Error(`UAT-03 failed: expected 0, got ${unknownVotes}`);
  }
  pass("UAT-03: getVotesByCandidate(unknown) = 0");

  // UAT-04 — pause does not block reads
  const pauserRole = await registry.PAUSER_ROLE();
  if (!(await registry.hasRole(pauserRole, admin.address))) {
    await (await registry.connect(admin).grantRole(pauserRole, admin.address)).wait();
  }
  const wasPaused = await registry.paused();
  if (!wasPaused) {
    await (await registry.connect(admin).pause()).wait();
  }
  const state = await auditView.getElectionState(electionId);
  const votes = await auditView.getVotesByCandidate(electionId, candidateId);
  if (!wasPaused) {
    await (await registry.connect(admin).unpause()).wait();
  }
  pass(`UAT-04: reads while paused ok (state=${state}, votes(A)=${votes})`);

  console.log("\nAll VOTAR-350 UATs passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
