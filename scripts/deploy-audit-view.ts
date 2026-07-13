import { ethers } from "hardhat";

/**
 * Deploys AuditViewContract against existing MerkleRootStore + VoteRegistry.
 * Env: MERKLE_ROOT_STORE_ADDRESS, VOTE_REGISTRY_ADDRESS
 */
async function main() {
  const merkleRootStore = process.env.MERKLE_ROOT_STORE_ADDRESS;
  const voteRegistry = process.env.VOTE_REGISTRY_ADDRESS;

  if (!merkleRootStore || !ethers.isAddress(merkleRootStore)) {
    throw new Error(
      `MERKLE_ROOT_STORE_ADDRESS is missing or invalid: ${merkleRootStore}`,
    );
  }
  if (!voteRegistry || !ethers.isAddress(voteRegistry)) {
    throw new Error(`VOTE_REGISTRY_ADDRESS is missing or invalid: ${voteRegistry}`);
  }

  const factory = await ethers.getContractFactory("AuditViewContract");
  const contract = await factory.deploy(merkleRootStore, voteRegistry);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`[deploy] AuditViewContract deployed at: ${address}`);
  console.log(`[deploy] merkleRootStore: ${merkleRootStore}`);
  console.log(`[deploy] voteRegistry:    ${voteRegistry}`);
  console.log(`[deploy] Set AUDIT_VIEW_ADDRESS=${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
