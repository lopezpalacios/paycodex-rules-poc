// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IInterestStrategy} from "./interfaces/IInterestStrategy.sol";
import {RuleRegistry} from "./RuleRegistry.sol";
import {InterestBearingDeposit} from "./InterestBearingDeposit.sol";

/// @title DepositFactory
/// @notice Deploys an InterestBearingDeposit bound to a registered rule.
contract DepositFactory {
    RuleRegistry public immutable registry;

    event DepositDeployed(
        bytes32 indexed ruleId,
        address indexed customer,
        address indexed deposit,
        address strategy
    );

    error RuleDeprecated();

    constructor(RuleRegistry registry_) {
        registry = registry_;
    }

    /// @notice Deploy a deposit instance for `customer` using strategy bound to `ruleId`.
    /// @param taxCollector Address of the WHT collector (required iff whtEnabled = true).
    function deploy(
        bytes32 ruleId,
        IERC20 asset,
        address customer,
        bool whtEnabled,
        uint256 whtBps,
        address taxCollector
    ) external returns (InterestBearingDeposit deposit) {
        RuleRegistry.Entry memory e = registry.get(ruleId);
        if (e.deprecated) revert RuleDeprecated();
        deposit = new InterestBearingDeposit(
            asset,
            IInterestStrategy(e.strategy),
            customer,
            ruleId,
            whtEnabled,
            whtBps,
            taxCollector
        );
        emit DepositDeployed(ruleId, customer, address(deposit), e.strategy);
    }
}
