// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleRootStore} from "../merkle/MerkleRootStore.sol";
import {VoteRegistry} from "../registry/VoteRegistry.sol";

/**
 * @title AuditViewContract
 * @notice Gas-free public read facade for electoral auditors (VOTAR-350).
 * @dev Delegates to {MerkleRootStore} and {VoteRegistry}. All entrypoints are
 *      `view`/`pure` — callable from any address (including zero-balance wallets)
 *      via public RPC nodes, and remain available while sibling contracts are paused.
 *
 *      Privacy: never returns reversible voter identity. Receipt verification uses
 *      the anonymous nullifier/voterHash anchor only.
 */
contract AuditViewContract {
    MerkleRootStore public immutable merkleRootStore;
    VoteRegistry public immutable voteRegistry;

    error MerkleRootStoreIsZeroAddress();
    error VoteRegistryIsZeroAddress();

    constructor(address merkleRootStoreAddress, address voteRegistryAddress) {
        if (merkleRootStoreAddress == address(0)) revert MerkleRootStoreIsZeroAddress();
        if (voteRegistryAddress == address(0)) revert VoteRegistryIsZeroAddress();
        merkleRootStore = MerkleRootStore(merkleRootStoreAddress);
        voteRegistry = VoteRegistry(voteRegistryAddress);
    }

    /**
     * @notice Current election lifecycle state (DRAFT/CONFIGURED/OPEN/CLOSED/TALLIED).
     * @dev Maps to the ticket wording Configuración/Abierto/Cerrado; emergency pause is
     *      orthogonal and does not block this read (UAT-04).
     */
    function getElectionState(uint256 electionId) external view returns (MerkleRootStore.ElectionState) {
        return merkleRootStore.getElectionState(electionId);
    }

    /**
     * @notice Participation aggregates for an election.
     * @return totalVotes Unique votes cast (LAST_VOTE_WINS does not double-count).
     * @return blankVotes Blank ballots currently tallied.
     * @return nullVotes Null ballots currently tallied.
     */
    function getParticipationStats(uint256 electionId)
        external
        view
        returns (uint256 totalVotes, uint256 blankVotes, uint256 nullVotes)
    {
        (totalVotes, blankVotes, nullVotes) = voteRegistry.getParticipationStats(electionId);
    }

    /**
     * @notice Running tally for a candidate id (0 if never voted / unknown id).
     */
    function getVotesByCandidate(uint256 electionId, uint256 candidateId) external view returns (uint256) {
        return voteRegistry.getVotesByCandidate(electionId, candidateId);
    }

    /**
     * @notice Confirms that a cryptographic participation receipt hash was included on-chain.
     * @param receiptHash Anonymous nullifier/voterHash from the voter's receipt — not a wallet.
     */
    function verifyReceipt(bytes32 receiptHash) external view returns (bool) {
        return voteRegistry.verifyReceipt(receiptHash);
    }

    /**
     * @notice VOTAR-345 — Whether an id is votable: a sealed candidate, or blanco/nulo.
     */
    function isVotableCandidate(uint256 electionId, uint256 candidateId) external view returns (bool) {
        return voteRegistry.isVotableCandidate(electionId, candidateId);
    }

    /**
     * @notice VOTAR-345 — Whether the election's candidate set was already sealed.
     */
    function isCandidateSetSealed(uint256 electionId) external view returns (bool) {
        return voteRegistry.isCandidateSetSealed(electionId);
    }
}
