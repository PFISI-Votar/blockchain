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
 *      include `voterLeaf`, so leaf↔nullifier↔candidateIds cannot be joined on-chain.
 *      `candidateIds` are bound in the EIP-712 Vote digest (integrity of audit tallies).
 *      VOTAR-474 — Multi-category ballots: `SignedVoteInput.candidateIds` is `uint256[]`
 *      (EIP-712 domain version "2") and forwarded to {VoteRegistry.recordVote} so every
 *      category increments its on-chain tally.
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
 *      requires >= 1). {castSignedVote} is the single vote path and enforces the counter.
 *
 *      VOTAR-377 — "Entidad de Firmas Digitales" (Tercero de Confianza). Every vote
 *      MUST carry a second, institutional ECDSA signature (`validatorSignature`) over
 *      the EIP-712 `Validation` digest, produced off-chain by the backend once it has
 *      verified the emitter belongs to the enabled padrón (Ley 25.506). The recovered
 *      signer MUST hold {VALIDATOR_ROLE}, otherwise the transaction reverts with
 *      {MissingValidatorSignature} / {InvalidValidatorSignature}. The digest binds the
 *      whole payload (electionId, nullifier, selectionHash, candidateIds, timestamp,
 *      expectedSigner) so an interceptor cannot alter the ballot and keep the signature
 *      valid. It deliberately omits `voterLeaf`, so the institutional signature that
 *      remains in calldata only proves "a padrón member voted", never *which* member.
 *
 *      VOTAR-325 — `minIntervalSeconds` enforces a minimum cooldown between signed
 *      votes of the same nullifier (anti "voto en cadena" coercion mitigation).
 *      0 disables the cooldown. Enforced against `block.timestamp`, so it cannot be
 *      bypassed by manipulating the client's local clock.
 */
