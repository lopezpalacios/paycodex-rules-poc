// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IInterestStrategy} from "../interfaces/IInterestStrategy.sol";
import {IRateOracle} from "../interfaces/IRateOracle.sol";
import {DayCount} from "../lib/DayCount.sol";

/// @title FloatingStrategy
/// @notice Reference rate from an oracle + fixed spread, simple interest, with optional
///         floor and cap on the effective rate. Use for €STR + spread, SOFR + spread, etc.
/// @dev The effective rate is computed at preview time (`oracle.getRateBps() + spreadBps`,
///      then clamped). For real-bank periodic-reset semantics, snapshot the rate at the
///      posting boundary off-chain and use a `SimpleStrategy` deployed for that period.
///      Sentinel values: `floorBps = -10001` disables the floor; `capBps = 10001` disables
///      the cap. Negative effective rates are floored to 0 from the depositor's view.
contract FloatingStrategy is IInterestStrategy {
    /// @notice Source of the reference rate
    IRateOracle public immutable oracle;
    /// @notice Spread added to the oracle rate, in basis points (signed)
    int256 public immutable spreadBps;
    /// @notice Day-count basis enum (see `DayCount.Basis`)
    DayCount.Basis public immutable basis;
    /// @notice Minimum effective rate in bps; sentinel `-10001` disables the floor
    int256 public immutable floorBps;
    /// @notice Maximum effective rate in bps; sentinel `10001` disables the cap
    int256 public immutable capBps;

    /// @param oracle_ Rate oracle (`getRateBps()` returns int bps)
    /// @param spreadBps_ Spread to add to oracle rate (basis points, signed)
    /// @param basis_ Day-count basis to apply
    /// @param floorBps_ Minimum effective rate, or `-10001` to disable
    /// @param capBps_ Maximum effective rate, or `10001` to disable
    constructor(IRateOracle oracle_, int256 spreadBps_, DayCount.Basis basis_, int256 floorBps_, int256 capBps_) {
        oracle = oracle_;
        spreadBps = spreadBps_;
        basis = basis_;
        floorBps = floorBps_;
        capBps = capBps_;
    }

    /// @dev Computes oracle rate + spread, applies floor/cap (when not sentinel), clamps negative to 0
    function _effectiveRateBps() internal view returns (uint256) {
        int256 r = oracle.getRateBps() + spreadBps;
        if (floorBps != -10001 && r < floorBps) r = floorBps;
        if (capBps != 10001 && r > capBps) r = capBps;
        if (r < 0) return 0; // negative pass-through becomes zero from depositor view
        return uint256(r);
    }

    /// @inheritdoc IInterestStrategy
    function previewAccrual(uint256 balance, uint64 fromTs, uint64 toTs) external view returns (uint256) {
        if (balance == 0 || toTs <= fromTs) return 0;
        (uint256 daysCount, uint256 denom) = DayCount.daysAndDenominator(basis, fromTs, toTs);
        if (daysCount == 0) return 0;
        uint256 r = _effectiveRateBps();
        if (r == 0) return 0;
        return (balance * r * daysCount) / (10000 * denom);
    }

    /// @inheritdoc IInterestStrategy
    function kind() external pure returns (string memory) { return "floating"; }
    /// @inheritdoc IInterestStrategy
    function dayCount() external view returns (string memory) { return DayCount.toString(basis); }
}
