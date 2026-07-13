// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VotarAccessControl} from "../access/VotarAccessControl.sol";
import {MerkleRootStore} from "../merkle/MerkleRootStore.sol";
import {BallotContract} from "../ballot/BallotContract.sol";

/**
 * @title ElectionFactory
 * @notice Master factory that deploys a per-election {BallotContract} on demand.
 * @dev VOTAR-337 — Standardised infrastructure for creating comicios.
 *
 *      Architecture (C4 Sprint 3) describes a UUPS Proxy Factory that also spins
 *      VoteRegistry / Tally / AuditView. Those contracts are not yet on `dev`; this
 *      factory therefore deploys a fresh {BallotContract} via `CREATE` and freezes
 *      {RevoteConfig} for off-chain lifecycle / future on-chain wiring.
 *
 *      `MerkleRootStore` remains a shared global address until per-comicio stores
 *      are introduced (see DER note US-335 → US-337).
 *
 *      Access: only `DEFAULT_ADMIN_ROLE` (Multisig/Governor) may call {createElection}.
 */
contract ElectionFactory is VotarAccessControl {
    /// @notice Tally policy persisted with the election deployment (C4 RevoteConfig).
    enum TallyPolicy {
        LAST_VOTE_WINS
    }

    /**
     * @notice Revote policy injected at election creation (immutable thereafter).
     * @dev Consumed by off-chain lifecycle / future on-chain revote enforcement.
     */
    struct RevoteConfig {
        bool enabled;
        uint16 maxVotesPerVoter;
        uint32 minIntervalSeconds;
        TallyPolicy policy;
    }

    struct ElectionDeployment {
        address ballot;
        RevoteConfig revoteConfig;
        bool exists;
    }

    /// @notice Multisig/Governor that receives DEFAULT_ADMIN_ROLE on child ballots.
    address public immutable admin;

    /// @notice Shared Merkle root store used by every BallotContract instance.
    MerkleRootStore public immutable merkleRootStore;

    /// @notice Emitted when a BallotContract is deployed for an election.
    event ElectionCreated(uint256 indexed electionId, address ballot, RevoteConfig revoteConfig);

    error ElectionAlreadyExists(uint256 electionId);
    error MerkleRootStoreIsZeroAddress();

    mapping(uint256 electionId => ElectionDeployment deployment) private _deployments;
    uint256[] private _electionIds;

    /**
     * @param admin_ Multisig/Governor — DEFAULT_ADMIN_ROLE on this factory and ballots.
     * @param merkleRootStoreAddress Shared {MerkleRootStore} used by new ballots.
     */
    constructor(address admin_, address merkleRootStoreAddress) VotarAccessControl(admin_) {
        if (merkleRootStoreAddress == address(0)) revert MerkleRootStoreIsZeroAddress();
        admin = admin_;
        merkleRootStore = MerkleRootStore(merkleRootStoreAddress);
    }

    /**
     * @notice Deploys a BallotContract for `electionId` and freezes its RevoteConfig.
     * @param electionId Off-chain election identifier (`id_eleccion`).
     * @param revoteConfig Revote / tally policy frozen at creation.
     * @return ballot Address of the new BallotContract.
     */
    function createElection(uint256 electionId, RevoteConfig calldata revoteConfig)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenNotPaused
        returns (address ballot)
    {
        if (_deployments[electionId].exists) revert ElectionAlreadyExists(electionId);

        BallotContract ballotContract = new BallotContract(admin, address(merkleRootStore));
        ballot = address(ballotContract);

        _deployments[electionId] = ElectionDeployment({
            ballot: ballot, revoteConfig: revoteConfig, exists: true
        });
        _electionIds.push(electionId);

        emit ElectionCreated(electionId, ballot, revoteConfig);
    }

    /// @notice Returns deployment metadata for an election, if created.
    function getElection(uint256 electionId) external view returns (ElectionDeployment memory) {
        return _deployments[electionId];
    }

    /// @notice Number of elections created through this factory.
    function electionCount() external view returns (uint256) {
        return _electionIds.length;
    }

    /// @notice Election id at index `i` in creation order.
    function electionIdAt(uint256 index) external view returns (uint256) {
        return _electionIds[index];
    }
}
