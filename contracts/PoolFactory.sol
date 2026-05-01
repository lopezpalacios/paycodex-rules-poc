// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IInterestStrategy} from "./interfaces/IInterestStrategy.sol";
import {RuleRegistry} from "./RuleRegistry.sol";
import {InterestBearingPool} from "./InterestBearingPool.sol";

/// @title PoolFactory
/// @author paycodex-rules-poc
/// @notice Deploys an `InterestBearingPool` (multi-holder, Aave-style index) bound to a registered
///         rule. Mirror of `DepositFactory` for the Pattern B accrual model. Same rule registry,
///         same operator multisig flow — just different storage shape and per-user gas profile.
/// @dev When to use which factory:
///        - `DepositFactory`  → single-customer deposit; per-user storage, per-user tier semantics
///        - `PoolFactory`     → many-customer pool; O(1) accrual, blended tier semantics
///      Both factories read from the same `RuleRegistry` so a single ruleId can be deployed in
///      either shape (or both — different deposit and pool instances for the same rule).
contract PoolFactory {
    /// @notice Source of strategy resolution
    RuleRegistry public immutable registry;

    /// @notice Emitted when a pool is created
    /// @param ruleId The rule this pool is bound to
    /// @param pool Address of the new `InterestBearingPool`
    /// @param strategy The strategy contract bound to the pool
    event PoolDeployed(bytes32 indexed ruleId, address indexed pool, address strategy);

    /// @notice The rule has been deprecated; new pools cannot be created against it
    error RuleDeprecated();

    /// @param registry_ Source of `Entry.strategy` lookups
    constructor(RuleRegistry registry_) {
        registry = registry_;
    }

    /// @notice Deploy a pool for the given rule.
    /// @param ruleId Identifier registered in the `RuleRegistry`
    /// @param asset Underlying ERC20 (must implement `IMintable.mint` for accrual)
    /// @return pool The newly-deployed `InterestBearingPool`
    function deploy(bytes32 ruleId, IERC20 asset) external returns (InterestBearingPool pool) {
        RuleRegistry.Entry memory e = registry.get(ruleId);
        if (e.deprecated) revert RuleDeprecated();
        pool = new InterestBearingPool(asset, IInterestStrategy(e.strategy), ruleId);
        emit PoolDeployed(ruleId, address(pool), e.strategy);
    }
}
