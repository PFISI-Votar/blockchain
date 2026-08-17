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
     * @notice VOTAR-347 — emitted (in addition to OZ's own {Pausable-Paused}) with the
     *         audit reason recorded by the Autoridad Electoral triggering the pause.
     * @dev Overloads OZ Pausable's `event Paused(address)`. Solidity resolves the
     *      `emit Paused(_msgSender())` inside OZ's own `_pause()` unambiguously to the
     *      1-arg version (declared in Pausable.sol's own lexical scope); this 2-arg
     *      version is only ever emitted explicitly by {_pauseWithReason}. Tests/tools
     *      MUST reference the fully-qualified signature `"Paused(address,string)"`
     *      (not the bare name `"Paused"`, now ambiguous between two overloads).
     */
    event Paused(address indexed account, string reason);

    /**
     * @param admin Multisig/Governor address that receives DEFAULT_ADMIN_ROLE.
     *              It becomes the sole authority able to grant/revoke roles.
     */
    constructor(address admin) {
        if (admin == address(0)) revert AdminIsZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Pause all `whenNotPaused` operations, with no recorded reason.
    /// @dev Equivalent to `pause("")`. Solidity has no default/optional parameters —
    ///      this overload is the idiomatic way to satisfy VOTAR-347 AC3's "parámetro
    ///      opcional" without breaking existing zero-arg callers.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pauseWithReason("");
    }

    /// @notice VOTAR-347 (AC3) — Pause with an audit-trail reason.
    /// @param reason Human-readable justification for the emergency stop, emitted via
    ///        {Paused} (2-arg) for later off-chain audit / Frontend banners.
    function pause(string calldata reason) external onlyRole(PAUSER_ROLE) {
        _pauseWithReason(reason);
    }

    /// @notice Resume operations. Restricted to PAUSER_ROLE.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _pauseWithReason(string memory reason) private {
        _pause();
        emit Paused(_msgSender(), reason);
    }
}
