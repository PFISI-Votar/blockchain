import { ethers, network } from "hardhat";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Hardhat default account #1 private key (matches `hardhat node` output).
 * @see https://hardhat.org/hardhat-network/docs/#accounts
 */
const HARDHAT_ACCOUNT_1_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const BACK_ENV_FILE = resolve(__dirname, "../../back/.env.blockchain.local");

const writeBackendEnv = (values: Record<string, string | number>) => {
  const lines = [
    "# Generado automáticamente por blockchain/scripts/deploy-local.ts",
    "# No commitear — reiniciá `npm run dev` en blockchain/ si reiniciás Hardhat node.",
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    "",
  ];
  const directory = dirname(BACK_ENV_FILE);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(BACK_ENV_FILE, lines.join("\n"), "utf8");
  console.log(`[deploy-local] Variables escritas en ${BACK_ENV_FILE}`);
};

async function main() {
  if (network.name !== "localhost" && network.name !== "hardhat") {
    throw new Error(
      "deploy-local.ts solo debe ejecutarse contra localhost o hardhat",
    );
  }

  const [admin, merkleUpdater] = await ethers.getSigners();

  const storeFactory = await ethers.getContractFactory("MerkleRootStore");
  const contract = await storeFactory.deploy(admin.address);
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();

  const ballotFactory = await ethers.getContractFactory("BallotContract");
  const ballot = await ballotFactory.deploy(admin.address, contractAddress);
  await ballot.waitForDeployment();
  const ballotAddress = await ballot.getAddress();

  const merkleUpdaterRole = await contract.MERKLE_UPDATER_ROLE();
  const hasRole = await contract.hasRole(
    merkleUpdaterRole,
    merkleUpdater.address,
  );
  if (!hasRole) {
    console.log(
      `[deploy-local] Otorgando MERKLE_UPDATER_ROLE a ${merkleUpdater.address}...`,
    );
    const grantTx = await contract
      .connect(admin)
      .grantRole(merkleUpdaterRole, merkleUpdater.address);
    await grantTx.wait();
  }

  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  writeBackendEnv({
    SEPOLIA_RPC_URL: "http://127.0.0.1:8545",
    MERKLE_ROOT_STORE_ADDRESS: contractAddress,
    BALLOT_CONTRACT_ADDRESS: ballotAddress,
    MERKLE_UPDATER_PRIVATE_KEY: HARDHAT_ACCOUNT_1_PRIVATE_KEY,
    CHAIN_ID: chainId,
    ETHERSCAN_BASE_URL: "http://localhost",
  });

  console.log(`[deploy-local] MerkleRootStore: ${contractAddress}`);
  console.log(`[deploy-local] BallotContract:  ${ballotAddress}`);
  console.log(`[deploy-local] DEFAULT_ADMIN_ROLE: ${admin.address}`);
  console.log(`[deploy-local] MERKLE_UPDATER_ROLE: ${merkleUpdater.address}`);
  console.log(`[deploy-local] chainId: ${chainId}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
