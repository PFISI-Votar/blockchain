import { ethers, network } from "hardhat";

/**
 * Deploys BallotContract wired to MerkleRootStore + VoteRegistry.
 */
async function main() {
  let admin = process.env.ADMIN_MULTISIG_ADDRESS;
  let merkleRootStoreAddress = process.env.MERKLE_ROOT_STORE_ADDRESS;
  let voteRegistryAddress = process.env.VOTE_REGISTRY_ADDRESS;

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

  if (!merkleRootStoreAddress || !ethers.isAddress(merkleRootStoreAddress)) {
    if (network.name === "hardhat") {
      const storeFactory = await ethers.getContractFactory("MerkleRootStore");
      const store = await storeFactory.deploy(admin);
      await store.waitForDeployment();
      merkleRootStoreAddress = await store.getAddress();
      console.warn(
        `[deploy] MERKLE_ROOT_STORE_ADDRESS not set — deployed MerkleRootStore at ${merkleRootStoreAddress}`,
      );
    } else {
      throw new Error(
        "MERKLE_ROOT_STORE_ADDRESS is required for non-local deployments.",
      );
    }
  }

  if (!voteRegistryAddress || !ethers.isAddress(voteRegistryAddress)) {
    const registryFactory = await ethers.getContractFactory("VoteRegistry");
    const registry = await registryFactory.deploy(admin);
    await registry.waitForDeployment();
    voteRegistryAddress = await registry.getAddress();
    console.log(`[deploy] VoteRegistry deployed at: ${voteRegistryAddress}`);
  }

  const factory = await ethers.getContractFactory("BallotContract");
  const contract = await factory.deploy(
    admin,
    merkleRootStoreAddress,
    voteRegistryAddress,
  );
  await contract.waitForDeployment();

  const address = await contract.getAddress();

  const registry = await ethers.getContractAt("VoteRegistry", voteRegistryAddress);
  const ballotRole = await registry.BALLOT_ROLE();
  const hasBallotRole = await registry.hasRole(ballotRole, address);
  if (!hasBallotRole) {
    const grantTx = await registry.grantRole(ballotRole, address);
    await grantTx.wait();
    console.log(`[deploy] Granted BALLOT_ROLE on VoteRegistry to ${address}`);
  }

  console.log(`[deploy] BallotContract deployed at: ${address}`);
  console.log(`[deploy] MerkleRootStore:            ${merkleRootStoreAddress}`);
  console.log(`[deploy] VoteRegistry:               ${voteRegistryAddress}`);
  console.log(`[deploy] DEFAULT_ADMIN_ROLE granted to: ${admin}`);
  console.log(`[deploy] Set BALLOT_CONTRACT_ADDRESS=${address} in backend .env`);
  console.log(`[deploy] Set VOTE_REGISTRY_ADDRESS=${voteRegistryAddress} in backend .env`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
