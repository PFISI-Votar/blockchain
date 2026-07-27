import { ethers, network } from "hardhat";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Hardhat default account #0 private key — DEFAULT_ADMIN + ELECTION_ADMIN locally.
 * @see https://hardhat.org/hardhat-network/docs/#accounts
 */
const HARDHAT_ACCOUNT_0_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/**
 * Hardhat default account #1 private key (matches `hardhat node` output).
 * @see https://hardhat.org/hardhat-network/docs/#accounts
 */
const HARDHAT_ACCOUNT_1_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const BACK_ENV_FILE = resolve(__dirname, "../../back/.env.blockchain.local");
const FRONT_ENV_FILE = resolve(__dirname, "../../front/.env.local");

const writeEnvFile = (
  filePath: string,
  values: Record<string, string | number>,
  headerLines: string[],
) => {
  const lines = [
    ...headerLines,
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    "",
  ];
  const directory = dirname(filePath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(filePath, lines.join("\n"), "utf8");
  console.log(`[deploy-local] Variables escritas en ${filePath}`);
};

/**
 * Merges blockchain keys into an existing `.env.local` so vars like
 * `VITE_API_URL` are preserved across redeploys.
 */
const mergeEnvFile = (
  filePath: string,
  values: Record<string, string | number>,
  headerLines: string[],
) => {
  const existing: Record<string, string> = {};
  if (existsSync(filePath)) {
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }
      const key = trimmed.slice(0, separatorIndex);
      const value = trimmed.slice(separatorIndex + 1);
      existing[key] = value;
    }
  }
  const merged: Record<string, string | number> = {
    ...existing,
    ...values,
  };
  writeEnvFile(filePath, merged, headerLines);
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

  // VOTAR-341 — local default matches production: revote disabled.
  const revoteEnabled = process.env.REVOTE_ENABLED === "true";
  const registryFactory = await ethers.getContractFactory("VoteRegistry");
  const registry = await registryFactory.deploy(admin.address, revoteEnabled);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log(`[deploy-local] VoteRegistry revoteEnabled=${revoteEnabled}`);

  // VOTAR-324 — local default matches production floor: 1 vote per voter.
  const maxVotesPerVoter = Number(process.env.MAX_VOTES_PER_VOTER ?? "1");
  // VOTAR-325 — local default matches production floor: no cooldown.
  const minIntervalSeconds = Number(process.env.MIN_INTERVAL_SECONDS ?? "0");
  const ballotFactory = await ethers.getContractFactory("BallotContract");
  const ballot = await ballotFactory.deploy(
    admin.address,
    contractAddress,
    registryAddress,
    maxVotesPerVoter,
    minIntervalSeconds,
  );
  await ballot.waitForDeployment();
  const ballotAddress = await ballot.getAddress();

  const auditFactory = await ethers.getContractFactory("AuditViewContract");
  const auditView = await auditFactory.deploy(contractAddress, registryAddress);
  await auditView.waitForDeployment();
  const auditViewAddress = await auditView.getAddress();

  // VOTAR-337 — ElectionFactory (master) wired to the shared MerkleRootStore.
  const electionFactoryFactory =
    await ethers.getContractFactory("ElectionFactory");
  const electionFactory = await electionFactoryFactory.deploy(
    admin.address,
    contractAddress,
  );
  await electionFactory.waitForDeployment();
  const electionFactoryAddress = await electionFactory.getAddress();

  const ballotRole = await registry.BALLOT_ROLE();
  const hasBallotRole = await registry.hasRole(ballotRole, ballotAddress);
  if (!hasBallotRole) {
    console.log(
      `[deploy-local] Otorgando BALLOT_ROLE a BallotContract ${ballotAddress}...`,
    );
    const grantBallotTx = await registry
      .connect(admin)
      .grantRole(ballotRole, ballotAddress);
    await grantBallotTx.wait();
  }

  const electionAdminRole = await contract.ELECTION_ADMIN_ROLE();
  const hasElectionAdminRole = await contract.hasRole(
    electionAdminRole,
    admin.address,
  );
  if (!hasElectionAdminRole) {
    console.log(
      `[deploy-local] Otorgando ELECTION_ADMIN_ROLE a ${admin.address}...`,
    );
    const grantElectionAdminTx = await contract
      .connect(admin)
      .grantRole(electionAdminRole, admin.address);
    await grantElectionAdminTx.wait();
  }

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

  writeEnvFile(
    BACK_ENV_FILE,
    {
      SEPOLIA_RPC_URL: "http://127.0.0.1:8545",
      MERKLE_ROOT_STORE_ADDRESS: contractAddress,
      VOTE_REGISTRY_ADDRESS: registryAddress,
      AUDIT_VIEW_ADDRESS: auditViewAddress,
      BALLOT_CONTRACT_ADDRESS: ballotAddress,
      ELECTION_FACTORY_ADDRESS: electionFactoryAddress,
      MERKLE_UPDATER_PRIVATE_KEY: HARDHAT_ACCOUNT_1_PRIVATE_KEY,
      ELECTION_ADMIN_PRIVATE_KEY: HARDHAT_ACCOUNT_0_PRIVATE_KEY,
      CHAIN_ID: chainId,
      ETHERSCAN_BASE_URL: "http://localhost",
    },
    [
      "# Generado automáticamente por blockchain/scripts/deploy-local.ts",
      "# No commitear — reiniciá `npm run dev` en blockchain/ si reiniciás Hardhat node.",
    ],
  );

  mergeEnvFile(
    FRONT_ENV_FILE,
    {
      VITE_RPC_URL: "http://127.0.0.1:8545",
      VITE_CHAIN_ID: chainId,
      VITE_BALLOT_CONTRACT_ADDRESS: ballotAddress,
      VITE_VOTE_REGISTRY_ADDRESS: registryAddress,
      VITE_AUDIT_VIEW_ADDRESS: auditViewAddress,
      // Hardhat account #0 — pays gas for castSignedVote (local/testnet only)
      VITE_VOTE_TRANSMITTER_PRIVATE_KEY: HARDHAT_ACCOUNT_0_PRIVATE_KEY,
    },
    [
      "# Generado automáticamente por blockchain/scripts/deploy-local.ts",
      "# Mergea claves blockchain en .env.local sin borrar otras vars (ej. VITE_API_URL).",
      "# Vite carga este archivo automáticamente — no commitear.",
      "# Reiniciá `npm run dev` en front/ después de un redeploy.",
    ],
  );

  console.log(`[deploy-local] MerkleRootStore: ${contractAddress}`);
  console.log(`[deploy-local] VoteRegistry:    ${registryAddress}`);
  console.log(`[deploy-local] BallotContract:  ${ballotAddress}`);
  console.log(`[deploy-local] AuditView:       ${auditViewAddress}`);
  console.log(`[deploy-local] ElectionFactory: ${electionFactoryAddress}`);
  console.log(`[deploy-local] DEFAULT_ADMIN_ROLE: ${admin.address}`);
  console.log(`[deploy-local] MERKLE_UPDATER_ROLE: ${merkleUpdater.address}`);
  console.log(`[deploy-local] chainId: ${chainId}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
