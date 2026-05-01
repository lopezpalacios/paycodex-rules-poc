// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IInterestStrategy} from "../interfaces/IInterestStrategy.sol";
import {IRateOracle} from "../interfaces/IRateOracle.sol";
import {DayCount} from "../lib/DayCount.sol";

/// @title FloatingStrategy
/// @notice Reference rate (oracle) + fixed spread, simple interest, optional floor/cap.
/// @dev Reset is at preview time (effectively daily for this demo) — production would snapshot per posting period.
contract FloatingStrategy is IInterestStrategy {
    IRateOracle public immutable oracle;
    int256 public immutable spreadBps;
    DayCount.Basis public immutable basis;
    int256 public immutable floorBps;   // -10001 sentinel = no floor
    int256 public immutable capBps;     // 10001 sentinel = no cap

    constructor(IRateOracle oracle_, int256 spreadBps_, DayCount.Basis basis_, int256 floorBps_, int256 capBps_) {
        oracle = oracle_;
        spreadBps = spreadBps_;
        basis = basis_;
        floorBps = floorBps_;
        capBps = capBps_;
    }

    function _effectiveRateBps() internal view returns (uint256) {
        int256 r = oracle.getRateBps() + spreadBps;
        if (floorBps != -10001 && r < floorBps) r = floorBps;
        if (capBps != 10001 && r > capBps) r = capBps;
        if (r < 0) return 0; // demo: negative pass-through becomes zero from depositor view
        return uint256(r);
    }

    function previewAccrual(uint256 balance, uint64 fromTs, uint64 toTs) external view returns (uint256) {
        if (balance == 0 || toTs <= fromTs) return 0;
        (uint256 daysCount, uint256 denom) = DayCount.daysAndDenominator(basis, fromTs, toTs);
        if (daysCount == 0) return 0;
        uint256 r = _effectiveRateBps();
        if (r == 0) return 0;
        return (balance * r * daysCount) / (10000 * denom);
    }

    function kind() external pure returns (string memory) { return "floating"; }
    function dayCount() external view returns (string memory) { return DayCount.toString(basis); }
}
