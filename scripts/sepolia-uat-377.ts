import { ethers, network } from "hardhat";
import {
  buildPadronMerkleTree,
  getMerkleProof,
  hashVotante,
  toBytes32Hex,
} from "../test/helpers/merkle";
import { signValidation, signVote, toSignedVoteInput } from "../test/helpers/vote";

/**
 * VOTAR-377 — UAT-01..04 for the "Entidad de Firmas Digitales" on Sepolia.
 *
 *   UAT-01  A vote sent to the contract without / with an invalid institutional
 *           signature reverts (MissingValidatorSignature / InvalidValidatorSignature).
 *   UAT-02  A successful tx carries a validator signature that recovers to a
 *           VALIDATOR_ROLE holder, and leaks neither DNI nor padrón leaf.
 *   UAT-03  Tampering the payload while keeping the original validator signature
 *           is rejected (InvalidValidatorSignature).
 *   UAT-04  Scanning SignedVoteCast events, every registered vote is backed by a
 *           valid institutional signature → integrity + authorship report.
 *
 * Env: SEPOLIA_RPC_URL, PRIVATE_KEY (deployer, doubles as the validator here).
 */
const ELECTION_ID = 377n;
const CANDIDATE_ID = 101n;
const VOTE_TIMESTAMP = 1_700_000_000n;
const VOTER_DNI = "37700001";
const VOTER_EMAIL = "uat377@votar.test";

