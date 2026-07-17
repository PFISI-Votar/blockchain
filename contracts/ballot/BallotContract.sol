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
 *      VOTAR-346 — Delegates audit `VoteCast` to {VoteRegistry} using nullifier as
 *      anonymous `voterHash`. `SignedVoteCast` is the receipt event and MUST NOT
 *      include `voterLeaf`, so leaf↔nullifier↔candidateId cannot be joined on-chain.
 *      `candidateId` is bound in the EIP-712 Vote digest (integrity of audit tallies).
 *      VOTAR-341 — `enforceRevotePolicy`: if {VoteRegistry.revoteEnabled} is false and
 *      the nullifier already has a vote entry, reverts with {RevoteDisabled}.
 *
 *      The nullifier value is produced off-chain by VOTAR-353 and included in the
 *      signed Vote struct; this contract only verifies the EIP-712 signature and
 *      enforces uniqueness / revote policy. It does NOT derive nullifier semantics.
 *      LAST_VOTE_WINS when revote is enabled is completed in VOTAR-344.
 *
 *      Design note (VOTAR-341): `revoteEnabled` is an immutable on {VoteRegistry}
 *      (one registry deployment per comicio today). Domain config is per-election
 *      (`PoliticaRevoto`); if a shared registry across elections is ever used,
 *      the flag must become per-`electionId` (known debt until ElectionFactory).
 */
contract BallotContract is VotarAccessControl, EIP712 {
    MerkleRootStore public immutable merkleRootStore;
    VoteRegistry public immutable voteRegistry;

    bytes32 private constant VOTE_TYPEHASH = keccak256(
        "Vote(uint256 electionId,bytes32 nullifier,bytes32 selectionHash,uint256 candidateId,uint256 timestamp)"
    );

    /**
     * @notice Receipt event for a successful signed vote.
     * @dev Intentionally omits `voterLeaf` so public logs cannot join padron identity
     *      to the anonymous nullifier / VoteCast preference (VOTAR-346 privacy).
     */
    event SignedVoteCast(
        uint256 indexed electionId,
        bytes32 indexed nullifier,
        bytes32 selectionHash,
        address signer
    );

    error InvalidMerkleProof();
    error MerkleRootNotPublished(uint256 electionId);
    error MerkleRootStoreIsZeroAddress();
    error VoteRegistryIsZeroAddress();
    /// @notice Thrown when a nullifier already voted and {VoteRegistry.revoteEnabled} is false.
    error RevoteDisabled();
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
     * @notice Legacy Merkle-eligibility path (US-339). Does NOT write {VoteRegistry}.
     * @dev Public audit `VoteCast` requires an anonymous nullifier; feeding `voterLeaf`
     *      as `voterHash` would create an identity↔preference FK. Production votes MUST
     *      use {castSignedVote}.
     */
    function castVote(uint256 electionId, bytes32 voterLeaf, bytes32[] calldata merkleProof)
        external
        whenNotPaused
    {
        _assertElectionAcceptingVotes(electionId);
        _assertValidMerkleProof(electionId, voterLeaf, merkleProof);

        _hasVoted[electionId][voterLeaf] = true;
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
     * @param candidateId Audit candidate id (or reserved blanco/nulo), bound in the digest.
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
        _enforceRevotePolicy(electionId, nullifier);
        _assertValidVoteSignature(
            electionId, nullifier, selectionHash, candidateId, timestamp, expectedSigner, signature
        );

        _hasVoted[electionId][voterLeaf] = true;
        // voterHash for audit = nullifier (anonymous anchor, not wallet / leaf).
        voteRegistry.recordVote(electionId, nullifier, candidateId);
        emit SignedVoteCast(electionId, nullifier, selectionHash, expectedSigner);
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

    /**
     * @dev VOTAR-341 — Strict uniqueness when revote is disabled.
     *      Checks the nullifier ledger (and aligns with {VoteRegistry} vote entries):
     *      if the nullifier already has a prior vote and revote is off → {RevoteDisabled}.
     *      When revote is enabled, reuse is allowed so {VoteRegistry} can overwrite (VOTAR-344).
     */
    function _enforceRevotePolicy(uint256 electionId, bytes32 nullifier) private {
        if (_nullifierUsed[electionId][nullifier]) {
            if (!voteRegistry.revoteEnabled()) {
                revert RevoteDisabled();
            }
            return;
        }
        _nullifierUsed[electionId][nullifier] = true;
    }

    function _assertValidVoteSignature(
        uint256 electionId,
        bytes32 nullifier,
        bytes32 selectionHash,
        uint256 candidateId,
        uint256 timestamp,
        address expectedSigner,
        bytes calldata signature
    ) private view {
        bytes32 structHash = keccak256(
            abi.encode(VOTE_TYPEHASH, electionId, nullifier, selectionHash, candidateId, timestamp)
        );
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
