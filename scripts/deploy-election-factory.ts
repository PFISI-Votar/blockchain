import { createHash } from "node:crypto";
import { ethers, network, run } from "hardhat";
import { writeElectionFactoryArtifact } from "./lib/write-deployment-artifact";

/**
 * VOTAR-337 — Deploys ElectionFactory, optionally verifies on Etherscan, and
 * exports address + ABI for NestJS PostgreSQL sync.
 *
 * Required env (Sepolia):
 *   SEPOLIA_RPC_URL, PRIVATE_KEY, ADMIN_MULTISIG_ADDRESS, MERKLE_ROOT_STORE_ADDRESS
 * Optional:
 *   ETHERSCAN_API_KEY — enables automatic source verification
 *   SKIP_VERIFY=true — skip verification even if API key is set
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

  const factoryFactory = await ethers.getContractFactory("ElectionFactory");
  const contract = await factoryFactory.deploy(admin, merkleRootStoreAddress);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const deployTx = contract.deploymentTransaction();
  const receipt = deployTx ? await deployTx.wait() : null;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log(`[deploy] ElectionFactory deployed at: ${address}`);
  console.log(`[deploy] MerkleRootStore:             ${merkleRootStoreAddress}`);
  console.log(`[deploy] DEFAULT_ADMIN_ROLE:          ${admin}`);
  console.log(`[deploy] network:                     ${network.name} (chainId=${chainId})`);
  if (receipt?.hash) {
    console.log(`[deploy] tx:                          ${receipt.hash}`);
  }

  let verified = false;
  const skipVerify = process.env.SKIP_VERIFY === "true";
  const etherscanApiKey = process.env.ETHERSCAN_API_KEY?.trim();

  if (!skipVerify && etherscanApiKey && network.name === "sepolia") {
    console.log("[deploy] Waiting for Etherscan indexing before verify...");
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    try {
      await run("verify:verify", {
        address,
        constructorArguments: [admin, merkleRootStoreAddress],
      });
      verified = true;
      console.log("[deploy] Source verified on Etherscan");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("already verified")) {
        verified = true;
        console.log("[deploy] Source already verified on Etherscan");
      } else {
        console.error(`[deploy] Etherscan verification failed: ${message}`);
        console.error(
          "[deploy] Re-run with: npx hardhat verify --network sepolia",
          address,
          admin,
          merkleRootStoreAddress,
        );
      }
    }
  } else if (network.name === "sepolia" && !etherscanApiKey) {
    console.warn(
      "[deploy] ETHERSCAN_API_KEY not set — skipping automatic verification",
    );
  }

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
    verified,
    deployedAt: new Date().toISOString(),
  });

  console.log(`[deploy] Artifact written to ${artifactPath}`);
  console.log(
    `[deploy] Sync into NestJS DB with: npm run sync:election-factory (from back/)`,
  );
  console.log(`[deploy] Set ELECTION_FACTORY_ADDRESS=${address} in backend .env`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
