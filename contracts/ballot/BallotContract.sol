// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VotarAccessControl} from "../access/VotarAccessControl.sol";
import {MerkleRootStore} from "../merkle/MerkleRootStore.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title BallotContract
 * @notice Validates voter eligibility on-chain via Merkle proof against the
 *         root anchored in {MerkleRootStore} before accepting a vote intention.
 * @dev US-339 — Cryptographic validation of voters on the blockchain.
 *      Leaf encoding matches backend StandardMerkleTree (['bytes32']).
 */
contract BallotContract is VotarAccessControl {
    MerkleRootStore public immutable merkleRootStore;

    /// @notice Emitted when a vote passes Merkle validation and is recorded.
    event VoteCast(uint256 indexed electionId, bytes32 indexed voterLeaf, address indexed voter);

    error InvalidMerkleProof();
    error MerkleRootNotPublished(uint256 electionId);
    error MerkleRootStoreIsZeroAddress();

    mapping(uint256 electionId => mapping(bytes32 voterLeaf => bool hasVoted)) private _hasVoted;

    constructor(address admin, address merkleRootStoreAddress) VotarAccessControl(admin) {
        if (merkleRootStoreAddress == address(0)) revert MerkleRootStoreIsZeroAddress();
        merkleRootStore = MerkleRootStore(merkleRootStoreAddress);
    }

    /**
     * @notice Submits a vote intention after verifying Merkle membership.
     * @param electionId Off-chain election identifier (id_eleccion).
     * @param voterLeaf Keccak-256 hash of the voter identity (hash_hoja / PADRON_VOTANTE).
     * @param merkleProof Sibling hashes from the StandardMerkleTree proof path.
     */
    function castVote(
        uint256 electionId,
        bytes32 voterLeaf,
        bytes32[] calldata merkleProof
    ) external whenNotPaused {
        (bytes32 root,) = merkleRootStore.getMerkleRoot(electionId);
        if (root == bytes32(0)) revert MerkleRootNotPublished(electionId);

        bytes32 leaf = _standardLeafHash(voterLeaf);
        if (!MerkleProof.verify(merkleProof, root, leaf)) {
            revert InvalidMerkleProof();
        }

        _hasVoted[electionId][voterLeaf] = true;
        emit VoteCast(electionId, voterLeaf, msg.sender);
    }

    /// @notice Returns whether a voter leaf has successfully cast a vote on-chain.
    function hasVoted(uint256 electionId, bytes32 voterLeaf) external view returns (bool) {
        return _hasVoted[electionId][voterLeaf];
    }

    /**
     * @dev StandardMerkleTree leaf hash for type bytes32, matching the backend
     *      OpenZeppelin merkle-tree library standardLeafHash encoding.
     */
    function _standardLeafHash(bytes32 value) private pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(value))));
    }
}
