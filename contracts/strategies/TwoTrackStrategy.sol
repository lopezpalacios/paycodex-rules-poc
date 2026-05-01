// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IInterestStrategy} from "../interfaces/IInterestStrategy.sol";
import {DayCount} from "../lib/DayCount.sol";

/// @title TwoTrackStrategy
/// @notice US-style commercial deposit. previewAccrual returns the HARD-interest portion only.
///         ECR (soft-dollar fee offset) is queryable via previewEcr.
/// @dev `previewAccrual` returns ONLY the hard-interest portion that capitalises into principal.
///      Use `previewEcr()` to retrieve the soft-dollar portion that offsets fees on the account-analysis statement.
contract TwoTrackStrategy is IInterestStrategy {
    uint256 public immutable rateBps;
    uint256 public immutable hardPortionBps;   // e.g. 5000 = 50%
    uint256 public immutable ecrPortionBps;    // e.g. 5000 = 50%
    uint256 public immutable reserveReqBps;    // applied to ECR portion only
    DayCount.Basis public immutable basis;

    error PortionOverflow(uint256 sum);
    error RateTooHigh(uint256 rateBps);
    error ReserveTooHigh(uint256 reserveBps);

    constructor(uint256 rateBps_, uint256 hardPortionBps_, uint256 ecrPortionBps_, uint256 reserveReqBps_, DayCount.Basis basis_) {
        if (hardPortionBps_ + ecrPortionBps_ > 10000) revert PortionOverflow(hardPortionBps_ + ecrPortionBps_);
        if (rateBps_ > 10000) revert RateTooHigh(rateBps_);
        if (reserveReqBps_ > 10000) revert ReserveTooHigh(reserveReqBps_);
        rateBps = rateBps_;
        hardPortionBps = hardPortionBps_;
        ecrPortionBps = ecrPortionBps_;
        reserveReqBps = reserveReqBps_;
        basis = basis_;
    }

    function previewAccrual(uint256 balance, uint64 fromTs, uint64 toTs) external view returns (uint256) {
        if (balance == 0 || rateBps == 0 || toTs <= fromTs) return 0;
        (uint256 daysCount, uint256 denom) = DayCount.daysAndDenominator(basis, fromTs, toTs);
        if (daysCount == 0) return 0;
        // gross = balance * rate * days / (10000 * denom)
        uint256 gross = (balance * rateBps * daysCount) / (10000 * denom);
        return (gross * hardPortionBps) / 10000;
    }

    /// @notice ECR (earnings credit rate) accrual. Soft dollar — fee offset only, NOT capitalised. Reserve requirement reduces base.
    function previewEcr(uint256 avgCollectedBalance, uint64 fromTs, uint64 toTs) external view returns (uint256) {
        if (avgCollectedBalance == 0 || rateBps == 0 || toTs <= fromTs) return 0;
        (uint256 daysCount, uint256 denom) = DayCount.daysAndDenominator(basis, fromTs, toTs);
        if (daysCount == 0) return 0;
        uint256 base = (avgCollectedBalance * (10000 - reserveReqBps)) / 10000;
        uint256 gross = (base * rateBps * daysCount) / (10000 * denom);
        return (gross * ecrPortionBps) / 10000;
    }

    function kind() external pure returns (string memory) { return "two-track"; }
    function dayCount() external view returns (string memory) { return DayCount.toString(basis); }
}
