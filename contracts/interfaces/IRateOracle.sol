// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IRateOracle
/// @notice Returns current annualised reference rate in basis points. Signed (negative supported, e.g. legacy SNB/ECB).
interface IRateOracle {
    function getRateBps() external view returns (int256 rateBps);
    function name() external view returns (string memory);
}
