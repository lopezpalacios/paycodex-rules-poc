// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IInterestStrategy} from "../interfaces/IInterestStrategy.sol";
import {DayCount} from "../lib/DayCount.sol";

/// @title SimpleStrategy
/// @notice Simple-interest accrual: `balance × rateBps × days / (10_000 × denom)`. Day-count
///         denominator is determined by the configured `basis` (act/360, act/365, 30/360, act/act-isda).
/// @dev Negative rates are modelled as zero from the depositor's perspective — wrap with a
///      floor/cap strategy if real negative pass-through is required. The rate is fixed at
///      construction and cannot change for the lifetime of the strategy; deprecate + replace
///      via `RuleRegistry` to update terms for new deposits.
contract SimpleStrategy is IInterestStrategy {
    /// @notice Annualised rate in basis points. Signed (range checked to [-10_000, 10_000]).
    int256 public immutable rateBps;
    /// @notice Day-count basis enum (see `DayCount.Basis`)
    DayCount.Basis public immutable basis;

    /// @notice Constructor `rateBps_` outside the [-10_000, 10_000] range
    /// @param rateBps The supplied bad value
    error RateOutOfRange(int256 rateBps);

    /// @param rateBps_ Annualised rate, basis points; range-checked
    /// @param basis_ Day-count basis to apply
    constructor(int256 rateBps_, DayCount.Basis basis_) {
        if (rateBps_ < -10000 || rateBps_ > 10000) revert RateOutOfRange(rateBps_);
        rateBps = rateBps_;
        basis = basis_;
    }

    /// @inheritdoc IInterestStrategy
    function previewAccrual(uint256 balance, uint64 fromTs, uint64 toTs) external view returns (uint256) {
        if (balance == 0 || rateBps == 0 || toTs <= fromTs) return 0;
        (uint256 daysCount, uint256 denom) = DayCount.daysAndDenominator(basis, fromTs, toTs);
        if (daysCount == 0) return 0;
        if (rateBps < 0) {
            // Negative-rate accrual modelled as zero from the deposit-holder's perspective in this demo.
            // Wrap with FloorCap if you want real negative pass-through.
            return 0;
        }
        return (balance * uint256(rateBps) * daysCount) / (10000 * denom);
    }

    /// @inheritdoc IInterestStrategy
    function kind() external pure returns (string memory) { return "simple"; }
    /// @inheritdoc IInterestStrategy
    function dayCount() external view returns (string memory) { return DayCount.toString(basis); }
}
