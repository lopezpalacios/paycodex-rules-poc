// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IInterestStrategy} from "../interfaces/IInterestStrategy.sol";
import {DayCount} from "../lib/DayCount.sol";

/// @title TwoTrackStrategy
/// @notice US-style commercial deposit splitting interest into two tracks: HARD interest (cash,
///         taxable, capitalises into principal) and ECR (Earnings Credit Rate — soft dollar, fee
///         offset only on the account-analysis statement, not paid as cash). Common shape:
///         50% hard / 50% ECR with a 10% reserve requirement on the ECR base.
/// @dev `IInterestStrategy.previewAccrual` returns ONLY the hard-interest portion that capitalises
///      into principal — that's what `InterestBearingDeposit` cares about. The ECR portion is
///      queryable via `previewEcr` for the bank's account-analysis statement generator. ECR base
///      is reduced by `reserveReqBps` (a Fed reserve-req approximation; in production wire to the
///      bank's actual reserve calculation).
contract TwoTrackStrategy is IInterestStrategy {
    /// @notice Headline annualised rate in basis points (≤ 10_000)
    uint256 public immutable rateBps;
    /// @notice Fraction of `gross` paid as cash interest, in basis points (e.g. 5000 = 50%)
    uint256 public immutable hardPortionBps;
    /// @notice Fraction of `gross` paid as ECR (fee offset), in basis points
    uint256 public immutable ecrPortionBps;
    /// @notice Reserve requirement applied to the ECR base only, in basis points
    uint256 public immutable reserveReqBps;
    /// @notice Day-count basis enum (see `DayCount.Basis`)
    DayCount.Basis public immutable basis;

    /// @notice `hardPortionBps + ecrPortionBps` exceeded 10_000
    /// @param sum The supplied bad sum
    error PortionOverflow(uint256 sum);
    /// @notice Constructor `rateBps_` exceeded 10_000 bps
    error RateTooHigh(uint256 rateBps);
    /// @notice Constructor `reserveReqBps_` exceeded 10_000 bps
    error ReserveTooHigh(uint256 reserveBps);

    /// @param rateBps_ Headline annualised rate (basis points, ≤ 10_000)
    /// @param hardPortionBps_ Hard-interest fraction (e.g. 5000 = 50%)
    /// @param ecrPortionBps_ ECR fraction (basis points). `hard + ecr` must be ≤ 10_000.
    /// @param reserveReqBps_ Reserve requirement applied to ECR base (basis points)
    /// @param basis_ Day-count basis to apply
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

    /// @inheritdoc IInterestStrategy
    /// @dev Returns the HARD-interest portion only. ECR portion is queried via `previewEcr`.
    function previewAccrual(uint256 balance, uint64 fromTs, uint64 toTs) external view returns (uint256) {
        if (balance == 0 || rateBps == 0 || toTs <= fromTs) return 0;
        (uint256 daysCount, uint256 denom) = DayCount.daysAndDenominator(basis, fromTs, toTs);
        if (daysCount == 0) return 0;
        // Single division at the end to avoid divide-before-multiply precision loss (Slither: divide-before-multiply).
        return (balance * rateBps * daysCount * hardPortionBps) / (10000 * 10000 * denom);
    }

    /// @notice Compute the ECR (Earnings Credit Rate) accrual for a given balance over a period.
    ///         Soft dollar — offsets fees on the account-analysis statement, NOT capitalised
    ///         into principal. The bank's account-analysis system reads this off-chain.
    /// @dev Reserve requirement reduces the base before computing interest. The portion split is
    ///      applied at the end. Multiply all numerators first to avoid divide-before-multiply.
    /// @param avgCollectedBalance Average collected balance over the period (caller's responsibility
    ///        to compute)
    /// @param fromTs Period start (unix seconds)
    /// @param toTs Period end (unix seconds, exclusive)
    /// @return The ECR amount in same base units as `avgCollectedBalance`
    function previewEcr(uint256 avgCollectedBalance, uint64 fromTs, uint64 toTs) external view returns (uint256) {
        if (avgCollectedBalance == 0 || rateBps == 0 || toTs <= fromTs) return 0;
        (uint256 daysCount, uint256 denom) = DayCount.daysAndDenominator(basis, fromTs, toTs);
        if (daysCount == 0) return 0;
        // base * rate * days * ecrPortion * (10000 - reserve) / (10000 ^ 3 * denom)
        return
            (avgCollectedBalance * (10000 - reserveReqBps) * rateBps * daysCount * ecrPortionBps)
            / (10000 * 10000 * 10000 * denom);
    }

    /// @inheritdoc IInterestStrategy
    function kind() external pure returns (string memory) { return "two-track"; }
    /// @inheritdoc IInterestStrategy
    function dayCount() external view returns (string memory) { return DayCount.toString(basis); }
}
