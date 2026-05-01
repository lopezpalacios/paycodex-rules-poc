// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IInterestStrategy} from "../interfaces/IInterestStrategy.sol";
import {DayCount} from "../lib/DayCount.sol";

/// @title StepUpStrategy
/// @notice Schedule-based piecewise-constant interest rate. Rate steps up (or down) at
///         predefined timestamps. Real-bank pattern: sustainability-linked bonds where the
///         coupon increases on a fixed date if a KPI is not met by then. Each step's rate
///         applies from `step[i].atTimestamp` until `step[i+1].atTimestamp` (or forever for
///         the last step). Time before the first step accrues zero (coupon hasn't started).
/// @dev Steps must be strictly ascending by `atTimestamp` and each `bps` must be ≤ 10_000.
///      The schedule is fixed at construction — to revise the path, deploy a new strategy
///      under a new ruleId and deprecate the old one. `previewAccrual` integrates over each
///      step's overlap with `[fromTs, toTs]`, summing piecewise contributions.
contract StepUpStrategy is IInterestStrategy {
    /// @notice One scheduled step
    /// @param atTimestamp Unix-second timestamp at which this step's rate becomes effective
    /// @param bps Annualised rate in basis points (≤ 10_000) effective from `atTimestamp`
    struct Step {
        uint64  atTimestamp;
        uint256 bps;
    }

    Step[] private _steps;

    /// @notice Day-count basis enum (see `DayCount.Basis`)
    DayCount.Basis public immutable basis;

    /// @notice Constructor `timestamps.length` and `bpsList.length` mismatch, or both zero
    error BadLength();
    /// @notice Step `atTimestamp` values are not strictly ascending
    /// @param index Index of the offending step
    error NotSorted(uint256 index);
    /// @notice A step's rate exceeded 10_000 bps
    /// @param index Index of the offending step
    /// @param rateBps The supplied bad value
    error RateTooHigh(uint256 index, uint256 rateBps);

    /// @param timestamps Strictly ascending unix-second timestamps for each step
    /// @param bpsList Rates per step, parallel to `timestamps`
    /// @param basis_ Day-count basis to apply
    constructor(uint64[] memory timestamps, uint256[] memory bpsList, DayCount.Basis basis_) {
        if (timestamps.length != bpsList.length || timestamps.length == 0) revert BadLength();
        for (uint256 i = 0; i < timestamps.length; i++) {
            if (i > 0 && timestamps[i] <= timestamps[i - 1]) revert NotSorted(i);
            if (bpsList[i] > 10000) revert RateTooHigh(i, bpsList[i]);
            _steps.push(Step({ atTimestamp: timestamps[i], bps: bpsList[i] }));
        }
        basis = basis_;
    }

    /// @notice Number of configured steps
    function stepsLength() external view returns (uint256) { return _steps.length; }

    /// @notice Read a single step
    /// @param i Step index
    /// @return atTimestamp Effective-from timestamp for this step
    /// @return bps Rate (basis points) for this step
    function stepAt(uint256 i) external view returns (uint64 atTimestamp, uint256 bps) {
        Step storage s = _steps[i];
        return (s.atTimestamp, s.bps);
    }

    /// @inheritdoc IInterestStrategy
    /// @dev Iterates the schedule once, summing each step's contribution over its overlap with
    ///      `[fromTs, toTs]`. O(n) in step count. Day-count denominator comes from the library.
    function previewAccrual(uint256 balance, uint64 fromTs, uint64 toTs) external view returns (uint256) {
        if (balance == 0 || toTs <= fromTs) return 0;
        uint256 total = 0;
        uint256 n = _steps.length;
        for (uint256 i = 0; i < n; i++) {
            total += _stepContribution(i, n, balance, fromTs, toTs);
        }
        return total;
    }

    function _stepContribution(
        uint256 i,
        uint256 n,
        uint256 balance,
        uint64 fromTs,
        uint64 toTs
    ) internal view returns (uint256) {
        uint64 stepStart = _steps[i].atTimestamp;
        uint64 stepEnd = (i + 1 < n) ? _steps[i + 1].atTimestamp : type(uint64).max;
        uint64 subFrom = fromTs > stepStart ? fromTs : stepStart;
        uint64 subTo = toTs < stepEnd ? toTs : stepEnd;
        if (subFrom >= subTo) return 0;
        (uint256 daysInStep, uint256 denom) = DayCount.daysAndDenominator(basis, subFrom, subTo);
        if (daysInStep == 0) return 0;
        return (balance * _steps[i].bps * daysInStep) / (10000 * denom);
    }

    /// @inheritdoc IInterestStrategy
    function kind() external pure returns (string memory) { return "step-up"; }
    /// @inheritdoc IInterestStrategy
    function dayCount() external view returns (string memory) { return DayCount.toString(basis); }
}
