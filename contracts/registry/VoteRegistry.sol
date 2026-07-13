// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VotarAccessControl} from "../access/VotarAccessControl.sol";

/**
 * @title VoteRegistry
 * @notice Canonical on-chain vote registry keyed by anonymous voterHash (nullifier).
 * @dev VOTAR-346 — Emits indexed `VoteCast` for public audit without linking to
 *      wallet identity or padron `voterLeaf`. Only `BALLOT_ROLE` may record votes
 *      (typically BallotContract via castSignedVote with nullifier as voterHash).
 *
 *      Reserved candidate IDs for non-partisan ballots (blanco/nulo) are exposed as
 *      constants so auditors and UIs can filter those events the same way as
 *      positive votes. Full candidate-set validation remains VOTAR-345.
 *      Overwrite/LAST_WINS tallies work here; end-to-end revote via Ballot is VOTAR-344.
 *
 *      Limitation: one `candidateId` per voterHash — multi-category ballots must
 *      project to a single audit id off-chain until a per-category model exists.
 */
contract VoteRegistry is VotarAccessControl {
    /// @notice Reserved candidate id for blank ballots (does not collide with real ids).
    uint256 public constant VOTO_BLANCO = type(uint256).max - 1;

    /// @notice Reserved candidate id for null ballots.
    uint256 public constant VOTO_NULO = type(uint256).max;

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

    struct VoterState {
        uint256 candidateId;
        bool hasVoted;
    }

    mapping(uint256 electionId => mapping(bytes32 voterHash => VoterState state)) private _votes;
    mapping(uint256 electionId => mapping(uint256 candidateId => uint256 count)) private _tallies;

    constructor(address admin) VotarAccessControl(admin) {}

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
        }

        emit VoteCast(electionId, voterHash, candidateId, isOverwrite);
    }

    /// @notice Returns the running tally for a candidate (includes reserved ids).
    function getTally(uint256 electionId, uint256 candidateId) external view returns (uint256) {
        return _tallies[electionId][candidateId];
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
