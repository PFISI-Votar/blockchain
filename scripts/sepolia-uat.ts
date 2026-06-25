import { ethers, network } from "hardhat";

const CONTRACT_ADDRESS_ENV = "CONTRACT_ADDRESS";
const TEST_ACCOUNT_FUNDING = ethers.parseEther("0.002");

async function fundTestAccounts(
  deployer: { sendTransaction: (tx: { to: string; value: bigint }) => Promise<{ wait: () => Promise<unknown> }> },
  addresses: string[],
): Promise<void> {
  for (const to of addresses) {
    const tx = await deployer.sendTransaction({ to, value: TEST_ACCOUNT_FUNDING });
    await tx.wait();
  }
}

function isAccessControlRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("AccessControlUnauthorizedAccount") || message.includes("execution reverted");
}

async function getContractAddress(): Promise<string> {
  const existing = process.env[CONTRACT_ADDRESS_ENV];
  if (existing && ethers.isAddress(existing)) {
    console.log(`[uat] Using existing contract: ${existing}`);
    return existing;
  }

  const admin = process.env.ADMIN_MULTISIG_ADDRESS;
  if (!admin || !ethers.isAddress(admin)) {
    throw new Error("ADMIN_MULTISIG_ADDRESS must be set in .env");
  }

  console.log("[uat] Deploying AccessControlHarness...");
  const factory = await ethers.getContractFactory("AccessControlHarness");
  const contract = await factory.deploy(admin);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`[uat] Deployed at: ${address}`);
  console.log(`[uat] DEFAULT_ADMIN_ROLE → ${admin}`);
  return address;
}

async function main() {
  if (network.name !== "sepolia") {
    throw new Error("Run with: npx hardhat run scripts/sepolia-uat.ts --network sepolia");
  }

  const address = await getContractAddress();
  const contract = await ethers.getContractAt("AccessControlHarness", address);

  const [deployer] = await ethers.getSigners();
  const adminAddress = process.env.ADMIN_MULTISIG_ADDRESS!;
  const adminPrivateKey = process.env.ADMIN_PRIVATE_KEY;

  const DEFAULT_ADMIN_ROLE = await contract.DEFAULT_ADMIN_ROLE();
  const PAUSER_ROLE = await contract.PAUSER_ROLE();
  const MERKLE_UPDATER_ROLE = await contract.MERKLE_UPDATER_ROLE();
  const BALLOT_ROLE = await contract.BALLOT_ROLE();

  console.log("\n=== Setup verification ===");
  console.log("Deployer:", deployer.address);
  console.log("Admin:   ", adminAddress);
  console.log(
    "Admin has DEFAULT_ADMIN_ROLE:",
    await contract.hasRole(DEFAULT_ADMIN_ROLE, adminAddress),
  );

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  const pass = (label: string) => {
    console.log(`✔ ${label}`);
    passed += 1;
  };
  const fail = (label: string, err: unknown) => {
    console.log(`✘ ${label}`);
    console.log("  ", err instanceof Error ? err.message : err);
    failed += 1;
  };
  const skip = (label: string, reason: string) => {
    console.log(`⊘ ${label} — SKIPPED: ${reason}`);
    skipped += 1;
  };

  console.log("\n=== UAT-02 — non-admin cannot grant BALLOT_ROLE ===");
  try {
    await contract.grantRole(BALLOT_ROLE, deployer.address);
    fail("UAT-02", "grantRole succeeded but should have reverted");
  } catch {
    pass("UAT-02: deployer denied when granting BALLOT_ROLE");
  }

  if (!adminPrivateKey) {
    skip("UAT-01", "set ADMIN_PRIVATE_KEY in .env (MetaMask admin account)");
    skip("UAT-03", "set ADMIN_PRIVATE_KEY in .env");
    skip("UAT-04", "set ADMIN_PRIVATE_KEY in .env");
  } else {
    const adminWallet = new ethers.Wallet(
      adminPrivateKey.startsWith("0x") ? adminPrivateKey : `0x${adminPrivateKey}`,
      deployer.provider!,
    );
    const adminContract = contract.connect(adminWallet);

    const merkleUpdater = ethers.Wallet.createRandom().connect(deployer.provider!);
    const pauser = ethers.Wallet.createRandom().connect(deployer.provider!);
    const ballotAccount = ethers.Wallet.createRandom().connect(deployer.provider!);

    console.log("\n=== Funding test accounts (gas) ===");
    await fundTestAccounts(deployer, [
      merkleUpdater.address,
      pauser.address,
      ballotAccount.address,
    ]);

    console.log("\n=== Provisioning roles (admin signs) ===");
    await (await adminContract.grantRole(PAUSER_ROLE, pauser.address)).wait();
    await (await adminContract.grantRole(MERKLE_UPDATER_ROLE, merkleUpdater.address)).wait();
    await (await adminContract.grantRole(BALLOT_ROLE, ballotAccount.address)).wait();
    console.log("Roles granted to ephemeral test accounts");

    console.log("\n=== UAT-01 — MERKLE_UPDATER cannot pause() ===");
    try {
      await contract.connect(merkleUpdater).pause();
      fail("UAT-01", "pause() succeeded but should have reverted");
    } catch (err) {
      if (isAccessControlRejection(err)) {
        pass("UAT-01: MERKLE_UPDATER blocked from pause()");
      } else {
        fail("UAT-01", err);
      }
    }

    console.log("\n=== UAT-03 — RoleGranted event on grant ===");
    const extraAccount = ethers.Wallet.createRandom();
    const tx = await adminContract.grantRole(BALLOT_ROLE, extraAccount.address);
    const receipt = await tx.wait();
    const iface = contract.interface;
    const granted = receipt?.logs
      .map((log) => {
        try {
          return iface.parseLog({ topics: [...log.topics], data: log.data });
        } catch {
          return null;
        }
      })
      .find((e) => e?.name === "RoleGranted");

    if (
      granted &&
      granted.args.role === BALLOT_ROLE &&
      granted.args.account === extraAccount.address &&
      granted.args.sender.toLowerCase() === adminAddress.toLowerCase()
    ) {
      pass("UAT-03: RoleGranted(role, account, sender) emitted correctly");
    } else {
      fail("UAT-03", "RoleGranted event missing or wrong args");
    }

    console.log("\n=== UAT-04 — renounceRole (self) ===");
    const renounceTx = await contract.connect(ballotAccount).renounceRole(BALLOT_ROLE, ballotAccount.address);
    const renounceReceipt = await renounceTx.wait();
    const revoked = renounceReceipt?.logs
      .map((log) => {
        try {
          return iface.parseLog({ topics: [...log.topics], data: log.data });
        } catch {
          return null;
        }
      })
      .find((e) => e?.name === "RoleRevoked");

    const stillHasRole = await contract.hasRole(BALLOT_ROLE, ballotAccount.address);
    if (
      revoked &&
      revoked.args.role === BALLOT_ROLE &&
      revoked.args.account === ballotAccount.address &&
      !stillHasRole
    ) {
      pass("UAT-04: account renounced its own BALLOT_ROLE");
    } else {
      fail("UAT-04", "renounceRole did not work as expected");
    }

    console.log("\n=== Bonus — PAUSER can pause ===");
    try {
      await contract.connect(pauser).pause();
      pass("PAUSER_ROLE can pause (paused=" + (await contract.paused()) + ")");
    } catch (err) {
      fail("PAUSER pause", err);
    }
  }

  console.log("\n=== Summary ===");
  console.log(`Contract: ${address}`);
  console.log(`Etherscan: https://sepolia.etherscan.io/address/${address}`);
  console.log(`Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped}`);

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
