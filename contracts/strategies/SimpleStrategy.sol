// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IInterestStrategy} from "../interfaces/IInterestStrategy.sol";
import {DayCount} from "../lib/DayCount.sol";

/// @title SimpleStrategy
/// @notice Simple interest. interest = balance * rateBps * days / (10000 * denom).
contract SimpleStrategy is IInterestStrategy {
    int256 public immutable rateBps;     // signed; negative supported (capped by registry-side validation)
    DayCount.Basis public immutable basis;

    constructor(int256 rateBps_, DayCount.Basis basis_) {
        require(rateBps_ >= -10000 && rateBps_ <= 10000, "Simple: rate out of range");
        rateBps = rateBps_;
        basis = basis_;
    }

    function previewAccrual(uint256 balance, uint64 fromTs, uint64 toTs) external view returns (uint256) {
        if (balance == 0 || rateBps == 0 || toTs <= fromTs) return 0;
        (uint256 daysCount, uint256 denom) = DayCount.daysAndDenominator(basis, fromTs, toTs);
        if (daysCount == 0) return 0;
        if (rateBps < 0) {
            // negative-rate accrual modelled as zero from the deposit-holder's perspective in this demo.
            // Wrap with FloorCap if you want real negative pass-through.
            return 0;
        }
        return (balance * uint256(rateBps) * daysCount) / (10000 * denom);
    }

    function kind() external pure returns (string memory) { return "simple"; }
    function dayCount() external view returns (string memory) { return DayCount.toString(basis); }
}
