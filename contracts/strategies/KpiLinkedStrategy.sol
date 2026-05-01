// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IInterestStrategy} from "../interfaces/IInterestStrategy.sol";
import {IKpiOracle} from "../interfaces/IKpiOracle.sol";
import {DayCount} from "../lib/DayCount.sol";

/// @title KpiLinkedStrategy
/// @notice Base spread adjusted by KPI oracle delta within an allowed range. Simple interest.
contract KpiLinkedStrategy is IInterestStrategy {
    IKpiOracle public immutable kpi;
    int256 public immutable baseSpreadBps;
    int16 public immutable minDelta;
    int16 public immutable maxDelta;
    DayCount.Basis public immutable basis;

    constructor(IKpiOracle kpi_, int256 baseSpreadBps_, int16 minDelta_, int16 maxDelta_, DayCount.Basis basis_) {
        require(maxDelta_ >= minDelta_, "KPI: bad range");
        kpi = kpi_;
        baseSpreadBps = baseSpreadBps_;
        minDelta = minDelta_;
        maxDelta = maxDelta_;
        basis = basis_;
    }

    function _effectiveRateBps() internal view returns (uint256) {
        int16 d = kpi.spreadAdjustmentBps();
        if (d < minDelta) d = minDelta;
        if (d > maxDelta) d = maxDelta;
        int256 r = baseSpreadBps + int256(d);
        if (r < 0) return 0;
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

    function kind() external pure returns (string memory) { return "kpi-linked"; }
    function dayCount() external view returns (string memory) { return DayCount.toString(basis); }
}
