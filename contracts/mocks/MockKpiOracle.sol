// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IKpiOracle} from "../interfaces/IKpiOracle.sol";

contract MockKpiOracle is IKpiOracle {
    int16 public delta;
    string public override kpiName;

    constructor(int16 initialDelta, string memory name_) {
        delta = initialDelta;
        kpiName = name_;
    }

    function set(int16 newDelta) external {
        delta = newDelta;
    }

    function spreadAdjustmentBps() external view returns (int16) {
        return delta;
    }
}
