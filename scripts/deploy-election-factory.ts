import { createHash } from "node:crypto";
import { ethers, network } from "hardhat";
import { verifyContractSource } from "./lib/verify-contract";
import { writeElectionFactoryArtifact } from "./lib/write-deployment-artifact";
import { exportAbisToConsumers } from "./lib/export-abis";

/**
 * VOTAR-337 — Deploys ElectionFactory, optionally verifies on Etherscan, and
 * exports address + ABI for NestJS PostgreSQL sync.
 *
 * Required env (Sepolia):
 *   SEPOLIA_RPC_URL, PRIVATE_KEY, ADMIN_MULTISIG_ADDRESS, MERKLE_ROOT_STORE_ADDRESS,
 *   PAUSER_OPERATOR_ADDRESS
 * Optional:
 *   ETHERSCAN_API_KEY — enables automatic source verification
 *   SKIP_VERIFY=true — skip verification even if API key is set
 *
 * For full-stack Sepolia automation (gas retries + catalog + ABI export), prefer:
 *   npm run deploy:sepolia:stack
 */
async function main() {
  let admin = process.env.ADMIN_MULTISIG_ADDRESS;
  let merkleRootStoreAddress = process.env.MERKLE_ROOT_STORE_ADDRESS;

  if (!admin) {
    if (network.name === "hardhat" || network.name === "localhost") {
      admin = (await ethers.getSigners())[0].address;
      console.warn(
        `[deploy] ADMIN_MULTISIG_ADDRESS not set — using local signer ${admin}`,
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
    if (network.name === "hardhat" || network.name === "localhost") {
      const storeFactory = await ethers.getContractFactory("MerkleRootStore");
      const store = await storeFactory.deploy(admin);
      await store.waitForDeployment();
      merkleRootStoreAddress = await store.getAddress();
      console.warn(
        `[deploy] MERKLE_ROOT_STORE_ADDRESS not set — deployed MerkleRootStore at ${merkleRootStoreAddress}`,
      );
    } else {
      throw new Error(
        "MERKLE_ROOT_STORE_ADDRESS is required for Sepolia (shared store from US-335).",
      );
    }
  }

  let pauserOperator = process.env.PAUSER_OPERATOR_ADDRESS;
  if (!pauserOperator) {
    if (network.name === "hardhat" || network.name === "localhost") {
      pauserOperator = (await ethers.getSigners())[0].address;
      console.warn(
        `[deploy] PAUSER_OPERATOR_ADDRESS not set — using local signer ${pauserOperator}`,
      );
    } else {
      throw new Error(
        "PAUSER_OPERATOR_ADDRESS is required: PAUSER_ROLE (VOTAR-347) must go to the backend's operational wallet.",
      );
    }
  }

  if (!ethers.isAddress(pauserOperator)) {
    throw new Error(`PAUSER_OPERATOR_ADDRESS is not a valid address: ${pauserOperator}`);
  }

  const factoryFactory = await ethers.getContractFactory("ElectionFactory");
  const contract = await factoryFactory.deploy(admin, merkleRootStoreAddress, pauserOperator);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const deployTx = contract.deploymentTransaction();
  const receipt = deployTx ? await deployTx.wait() : null;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log(`[deploy] ElectionFactory deployed at: ${address}`);
  console.log(`[deploy] MerkleRootStore:             ${merkleRootStoreAddress}`);
  console.log(`[deploy] DEFAULT_ADMIN_ROLE:          ${admin}`);
  console.log(`[deploy] PAUSER_ROLE operator:        ${pauserOperator}`);
  console.log(`[deploy] network:                     ${network.name} (chainId=${chainId})`);
  if (receipt?.hash) {
    console.log(`[deploy] tx:                          ${receipt.hash}`);
  }

  const verified = await verifyContractSource({
    address,
    constructorArguments: [admin, merkleRootStoreAddress, pauserOperator],
    networkName: network.name,
  });

  const artifact = await ethers.getContractFactory("ElectionFactory");
  const fullAbi = JSON.parse(artifact.interface.formatJson()) as unknown[];

  const abiHash = `0x${createHash("sha256")
    .update(JSON.stringify(fullAbi))
    .digest("hex")}`;

  const artifactPath = writeElectionFactoryArtifact({
    contractName: "ElectionFactory",
    network: network.name,
    chainId,
    address,
    abi: fullAbi,
    abiHash,
    txHash: receipt?.hash ?? null,
    blockNumber: receipt?.blockNumber ?? null,
    admin,
    merkleRootStore: merkleRootStoreAddress,
    pauserOperator,
    verified,
    deployedAt: new Date().toISOString(),
  });

  console.log(`[deploy] Artifact written to ${artifactPath}`);

  await exportAbisToConsumers(["ElectionFactory"]);

  console.log(
    `[deploy] Sync into NestJS DB with: npm run sync:election-factory (from back/)`,
  );
  console.log(`[deploy] Set ELECTION_FACTORY_ADDRESS=${address} in backend .env`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
