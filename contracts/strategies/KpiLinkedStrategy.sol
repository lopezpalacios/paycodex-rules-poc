// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IInterestStrategy} from "../interfaces/IInterestStrategy.sol";
import {IKpiOracle} from "../interfaces/IKpiOracle.sol";
import {DayCount} from "../lib/DayCount.sol";

/// @title KpiLinkedStrategy
/// @notice Base spread adjusted by a KPI oracle delta, clamped to a declared range. Simple interest.
///         Pattern: ESG-linked products where the rate moves up/down based on a measured KPI
///         (carbon emissions, audit scores, supply-chain attestation, etc).
/// @dev Effective rate = `baseSpreadBps + clamp(kpi.delta, minDelta, maxDelta)`. KPI oracle is
///      consulted at preview time. The clamp protects both customer and bank from a malicious or
///      malfunctioning KPI source — even a wildly out-of-band delta only moves the rate within
///      the declared `[minDelta, maxDelta]` range.
contract KpiLinkedStrategy is IInterestStrategy {
    /// @notice KPI source — returns a signed delta in bps
    IKpiOracle public immutable kpi;
    /// @notice Base spread before KPI adjustment, in basis points (signed)
    int256 public immutable baseSpreadBps;
    /// @notice Lower clamp on KPI delta
    int16 public immutable minDelta;
    /// @notice Upper clamp on KPI delta
    int16 public immutable maxDelta;
    /// @notice Day-count basis enum (see `DayCount.Basis`)
    DayCount.Basis public immutable basis;

    /// @notice Constructor `maxDelta_ < minDelta_`
    /// @param minDelta The supplied lower bound
    /// @param maxDelta The supplied upper bound
    error BadRange(int16 minDelta, int16 maxDelta);

    /// @param kpi_ KPI oracle returning a signed bps delta
    /// @param baseSpreadBps_ Base spread before KPI adjustment
    /// @param minDelta_ Lower bound on KPI delta
    /// @param maxDelta_ Upper bound on KPI delta
    /// @param basis_ Day-count basis to apply
    constructor(IKpiOracle kpi_, int256 baseSpreadBps_, int16 minDelta_, int16 maxDelta_, DayCount.Basis basis_) {
        if (maxDelta_ < minDelta_) revert BadRange(minDelta_, maxDelta_);
        kpi = kpi_;
        baseSpreadBps = baseSpreadBps_;
        minDelta = minDelta_;
        maxDelta = maxDelta_;
        basis = basis_;
    }

    /// @dev Reads KPI delta, clamps to [minDelta, maxDelta], adds to baseSpread, floors negatives at 0
    function _effectiveRateBps() internal view returns (uint256) {
        int16 d = kpi.spreadAdjustmentBps();
        if (d < minDelta) d = minDelta;
        if (d > maxDelta) d = maxDelta;
        int256 r = baseSpreadBps + int256(d);
        if (r < 0) return 0;
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
    function kind() external pure returns (string memory) { return "kpi-linked"; }
    /// @inheritdoc IInterestStrategy
    function dayCount() external view returns (string memory) { return DayCount.toString(basis); }
}
