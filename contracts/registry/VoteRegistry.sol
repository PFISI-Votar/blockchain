// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VotarAccessControl} from "../access/VotarAccessControl.sol";

/**
 * @title VoteRegistry
 * @notice Canonical on-chain vote registry keyed by anonymous voterHash (nullifier).
 * @dev VOTAR-346 — Emits indexed `VoteCast` for public audit without linking to
 *      wallet identity or padron `voterLeaf`. Only `BALLOT_ROLE` may record votes
 *      (typically BallotContract via castSignedVote with nullifier as voterHash).
 *      VOTAR-350 — Pure view helpers for participation stats, per-candidate tallies
 *      and receipt inclusion checks (gas-free RPC reads).
 *      VOTAR-341 — When `revoteEnabled` is false, a second `recordVote` for the same
 *      nullifier reverts with {RevoteDisabled} (strict uniqueness). Overwrite /
 *      LAST_VOTE_WINS tallies apply only when `revoteEnabled` is true.
 *      VOTAR-326 — Overwrite decrements previous candidate tallies with an
 *      explicit checked guard ({TallyUnderflow}) instead of `unchecked`, and emits
 *      {VoteUpdated} for every tally adjustment so an off-chain auditor can
 *      reconstruct tallies from events alone (UAT-02). Removals use
 *      `newCandidate = {SIN_VOTO_PREVIO}` (delta −1 only); additions use
 *      `oldCandidate = {SIN_VOTO_PREVIO}` (delta +1 only).
 *
 *      Reserved candidate IDs for non-partisan ballots (blanco/nulo) are exposed as
 *      constants so auditors and UIs can filter those events the same way as
 *      positive votes.
 *
 *      VOTAR-345 — Candidate set is sealed on-chain via {registerCandidates}
 *      (one-shot, `ELECTION_ADMIN_ROLE`) before an election opens. Once sealed,
 *      {recordVote} only accepts ids in that allowlist plus {VOTO_BLANCO} /
 *      {VOTO_NULO}; any other id (including {SIN_VOTO_PREVIO}) reverts with
 *      {InvalidCandidateId}, and voting before the set is sealed reverts with
 *      {CandidateSetNotRegistered}.
 *
 *      VOTAR-474 — Multi-category ballots: {recordVote} accepts `uint256[]`
 *      candidateIds and increments each tally. One {VoteCast} is emitted per
 *      ballot (participation / overwrite signal; `candidateId` is the first id
 *      for display). One {VoteUpdated} is emitted per id added or removed.
 */
