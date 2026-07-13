// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VotarAccessControl} from "../access/VotarAccessControl.sol";
import {MerkleRootStore} from "../merkle/MerkleRootStore.sol";
import {VoteRegistry} from "../registry/VoteRegistry.sol";
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
 *      VOTAR-321 — Rejects votes when election is CLOSED or past endTime (`ElectionClosed`).
 *      VOTAR-346 — Delegates audit `VoteCast` emission to {VoteRegistry} (voterHash =
 *      nullifier for signed votes). `SignedVoteCast` remains the receipt event.
 *
 *      The nullifier value is produced off-chain by VOTAR-353 and included in the
 *      signed Vote struct; this contract only verifies the EIP-712 signature and
 *      rejects reuse (UAT-03). It does NOT derive or validate nullifier semantics.
 *      LAST_VOTE_WINS overwrite policy beyond registry recording is VOTAR-344.
 */
contract BallotContract is VotarAccessControl, EIP712 {
    MerkleRootStore public immutable merkleRootStore;
    VoteRegistry public immutable voteRegistry;

    bytes32 private constant VOTE_TYPEHASH =
        keccak256("Vote(uint256 electionId,bytes32 nullifier,bytes32 selectionHash,uint256 timestamp)");

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
    error VoteRegistryIsZeroAddress();
    error NullifierAlreadyUsed(bytes32 nullifier);
    error InvalidSignature();
    /// @notice Thrown when the election is CLOSED/TALLIED or `block.timestamp` >= endTime.
    error ElectionClosed(uint256 electionId);

    mapping(uint256 electionId => mapping(bytes32 voterLeaf => bool hasVoted)) private _hasVoted;
    mapping(uint256 electionId => mapping(bytes32 nullifier => bool used)) private _nullifierUsed;

    constructor(address admin, address merkleRootStoreAddress, address voteRegistryAddress)
        VotarAccessControl(admin)
        EIP712("VOTAR", "1")
    {
        if (merkleRootStoreAddress == address(0)) revert MerkleRootStoreIsZeroAddress();
        if (voteRegistryAddress == address(0)) revert VoteRegistryIsZeroAddress();
        merkleRootStore = MerkleRootStore(merkleRootStoreAddress);
        voteRegistry = VoteRegistry(voteRegistryAddress);
    }

    /**
     * @notice Submits a vote after verifying Merkle membership and records it for audit.
     * @param electionId Off-chain election identifier (id_eleccion).
     * @param voterLeaf Keccak-256 hash of the voter identity (hash_hoja / PADRON_VOTANTE).
     * @param merkleProof Sibling hashes from the StandardMerkleTree proof path.
     * @param candidateId Selected candidate, or VoteRegistry reserved blanco/nulo ids.
     * @dev Legacy Merkle-only path: `voterLeaf` is used as the audit `voterHash` because
     *      this entrypoint has no nullifier. Prefer {castSignedVote} in production.
     */
    function castVote(
        uint256 electionId,
        bytes32 voterLeaf,
        bytes32[] calldata merkleProof,
        uint256 candidateId
    ) external whenNotPaused {
        _assertElectionAcceptingVotes(electionId);
        _assertValidMerkleProof(electionId, voterLeaf, merkleProof);

        _hasVoted[electionId][voterLeaf] = true;
        voteRegistry.recordVote(electionId, voterLeaf, candidateId);
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
     * @param candidateId Audit candidate id (or reserved blanco/nulo) for {VoteCast}.
     */
    function castSignedVote(
        uint256 electionId,
        bytes32 voterLeaf,
        bytes32[] calldata merkleProof,
        bytes32 nullifier,
        bytes32 selectionHash,
        uint256 timestamp,
        address expectedSigner,
        bytes calldata signature,
        uint256 candidateId
    ) external whenNotPaused {
        _assertElectionAcceptingVotes(electionId);
        _assertValidMerkleProof(electionId, voterLeaf, merkleProof);
        _consumeNullifier(electionId, nullifier);
        _assertValidVoteSignature(
            electionId, nullifier, selectionHash, timestamp, expectedSigner, signature
        );

        _hasVoted[electionId][voterLeaf] = true;
        // voterHash for audit = nullifier (anonymous anchor, not wallet / leaf).
        voteRegistry.recordVote(electionId, nullifier, candidateId);
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

    function _consumeNullifier(uint256 electionId, bytes32 nullifier) private {
        if (_nullifierUsed[electionId][nullifier]) {
            revert NullifierAlreadyUsed(nullifier);
        }
        _nullifierUsed[electionId][nullifier] = true;
    }

    function _assertValidVoteSignature(
        uint256 electionId,
        bytes32 nullifier,
        bytes32 selectionHash,
        uint256 timestamp,
        address expectedSigner,
        bytes calldata signature
    ) private view {
        bytes32 structHash = keccak256(abi.encode(VOTE_TYPEHASH, electionId, nullifier, selectionHash, timestamp));
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer == address(0) || signer != expectedSigner) {
            revert InvalidSignature();
        }
    }

    /**
     * @dev VOTAR-321 — Autonomous close by `block.timestamp` and explicit CLOSED state.
     *      Manual close sets state to CLOSED; auto-close also rejects when past endTime
     *      even if the backend has not yet synced CLOSED.
     */
    function _assertElectionAcceptingVotes(uint256 electionId) private view {
        MerkleRootStore.ElectionState state = merkleRootStore.getElectionState(electionId);
        if (state == MerkleRootStore.ElectionState.CLOSED || state == MerkleRootStore.ElectionState.TALLIED) {
            revert ElectionClosed(electionId);
        }

        uint256 endTime = merkleRootStore.getElectionEndTime(electionId);
        if (endTime > 0 && block.timestamp >= endTime) {
            revert ElectionClosed(electionId);
        }

        if (state != MerkleRootStore.ElectionState.OPEN) {
            revert ElectionClosed(electionId);
        }
    }

    function _assertValidMerkleProof(uint256 electionId, bytes32 voterLeaf, bytes32[] calldata merkleProof)
        private
        view
    {
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
