import { ethers, network } from "hardhat";

const MERKLE_ROOT_STORE_ADDRESS_ENV = "MERKLE_ROOT_STORE_ADDRESS";
const MERKLE_UPDATER_ADDRESS_ENV = "MERKLE_UPDATER_ADDRESS";
const TEST_ELECTION_ID = 335n;
const TEST_ROOT = ethers.id("votar-335-uat-merkle-root");

function isAccessControlRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("AccessControlUnauthorizedAccount") || message.includes("execution reverted");
}

async function getStoreAddress(): Promise<string> {
  const existing = process.env[MERKLE_ROOT_STORE_ADDRESS_ENV];
  if (existing && ethers.isAddress(existing)) {
    console.log(`[uat-335] Using existing MerkleRootStore: ${existing}`);
    return existing;
  }

  const admin = process.env.ADMIN_MULTISIG_ADDRESS;
  if (!admin || !ethers.isAddress(admin)) {
    throw new Error("ADMIN_MULTISIG_ADDRESS must be set in .env");
  }

  console.log("[uat-335] Deploying MerkleRootStore...");
  const factory = await ethers.getContractFactory("MerkleRootStore");
  const contract = await factory.deploy(admin);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`[uat-335] Deployed at: ${address}`);
  return address;
}

async function main() {
  if (network.name !== "sepolia") {
    throw new Error("Run with: npx hardhat run scripts/sepolia-uat-335.ts --network sepolia");
  }

  const address = await getStoreAddress();
  const store = await ethers.getContractAt("MerkleRootStore", address);

  const [deployer] = await ethers.getSigners();
  const adminAddress = process.env.ADMIN_MULTISIG_ADDRESS!;
  const adminPrivateKey = process.env.ADMIN_PRIVATE_KEY;
  const merkleUpdaterAddress = process.env[MERKLE_UPDATER_ADDRESS_ENV] ?? deployer.address;

  const MERKLE_UPDATER_ROLE = await store.MERKLE_UPDATER_ROLE();

  let passed = 0;
  let failed = 0;

  const pass = (label: string) => {
    console.log(`✔ ${label}`);
    passed += 1;
  };
  const fail = (label: string, err: unknown) => {
    console.log(`✘ ${label}`);
    console.log("  ", err instanceof Error ? err.message : err);
    failed += 1;
  };

  // Grant MERKLE_UPDATER_ROLE if admin key available
  if (adminPrivateKey) {
    const adminWallet = new ethers.Wallet(adminPrivateKey, ethers.provider);
    const storeAsAdmin = store.connect(adminWallet);
    const hasRole = await store.hasRole(MERKLE_UPDATER_ROLE, merkleUpdaterAddress);
    if (!hasRole) {
      console.log(`[uat-335] Granting MERKLE_UPDATER_ROLE to ${merkleUpdaterAddress}...`);
      const grantTx = await storeAsAdmin.grantRole(MERKLE_UPDATER_ROLE, merkleUpdaterAddress);
      await grantTx.wait();
    }
  } else if (!(await store.hasRole(MERKLE_UPDATER_ROLE, merkleUpdaterAddress))) {
    console.warn(
      "[uat-335] MERKLE_UPDATER_ROLE not granted — set ADMIN_PRIVATE_KEY or grant role manually",
    );
  }

  const isPublished = await store.isPublished(TEST_ELECTION_ID);
  const electionIdForUat = isPublished ? TEST_ELECTION_ID + 1n : TEST_ELECTION_ID;
  const rootForUat = isPublished ? ethers.id("votar-335-uat-merkle-root-alt") : TEST_ROOT;

  // UAT-01: authorized publish
  try {
    const updater =
      merkleUpdaterAddress === deployer.address
        ? store.connect(deployer)
        : store.connect(new ethers.Wallet(process.env.PRIVATE_KEY!, ethers.provider));

    const tx = await updater.publishRoot(electionIdForUat, rootForUat);
    const receipt = await tx.wait();
    const iface = store.interface;
    const event = receipt!.logs
      .map((log) => {
        try {
          return iface.parseLog({ topics: [...log.topics], data: log.data });
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "RootPublished");

    if (!event || event.args[0] !== electionIdForUat || event.args[1] !== rootForUat) {
      throw new Error("RootPublished event args mismatch");
    }

    pass(`UAT-01: publishRoot confirmed (tx: ${receipt!.hash})`);
    console.log(`       Explorer: https://sepolia.etherscan.io/tx/${receipt!.hash}`);
  } catch (err) {
    fail("UAT-01: publishRoot with MERKLE_UPDATER_ROLE", err);
  }

  // UAT-02: unauthorized account
  const unauthorized = ethers.Wallet.createRandom().connect(ethers.provider);
  try {
    await store.connect(unauthorized).publishRoot(electionIdForUat + 100n, rootForUat);
    fail("UAT-02: unauthorized publish should revert", new Error("Transaction succeeded unexpectedly"));
  } catch (err) {
    if (isAccessControlRejection(err)) {
      pass("UAT-02: unauthorized account rejected (AccessControl)");
    } else {
      fail("UAT-02: unexpected error", err);
    }
  }

  console.log(`\n=== UAT-335 summary: ${passed} passed, ${failed} failed ===`);
  console.log(`MerkleRootStore: ${address}`);
  console.log(`Admin:           ${adminAddress}`);
  console.log(`Merkle updater:  ${merkleUpdaterAddress}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
