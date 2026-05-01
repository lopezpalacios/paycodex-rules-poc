// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title WadMath
/// @notice Minimal 1e18 fixed-point math for compound accrual.
library WadMath {
    uint256 internal constant WAD = 1e18;

    function wmul(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * b) / WAD;
    }

    /// @notice Compute base^exp using exponentiation-by-squaring on a wad-scaled `base`.
    /// @dev base is wad-scaled (e.g. 1.0001e18 means 1.0001). exp is integer (number of compounding periods).
    function rpow(uint256 base, uint256 exp) internal pure returns (uint256 result) {
        result = WAD;
        uint256 b = base;
        uint256 e = exp;
        while (e > 0) {
            if (e & 1 == 1) {
                result = wmul(result, b);
            }
            b = wmul(b, b);
            e >>= 1;
        }
    }
}
