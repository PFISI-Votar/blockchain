import { ethers } from "hardhat";

/**
 * Deploys VoteRegistry standalone (admin receives DEFAULT_ADMIN_ROLE).
 */
async function main() {
  let admin = process.env.ADMIN_MULTISIG_ADDRESS;

  if (!admin) {
    admin = (await ethers.getSigners())[0].address;
    console.warn(
      `[deploy] ADMIN_MULTISIG_ADDRESS not set — using local signer ${admin}`,
    );
  }

  if (!ethers.isAddress(admin)) {
    throw new Error(`ADMIN_MULTISIG_ADDRESS is not a valid address: ${admin}`);
  }

  const factory = await ethers.getContractFactory("VoteRegistry");
  const contract = await factory.deploy(admin);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`[deploy] VoteRegistry deployed at: ${address}`);
  console.log(`[deploy] DEFAULT_ADMIN_ROLE granted to: ${admin}`);
  console.log(`[deploy] Set VOTE_REGISTRY_ADDRESS=${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
