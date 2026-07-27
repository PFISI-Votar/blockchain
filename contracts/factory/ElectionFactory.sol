// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VotarAccessControl} from "../access/VotarAccessControl.sol";
import {MerkleRootStore} from "../merkle/MerkleRootStore.sol";
import {VoteRegistry} from "../registry/VoteRegistry.sol";
import {BallotContract} from "../ballot/BallotContract.sol";
import {AuditViewContract} from "../audit/AuditViewContract.sol";
import {TallyPolicy} from "../types/TallyPolicy.sol";

/**
 * @title ElectionFactory
 * @notice Master factory that deploys a per-election contract set (VoteRegistry,
 *         BallotContract, AuditViewContract) on demand.
 * @dev VOTAR-337 — Standardised infrastructure for creating comicios.
 *
 *      Architecture (C4 Sprint 3) describes a UUPS Proxy Factory. Current electoral
 *      contracts are non-upgradeable; this factory therefore deploys fresh instances
 *      via `CREATE`. Upgradeable proxies can replace this path later without changing
 *      the off-chain registration of the factory address/ABI.
 *
 *      `MerkleRootStore` remains a shared global address until per-comicio stores
 *      are introduced (see DER note US-335 → US-337).
 *
 *      Access: only `DEFAULT_ADMIN_ROLE` (Multisig/Governor) may call {createElection}.
 */
contract ElectionFactory is VotarAccessControl {
    /**
     * @notice Revote policy injected at election creation (immutable thereafter).
     * @dev `enabled` is passed to {VoteRegistry} at deploy (VOTAR-341).
     *      `maxVotesPerVoter` is passed to {BallotContract} at deploy (VOTAR-324).
     *      `minIntervalSeconds` is passed to {BallotContract} at deploy (VOTAR-325).
     */
    struct RevoteConfig {
        bool enabled;
        uint16 maxVotesPerVoter;
        uint32 minIntervalSeconds;
        TallyPolicy policy;
    }

    struct ElectionDeployment {
        address ballot;
        address voteRegistry;
        address auditView;
        RevoteConfig revoteConfig;
        bool exists;
    }

    /// @notice Multisig/Governor that receives DEFAULT_ADMIN_ROLE on child contracts.
    address public immutable admin;

    /// @notice Shared Merkle root store used by every BallotContract instance.
    MerkleRootStore public immutable merkleRootStore;

    /// @notice Emitted when a full election stack is deployed.
    event ElectionCreated(
        uint256 indexed electionId,
        address ballot,
        address voteRegistry,
        address auditView,
        RevoteConfig revoteConfig
    );

    error ElectionAlreadyExists(uint256 electionId);
    error MerkleRootStoreIsZeroAddress();

    mapping(uint256 electionId => ElectionDeployment deployment) private _deployments;
    uint256[] private _electionIds;

    /**
     * @param admin_ Multisig/Governor — DEFAULT_ADMIN_ROLE on this factory and children.
     * @param merkleRootStoreAddress Shared {MerkleRootStore} used by new ballots.
     */
    constructor(address admin_, address merkleRootStoreAddress) VotarAccessControl(admin_) {
        // Explicit zero-check (also enforced by {VotarAccessControl}) for Slither.
        if (admin_ == address(0)) revert AdminIsZeroAddress();
        if (merkleRootStoreAddress == address(0)) revert MerkleRootStoreIsZeroAddress();
        admin = admin_;
        merkleRootStore = MerkleRootStore(merkleRootStoreAddress);
    }

    /**
     * @notice Deploys VoteRegistry + BallotContract + AuditView for `electionId`.
     * @param electionId Off-chain election identifier (`id_eleccion`).
     * @param revoteConfig Revote / tally policy frozen at creation.
     * @return ballot Address of the new BallotContract.
     * @return voteRegistry Address of the new VoteRegistry.
     * @return auditView Address of the new AuditViewContract.
     * @dev Follows checks-effects-interactions: storage + event are written before
     *      role grants on the fresh VoteRegistry. Any revert on grant/renounce rolls
     *      back the entire creation.
     */
    function createElection(uint256 electionId, RevoteConfig calldata revoteConfig)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenNotPaused
        returns (address ballot, address voteRegistry, address auditView)
    {
        if (_deployments[electionId].exists) revert ElectionAlreadyExists(electionId);

        // Factory is temporary admin of VoteRegistry so it can grant BALLOT_ROLE
        // atomically, then transfers DEFAULT_ADMIN_ROLE to the Multisig.
        // VOTAR-341 — wire RevoteConfig.enabled into VoteRegistry.revoteEnabled.
        VoteRegistry registry = new VoteRegistry(address(this), revoteConfig.enabled);
        BallotContract ballotContract = new BallotContract(
            admin,
            address(merkleRootStore),
            address(registry),
            revoteConfig.maxVotesPerVoter,
            revoteConfig.minIntervalSeconds,
            revoteConfig.policy
        );
        AuditViewContract audit =
            new AuditViewContract(address(merkleRootStore), address(registry));

        ballot = address(ballotContract);
        voteRegistry = address(registry);
        auditView = address(audit);

        // Effects before external role calls (CEI) — suppresses reentrancy-no-eth.
        _deployments[electionId] = ElectionDeployment({
            ballot: ballot,
            voteRegistry: voteRegistry,
            auditView: auditView,
            revoteConfig: revoteConfig,
            exists: true
        });
        _electionIds.push(electionId);
        emit ElectionCreated(electionId, ballot, voteRegistry, auditView, revoteConfig);

        registry.grantRole(registry.BALLOT_ROLE(), address(ballotContract));
        registry.grantRole(DEFAULT_ADMIN_ROLE, admin);
        registry.renounceRole(DEFAULT_ADMIN_ROLE, address(this));
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