contract BallotContract is VotarAccessControl, EIP712 {
    /**
     * @notice VOTAR-377 — vote payload bundled into a single calldata struct.
     * @dev Grouping the scalar fields keeps {castSignedVote} within the EVM stack
     *      limit once the institutional `validatorSignature` argument is added, and
     *      trims calldata-decoding bytecode (ElectionFactory embeds this init code).
     *      VOTAR-474 — `candidateIds` is a dynamic array (one id per category, or a
     *      single blanco/nulo); EIP-712 encodes it as keccak256 of packed elements.
     */
    struct SignedVoteInput {
        uint256 electionId;
        bytes32 voterLeaf;
        bytes32 nullifier;
        bytes32 selectionHash;
        uint256[] candidateIds;
        uint256 timestamp;
        address expectedSigner;
    }

    MerkleRootStore public immutable merkleRootStore;
    VoteRegistry public immutable voteRegistry;
    /// @notice VOTAR-324 — maximum signed votes a single nullifier may cast.
    uint16 public immutable maxVotesPerVoter;
    /// @notice VOTAR-325 — minimum seconds between signed votes of a nullifier. 0 = disabled.
    uint32 public immutable minIntervalSeconds;
    /// @notice VOTAR-326 — tally policy frozen at deploy; only LAST_VOTE_WINS is supported.
    TallyPolicy public immutable tallyPolicy;

    /// @dev VOTAR-474 — `uint256[] candidateIds` replaces the single audit id (domain v2).
    bytes32 private constant VOTE_TYPEHASH = keccak256(
        "Vote(uint256 electionId,bytes32 nullifier,bytes32 selectionHash,uint256[] candidateIds,uint256 timestamp)"
    );

    /// @notice VOTAR-377 — institutional certificate ("un padrón member votó").
    /// @dev VOTAR-474 — Validation digest also binds `candidateIds[]` (same encoding as Vote).
    bytes32 private constant VALIDATION_TYPEHASH = keccak256(
        "Validation(uint256 electionId,bytes32 nullifier,bytes32 selectionHash,uint256[] candidateIds,uint256 timestamp,address expectedSigner)"
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
    /// @notice VOTAR-377 — Thrown when `validatorSignature` is empty (no institutional certificate).
    error MissingValidatorSignature();
    /// @notice VOTAR-377 — Thrown when the recovered validator signer does not hold {VALIDATOR_ROLE}.
    error InvalidValidatorSignature();
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
    ) VotarAccessControl(admin) EIP712("VOTAR", "2") {
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
     * @notice Submits an EIP-712 signed ballot after Merkle eligibility validation
     *         and institutional certification ("Entidad de Firmas Digitales", VOTAR-377).
     * @param vote Bundled ballot payload (see {SignedVoteInput}).
     * @param merkleProof Sibling hashes from the StandardMerkleTree proof path.
     * @param signature Ephemeral-key ECDSA signature over the EIP-712 `Vote` digest.
     * @param validatorSignature Institutional ECDSA signature over the EIP-712
     *        `Validation` digest, produced by the backend once padrón membership is
     *        verified. The recovered signer MUST hold {VALIDATOR_ROLE}.
     * @dev Check order — the institutional signature is verified first (cheapest
     *      rejection, before any storage write) so an attacker bypassing the backend
     *      (UAT-01) is turned away by {MissingValidatorSignature}/{InvalidValidatorSignature}.
     */
    function castSignedVote(
        SignedVoteInput calldata vote,
        bytes32[] calldata merkleProof,
        bytes calldata signature,
        bytes calldata validatorSignature
    ) external whenNotPaused {
        _assertElectionAcceptingVotes(vote.electionId);

        // VOTAR-377 — reject any vote not certified by the Entidad de Firmas Digitales.
        if (validatorSignature.length == 0) revert MissingValidatorSignature();
        _assertValidValidatorSignature(vote, validatorSignature);

        _assertValidMerkleProof(vote.electionId, vote.voterLeaf, merkleProof);
        // VOTAR-451 — leaf already used by another nullifier ⇒ reject before bumping counters.
        if (_hasVoted[vote.electionId][vote.voterLeaf] && _votesUsed[vote.electionId][vote.nullifier] == 0) {
            revert AlreadyVoted();
        }
        _enforceRevotePolicy(vote.electionId, vote.nullifier);
        _assertValidVoteSignature(vote, signature);

        _hasVoted[vote.electionId][vote.voterLeaf] = true;
        // voterHash for audit = nullifier (anonymous anchor, not wallet / leaf).
        voteRegistry.recordVote(vote.electionId, vote.nullifier, vote.candidateIds);
        emit SignedVoteCast(vote.electionId, vote.nullifier, vote.selectionHash, vote.expectedSigner);
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

    function _assertValidVoteSignature(SignedVoteInput calldata vote, bytes calldata signature) private view {
        // EIP-712: dynamic `uint256[]` encodes as keccak256 of packed encodeData elements.
        bytes32 candidateIdsHash = keccak256(abi.encodePacked(vote.candidateIds));
        bytes32 structHash = keccak256(
            abi.encode(
                VOTE_TYPEHASH,
                vote.electionId,
                vote.nullifier,
                vote.selectionHash,
                candidateIdsHash,
                vote.timestamp
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer == address(0) || signer != vote.expectedSigner) {
            revert InvalidSignature();
        }
    }

    /**
     * @dev VOTAR-377 — Verifies the institutional certificate over the whole payload.
     *      The digest binds `expectedSigner` too, so the voter signature and the
     *      institutional signature cannot be recombined across ballots. `voterLeaf`
     *      is intentionally excluded so the on-chain signature never leaks identity.
     */
    function _assertValidValidatorSignature(SignedVoteInput calldata vote, bytes calldata validatorSignature)
        private
        view
    {
        bytes32 candidateIdsHash = keccak256(abi.encodePacked(vote.candidateIds));
        bytes32 structHash = keccak256(
            abi.encode(
                VALIDATION_TYPEHASH,
                vote.electionId,
                vote.nullifier,
                vote.selectionHash,
                candidateIdsHash,
                vote.timestamp,
                vote.expectedSigner
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), validatorSignature);
        if (signer == address(0) || !hasRole(VALIDATOR_ROLE, signer)) {
            revert InvalidValidatorSignature();
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
