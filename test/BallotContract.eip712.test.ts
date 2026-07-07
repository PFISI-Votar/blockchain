import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { BallotContract, MerkleRootStore } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  buildPadronMerkleTree,
  getMerkleProof,
  hashVotante,
  toBytes32Hex,
} from "./helpers/merkle";

const VOTE_TYPE = {
  Vote: [
    { name: "electionId", type: "uint256" },
    { name: "nullifier", type: "bytes32" },
    { name: "selectionHash", type: "bytes32" },
    { name: "timestamp", type: "uint256" },
  ],
};

describe("BallotContract — VOTAR-357 EIP-712 UATs", () => {
  const ELECTION_ID = 357n;
  const VOTER_DNI = "30222333";
  const VOTER_EMAIL = "bruno@frvm.utn.edu.ar";
  const VOTER_HASH = hashVotante(VOTER_DNI, VOTER_EMAIL);
  const VOTER_LEAF = toBytes32Hex(VOTER_HASH);
  const SELECTION_HASH =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const TIMESTAMP = 1_700_000_000n;

  let store: MerkleRootStore;
  let ballot: BallotContract;
  let admin: HardhatEthersSigner;
  let merkleUpdater: HardhatEthersSigner;
  let ephemeralSigner: HardhatEthersSigner;
  let voter: HardhatEthersSigner;
  let validProof: string[];
  let nullifier: string;

  async function deployFixture() {
    const [admin, merkleUpdater, ephemeralSigner, voter] = await ethers.getSigners();

    const storeFactory = await ethers.getContractFactory("MerkleRootStore");
    const store = await storeFactory.deploy(admin.address);
    await store.waitForDeployment();

    const ballotFactory = await ethers.getContractFactory("BallotContract");
    const ballot = await ballotFactory.deploy(admin.address, await store.getAddress());
    await ballot.waitForDeployment();

    await store.connect(admin).grantRole(await store.MERKLE_UPDATER_ROLE(), merkleUpdater.address);

    const hashes = [
      hashVotante("30111222", "ana@frvm.utn.edu.ar"),
      VOTER_HASH,
      hashVotante("30333444", "carla@frvm.utn.edu.ar"),
    ];
    const { merkleRoot, sortedHashes, tree } = buildPadronMerkleTree(hashes);
    const voterLeafIndex = sortedHashes.indexOf(VOTER_HASH);
    const validProof = getMerkleProof(tree, voterLeafIndex);

    await store.connect(merkleUpdater).publishRoot(ELECTION_ID, merkleRoot);

    const nullifier = ethers.keccak256(
      ethers.solidityPacked(["address", "uint256"], [ephemeralSigner.address, ELECTION_ID]),
    );

    return {
      store,
      ballot,
      admin,
      merkleUpdater,
      ephemeralSigner,
      voter,
      validProof,
      nullifier,
    };
  }

  async function signVote(
    signer: HardhatEthersSigner,
    overrides?: Partial<{
      electionId: bigint;
      nullifier: string;
      selectionHash: string;
      timestamp: bigint;
    }>,
  ) {
    const domain = {
      name: "VOTAR",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await ballot.getAddress(),
    };

    const message = {
      electionId: overrides?.electionId ?? ELECTION_ID,
      nullifier: overrides?.nullifier ?? nullifier,
      selectionHash: overrides?.selectionHash ?? SELECTION_HASH,
      timestamp: overrides?.timestamp ?? TIMESTAMP,
    };

    return signer.signTypedData(domain, VOTE_TYPE, message);
  }

  beforeEach(async () => {
    ({
      store,
      ballot,
      admin,
      merkleUpdater,
      ephemeralSigner,
      voter,
      validProof,
      nullifier,
    } = await loadFixture(deployFixture));
  });

  describe("UAT-01: domain separator", () => {
    it("exposes an EIP-712 domain separator tied to this deployment", async () => {
      const separator = await ballot.domainSeparator();
      expect(separator).to.not.equal(ethers.ZeroHash);
    });
  });

  describe("UAT-02: integridad del payload", () => {
    it("reverts InvalidSignature when selectionHash is tampered", async () => {
      const signature = await signVote(ephemeralSigner);
      const tamperedSelectionHash =
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            tamperedSelectionHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
          ),
      ).to.be.revertedWithCustomError(ballot, "InvalidSignature");
    });
  });

  describe("UAT-03: protección contra replay", () => {
    it("reverts NullifierAlreadyUsed on duplicate signed vote submission", async () => {
      const signature = await signVote(ephemeralSigner);

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            SELECTION_HASH,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
          ),
      ).to.emit(ballot, "SignedVoteCast");

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            SELECTION_HASH,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
          ),
      ).to.be.revertedWithCustomError(ballot, "NullifierAlreadyUsed");
    });
  });

  describe("signed vote acceptance", () => {
    it("records the vote when Merkle proof and EIP-712 signature are valid", async () => {
      const signature = await signVote(ephemeralSigner);

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            SELECTION_HASH,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
          ),
      )
        .to.emit(ballot, "SignedVoteCast")
        .withArgs(ELECTION_ID, VOTER_LEAF, nullifier, SELECTION_HASH, ephemeralSigner.address);

      expect(await ballot.hasVoted(ELECTION_ID, VOTER_LEAF)).to.equal(true);
      expect(await ballot.isNullifierUsed(ELECTION_ID, nullifier)).to.equal(true);
    });

    it("reverts InvalidSignature when signer does not match expected ephemeral key", async () => {
      const signature = await signVote(ephemeralSigner);

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            SELECTION_HASH,
            TIMESTAMP,
            voter.address,
            signature,
          ),
      ).to.be.revertedWithCustomError(ballot, "InvalidSignature");
    });
  });
});
