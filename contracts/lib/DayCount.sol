// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DayCount
/// @notice Day-count fraction helpers. Returns numerator/denominator pair so caller controls rounding.
/// @dev Demo simplifications:
///      - act/* uses (toTs - fromTs) / 86400 for days (no leap-second handling).
///      - 30/360 uses crude approximation: (toTs - fromTs)/86400 days, denominator 360 (ignores month-end conventions).
///      - act/act-isda treated as act/365 for simplicity.
library DayCount {
    uint256 internal constant SECONDS_PER_DAY = 86400;

    enum Basis { ACT_360, ACT_365, THIRTY_360, ACT_ACT_ISDA }

    /// @notice Returns day-count fraction as (days, denominator). Caller does `principal * rateBps * days / (10000 * denom)`.
    function daysAndDenominator(Basis b, uint64 fromTs, uint64 toTs)
        internal
        pure
        returns (uint256 daysCount, uint256 denominator)
    {
        require(toTs >= fromTs, "DayCount: negative period");
        daysCount = (uint256(toTs) - uint256(fromTs)) / SECONDS_PER_DAY;
        if (b == Basis.ACT_360) denominator = 360;
        else if (b == Basis.ACT_365) denominator = 365;
        else if (b == Basis.THIRTY_360) denominator = 360;
        else denominator = 365; // ACT_ACT_ISDA simplified
    }

    function fromString(string memory s) internal pure returns (Basis) {
        bytes32 h = keccak256(bytes(s));
        if (h == keccak256("act/360")) return Basis.ACT_360;
        if (h == keccak256("act/365")) return Basis.ACT_365;
        if (h == keccak256("30/360")) return Basis.THIRTY_360;
        if (h == keccak256("act/act-isda")) return Basis.ACT_ACT_ISDA;
        revert("DayCount: unknown basis");
    }

    function toString(Basis b) internal pure returns (string memory) {
        if (b == Basis.ACT_360) return "act/360";
        if (b == Basis.ACT_365) return "act/365";
        if (b == Basis.THIRTY_360) return "30/360";
        return "act/act-isda";
    }
}
