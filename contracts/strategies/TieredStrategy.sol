// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IInterestStrategy} from "../interfaces/IInterestStrategy.sol";
import {DayCount} from "../lib/DayCount.sol";

/// @title TieredStrategy
/// @notice Marginal-tier interest: each balance band accrues at its own rate. The customer's
///         balance is sliced through ascending bands; portions of the balance falling in band `i`
///         accrue at `tiers[i].bps`. Industry-standard "marginal" semantics (NOT "blended"-tier).
/// @dev Tier list is fixed at construction. To change bands or rates, deploy a new strategy and
///      register it under a new ruleId; deprecate the old one. Last tier should have
///      `upTo = type(uint256).max` to represent "and above". The constructor validates ascending
///      order and rate ceiling but doesn't enforce that the last tier hits MAX_UINT — caller
///      responsibility.
contract TieredStrategy is IInterestStrategy {
    /// @notice One tier band
    /// @param upTo Upper bound (inclusive) of the balance for this band's rate to apply
    /// @param bps Rate in basis points for the slice of balance in this band
    struct Tier {
        uint256 upTo;
        uint256 bps;
    }

    Tier[] private _tiers;

    /// @notice Day-count basis enum (see `DayCount.Basis`)
    DayCount.Basis public immutable basis;

    /// @notice Constructor `upTos.length` and `bpsList.length` mismatch, or both zero
    error BadLength();
    /// @notice Tier `upTo` values are not strictly ascending
    /// @param index Index of the offending tier
    error NotSorted(uint256 index);
    /// @notice A tier's rate exceeded 10_000 bps
    /// @param index Index of the offending tier
    /// @param rateBps The supplied bad value
    error RateTooHigh(uint256 index, uint256 rateBps);

    /// @param upTos Upper bounds for each tier, strictly ascending
    /// @param bpsList Rates per tier, parallel to `upTos`
    /// @param basis_ Day-count basis to apply
    constructor(uint256[] memory upTos, uint256[] memory bpsList, DayCount.Basis basis_) {
        if (upTos.length != bpsList.length || upTos.length == 0) revert BadLength();
        for (uint256 i = 0; i < upTos.length; i++) {
            if (i > 0 && upTos[i] <= upTos[i - 1]) revert NotSorted(i);
            if (bpsList[i] > 10000) revert RateTooHigh(i, bpsList[i]);
            _tiers.push(Tier({ upTo: upTos[i], bps: bpsList[i] }));
        }
        basis = basis_;
    }

    /// @notice Number of configured tiers
    function tiersLength() external view returns (uint256) { return _tiers.length; }

    /// @notice Read a single tier
    /// @param i Tier index
    /// @return upTo Upper bound for this tier
    /// @return bps Rate (basis points) for this tier
    function tierAt(uint256 i) external view returns (uint256 upTo, uint256 bps) {
        Tier storage t = _tiers[i];
        return (t.upTo, t.bps);
    }

    /// @inheritdoc IInterestStrategy
    function previewAccrual(uint256 balance, uint64 fromTs, uint64 toTs) external view returns (uint256) {
        if (balance == 0 || toTs <= fromTs) return 0;
        (uint256 daysCount, uint256 denom) = DayCount.daysAndDenominator(basis, fromTs, toTs);
        if (daysCount == 0) return 0;

        uint256 prevBound = 0;
        uint256 totalInterest = 0;
        uint256 nTiers = _tiers.length;
        for (uint256 i = 0; i < nTiers; i++) {
            Tier storage t = _tiers[i];
            if (balance <= prevBound) break;
            uint256 sliceTop = balance < t.upTo ? balance : t.upTo;
            uint256 slice = sliceTop - prevBound;
            totalInterest += (slice * t.bps * daysCount) / (10000 * denom);
            prevBound = t.upTo;
            if (balance <= t.upTo) break;
        }
        return totalInterest;
    }

    /// @inheritdoc IInterestStrategy
    function kind() external pure returns (string memory) { return "tiered"; }
    /// @inheritdoc IInterestStrategy
    function dayCount() external view returns (string memory) { return DayCount.toString(basis); }
}