contract VoteRegistry is VotarAccessControl {
    /// @notice Reserved candidate id for blank ballots (does not collide with real ids).
    uint256 public constant VOTO_BLANCO = type(uint256).max - 1;

    /// @notice Reserved candidate id for null ballots.
    uint256 public constant VOTO_NULO = type(uint256).max;

    /// @notice Sentinel for {VoteUpdated}: first vote (`old`) or removal (`new`).
    uint256 public constant SIN_VOTO_PREVIO = type(uint256).max - 2;

    /// @notice Hard cap on candidate ids per ballot (DoS / gas bound).
    uint256 public constant MAX_CANDIDATES_PER_BALLOT = 32;

    /// @notice Whether a nullifier may overwrite a previous vote (LAST_VOTE_WINS).
    /// @dev Immutable at deploy; production elections default to `false` (VOTAR-341).
    ///      Assumes one VoteRegistry per comicio. If a registry is shared across
    ///      elections, replace with a per-electionId mapping (known debt).
    bool public immutable revoteEnabled;

    /**
     * @notice Public audit event for every successful ballot recording.
     * @dev Only `electionId` and `voterHash` are indexed (gas optimization).
     *      `voterHash` is the anonymous nullifier/anchor — never an identity leaf
     *      nor the submitting wallet address.
     *      VOTAR-474 — Emitted once per ballot; `candidateId` is the first id of the
     *      sorted/submitted selection (display). Full tallies come from {VoteUpdated}
     *      / {getTally}.
     */
    event VoteCast(
        uint256 indexed electionId,
        bytes32 indexed voterHash,
        uint256 candidateId,
        bool isOverwrite
    );

    /**
     * @notice VOTAR-326 — Public audit trail of every tally adjustment (LAST_VOTE_WINS).
     * @dev Emitted for each candidate id added or removed by {recordVote}.
     *      Summing `+newCandidate` / `-oldCandidate` while ignoring {SIN_VOTO_PREVIO}
     *      on either side reconstructs {getTally} exactly (UAT-02), without ever
     *      revealing voter identity.
     */
    event VoteUpdated(
        uint256 indexed electionId,
        bytes32 indexed voterNullifier,
        uint256 oldCandidate,
        uint256 newCandidate
    );

    /// @notice Thrown when a nullifier already has a vote and revote is disabled.
    error RevoteDisabled();

    /// @notice Thrown if an overwrite would decrement a candidate's tally below zero.
    error TallyUnderflow(uint256 electionId, uint256 candidateId);

    /// @notice VOTAR-345 — Thrown when {registerCandidates} is called after the set is sealed.
    error CandidateSetSealed(uint256 electionId);

    /// @notice VOTAR-345 — Thrown by {recordVote} when the election has no sealed candidate set.
    error CandidateSetNotRegistered(uint256 electionId);

    /// @notice VOTAR-345 — Thrown when {registerCandidates} receives a reserved id (UAT-03).
    error ReservedCandidateId(uint256 candidateId);

    /// @notice VOTAR-345 — Thrown when {registerCandidates} is called with an empty set.
    error EmptyCandidateSet();

    /// @notice VOTAR-345 — Thrown by {recordVote} for an id outside the sealed set / reserved ids.
    error InvalidCandidateId(uint256 electionId, uint256 candidateId);

    /// @notice VOTAR-474 — Thrown when {recordVote} receives an empty candidateIds array.
    error EmptyBallotSelection();

    /// @notice VOTAR-474 — Thrown when {recordVote} exceeds {MAX_CANDIDATES_PER_BALLOT}.
    error TooManyCandidates(uint256 count);

    /// @notice VOTAR-474 — Thrown when the same candidateId appears twice in one ballot.
    error DuplicateCandidateId(uint256 candidateId);

    /// @notice VOTAR-345 — Emitted once when a candidate set is sealed for an election.
    event CandidateSetRegistered(uint256 indexed electionId, uint256 candidateCount);

    struct VoterState {
        uint256[] candidateIds;
        bool hasVoted;
    }

    mapping(uint256 electionId => mapping(bytes32 voterHash => VoterState state)) private _votes;
    mapping(uint256 electionId => mapping(uint256 candidateId => uint256 count)) private _tallies;
    /// @notice Unique voters that have cast at least one vote (overwrite does not increment).
    mapping(uint256 electionId => uint256 totalVotes) private _totalVotes;
    /// @notice VOTAR-329 — Count of overwrite actions (isOverwrite=true) per election.
    mapping(uint256 electionId => uint256 totalRevotes) private _totalRevotes;
    /// @notice Anonymous receipt anchors included on-chain (`voterHash` / nullifier).
    mapping(bytes32 receiptHash => bool included) private _receiptIncluded;
    /// @notice VOTAR-345 — Sealed allowlist of votable candidate ids per election.
    mapping(uint256 electionId => mapping(uint256 candidateId => bool allowed)) private _candidateAllowed;
    /// @notice VOTAR-345 — Whether {registerCandidates} was already called for an election.
    mapping(uint256 electionId => bool sealed_) private _candidateSetSealed;

    /**
     * @param admin DEFAULT_ADMIN_ROLE holder (Multisig / Governor).
     * @param revoteEnabled_ When false, second vote for the same nullifier reverts
     *        with {RevoteDisabled}. When true, LAST_VOTE_WINS overwrites are allowed.
     */
    constructor(address admin, bool revoteEnabled_) VotarAccessControl(admin) {
        revoteEnabled = revoteEnabled_;
    }

    /**
     * @notice Records (or overwrites) a multi-candidate ballot and emits audit events.
     * @param electionId Off-chain election identifier.
     * @param voterHash Anonymous per-election anchor (nullifier).
     * @param candidateIds Selected candidates (one or more per multi-seat
     *        category), or a single {VOTO_BLANCO}/{VOTO_NULO}. Must be non-empty,
     *        ≤ {MAX_CANDIDATES_PER_BALLOT}, with no duplicates.
     */
    function recordVote(uint256 electionId, bytes32 voterHash, uint256[] calldata candidateIds)
        external
        onlyRole(BALLOT_ROLE)
        whenNotPaused
    {
        uint256 length = candidateIds.length;
        if (length == 0) revert EmptyBallotSelection();
        if (length > MAX_CANDIDATES_PER_BALLOT) revert TooManyCandidates(length);
        if (!_candidateSetSealed[electionId]) revert CandidateSetNotRegistered(electionId);

        for (uint256 i = 0; i < length; ++i) {
            uint256 candidateId = candidateIds[i];
            if (!isVotableCandidate(electionId, candidateId)) {
                revert InvalidCandidateId(electionId, candidateId);
            }
            for (uint256 j = 0; j < i; ++j) {
                if (candidateIds[j] == candidateId) revert DuplicateCandidateId(candidateId);
            }
        }

        VoterState storage state = _votes[electionId][voterHash];
        bool isOverwrite = state.hasVoted;

        if (isOverwrite) {
            if (!revoteEnabled) {
                revert RevoteDisabled();
            }
            unchecked {
                _totalRevotes[electionId] += 1;
            }
            _clearPreviousSelection(electionId, voterHash, state);
        } else {
            state.hasVoted = true;
            unchecked {
                _totalVotes[electionId] += 1;
            }
            // Receipt anchor = anonymous voterHash (nullifier). Never identity leaf / wallet.
            _receiptIncluded[voterHash] = true;
        }

        for (uint256 i = 0; i < length; ++i) {
            uint256 candidateId = candidateIds[i];
            _tallies[electionId][candidateId] += 1;
            state.candidateIds.push(candidateId);
            emit VoteUpdated(electionId, voterHash, SIN_VOTO_PREVIO, candidateId);
        }

        emit VoteCast(electionId, voterHash, candidateIds[0], isOverwrite);
    }

    /**
     * @notice VOTAR-345 — Seals the votable candidate set for an election (one-shot).
     * @dev Reserved ids ({VOTO_BLANCO}/{VOTO_NULO}/{SIN_VOTO_PREVIO}) cannot be registered
     *      (UAT-03) — they are always votable/handled separately. Must be called before
     *      the election opens; {recordVote} reverts with {CandidateSetNotRegistered} until
     *      this runs, and this reverts with {CandidateSetSealed} if called twice.
     */
    function registerCandidates(uint256 electionId, uint256[] calldata ids)
        external
        onlyRole(ELECTION_ADMIN_ROLE)
        whenNotPaused
    {
        if (_candidateSetSealed[electionId]) revert CandidateSetSealed(electionId);
        if (ids.length == 0) revert EmptyCandidateSet();
        for (uint256 i = 0; i < ids.length; ++i) {
            uint256 id = ids[i];
            if (id == VOTO_BLANCO || id == VOTO_NULO || id == SIN_VOTO_PREVIO) {
                revert ReservedCandidateId(id);
            }
            _candidateAllowed[electionId][id] = true;
        }
        _candidateSetSealed[electionId] = true;
        emit CandidateSetRegistered(electionId, ids.length);
    }

    /// @notice VOTAR-345 — Whether an id is votable: a sealed candidate, or blanco/nulo.
    function isVotableCandidate(uint256 electionId, uint256 candidateId) public view returns (bool) {
        if (candidateId == VOTO_BLANCO || candidateId == VOTO_NULO) return true;
        return _candidateAllowed[electionId][candidateId];
    }

    /// @notice VOTAR-345 — Whether {registerCandidates} was already called for an election.
    function isCandidateSetSealed(uint256 electionId) external view returns (bool) {
        return _candidateSetSealed[electionId];
    }

    /// @notice Returns the running tally for a candidate (includes reserved ids).
    function getTally(uint256 electionId, uint256 candidateId) external view returns (uint256) {
        return _tallies[electionId][candidateId];
    }

    /**
     * @notice VOTAR-350 — Votes counted for a candidate; unknown ids return 0.
     * @dev Alias of {getTally} with the acceptance-criteria name.
     */
    function getVotesByCandidate(uint256 electionId, uint256 candidateId) external view returns (uint256) {
        return _tallies[electionId][candidateId];
    }

    /**
     * @notice VOTAR-350 — Aggregate participation: unique votes, blank and null tallies.
     * @return totalVotes Unique voterHashes that have voted (overwrites do not double-count).
     * @return blankVotes Current tally of {VOTO_BLANCO}.
     * @return nullVotes Current tally of {VOTO_NULO}.
     */
    function getParticipationStats(uint256 electionId)
        external
        view
        returns (uint256 totalVotes, uint256 blankVotes, uint256 nullVotes)
    {
        return (_totalVotes[electionId], _tallies[electionId][VOTO_BLANCO], _tallies[electionId][VOTO_NULO]);
    }

    /**
     * @notice VOTAR-329 — Aggregated revote audit metrics for public dashboards.
     * @return totalRevotes Count of overwrite actions (VoteCast with isOverwrite=true).
     * @return uniqueVoters Unique voterHashes that have cast at least one vote.
     * @return overwriteRatio WAD-scaled ratio totalRevotes / (uniqueVoters + totalRevotes); 0 when empty.
     */
    function getRevoteStats(uint256 electionId)
        external
        view
        returns (uint256 totalRevotes, uint256 uniqueVoters, uint256 overwriteRatio)
    {
        totalRevotes = _totalRevotes[electionId];
        uniqueVoters = _totalVotes[electionId];
        uint256 totalEvents = uniqueVoters + totalRevotes;
        if (totalEvents == 0) {
            overwriteRatio = 0;
        } else {
            overwriteRatio = (totalRevotes * 1e18) / totalEvents;
        }
    }

    /**
     * @notice VOTAR-350 — Whether an anonymous receipt hash was included on-chain.
     * @param receiptHash Participation anchor (nullifier / voterHash). Does not reveal identity.
     * @return True if a vote was recorded under that hash; false otherwise (safe default).
     */
    function verifyReceipt(bytes32 receiptHash) external view returns (bool) {
        return _receiptIncluded[receiptHash];
    }

    /**
     * @notice Returns the recorded candidate ids and whether the voterHash has voted.
     * @dev VOTAR-474 — `candidateIds` may contain one id per category (or a single
     *      blanco/nulo). Empty when `hasVoted` is false.
     */
    function getVoterState(uint256 electionId, bytes32 voterHash)
        external
        view
        returns (uint256[] memory candidateIds, bool hasVoted)
    {
        VoterState storage state = _votes[electionId][voterHash];
        return (state.candidateIds, state.hasVoted);
    }

    /**
     * @dev Decrements tallies for the previous selection and clears storage slots.
     *      Emits {VoteUpdated}(old, SIN) per removed id so auditors apply −1 only.
     */
    function _clearPreviousSelection(uint256 electionId, bytes32 voterHash, VoterState storage state)
        private
    {
        uint256 previousLength = state.candidateIds.length;
        for (uint256 i = 0; i < previousLength; ++i) {
            uint256 previousCandidateId = state.candidateIds[i];
            if (_tallies[electionId][previousCandidateId] == 0) {
                revert TallyUnderflow(electionId, previousCandidateId);
            }
            _tallies[electionId][previousCandidateId] -= 1;
            emit VoteUpdated(electionId, voterHash, previousCandidateId, SIN_VOTO_PREVIO);
        }
        delete state.candidateIds;
    }
}
