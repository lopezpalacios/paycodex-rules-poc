// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IInterestStrategy} from "../interfaces/IInterestStrategy.sol";
import {DayCount} from "../lib/DayCount.sol";

/// @title TieredStrategy
/// @notice Marginal-tier interest. Balance is sliced through ascending bands, each portion accrues at band rate.
/// @dev Tiers MUST be sorted by `upTo` ascending. Last tier `upTo = type(uint256).max` represents "and above".
contract TieredStrategy is IInterestStrategy {
    struct Tier {
        uint256 upTo;
        uint256 bps;
    }

    Tier[] private _tiers;
    DayCount.Basis public immutable basis;

    constructor(uint256[] memory upTos, uint256[] memory bpsList, DayCount.Basis basis_) {
        require(upTos.length == bpsList.length && upTos.length > 0, "Tiered: bad length");
        for (uint256 i = 0; i < upTos.length; i++) {
            if (i > 0) require(upTos[i] > upTos[i - 1], "Tiered: not sorted");
            require(bpsList[i] <= 10000, "Tiered: rate too high");
            _tiers.push(Tier({ upTo: upTos[i], bps: bpsList[i] }));
        }
        basis = basis_;
    }

    function tiersLength() external view returns (uint256) { return _tiers.length; }
    function tierAt(uint256 i) external view returns (uint256 upTo, uint256 bps) {
        Tier storage t = _tiers[i];
        return (t.upTo, t.bps);
    }

    function previewAccrual(uint256 balance, uint64 fromTs, uint64 toTs) external view returns (uint256) {
        if (balance == 0 || toTs <= fromTs) return 0;
        (uint256 daysCount, uint256 denom) = DayCount.daysAndDenominator(basis, fromTs, toTs);
        if (daysCount == 0) return 0;

        uint256 prevBound = 0;
        uint256 totalInterest = 0;
        for (uint256 i = 0; i < _tiers.length; i++) {
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

    function kind() external pure returns (string memory) { return "tiered"; }
    function dayCount() external view returns (string memory) { return DayCount.toString(basis); }
}
