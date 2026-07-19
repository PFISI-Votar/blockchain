import { createHash } from "node:crypto";
import {
  ContractFactory,
  type BaseContract,
  type ContractTransactionResponse,
  type Signer,
} from "ethers";
import { ethers, network } from "hardhat";
import { formatGwei, resolveGasOverrides } from "./lib/gas";
import { exportAbisToConsumers } from "./lib/export-abis";
import { withRetry } from "./lib/retry";
import { verifyContractSource } from "./lib/verify-contract";
import {
  upsertDeploymentCatalog,
  writeDeploymentArtifact,
  writeElectionFactoryArtifact,
} from "./lib/write-deployment-artifact";

/**
 * VOTAR-385 — Reproducible Sepolia stack deploy with:
 * - fixed compiler settings (bytecode consistency)
 * - dynamic EIP-1559 gas + RPC retries (no orphaned deploys)
 * - automatic Etherscan verification
 * - artifact catalog + ABI export to NestJS / Vite
 *
 * Required env (Sepolia):
 *   SEPOLIA_RPC_URL, PRIVATE_KEY, ADMIN_MULTISIG_ADDRESS
 * Optional:
 *   MERKLE_ROOT_STORE_ADDRESS — reuse existing store (US-335)
 *   ETHERSCAN_API_KEY, SKIP_VERIFY
 *   DEPLOY_MAX_ATTEMPTS (default 5)
 *   GAS_BUMP_PERCENT (default 20)
 */

const COMPILER = {
  version: "0.8.26",
  optimizer: { enabled: true, runs: 200 },
  evmVersion: "cancun",
} as const;

const hashAbi = (abi: unknown[]): string =>
  `0x${createHash("sha256").update(JSON.stringify(abi)).digest("hex")}`;

