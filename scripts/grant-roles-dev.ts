import { ethers } from "hardhat";

async function main() {
  const merkleRootStoreAddress = process.env.MERKLE_ROOT_STORE_ADDRESS;
  const target = process.env.GRANT_TARGET;
  if (!merkleRootStoreAddress || !target) {
    throw new Error("Set MERKLE_ROOT_STORE_ADDRESS and GRANT_TARGET env vars");
  }

  const store = await ethers.getContractAt("MerkleRootStore", merkleRootStoreAddress);

  const roles = ["MERKLE_UPDATER_ROLE", "ELECTION_ADMIN_ROLE"] as const;
  for (const roleName of roles) {
    const role = await store[roleName]();
    const has = await store.hasRole(role, target);
    if (has) {
      console.log(`[grant-roles] ${roleName} already granted to ${target}`);
      continue;
    }
    const tx = await store.grantRole(role, target);
    console.log(`[grant-roles] granting ${roleName} to ${target} — tx ${tx.hash}`);
    await tx.wait();
    console.log(`[grant-roles] ${roleName} granted`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
