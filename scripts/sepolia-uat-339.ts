import { ethers, network } from "hardhat";
import {
  buildPadronMerkleTree,
  getMerkleProof,
  hashVotante,
  toBytes32Hex,
} from "../test/helpers/merkle";

const MERKLE_ROOT_STORE_ADDRESS_ENV = "MERKLE_ROOT_STORE_ADDRESS";
const BALLOT_CONTRACT_ADDRESS_ENV = "BALLOT_CONTRACT_ADDRESS";
const MERKLE_UPDATER_ADDRESS_ENV = "MERKLE_UPDATER_ADDRESS";

const TEST_ELECTION_ID = 339n;
const VOTER_DNI = "33900001";
const VOTER_EMAIL = "uat339@votar.test";

async function getMerkleRootStoreAddress(): Promise<string> {
  const existing = process.env[MERKLE_ROOT_STORE_ADDRESS_ENV];
  if (existing && ethers.isAddress(existing)) {
    console.log(`[uat-339] Using existing MerkleRootStore: ${existing}`);
    return existing;
  }

  const admin = process.env.ADMIN_MULTISIG_ADDRESS;
  if (!admin || !ethers.isAddress(admin)) {
    throw new Error("ADMIN_MULTISIG_ADDRESS must be set in .env");
  }

  console.log("[uat-339] Deploying MerkleRootStore...");
  const factory = await ethers.getContractFactory("MerkleRootStore");
  const contract = await factory.deploy(admin);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`[uat-339] MerkleRootStore deployed at: ${address}`);
  return address;
}

async function getVoteRegistryAddress(): Promise<string> {
  const existing = process.env.VOTE_REGISTRY_ADDRESS;
  if (existing && ethers.isAddress(existing)) {
    console.log(`[uat-339] Using existing VoteRegistry: ${existing}`);
    return existing;
  }

  const admin = process.env.ADMIN_MULTISIG_ADDRESS!;
  console.log("[uat-339] Deploying VoteRegistry...");
  const factory = await ethers.getContractFactory("VoteRegistry");
  const contract = await factory.deploy(admin);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`[uat-339] VoteRegistry deployed at: ${address}`);
  return address;
}

async function getBallotContractAddress(
  merkleRootStoreAddress: string,
  voteRegistryAddress: string,
): Promise<string> {
  const existing = process.env[BALLOT_CONTRACT_ADDRESS_ENV];
  if (existing && ethers.isAddress(existing)) {
    console.log(`[uat-339] Using existing BallotContract: ${existing}`);
    return existing;
  }

  const admin = process.env.ADMIN_MULTISIG_ADDRESS!;
  console.log("[uat-339] Deploying BallotContract...");
  const factory = await ethers.getContractFactory("BallotContract");
  const contract = await factory.deploy(admin, merkleRootStoreAddress, voteRegistryAddress);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  const registry = await ethers.getContractAt("VoteRegistry", voteRegistryAddress);
  const ballotRole = await registry.BALLOT_ROLE();
  if (!(await registry.hasRole(ballotRole, address))) {
    const grantTx = await registry.grantRole(ballotRole, address);
    await grantTx.wait();
  }

  console.log(`[uat-339] BallotContract deployed at: ${address}`);
  return address;
}

