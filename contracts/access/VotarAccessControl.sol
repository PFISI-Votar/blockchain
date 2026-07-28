// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title VotarAccessControl
 * @notice RBAC base for the VOTAR on-chain ecosystem. Centralizes the role
 *         definitions and the least-privilege policy that every electoral
 *         contract (BallotContract, MerkleRootRegistry, ElectionFactory, ...)
 *         inherits.
 * @dev Built on OpenZeppelin {AccessControl} (the project's declared RBAC
 *      standard) plus {Pausable} for the emergency stop guarded by PAUSER_ROLE.
 *
 *      Role hierarchy: DEFAULT_ADMIN_ROLE is the admin of every role, so only
 *      the address holding it (a Multisig/Governor passed at deployment) can
 *      grant or revoke roles. Auditability is provided for free by OZ, which
 *      emits {RoleGranted} and {RoleRevoked} (role, account, sender) on every
 *      privilege change, letting an external indexer track permissions in
 *      real time.
 */
abstract contract VotarAccessControl is AccessControl, Pausable {
    /// @notice Role allowed to pause/unpause the contract (emergency stop).
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Role allowed to publish/update the electoral Merkle root.
    bytes32 public constant MERKLE_UPDATER_ROLE = keccak256("MERKLE_UPDATER_ROLE");

    /// @notice Role allowed to execute ballot operations (vote recording).
    bytes32 public constant BALLOT_ROLE = keccak256("BALLOT_ROLE");

    /// @notice Role allowed to manage election lifecycle (state transitions).
    bytes32 public constant ELECTION_ADMIN_ROLE = keccak256("ELECTION_ADMIN_ROLE");

    error AdminIsZeroAddress();

    /**
     * @param admin Multisig/Governor address that receives DEFAULT_ADMIN_ROLE.
     *              It becomes the sole authority able to grant/revoke roles.
     */
    constructor(address admin) {
        if (admin == address(0)) revert AdminIsZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Pause all `whenNotPaused` operations. Restricted to PAUSER_ROLE.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resume operations. Restricted to PAUSER_ROLE.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
