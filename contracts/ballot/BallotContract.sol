// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VotarAccessControl} from "../access/VotarAccessControl.sol";
import {MerkleRootStore} from "../merkle/MerkleRootStore.sol";
import {VoteRegistry} from "../registry/VoteRegistry.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {TallyPolicy} from "../types/TallyPolicy.sol";

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
 *      VOTAR-451 — Leaf anti-double-vote: once `_hasVoted[leaf]` is true, a *new*
 *      nullifier (e.g. after ephemeral key rotation on tab close) cannot cast again.
 *      Same-nullifier re-votes remain gated only by {RevoteDisabled}/{MaxVotesReached}/
 *      {RetryTooSoon}. Without this gate, each fresh nullifier inflated `_totalVotes`
 *      and public participation could exceed 100%.
 *
 *      The nullifier value is produced off-chain by VOTAR-353 and included in the
 *      signed Vote struct; this contract only verifies the EIP-712 signature and
 *      enforces uniqueness / revote policy. It does NOT derive nullifier semantics.
 *      VOTAR-326 — `tallyPolicy` is injected at construction and immutable: the only
 *      supported value is {TallyPolicy.LAST_VOTE_WINS}, enforced by {VoteRegistry}
 *      (decrement previous candidate / increment new candidate atomically, {VoteUpdated}
 *      audit event). `_votesUsed` doubles as the on-chain `lastVoteIndex` (see
 *      {lastVoteIndex}).
 *
 *      Design note (VOTAR-341): `revoteEnabled` is an immutable on {VoteRegistry}
 *      (one registry deployment per comicio today). Domain config is per-election
 *      (`PoliticaRevoto`); if a shared registry across elections is ever used,
 *      the flag must become per-`electionId` (known debt until ElectionFactory).
 *
 *      VOTAR-324 — `maxVotesPerVoter` caps how many times a nullifier may cast a
 *      signed vote (1..10 enforced off-chain by the backend DTO; the contract only
 *      requires >= 1). Only {castSignedVote} enforces the counter: {castVote} is the
 *      legacy US-339 Merkle-only path with no nullifier, no VoteRegistry write, and
 *      no production caller (the frontend always signs via {castSignedVote}).
 *
 *      VOTAR-325 — `minIntervalSeconds` enforces a minimum cooldown between signed
 *      votes of the same nullifier (anti "voto en cadena" coercion mitigation).
 *      0 disables the cooldown. Enforced against `block.timestamp`, so it cannot be
 *      bypassed by manipulating the client's local clock.
 */