async function main() {
  if (network.name !== "sepolia") {
    throw new Error("Run with: npx hardhat run scripts/sepolia-uat-339.ts --network sepolia");
  }

  const merkleRootStoreAddress = await getMerkleRootStoreAddress();
  const voteRegistryAddress = await getVoteRegistryAddress();
  const ballotAddress = await getBallotContractAddress(
    merkleRootStoreAddress,
    voteRegistryAddress,
  );

  const store = await ethers.getContractAt("MerkleRootStore", merkleRootStoreAddress);
  const ballot = await ethers.getContractAt("BallotContract", ballotAddress);
  const registry = await ethers.getContractAt("VoteRegistry", voteRegistryAddress);
  const candidateId = 101n;

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

  if (adminPrivateKey) {
    const adminWallet = new ethers.Wallet(adminPrivateKey, ethers.provider);
    const storeAsAdmin = store.connect(adminWallet);
    const hasRole = await store.hasRole(MERKLE_UPDATER_ROLE, merkleUpdaterAddress);
    if (!hasRole) {
      console.log(`[uat-339] Granting MERKLE_UPDATER_ROLE to ${merkleUpdaterAddress}...`);
      const grantTx = await storeAsAdmin.grantRole(MERKLE_UPDATER_ROLE, merkleUpdaterAddress);
      await grantTx.wait();
    }
  }

  const voterHash = hashVotante(VOTER_DNI, VOTER_EMAIL);
  const voterLeaf = toBytes32Hex(voterHash);
  const hashes = [
    hashVotante("33900000", "peer0@votar.test"),
    voterHash,
    hashVotante("33900002", "peer2@votar.test"),
  ];
  const { merkleRoot, sortedHashes, tree } = buildPadronMerkleTree(hashes);
  const voterLeafIndex = sortedHashes.indexOf(voterHash);
  const validProof = getMerkleProof(tree, voterLeafIndex);

  const isPublished = await store.isPublished(TEST_ELECTION_ID);
  const electionIdForUat = isPublished ? TEST_ELECTION_ID + 1n : TEST_ELECTION_ID;

  try {
    const updater =
      merkleUpdaterAddress === deployer.address
        ? store.connect(deployer)
        : store.connect(new ethers.Wallet(process.env.PRIVATE_KEY!, ethers.provider));

    if (!(await store.isPublished(electionIdForUat))) {
      const publishTx = await updater.publishRoot(electionIdForUat, merkleRoot);
      await publishTx.wait();
      console.log(`[uat-339] Published Merkle root for election ${electionIdForUat}`);
    }
  } catch (err) {
    fail("setup: publishRoot for UAT election", err);
  }

  // UAT-01: tampered proof → InvalidMerkleProof
  try {
    const tamperedProof = [...validProof];
    const original = tamperedProof[0];
    tamperedProof[0] = original.endsWith("a")
      ? `${original.slice(0, -1)}b`
      : `${original.slice(0, -1)}a`;

    await ballot
      .connect(deployer)
      .castVote(electionIdForUat, voterLeaf, tamperedProof, candidateId);
    fail("UAT-01: tampered proof should revert", new Error("Transaction succeeded unexpectedly"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("InvalidMerkleProof")) {
      pass("UAT-01: tampered proof rejected with InvalidMerkleProof");
    } else {
      fail("UAT-01: unexpected error on tampered proof", err);
    }
  }

  // UAT-02: valid proof → VoteCast persisted
  try {
    const tx = await ballot
      .connect(deployer)
      .castVote(electionIdForUat, voterLeaf, validProof, candidateId);
    const receipt = await tx.wait();
    const hasVoted = await ballot.hasVoted(electionIdForUat, voterLeaf);
    const tally = await registry.getTally(electionIdForUat, candidateId);

    if (!hasVoted) {
      throw new Error("hasVoted returned false after successful castVote");
    }
    if (tally < 1n) {
      throw new Error("VoteRegistry tally did not increase after castVote");
    }

    pass(`UAT-02: valid proof accepted (tx: ${receipt!.hash})`);
    console.log(`       Explorer: https://sepolia.etherscan.io/tx/${receipt!.hash}`);
  } catch (err) {
    fail("UAT-02: valid Merkle proof should succeed", err);
  }

  console.log(`\n=== UAT-339 summary: ${passed} passed, ${failed} failed ===`);
  console.log(`MerkleRootStore: ${merkleRootStoreAddress}`);
  console.log(`VoteRegistry:    ${voteRegistryAddress}`);
  console.log(`BallotContract:  ${ballotAddress}`);
  console.log(`Election ID:     ${electionIdForUat}`);
  console.log(`Admin:           ${adminAddress}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
