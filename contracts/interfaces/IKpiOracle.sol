// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IKpiOracle
/// @notice Returns spread adjustment in bps. Negative = discount (KPI met). Positive = penalty (KPI missed).
interface IKpiOracle {
    function spreadAdjustmentBps() external view returns (int16 deltaBps);
    function kpiName() external view returns (string memory);
}
