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
 *      LAST_VOTE_WINS tallies apply only when `revoteEnabled` is true (VOTAR-344).
 *
 *      Reserved candidate IDs for non-partisan ballots (blanco/nulo) are exposed as
 *      constants so auditors and UIs can filter those events the same way as
 *      positive votes. Full candidate-set validation remains VOTAR-345.
 *
 *      Limitation: one `candidateId` per voterHash — multi-category ballots must
 *      project to a single audit id off-chain until a per-category model exists.
 */
contract VoteRegistry is VotarAccessControl {
    /// @notice Reserved candidate id for blank ballots (does not collide with real ids).
    uint256 public constant VOTO_BLANCO = type(uint256).max - 1;

    /// @notice Reserved candidate id for null ballots.
    uint256 public constant VOTO_NULO = type(uint256).max;

    /// @notice Whether a nullifier may overwrite a previous vote (LAST_VOTE_WINS).
    /// @dev Immutable at deploy; production elections default to `false` (VOTAR-341).
    bool public immutable revoteEnabled;

    /**
     * @notice Public audit event for every successful vote recording.
     * @dev Only `electionId` and `voterHash` are indexed (gas optimization).
     *      `voterHash` is the anonymous nullifier/anchor — never an identity leaf
     *      nor the submitting wallet address.
     */
    event VoteCast(
        uint256 indexed electionId,
        bytes32 indexed voterHash,
        uint256 candidateId,
        bool isOverwrite
    );

    /// @notice Thrown when a nullifier already has a vote and revote is disabled.
    error RevoteDisabled();

    struct VoterState {
        uint256 candidateId;
        bool hasVoted;
    }

    mapping(uint256 electionId => mapping(bytes32 voterHash => VoterState state)) private _votes;
    mapping(uint256 electionId => mapping(uint256 candidateId => uint256 count)) private _tallies;
    /// @notice Unique voters that have cast at least one vote (overwrite does not increment).
    mapping(uint256 electionId => uint256 totalVotes) private _totalVotes;
    /// @notice Anonymous receipt anchors included on-chain (`voterHash` / nullifier).
    mapping(bytes32 receiptHash => bool included) private _receiptIncluded;

    /**
     * @param admin DEFAULT_ADMIN_ROLE holder (Multisig / Governor).
     * @param revoteEnabled_ When false, second vote for the same nullifier reverts
     *        with {RevoteDisabled}. When true, LAST_VOTE_WINS overwrites are allowed.
     */
    constructor(address admin, bool revoteEnabled_) VotarAccessControl(admin) {
        revoteEnabled = revoteEnabled_;
    }

    /**
     * @notice Records (or overwrites) a vote and emits {VoteCast} atomically.
     * @param electionId Off-chain election identifier.
     * @param voterHash Anonymous per-election anchor (nullifier).
     * @param candidateId Selected candidate, or {VOTO_BLANCO}/{VOTO_NULO}.
     */
    function recordVote(uint256 electionId, bytes32 voterHash, uint256 candidateId)
        external
        onlyRole(BALLOT_ROLE)
        whenNotPaused
    {
        VoterState storage state = _votes[electionId][voterHash];
        bool isOverwrite = state.hasVoted;

        if (isOverwrite) {
            if (!revoteEnabled) {
                revert RevoteDisabled();
            }
            if (state.candidateId != candidateId) {
                unchecked {
                    _tallies[electionId][state.candidateId] -= 1;
                }
                _tallies[electionId][candidateId] += 1;
                state.candidateId = candidateId;
            }
        } else {
            _tallies[electionId][candidateId] += 1;
            state.candidateId = candidateId;
            state.hasVoted = true;
            unchecked {
                _totalVotes[electionId] += 1;
            }
            // Receipt anchor = anonymous voterHash (nullifier). Never identity leaf / wallet.
            _receiptIncluded[voterHash] = true;
        }

        emit VoteCast(electionId, voterHash, candidateId, isOverwrite);
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
     * @notice VOTAR-350 — Whether an anonymous receipt hash was included on-chain.
     * @param receiptHash Participation anchor (nullifier / voterHash). Does not reveal identity.
     * @return True if a vote was recorded under that hash; false otherwise (safe default).
     */
    function verifyReceipt(bytes32 receiptHash) external view returns (bool) {
        return _receiptIncluded[receiptHash];
    }

    /// @notice Returns the last recorded candidate and whether the voterHash has voted.
    function getVoterState(uint256 electionId, bytes32 voterHash)
        external
        view
        returns (uint256 candidateId, bool hasVoted)
    {
        VoterState storage state = _votes[electionId][voterHash];
        return (state.candidateId, state.hasVoted);
    }
}
