// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ITaxCollector
/// @notice WHT remittance audit point. Implementations record received tax amounts
///         and (off-chain or via `remit`) forward them to the relevant tax authority.
interface ITaxCollector {
    function recordCollection(IERC20 asset, uint256 amount, bytes32 ruleId) external;
}
