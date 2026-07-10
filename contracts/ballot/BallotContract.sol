// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VotarAccessControl} from "../access/VotarAccessControl.sol";
import {MerkleRootStore} from "../merkle/MerkleRootStore.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title BallotContract
 * @notice Validates voter eligibility on-chain via Merkle proof against the
 *         root anchored in {MerkleRootStore} before accepting a vote intention.
 * @dev US-339 — Cryptographic validation of voters on the blockchain.
 *      VOTAR-357 — EIP-712 signed ballot with domain separator and nullifier
 *      replay protection. Leaf encoding matches backend StandardMerkleTree (['bytes32']).
 *
 *      The nullifier value is produced off-chain by VOTAR-353 and included in the
 *      signed Vote struct; this contract only verifies the EIP-712 signature and
 *      rejects reuse (UAT-03). It does NOT derive or validate nullifier semantics.
 *      LAST_VOTE_WINS overwrite requires VoteRegistry (future US).
 */
contract BallotContract is VotarAccessControl, EIP712 {
    MerkleRootStore public immutable merkleRootStore;

    bytes32 private constant VOTE_TYPEHASH =
        keccak256("Vote(uint256 electionId,bytes32 nullifier,bytes32 selectionHash,uint256 timestamp)");

    /// @notice Emitted when a vote passes Merkle validation and is recorded.
    event VoteCast(uint256 indexed electionId, bytes32 indexed voterLeaf, address indexed voter);

    /// @notice Emitted when a signed vote passes Merkle + EIP-712 validation.
    event SignedVoteCast(
        uint256 indexed electionId,
        bytes32 indexed voterLeaf,
        bytes32 indexed nullifier,
        bytes32 selectionHash,
        address signer
    );

    error InvalidMerkleProof();
    error MerkleRootNotPublished(uint256 electionId);
    error MerkleRootStoreIsZeroAddress();
    error NullifierAlreadyUsed(bytes32 nullifier);
    error InvalidSignature();

    mapping(uint256 electionId => mapping(bytes32 voterLeaf => bool hasVoted)) private _hasVoted;
    mapping(uint256 electionId => mapping(bytes32 nullifier => bool used)) private _nullifierUsed;

    constructor(address admin, address merkleRootStoreAddress)
        VotarAccessControl(admin)
        EIP712("VOTAR", "1")
    {
        if (merkleRootStoreAddress == address(0)) revert MerkleRootStoreIsZeroAddress();
        merkleRootStore = MerkleRootStore(merkleRootStoreAddress);
    }

    /**
     * @notice Submits a vote intention after verifying Merkle membership.
     * @param electionId Off-chain election identifier (id_eleccion).
     * @param voterLeaf Keccak-256 hash of the voter identity (hash_hoja / PADRON_VOTANTE).
     * @param merkleProof Sibling hashes from the StandardMerkleTree proof path.
     */
    function castVote(
        uint256 electionId,
        bytes32 voterLeaf,
        bytes32[] calldata merkleProof
    ) external whenNotPaused {
        _assertValidMerkleProof(electionId, voterLeaf, merkleProof);

        _hasVoted[electionId][voterLeaf] = true;
        emit VoteCast(electionId, voterLeaf, msg.sender);
    }

    /**
     * @notice Submits an EIP-712 signed ballot after Merkle eligibility validation.
     * @param electionId Off-chain election identifier (id_eleccion).
     * @param voterLeaf Keccak-256 hash of the voter identity (hash_hoja / PADRON_VOTANTE).
     * @param merkleProof Sibling hashes from the StandardMerkleTree proof path.
     * @param nullifier Anonymous per-election identifier produced off-chain (VOTAR-353).
     * @param selectionHash Hash of the selected ballot content.
     * @param timestamp Unix timestamp captured at signing time on the client.
     * @param expectedSigner Ethereum address derived from the ephemeral session key.
     * @param signature ECDSA signature over the EIP-712 typed data digest.
     */
    function castSignedVote(
        uint256 electionId,
        bytes32 voterLeaf,
        bytes32[] calldata merkleProof,
        bytes32 nullifier,
        bytes32 selectionHash,
        uint256 timestamp,
        address expectedSigner,
        bytes calldata signature
    ) external whenNotPaused {
        _assertValidMerkleProof(electionId, voterLeaf, merkleProof);

        if (_nullifierUsed[electionId][nullifier]) {
            revert NullifierAlreadyUsed(nullifier);
        }

        bytes32 structHash = keccak256(
            abi.encode(VOTE_TYPEHASH, electionId, nullifier, selectionHash, timestamp)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        if (signer == address(0) || signer != expectedSigner) {
            revert InvalidSignature();
        }

        _nullifierUsed[electionId][nullifier] = true;
        _hasVoted[electionId][voterLeaf] = true;
        emit SignedVoteCast(electionId, voterLeaf, nullifier, selectionHash, expectedSigner);
    }

    /// @notice Returns whether a voter leaf has successfully cast a vote on-chain.
    function hasVoted(uint256 electionId, bytes32 voterLeaf) external view returns (bool) {
        return _hasVoted[electionId][voterLeaf];
    }

    /// @notice Returns whether a nullifier was already consumed for the election.
    function isNullifierUsed(uint256 electionId, bytes32 nullifier) external view returns (bool) {
        return _nullifierUsed[electionId][nullifier];
    }

    /// @notice Exposes the EIP-712 domain separator for off-chain signing clients.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _assertValidMerkleProof(
        uint256 electionId,
        bytes32 voterLeaf,
        bytes32[] calldata merkleProof
    ) private view {
        (bytes32 root, uint256 publishedAt) = merkleRootStore.getMerkleRoot(electionId);
        if (root == bytes32(0) || publishedAt == 0) revert MerkleRootNotPublished(electionId);

        bytes32 leaf = _standardLeafHash(voterLeaf);
        if (!MerkleProof.verify(merkleProof, root, leaf)) {
            revert InvalidMerkleProof();
        }
    }

    /**
     * @dev StandardMerkleTree leaf hash for type bytes32, matching the backend
     *      OpenZeppelin merkle-tree library standardLeafHash encoding.
     */
    function _standardLeafHash(bytes32 value) private pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(value))));
    }
}