contract BallotContract is VotarAccessControl, EIP712 {
    MerkleRootStore public immutable merkleRootStore;
    VoteRegistry public immutable voteRegistry;
    /// @notice VOTAR-324 — maximum signed votes a single nullifier may cast.
    uint16 public immutable maxVotesPerVoter;
    /// @notice VOTAR-325 — minimum seconds between signed votes of a nullifier. 0 = disabled.
    uint32 public immutable minIntervalSeconds;
    /// @notice VOTAR-326 — tally policy frozen at deploy; only LAST_VOTE_WINS is supported.
    TallyPolicy public immutable tallyPolicy;

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
    /// @notice Thrown when the voter leaf already cast under a different nullifier (VOTAR-451).
    error AlreadyVoted();
    error InvalidSignature();
    /// @notice Thrown when the election is CLOSED/TALLIED or `block.timestamp` >= endTime.
    error ElectionClosed(uint256 electionId);
    /// @notice Thrown when `maxVotesPerVoter` is constructed as zero.
    error InvalidMaxVotesPerVoter();
    /// @notice Thrown when a nullifier already reached `maxVotesPerVoter` signed votes.
    error MaxVotesReached(uint256 electionId, uint16 maxVotes);
    /// @notice Thrown when a nullifier re-votes before `minIntervalSeconds` elapsed.
    error RetryTooSoon(uint256 electionId, uint256 remainingSeconds);
    /// @notice Thrown when constructed with an unsupported {TallyPolicy}.
    error InvalidTallyPolicy();
    /// @notice Thrown by {lastVoteIndex} when the nullifier has no signed vote yet.
    error NullifierHasNotVoted();

    mapping(uint256 electionId => mapping(bytes32 voterLeaf => bool hasVoted)) private _hasVoted;
    mapping(uint256 electionId => mapping(bytes32 nullifier => uint16 votesUsed)) private _votesUsed;
    mapping(uint256 electionId => mapping(bytes32 nullifier => uint64 lastVoteAt)) private _lastVoteAt;

    constructor(
        address admin,
        address merkleRootStoreAddress,
        address voteRegistryAddress,
        uint16 maxVotesPerVoter_,
        uint32 minIntervalSeconds_,
        TallyPolicy tallyPolicy_
    ) VotarAccessControl(admin) EIP712("VOTAR", "1") {
        if (merkleRootStoreAddress == address(0)) revert MerkleRootStoreIsZeroAddress();
        if (voteRegistryAddress == address(0)) revert VoteRegistryIsZeroAddress();
        if (maxVotesPerVoter_ == 0) revert InvalidMaxVotesPerVoter();
        if (tallyPolicy_ != TallyPolicy.LAST_VOTE_WINS) revert InvalidTallyPolicy();
        merkleRootStore = MerkleRootStore(merkleRootStoreAddress);
        voteRegistry = VoteRegistry(voteRegistryAddress);
        maxVotesPerVoter = maxVotesPerVoter_;
        minIntervalSeconds = minIntervalSeconds_;
        tallyPolicy = tallyPolicy_;
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
        if (_hasVoted[electionId][voterLeaf]) {
            revert AlreadyVoted();
        }

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
        // VOTAR-451 — leaf already used by another nullifier ⇒ reject before bumping counters.
        if (_hasVoted[electionId][voterLeaf] && _votesUsed[electionId][nullifier] == 0) {
            revert AlreadyVoted();
        }
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
        return _votesUsed[electionId][nullifier] != 0;
    }

    /**
     * @notice VOTAR-325 — Voter cooldown state anchored to the node's clock.
     * @dev `blockTimestamp` lets clients reconcile their local countdown against the
     *      network's real time instead of the OS clock (anti-manipulation, UAT-02).
     * @return votesUsed Signed votes cast so far by this nullifier.
     * @return lastVoteAt Unix timestamp of the last signed vote (0 if none yet).
     * @return cooldownRemaining Seconds left before this nullifier may vote again (0 if unlocked).
     * @return blockTimestamp Current `block.timestamp` as seen by this call.
     */
    function getVoterState(uint256 electionId, bytes32 nullifier)
        external
        view
        returns (uint16 votesUsed, uint64 lastVoteAt, uint256 cooldownRemaining, uint256 blockTimestamp)
    {
        votesUsed = _votesUsed[electionId][nullifier];
        lastVoteAt = _lastVoteAt[electionId][nullifier];
        blockTimestamp = block.timestamp;
        if (lastVoteAt > 0 && minIntervalSeconds > 0) {
            uint256 unlockAt = uint256(lastVoteAt) + minIntervalSeconds;
            cooldownRemaining = unlockAt > block.timestamp ? unlockAt - block.timestamp : 0;
        }
    }

    /**
     * @notice VOTAR-326 — 0-based index of a nullifier's last recorded signed vote.
     * @dev Reuses `_votesUsed` (already the on-chain count of signed votes cast):
     *      `lastVoteIndex = votesUsed - 1`. Reverts if the nullifier has not voted yet.
     */
    function lastVoteIndex(uint256 electionId, bytes32 nullifier) external view returns (uint256) {
        uint16 used = _votesUsed[electionId][nullifier];
        if (used == 0) revert NullifierHasNotVoted();
        return used - 1;
    }

    /// @notice Exposes the EIP-712 domain separator for off-chain signing clients.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /**
     * @dev VOTAR-341 — Strict uniqueness when revote is disabled.
     *      Checks the nullifier ledger (and aligns with {VoteRegistry} vote entries):
     *      if the nullifier already has a prior vote and revote is off → {RevoteDisabled}.
     *      When revote is enabled, reuse is allowed so {VoteRegistry} can overwrite (VOTAR-344),
     *      subject to the {RetryTooSoon} cooldown (VOTAR-325), up to `maxVotesPerVoter`
     *      signed votes (VOTAR-324) → {MaxVotesReached} beyond that.
     */
    function _enforceRevotePolicy(uint256 electionId, bytes32 nullifier) private {
        uint16 used = _votesUsed[electionId][nullifier];
        if (used > 0 && !voteRegistry.revoteEnabled()) {
            revert RevoteDisabled();
        }
        if (used > 0 && minIntervalSeconds > 0) {
            uint256 unlockAt = uint256(_lastVoteAt[electionId][nullifier]) + minIntervalSeconds;
            if (block.timestamp < unlockAt) {
                revert RetryTooSoon(electionId, unlockAt - block.timestamp);
            }
        }
        if (used >= maxVotesPerVoter) {
            revert MaxVotesReached(electionId, maxVotesPerVoter);
        }
        _votesUsed[electionId][nullifier] = used + 1;
        _lastVoteAt[electionId][nullifier] = uint64(block.timestamp);
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