const requireAdmin = async (): Promise<string> => {
  let admin = process.env.ADMIN_MULTISIG_ADDRESS;
  if (!admin) {
    if (network.name === "hardhat" || network.name === "localhost") {
      admin = (await ethers.getSigners())[0].address;
      console.warn(
        `[deploy-sepolia] ADMIN_MULTISIG_ADDRESS not set — using local signer ${admin}`,
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
  return admin;
};

type DeployedContract = {
  name: string;
  address: string;
  abi: unknown[];
  abiHash: string;
  txHash: string | null;
  blockNumber: number | null;
  constructorArguments: unknown[];
  verified: boolean;
};

const deployWithResilience = async (
  label: string,
  factory: ContractFactory,
  args: unknown[],
  signer: Signer,
): Promise<{
  contract: BaseContract;
  receiptHash: string | null;
  blockNumber: number | null;
}> => {
  const maxAttempts = Number(process.env.DEPLOY_MAX_ATTEMPTS ?? "5");
  const bumpPercent = Number(process.env.GAS_BUMP_PERCENT ?? "20");

  return withRetry(
    async (attempt) => {
      const gas = await resolveGasOverrides(ethers.provider, attempt, {
        bumpPercentPerAttempt: bumpPercent,
      });
      console.log(
        `[deploy-sepolia] ${label} attempt ${attempt}: maxFee=${formatGwei(gas.maxFeePerGas)} gwei tip=${formatGwei(gas.maxPriorityFeePerGas)} gwei`,
      );

      const connected = factory.connect(signer);
      const contract = await connected.deploy(...args, gas);
      await contract.waitForDeployment();

      const deployTx = contract.deploymentTransaction() as
        | ContractTransactionResponse
        | null;
      const receipt = deployTx ? await deployTx.wait() : null;

      if (!receipt) {
        throw new Error(
          `${label}: deployment tx mined without receipt — retrying to avoid orphaned state`,
        );
      }

      return {
        contract,
        receiptHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      };
    },
    {
      maxAttempts,
      label: `deploy ${label}`,
      baseDelayMs: Number(process.env.DEPLOY_RETRY_DELAY_MS ?? "2000"),
    },
  );
};

const persistArtifact = async (
  deployed: DeployedContract,
  chainId: number,
  meta?: Record<string, unknown>,
): Promise<string> => {
  if (deployed.name === "ElectionFactory" && meta?.admin && meta?.merkleRootStore) {
    return writeElectionFactoryArtifact({
      contractName: "ElectionFactory",
      network: network.name,
      chainId,
      address: deployed.address,
      abi: deployed.abi,
      abiHash: deployed.abiHash,
      txHash: deployed.txHash,
      blockNumber: deployed.blockNumber,
      admin: String(meta.admin),
      merkleRootStore: String(meta.merkleRootStore),
      verified: deployed.verified,
      deployedAt: new Date().toISOString(),
    });
  }

  return writeDeploymentArtifact({
    contractName: deployed.name,
    network: network.name,
    chainId,
    address: deployed.address,
    abi: deployed.abi,
    abiHash: deployed.abiHash,
    txHash: deployed.txHash,
    blockNumber: deployed.blockNumber,
    constructorArguments: deployed.constructorArguments,
    verified: deployed.verified,
    deployedAt: new Date().toISOString(),
    meta,
  });
};

async function main() {
  if (network.name === "hardhat") {
    console.warn(
      "[deploy-sepolia] Running on in-process hardhat — use --network sepolia for testnet",
    );
  }

  const [deployer] = await ethers.getSigners();
  const admin = await requireAdmin();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log(`[deploy-sepolia] network=${network.name} chainId=${chainId}`);
  console.log(`[deploy-sepolia] deployer=${deployer.address}`);
  console.log(`[deploy-sepolia] admin=${admin}`);
  console.log(
    `[deploy-sepolia] compiler=${COMPILER.version} optimizer=${COMPILER.optimizer.enabled}/${COMPILER.optimizer.runs} evm=${COMPILER.evmVersion}`,
  );

  const deployed: DeployedContract[] = [];

  // --- MerkleRootStore (shared) ---
  let merkleRootStoreAddress = process.env.MERKLE_ROOT_STORE_ADDRESS?.trim();
  if (merkleRootStoreAddress && !ethers.isAddress(merkleRootStoreAddress)) {
    throw new Error(
      `MERKLE_ROOT_STORE_ADDRESS is not a valid address: ${merkleRootStoreAddress}`,
    );
  }

  if (!merkleRootStoreAddress) {
    const storeFactory = await ethers.getContractFactory("MerkleRootStore");
    const { contract, receiptHash, blockNumber } = await deployWithResilience(
      "MerkleRootStore",
      storeFactory,
      [admin],
      deployer,
    );
    merkleRootStoreAddress = await contract.getAddress();
    const fullAbi = JSON.parse(
      storeFactory.interface.formatJson(),
    ) as unknown[];
    const entry: DeployedContract = {
      name: "MerkleRootStore",
      address: merkleRootStoreAddress,
      abi: fullAbi,
      abiHash: hashAbi(fullAbi),
      txHash: receiptHash,
      blockNumber,
      constructorArguments: [admin],
      verified: false,
    };
    entry.verified = await verifyContractSource({
      address: entry.address,
      constructorArguments: entry.constructorArguments,
      networkName: network.name,
    });
    deployed.push(entry);
    console.log(`[deploy-sepolia] MerkleRootStore → ${merkleRootStoreAddress}`);
  } else {
    console.log(
      `[deploy-sepolia] Reusing MerkleRootStore at ${merkleRootStoreAddress}`,
    );
  }

  // --- ElectionFactory ---
  const factoryFactory = await ethers.getContractFactory("ElectionFactory");
  const { contract: factory, receiptHash, blockNumber } =
    await deployWithResilience(
      "ElectionFactory",
      factoryFactory,
      [admin, merkleRootStoreAddress],
      deployer,
    );
  const factoryAddress = await factory.getAddress();
  const factoryAbi = JSON.parse(
    factoryFactory.interface.formatJson(),
  ) as unknown[];
  const factoryEntry: DeployedContract = {
    name: "ElectionFactory",
    address: factoryAddress,
    abi: factoryAbi,
    abiHash: hashAbi(factoryAbi),
    txHash: receiptHash,
    blockNumber,
    constructorArguments: [admin, merkleRootStoreAddress],
    verified: false,
  };
  factoryEntry.verified = await verifyContractSource({
    address: factoryEntry.address,
    constructorArguments: factoryEntry.constructorArguments,
    networkName: network.name,
  });
  deployed.push(factoryEntry);
  console.log(`[deploy-sepolia] ElectionFactory → ${factoryAddress}`);

  // --- Persist artifacts + catalog ---
  for (const entry of deployed) {
    const meta =
      entry.name === "ElectionFactory"
        ? { admin, merkleRootStore: merkleRootStoreAddress }
        : { admin };
    const artifactPath = await persistArtifact(entry, chainId, meta);
    const catalogPath = upsertDeploymentCatalog({
      network: network.name,
      chainId,
      compiler: COMPILER,
      entry: {
        contractName: entry.name,
        address: entry.address,
        abiHash: entry.abiHash,
        verified: entry.verified,
        artifactPath,
      },
    });
    console.log(`[deploy-sepolia] Artifact: ${artifactPath}`);
    console.log(`[deploy-sepolia] Catalog:  ${catalogPath}`);
  }

  // --- ABI export to back / front (also exports VoteRegistry, Ballot, AuditView) ---
  await exportAbisToConsumers();

  console.log("[deploy-sepolia] Done.");
  console.log(
    "[deploy-sepolia] Sync NestJS DB: npm run sync:election-factory (from back/)",
  );
  console.log(
    `[deploy-sepolia] Set MERKLE_ROOT_STORE_ADDRESS=${merkleRootStoreAddress}`,
  );
  console.log(
    `[deploy-sepolia] Set ELECTION_FACTORY_ADDRESS=${factoryAddress}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
