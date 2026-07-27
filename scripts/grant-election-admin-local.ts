import { ethers } from "hardhat";

async function main() {
  const storeAddress = process.env.MERKLE_ROOT_STORE_ADDRESS;
  if (!storeAddress) {
    throw new Error("MERKLE_ROOT_STORE_ADDRESS is required");
  }

  const [admin] = await ethers.getSigners();
  const store = await ethers.getContractAt("MerkleRootStore", storeAddress);
  const role = await store.ELECTION_ADMIN_ROLE();
  const hasRole = await store.hasRole(role, admin.address);

  if (hasRole) {
    console.log(`[grant-election-admin] ${admin.address} already has ELECTION_ADMIN_ROLE`);
    return;
  }

  const tx = await store.connect(admin).grantRole(role, admin.address);
  await tx.wait();
  console.log(`[grant-election-admin] granted ELECTION_ADMIN_ROLE to ${admin.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
