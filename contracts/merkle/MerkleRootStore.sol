// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VotarAccessControl} from "../access/VotarAccessControl.sol";

/**
 * @title MerkleRootStore
 * @notice Stores and versions electoral Merkle roots published by the authority
 *         before voting opens. Each election maps to a single immutable root.
 * @dev US-335 — Publication of the padron integrity seal on-chain.
 */
contract MerkleRootStore is VotarAccessControl {
    struct MerkleRootRecord {
        bytes32 root;
        uint256 timestamp;
    }

    /// @notice Emitted when a Merkle root is anchored for an election.
    event RootPublished(uint256 indexed electionId, bytes32 root, uint256 timestamp);

    error RootIsZero();
    error RootAlreadyPublished(uint256 electionId);

    mapping(uint256 electionId => MerkleRootRecord) private _roots;

    constructor(address admin) VotarAccessControl(admin) {}

    /**
     * @notice Publishes the Merkle root for an election.
     * @param electionId Off-chain election identifier (id_eleccion).
     * @param root Keccak-256 Merkle root of the electoral roll.
     */
    function publishRoot(uint256 electionId, bytes32 root) external onlyRole(MERKLE_UPDATER_ROLE) {
        if (root == bytes32(0)) revert RootIsZero();
        if (_roots[electionId].root != bytes32(0)) revert RootAlreadyPublished(electionId);

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
}
