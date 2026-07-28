import { ethers, network } from "hardhat";

/**
 * Deploys the RBAC base (via the AccessControlHarness concrete contract) and
 * assigns DEFAULT_ADMIN_ROLE to the Multisig/Governor address.
 *
 * On any network other than the in-process `hardhat` net, ADMIN_MULTISIG_ADDRESS
 * is required so admin rights are never silently handed to the deployer EOA.
 */
async function main() {
  let admin = process.env.ADMIN_MULTISIG_ADDRESS;

  if (!admin) {
    if (network.name === "hardhat") {
      // Local dry-run: fall back to the first signer.
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

  const factory = await ethers.getContractFactory("AccessControlHarness");
  const contract = await factory.deploy(admin);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`[deploy] AccessControlHarness deployed at: ${address}`);
  console.log(`[deploy] DEFAULT_ADMIN_ROLE granted to:    ${admin}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