async function main() {
  if (network.name !== "sepolia") {
    throw new Error(
      "Run with: npx hardhat run scripts/sepolia-uat-377.ts --network sepolia",
    );
  }

  const [deployer] = await ethers.getSigners();
  const admin = process.env.ADMIN_MULTISIG_ADDRESS ?? deployer.address;

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

  // --- Fresh, self-contained stack for the UAT ---
  const store = await (
    await ethers.getContractFactory("MerkleRootStore")
  ).deploy(deployer.address);
  await store.waitForDeployment();
  const registry = await (
    await ethers.getContractFactory("VoteRegistry")
  ).deploy(deployer.address, false);
  await registry.waitForDeployment();
  const ballot = await (
    await ethers.getContractFactory("BallotContract")
  ).deploy(
    deployer.address,
    await store.getAddress(),
    await registry.getAddress(),
    1,
    0,
    0,
  );
  await ballot.waitForDeployment();
  console.log(`[uat-377] BallotContract: ${await ballot.getAddress()}`);

  await (
    await ballot.grantRole(await ballot.VALIDATOR_ROLE(), deployer.address)
  ).wait();
  await (
    await registry.grantRole(
      await registry.BALLOT_ROLE(),
      await ballot.getAddress(),
    )
  ).wait();
  await (
    await registry.grantRole(
      await registry.ELECTION_ADMIN_ROLE(),
      deployer.address,
    )
  ).wait();
  await (
    await registry.registerCandidates(ELECTION_ID, [CANDIDATE_ID])
  ).wait();

  const voterHash = hashVotante(VOTER_DNI, VOTER_EMAIL);
  const voterLeaf = toBytes32Hex(voterHash);
  const { merkleRoot, sortedHashes, tree } = buildPadronMerkleTree([
    hashVotante("37700000", "peer0@votar.test"),
    voterHash,
    hashVotante("37700002", "peer2@votar.test"),
  ]);
  const proof = getMerkleProof(tree, sortedHashes.indexOf(voterHash));

  await (await store.publishRoot(ELECTION_ID, merkleRoot)).wait();
  const now = Math.floor(Date.now() / 1000);
  await (await store.setElectionWindow(ELECTION_ID, now - 60, now + 3600)).wait();
  await (await store.setElectionState(ELECTION_ID, 2 /* OPEN */)).wait();

  const fields = {
    electionId: ELECTION_ID,
    voterLeaf,
    nullifier: ethers.id("uat-377-nullifier"),
    selectionHash: ethers.id("uat-377-selection"),
    candidateId: CANDIDATE_ID,
    timestamp: VOTE_TIMESTAMP,
    expectedSigner: deployer.address,
  };
  const voteSig = await signVote(deployer, ballot, fields);
  const validatorSig = await signValidation(deployer, ballot, fields);

  // --- UAT-01: no institutional signature -----------------------------------
  try {
    await ballot.castSignedVote(
      toSignedVoteInput(fields),
      proof,
      voteSig,
      "0x",
    );
    fail("UAT-01: missing validator signature should revert", new Error("succeeded"));
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (m.includes("MissingValidatorSignature")) {
      pass("UAT-01: missing institutional signature rejected");
    } else {
      fail("UAT-01: unexpected error (missing signature)", err);
    }
  }

  // --- UAT-01: institutional signature from a non-validator ------------------
  try {
    const rogue = ethers.Wallet.createRandom();
    const rogueSig = await signValidation(rogue, ballot, fields);
    await ballot.castSignedVote(
      toSignedVoteInput(fields),
      proof,
      voteSig,
      rogueSig,
    );
    fail("UAT-01: non-validator signature should revert", new Error("succeeded"));
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (m.includes("InvalidValidatorSignature")) {
      pass("UAT-01: institutional signature from a non-validator rejected");
    } else {
      fail("UAT-01: unexpected error (non-validator signature)", err);
    }
  }

  // --- UAT-03: tampered payload, original institutional signature ------------
  try {
    await ballot.castSignedVote(
      toSignedVoteInput({ ...fields, selectionHash: ethers.id("tampered") }),
      proof,
      voteSig,
      validatorSig,
    );
    fail("UAT-03: tampered payload should revert", new Error("succeeded"));
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (m.includes("InvalidValidatorSignature")) {
      pass("UAT-03: tampered payload with original signature rejected");
    } else {
      fail("UAT-03: unexpected error (tampered payload)", err);
    }
  }

  // --- UAT-02: successful, anonymity-preserving vote ------------------------
  let castTxHash: string | undefined;
  try {
    const tx = await ballot.castSignedVote(
      toSignedVoteInput(fields),
      proof,
      voteSig,
      validatorSig,
    );
    const receipt = await tx.wait();
    castTxHash = receipt!.hash;

    const decoded = ballot.interface.parseTransaction({
      data: (await ethers.provider.getTransaction(castTxHash))!.data,
    });
    const onChainValidatorSig = decoded!.args[3] as string;
    const digest = ethers.TypedDataEncoder.hash(
      {
        name: "VOTAR",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await ballot.getAddress(),
      },
      {
        Validation: [
          { name: "electionId", type: "uint256" },
          { name: "nullifier", type: "bytes32" },
          { name: "selectionHash", type: "bytes32" },
          { name: "candidateId", type: "uint256" },
          { name: "timestamp", type: "uint256" },
          { name: "expectedSigner", type: "address" },
        ],
      },
      fields,
    );
    const recovered = ethers.recoverAddress(digest, onChainValidatorSig);
    const isValidator = await ballot.hasRole(
      await ballot.VALIDATOR_ROLE(),
      recovered,
    );

    // The calldata must not carry the DNI nor the plaintext identity.
    const rawData = (await ethers.provider.getTransaction(castTxHash))!.data;
    const leaksDni = rawData
      .toLowerCase()
      .includes(Buffer.from(VOTER_DNI).toString("hex"));

    if (isValidator && !leaksDni) {
      pass(
        `UAT-02: vote certified by VALIDATOR_ROLE=${recovered}, no DNI/identity in calldata`,
      );
      console.log(
        `       Explorer: https://sepolia.etherscan.io/tx/${castTxHash}`,
      );
    } else {
      fail(
        "UAT-02: signature/anonymity check failed",
        new Error(`isValidator=${isValidator} leaksDni=${leaksDni}`),
      );
    }
  } catch (err) {
    fail("UAT-02: valid signed vote should succeed", err);
  }

  // --- UAT-04: audit trail — every SignedVoteCast is institutionally backed --
  try {
    const events = await ballot.queryFilter(
      ballot.filters.SignedVoteCast(ELECTION_ID),
    );
    let allBacked = events.length > 0;
    for (const ev of events) {
      const tx = await ethers.provider.getTransaction(ev.transactionHash);
      const decoded = ballot.interface.parseTransaction({ data: tx!.data });
      if (!decoded || decoded.name !== "castSignedVote") {
        allBacked = false;
        continue;
      }
      const vote = decoded.args[0];
      const validatorSignature = decoded.args[3] as string;
      const digest = ethers.TypedDataEncoder.hash(
        {
          name: "VOTAR",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await ballot.getAddress(),
        },
        {
          Validation: [
            { name: "electionId", type: "uint256" },
            { name: "nullifier", type: "bytes32" },
            { name: "selectionHash", type: "bytes32" },
            { name: "candidateId", type: "uint256" },
            { name: "timestamp", type: "uint256" },
            { name: "expectedSigner", type: "address" },
          ],
        },
        {
          electionId: vote.electionId,
          nullifier: vote.nullifier,
          selectionHash: vote.selectionHash,
          candidateId: vote.candidateId,
          timestamp: vote.timestamp,
          expectedSigner: vote.expectedSigner,
        },
      );
      const recovered = ethers.recoverAddress(digest, validatorSignature);
      const ok = await ballot.hasRole(await ballot.VALIDATOR_ROLE(), recovered);
      console.log(
        `       nullifier=${ev.args.nullifier.slice(0, 10)}… validator=${recovered} backed=${ok}`,
      );
      if (!ok) allBacked = false;
    }
    if (allBacked) {
      pass(
        `UAT-04: ${events.length} vote(s) — presunción de integridad y autoría constatada`,
      );
    } else {
      fail("UAT-04: an unbacked vote was found", new Error("integrity check failed"));
    }
  } catch (err) {
    fail("UAT-04: audit trail verification failed", err);
  }

  console.log(`\n=== UAT-377 summary: ${passed} passed, ${failed} failed ===`);
  console.log(`BallotContract: ${await ballot.getAddress()}`);
  console.log(`Admin:          ${admin}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
