// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VotarAccessControl} from "../access/VotarAccessControl.sol";

/**
 * @title MerkleRootStore
 * @notice Stores and versions electoral Merkle roots published by the authority
 *         before voting opens. Each election maps to a single immutable root.
 * @dev US-335 — Publication of the padron integrity seal on-chain.
 * @dev US-336 — Hermetic seal: prevents padron modification once voting starts.
 * @dev VOTAR-321 — Voting window (endTime) for autonomous on-chain closure.
 * @dev VOTAR-327 — Seals the voting window against changes once locked.
 */
contract MerkleRootStore is VotarAccessControl {
    /// @notice Election lifecycle states.
    enum ElectionState {
        DRAFT, // BORRADOR
        CONFIGURED, // CONFIGURADA
        OPEN, // ABIERTA
        CLOSED, // CERRADA
        TALLIED // ESCRUTADA
    }

    struct MerkleRootRecord {
        bytes32 root;
        uint256 timestamp;
    }

    struct ElectionWindow {
        uint256 startTime;
        uint256 endTime;
    }

    /// @notice Emitted when a Merkle root is anchored for an election.
    event RootPublished(uint256 indexed electionId, bytes32 root, uint256 timestamp);

    /// @notice Emitted when an election state changes.
    event ElectionStateChanged(uint256 indexed electionId, ElectionState newState);

    /// @notice Emitted when the voting window is configured (VOTAR-321).
    event ElectionWindowSet(uint256 indexed electionId, uint256 startTime, uint256 endTime);

    /// @notice Emitted when the voting window configuration is sealed (VOTAR-327).
    event ConfigurationLocked(uint256 indexed electionId);

    error RootIsZero();
    error RootAlreadyPublished(uint256 electionId);
    error RootLocked(uint256 electionId);
    error InvalidElectionWindow();
    error ConfigLocked(uint256 electionId);

    mapping(uint256 electionId => MerkleRootRecord) private _roots;
    mapping(uint256 electionId => ElectionState) private _electionStates;
    mapping(uint256 electionId => ElectionWindow) private _electionWindows;
    mapping(uint256 electionId => bool locked) private _configLocked;

    constructor(address admin) VotarAccessControl(admin) {}

    /**
     * @notice Sets the state of an election (lifecycle management).
     * @param electionId Off-chain election identifier.
     * @param state New election state.
     * @dev US-336 — Allows backend to signal when voting opens (hermetic seal trigger).
     * @dev VOTAR-321 — CLOSED blocks further votes in BallotContract.
     */
    function setElectionState(uint256 electionId, ElectionState state) external onlyRole(ELECTION_ADMIN_ROLE) {
        _electionStates[electionId] = state;
        emit ElectionStateChanged(electionId, state);
    }

    /**
     * @notice Configures the on-chain voting window used for autonomous closure.
     * @param electionId Off-chain election identifier.
     * @param startTime Unix timestamp when voting opens.
     * @param endTime Unix timestamp when voting closes (exclusive upper bound).
     * @dev VOTAR-321 — BallotContract compares `block.timestamp` against `endTime`.
     */
    function setElectionWindow(uint256 electionId, uint256 startTime, uint256 endTime)
        external
        onlyRole(ELECTION_ADMIN_ROLE)
    {
        if (_configLocked[electionId]) revert ConfigLocked(electionId);
        if (endTime == 0 || endTime <= startTime) revert InvalidElectionWindow();
        _electionWindows[electionId] = ElectionWindow({startTime: startTime, endTime: endTime});
        emit ElectionWindowSet(electionId, startTime, endTime);
    }

    /**
     * @notice Seals the voting window against further changes (VOTAR-327).
     * @dev Deliberately does NOT gate {setElectionState}: after OPEN, the backend
     *      still needs to call setElectionState(CLOSED) and setElectionState(TALLIED)
     *      to advance the lifecycle. Locking state transitions here would brick the
     *      comicio after opening. Only the voting window, which has no legitimate
     *      reason to change once voting is live, is protected.
     */
    function lockConfig(uint256 electionId) external onlyRole(ELECTION_ADMIN_ROLE) {
        if (_configLocked[electionId]) revert ConfigLocked(electionId);
        _configLocked[electionId] = true;
        emit ConfigurationLocked(electionId);
    }

    /// @notice Whether {lockConfig} was already called for `electionId`.
    function isConfigLocked(uint256 electionId) external view returns (bool) {
        return _configLocked[electionId];
    }

    /**
     * @notice Publishes the Merkle root for an election.
     * @param electionId Off-chain election identifier (id_eleccion).
     * @param root Keccak-256 Merkle root of the electoral roll.
     * @dev US-336 — Reverts with RootLocked if election is already OPEN, CLOSED, or TALLIED.
     */
    function publishRoot(uint256 electionId, bytes32 root) external onlyRole(MERKLE_UPDATER_ROLE) {
        if (root == bytes32(0)) revert RootIsZero();
        if (_roots[electionId].root != bytes32(0)) revert RootAlreadyPublished(electionId);

        // US-336: Hermetic seal — block publication if voting has started
        ElectionState currentState = _electionStates[electionId];
        if (
            currentState == ElectionState.OPEN || currentState == ElectionState.CLOSED
                || currentState == ElectionState.TALLIED
        ) {
            revert RootLocked(electionId);
        }

        uint256 timestamp = block.timestamp;
        _roots[electionId] = MerkleRootRecord({root: root, timestamp: timestamp});
        emit RootPublished(electionId, root, timestamp);
    }

    /**
     * @notice Returns the published Merkle root and timestamp for an election.
     * @return root The anchored Merkle root (bytes32(0) if not published).
     * @return timestamp Block timestamp when the root was published.
     */
    function getMerkleRoot(uint256 electionId) external view returns (bytes32 root, uint256 timestamp) {
        MerkleRootRecord storage record = _roots[electionId];
        return (record.root, record.timestamp);
    }

    /// @notice Returns true if a Merkle root has been published for the election.
    function isPublished(uint256 electionId) external view returns (bool) {
        return _roots[electionId].root != bytes32(0);
    }

    /// @notice Returns the current state of an election.
    function getElectionState(uint256 electionId) external view returns (ElectionState) {
        return _electionStates[electionId];
    }

    /// @notice Returns the configured voting window (0,0 if unset).
    function getElectionWindow(uint256 electionId) external view returns (uint256 startTime, uint256 endTime) {
        ElectionWindow storage window = _electionWindows[electionId];
        return (window.startTime, window.endTime);
    }

    /// @notice Returns the configured end timestamp (0 if unset).
    function getElectionEndTime(uint256 electionId) external view returns (uint256) {
        return _electionWindows[electionId].endTime;
    }
}
