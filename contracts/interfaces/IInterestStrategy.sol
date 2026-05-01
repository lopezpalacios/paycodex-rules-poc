// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IInterestStrategy
/// @notice Pluggable accrual logic. One strategy per rule kind (simple, compound, tiered, floating, kpi-linked, two-track).
interface IInterestStrategy {
    /// @notice Compute interest accrued on `balance` over the period `[fromTs, toTs]`.
    /// @param balance Underlying balance (constant over period — caller responsible for averaging if needed).
    /// @param fromTs Start timestamp (unix seconds, inclusive).
    /// @param toTs End timestamp (unix seconds, exclusive).
    /// @return interestAmount Interest in same base units as `balance`.
    function previewAccrual(
        uint256 balance,
        uint64 fromTs,
        uint64 toTs
    ) external view returns (uint256 interestAmount);

    /// @notice Strategy kind label, e.g. "simple", "compound", "tiered".
    function kind() external view returns (string memory);

    /// @notice Day-count basis used: act/360, act/365, 30/360, act/act-isda.
    function dayCount() external view returns (string memory);
}
