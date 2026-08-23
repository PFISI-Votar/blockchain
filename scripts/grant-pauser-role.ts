import { ethers } from "hardhat";

/**
 * VOTAR-347 — grants PAUSER_ROLE to the backend's operational wallet
 * (PAUSER_OPERATOR_ADDRESS) on already-deployed election contracts.
 *
 * Only needed for elections created BEFORE this feature shipped: any election
 * created by ElectionFactory.createElection() after VOTAR-347 already receives
 * PAUSER_ROLE automatically. The signer running this script must hold
 * DEFAULT_ADMIN_ROLE on the target contracts (the Multisig/Governor `admin`).
 *
 * Env:
 *   PAUSER_OPERATOR_ADDRESS — required
 *   BALLOT_CONTRACT_ADDRESS, VOTE_REGISTRY_ADDRESS — at least one required
 */
async function main() {
  const target = process.env.PAUSER_OPERATOR_ADDRESS;
  if (!target) {
    throw new Error("Set PAUSER_OPERATOR_ADDRESS env var");
  }

  const targets = [
    { name: "BallotContract", address: process.env.BALLOT_CONTRACT_ADDRESS },
    { name: "VoteRegistry", address: process.env.VOTE_REGISTRY_ADDRESS },
  ].filter(
    (t): t is { name: string; address: string } => Boolean(t.address),
  );

  if (targets.length === 0) {
    throw new Error(
      "Set at least one of BALLOT_CONTRACT_ADDRESS / VOTE_REGISTRY_ADDRESS env vars",
    );
  }

  for (const { name, address } of targets) {
    const contract = await ethers.getContractAt(name, address);
    const role = await contract.PAUSER_ROLE();
    const has = await contract.hasRole(role, target);
    if (has) {
      console.log(`[grant-pauser-role] ${name} already has PAUSER_ROLE for ${target}`);
      continue;
    }
    const tx = await contract.grantRole(role, target);
    console.log(`[grant-pauser-role] granting PAUSER_ROLE on ${name} to ${target} — tx ${tx.hash}`);
    await tx.wait();
    console.log(`[grant-pauser-role] PAUSER_ROLE granted on ${name}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
