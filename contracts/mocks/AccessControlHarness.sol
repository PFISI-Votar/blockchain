// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VotarAccessControl} from "../access/VotarAccessControl.sol";

/**
 * @title AccessControlHarness
 * @notice Concrete contract used to exercise the RBAC base in isolation. It
 *         adds one representative critical function per role so each role
 *         modifier can be verified (operation isolation / cross-role revert).
 * @dev Not part of the production ecosystem — the real contracts inherit
 *      {VotarAccessControl} directly. Lives under contracts/mocks for tests.
 */
contract AccessControlHarness is VotarAccessControl {
    /// @notice Last Merkle root written via MERKLE_UPDATER_ROLE.
    bytes32 public lastMerkleRoot;

    /// @notice Last value written via BALLOT_ROLE.
    uint256 public lastBallotValue;

    constructor(address admin) VotarAccessControl(admin) {}

    /// @notice Merkle-root publication. Restricted to MERKLE_UPDATER_ROLE.
    function updateMerkleRoot(bytes32 root) external onlyRole(MERKLE_UPDATER_ROLE) {
        lastMerkleRoot = root;
    }

    /// @notice Ballot operation. Restricted to BALLOT_ROLE and the unpaused state.
    function recordBallotOp(uint256 value) external onlyRole(BALLOT_ROLE) whenNotPaused {
        lastBallotValue = value;
    }
}
