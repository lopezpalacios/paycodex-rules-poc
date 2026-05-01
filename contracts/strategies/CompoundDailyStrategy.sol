// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IInterestStrategy} from "../interfaces/IInterestStrategy.sol";
import {DayCount} from "../lib/DayCount.sol";
import {WadMath} from "../lib/WadMath.sol";

/// @title CompoundDailyStrategy
/// @notice Daily-compounded fixed rate. interest = balance * ((1 + r/denom)^days - 1).
contract CompoundDailyStrategy is IInterestStrategy {
    using WadMath for uint256;

    uint256 public immutable rateBps;
    DayCount.Basis public immutable basis;

    error RateTooHigh(uint256 rateBps);

    constructor(uint256 rateBps_, DayCount.Basis basis_) {
        if (rateBps_ > 10000) revert RateTooHigh(rateBps_);
        rateBps = rateBps_;
        basis = basis_;
    }

    function previewAccrual(uint256 balance, uint64 fromTs, uint64 toTs) external view returns (uint256) {
        if (balance == 0 || rateBps == 0 || toTs <= fromTs) return 0;
        (uint256 daysCount, uint256 denom) = DayCount.daysAndDenominator(basis, fromTs, toTs);
        if (daysCount == 0) return 0;

        // ratePerDayWad = rateBps / 10000 / denom  → in wad:  rateBps * 1e18 / (10000 * denom)
        uint256 ratePerDayWad = (rateBps * WadMath.WAD) / (10000 * denom);
        uint256 onePlusR = WadMath.WAD + ratePerDayWad;            // wad-scaled (1 + r/n)
        uint256 factor = WadMath.rpow(onePlusR, daysCount);        // (1 + r/n)^days, wad-scaled
        // compounded = balance * factor / 1e18
        uint256 compounded = (balance * factor) / WadMath.WAD;
        return compounded > balance ? compounded - balance : 0;
    }

    function kind() external pure returns (string memory) { return "compound"; }
    function dayCount() external view returns (string memory) { return DayCount.toString(basis); }
}
