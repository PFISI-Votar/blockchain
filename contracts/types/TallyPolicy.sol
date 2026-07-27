// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title TallyPolicy
 * @notice Vote-counting policy frozen at election creation (VOTAR-326).
 * @dev File-level enum so both {ElectionFactory} and {BallotContract} can share
 *      the type without a circular import (the factory already imports the ballot).
 */
enum TallyPolicy {
    LAST_VOTE_WINS
}
