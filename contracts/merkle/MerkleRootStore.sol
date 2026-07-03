// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VotarAccessControl} from "../access/VotarAccessControl.sol";

/**
 * @title MerkleRootStore
 * @notice Stores and versions electoral Merkle roots published by the authority
 *         before voting opens. Each election maps to a single immutable root.
 * @dev US-335 — Publication of the padron integrity seal on-chain.
 * @dev US-336 — Hermetic seal: prevents padron modification once voting starts.
 */
contract MerkleRootStore is VotarAccessControl {
    /// @notice Election lifecycle states.
    enum ElectionState {
        DRAFT,       // BORRADOR
        CONFIGURED,  // CONFIGURADA
        OPEN,        // ABIERTA
        CLOSED,      // CERRADA
        TALLIED      // ESCRUTADA
    }

    struct MerkleRootRecord {
        bytes32 root;
        uint256 timestamp;
    }

    /// @notice Emitted when a Merkle root is anchored for an election.
    event RootPublished(uint256 indexed electionId, bytes32 root, uint256 timestamp);

    /// @notice Emitted when an election state changes.
    event ElectionStateChanged(uint256 indexed electionId, ElectionState newState);

    error RootIsZero();
    error RootAlreadyPublished(uint256 electionId);
    error RootLocked(uint256 electionId);

    mapping(uint256 electionId => MerkleRootRecord) private _roots;
    mapping(uint256 electionId => ElectionState) private _electionStates;

    constructor(address admin) VotarAccessControl(admin) {}

    /**
     * @notice Sets the state of an election (lifecycle management).
     * @param electionId Off-chain election identifier.
     * @param state New election state.
     * @dev US-336 — Allows backend to signal when voting opens (hermetic seal trigger).
     */
    function setElectionState(uint256 electionId, ElectionState state) external onlyRole(ELECTION_ADMIN_ROLE) {
        _electionStates[electionId] = state;
        emit ElectionStateChanged(electionId, state);
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
        if (currentState == ElectionState.OPEN || currentState == ElectionState.CLOSED || currentState == ElectionState.TALLIED) {
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
}
