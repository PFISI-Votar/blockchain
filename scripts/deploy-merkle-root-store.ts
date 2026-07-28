import { ethers, network } from "hardhat";

/**
 * Deploys MerkleRootStore and assigns DEFAULT_ADMIN_ROLE to the Multisig/Governor.
 */
async function main() {
  let admin = process.env.ADMIN_MULTISIG_ADDRESS;

  if (!admin) {
    if (network.name === "hardhat") {
      admin = (await ethers.getSigners())[0].address;
      console.warn(
        `[deploy] ADMIN_MULTISIG_ADDRESS not set — using local signer ${admin} (hardhat network only)`,
      );
    } else {
      throw new Error(
        "ADMIN_MULTISIG_ADDRESS is required: DEFAULT_ADMIN_ROLE must go to the Multisig/Governor.",
      );
    }
  }

  if (!ethers.isAddress(admin)) {
    throw new Error(`ADMIN_MULTISIG_ADDRESS is not a valid address: ${admin}`);
  }

  const factory = await ethers.getContractFactory("MerkleRootStore");
  const contract = await factory.deploy(admin);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`[deploy] MerkleRootStore deployed at: ${address}`);
  console.log(`[deploy] DEFAULT_ADMIN_ROLE granted to:    ${admin}`);
  console.log(`[deploy] Set MERKLE_ROOT_STORE_ADDRESS=${address} in backend .env`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
