// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRateOracle} from "../interfaces/IRateOracle.sol";

contract MockRateOracle is IRateOracle {
    int256 public rate;
    string public override name;

    constructor(int256 initialBps, string memory name_) {
        rate = initialBps;
        name = name_;
    }

    function set(int256 newBps) external {
        rate = newBps;
    }

    function getRateBps() external view returns (int256) {
        return rate;
    }
}
