// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IInterestStrategy} from "../interfaces/IInterestStrategy.sol";
import {DayCount} from "../lib/DayCount.sol";
import {WadMath} from "../lib/WadMath.sol";

/// @title CompoundDailyStrategy
/// @notice Daily-compounded fixed rate. `interest = balance × ((1 + r/denom)^days - 1)` where
///         `denom` comes from the configured day-count basis. Uses 1e18 (WAD) fixed-point math
///         via `WadMath.rpow` for the exponentiation — O(log days) gas.
/// @dev Compound is ~1.16× simple at the same rate over 1 year (per `RESULTS.md`). The WAD-scaled
///      rpow drifts from a true f64 `Math.pow` by ≤ 0.1% — the parity test in `test/03-parity`
///      tolerates that on this strategy specifically.
contract CompoundDailyStrategy is IInterestStrategy {
    using WadMath for uint256;

    /// @notice Annualised rate in basis points (unsigned; range-checked to ≤ 10_000)
    uint256 public immutable rateBps;
    /// @notice Day-count basis enum (see `DayCount.Basis`)
    DayCount.Basis public immutable basis;

    /// @notice Constructor `rateBps_` exceeded 10_000 bps (100%)
    /// @param rateBps The supplied bad value
    error RateTooHigh(uint256 rateBps);

    /// @param rateBps_ Annualised rate, basis points; range-checked to ≤ 10_000
    /// @param basis_ Day-count basis to apply
    constructor(uint256 rateBps_, DayCount.Basis basis_) {
        if (rateBps_ > 10000) revert RateTooHigh(rateBps_);
        rateBps = rateBps_;
        basis = basis_;
    }

    /// @inheritdoc IInterestStrategy
    function previewAccrual(uint256 balance, uint64 fromTs, uint64 toTs) external view returns (uint256) {
        if (balance == 0 || rateBps == 0 || toTs <= fromTs) return 0;
        (uint256 daysCount, uint256 denom) = DayCount.daysAndDenominator(basis, fromTs, toTs);
        if (daysCount == 0) return 0;

        // ratePerDayWad = rateBps / 10000 / denom  → in wad:  rateBps * 1e18 / (10000 * denom)
        uint256 ratePerDayWad = (rateBps * WadMath.WAD) / (10000 * denom);
        uint256 onePlusR = WadMath.WAD + ratePerDayWad;            // wad-scaled (1 + r/n)
        uint256 factor = WadMath.rpow(onePlusR, daysCount);        // (1 + r/n)^days, wad-scaled
        // compounded = balance * factor / 1e18
        uint256 compounded = (balance * factor) / WadMath.WAD;
        return compounded > balance ? compounded - balance : 0;
    }

    /// @inheritdoc IInterestStrategy
    function kind() external pure returns (string memory) { return "compound"; }
    /// @inheritdoc IInterestStrategy
    function dayCount() external view returns (string memory) { return DayCount.toString(basis); }
}
