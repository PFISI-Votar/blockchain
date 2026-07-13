import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { BallotContract, MerkleRootStore, VoteRegistry } from "../typechain-types";
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

/**
 * Mirrors front `computeSelectionHash`: keccak256(JSON.stringify(normalizedPayload)).
 */
function computeSelectionHash(payload: {
  votoEnBlanco?: boolean;
  votoNulo?: boolean;
  selecciones: Array<{ idCategoria: number; idCandidato: number }>;
}): string {
  const normalized = {
    votoEnBlanco: payload.votoEnBlanco === true,
    votoNulo: payload.votoNulo === true,
    selecciones: [...payload.selecciones].sort(
      (a, b) => a.idCategoria - b.idCategoria || a.idCandidato - b.idCandidato,
    ),
  };
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(normalized)));
}

describe("BallotContract — VOTAR-357 EIP-712 UATs", () => {
  const ELECTION_ID = 357n;
  const VOTER_DNI = "30222333";
  const VOTER_EMAIL = "bruno@frvm.utn.edu.ar";
  const VOTER_HASH = hashVotante(VOTER_DNI, VOTER_EMAIL);
  const VOTER_LEAF = toBytes32Hex(VOTER_HASH);
  const TIMESTAMP = 1_700_000_000n;
  const CANDIDATE_ID = 101n;

  let store: MerkleRootStore;
  let registry: VoteRegistry;
  let ballot: BallotContract;
  let admin: HardhatEthersSigner;
  let merkleUpdater: HardhatEthersSigner;
  let ephemeralSigner: HardhatEthersSigner;
  let voter: HardhatEthersSigner;
  let validProof: string[];
  let nullifier: string;
  let selectionHash: string;
  let VOTO_BLANCO: bigint;
  let VOTO_NULO: bigint;

  async function deployFixture() {
    const [admin, merkleUpdater, ephemeralSigner, voter] = await ethers.getSigners();

    const storeFactory = await ethers.getContractFactory("MerkleRootStore");
    const store = await storeFactory.deploy(admin.address);
    await store.waitForDeployment();

    const registryFactory = await ethers.getContractFactory("VoteRegistry");
    const registry = await registryFactory.deploy(admin.address);
    await registry.waitForDeployment();

    const ballotFactory = await ethers.getContractFactory("BallotContract");
    const ballot = await ballotFactory.deploy(
      admin.address,
      await store.getAddress(),
      await registry.getAddress(),
    );
    await ballot.waitForDeployment();

    await registry
      .connect(admin)
      .grantRole(await registry.BALLOT_ROLE(), await ballot.getAddress());

    await store.connect(admin).grantRole(await store.MERKLE_UPDATER_ROLE(), merkleUpdater.address);
    await store.connect(admin).grantRole(await store.ELECTION_ADMIN_ROLE(), admin.address);

    const hashes = [
      hashVotante("30111222", "ana@frvm.utn.edu.ar"),
      VOTER_HASH,
      hashVotante("30333444", "carla@frvm.utn.edu.ar"),
    ];
    const { merkleRoot, sortedHashes, tree } = buildPadronMerkleTree(hashes);
    const voterLeafIndex = sortedHashes.indexOf(VOTER_HASH);
    const validProof = getMerkleProof(tree, voterLeafIndex);

    await store.connect(merkleUpdater).publishRoot(ELECTION_ID, merkleRoot);

    // VOTAR-321: voting requires OPEN state and an active window.
    const now = Math.floor(Date.now() / 1000);
    await store.connect(admin).setElectionWindow(ELECTION_ID, now, now + 3600);
    await store.connect(admin).setElectionState(ELECTION_ID, 2); // OPEN

    // Opaque nullifier as produced off-chain by VOTAR-353 (not derived here).
    const nullifier =
      "0x1111111111111111111111111111111111111111111111111111111111111111";

    const selectionHash = computeSelectionHash({
      selecciones: [
        { idCategoria: 1, idCandidato: 101 },
        { idCategoria: 2, idCandidato: 201 },
      ],
    });

    const VOTO_BLANCO = await registry.VOTO_BLANCO();
    const VOTO_NULO = await registry.VOTO_NULO();

    return {
      store,
      registry,
      ballot,
      admin,
      merkleUpdater,
      ephemeralSigner,
      voter,
      validProof,
      nullifier,
      selectionHash,
      VOTO_BLANCO,
      VOTO_NULO,
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
      selectionHash: overrides?.selectionHash ?? selectionHash,
      timestamp: overrides?.timestamp ?? TIMESTAMP,
    };

    return signer.signTypedData(domain, VOTE_TYPE, message);
  }

  beforeEach(async () => {
    ({
      store,
      registry,
      ballot,
      admin,
      merkleUpdater,
      ephemeralSigner,
      voter,
      validProof,
      nullifier,
      selectionHash,
      VOTO_BLANCO,
      VOTO_NULO,
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
            CANDIDATE_ID,
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
            selectionHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            CANDIDATE_ID,
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
            selectionHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            CANDIDATE_ID,
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
            selectionHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            CANDIDATE_ID,
          ),
      )
        .to.emit(ballot, "SignedVoteCast")
        .withArgs(ELECTION_ID, VOTER_LEAF, nullifier, selectionHash, ephemeralSigner.address)
        .and.to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, nullifier, CANDIDATE_ID, false);

      expect(await ballot.hasVoted(ELECTION_ID, VOTER_LEAF)).to.equal(true);
      expect(await ballot.isNullifierUsed(ELECTION_ID, nullifier)).to.equal(true);
      expect(await registry.getTally(ELECTION_ID, CANDIDATE_ID)).to.equal(1n);
    });

    it("reverts InvalidSignature when recovered signer does not match expectedSigner", async () => {
      // Signature from ephemeral key, but expectedSigner claims to be voter.
      const signature = await signVote(ephemeralSigner);

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            selectionHash,
            TIMESTAMP,
            voter.address,
            signature,
            CANDIDATE_ID,
          ),
      ).to.be.revertedWithCustomError(ballot, "InvalidSignature");
    });

    it("accepts selectionHash produced with the same JSON canonicalization as the BUD", async () => {
      const frontAlignedHash = computeSelectionHash({
        votoEnBlanco: false,
        votoNulo: false,
        selecciones: [
          { idCategoria: 2, idCandidato: 201 },
          { idCategoria: 1, idCandidato: 101 },
        ],
      });
      expect(frontAlignedHash).to.equal(selectionHash);

      const signature = await signVote(ephemeralSigner, { selectionHash: frontAlignedHash });

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            frontAlignedHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            CANDIDATE_ID,
          ),
      ).to.emit(ballot, "SignedVoteCast");
    });

    it("emits VoteCast with reserved VOTO_BLANCO id for blank ballots", async () => {
      const blankHash = computeSelectionHash({ votoEnBlanco: true, selecciones: [] });
      const signature = await signVote(ephemeralSigner, { selectionHash: blankHash });

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            blankHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            VOTO_BLANCO,
          ),
      )
        .to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, nullifier, VOTO_BLANCO, false);

      expect(await registry.getTally(ELECTION_ID, VOTO_BLANCO)).to.equal(1n);
    });

    it("emits VoteCast with reserved VOTO_NULO id for null ballots", async () => {
      const nullHash = computeSelectionHash({ votoNulo: true, selecciones: [] });
      const signature = await signVote(ephemeralSigner, { selectionHash: nullHash });

      await expect(
        ballot
          .connect(voter)
          .castSignedVote(
            ELECTION_ID,
            VOTER_LEAF,
            validProof,
            nullifier,
            nullHash,
            TIMESTAMP,
            ephemeralSigner.address,
            signature,
            VOTO_NULO,
          ),
      )
        .to.emit(registry, "VoteCast")
        .withArgs(ELECTION_ID, nullifier, VOTO_NULO, false);
    });
  });
});
