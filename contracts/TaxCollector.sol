// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITaxCollector} from "./interfaces/ITaxCollector.sol";

/// @title TaxCollector
/// @notice Single destination for withholding-tax remittance from many deposits.
///         Records every receipt as an event for off-chain audit + remittance schedule.
/// @dev In a real bank deployment this would forward to the tax authority's account
///      (CH ESTV / EU national authority / UK HMRC / etc.) on the regulator's schedule.
///      Here it just holds + records.
contract TaxCollector is ITaxCollector {
    using SafeERC20 for IERC20;

    address public immutable operator;
    string  public regime;                       // e.g. "CH-VST", "EU-DAC2", "UK-GROSS" — set once in constructor

    mapping(IERC20 => uint256) public collectedTotal;   // running total per asset

    event Collected(
        address indexed deposit,
        IERC20  indexed asset,
        uint256 amount,
        bytes32 ruleId,
        uint256 newCumulativeTotal
    );

    event Remitted(
        IERC20  indexed asset,
        address indexed authority,
        uint256 amount,
        string  referenceId
    );

    error NotOperator();
    error ZeroAddress();

    constructor(address operator_, string memory regime_) {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        regime = regime_;
    }

    /// @notice Called by InterestBearingDeposit to record + receive a WHT remittance.
    /// @dev The deposit pre-transfers `amount` of `asset` to this contract; this fn
    ///      only emits the audit event + bumps the running total. Pull-payment style
    ///      to keep the gas predictable on the deposit side.
    function recordCollection(IERC20 asset, uint256 amount, bytes32 ruleId) external override {
        collectedTotal[asset] += amount;
        emit Collected(msg.sender, asset, amount, ruleId, collectedTotal[asset]);
    }

    /// @notice Operator forwards collected WHT to the tax authority. Off-chain
    ///         remittance schedule is encoded in `referenceId` (e.g. quarterly
    ///         remittance ID for ESTV).
    function remit(IERC20 asset, address authority, uint256 amount, string calldata referenceId) external {
        if (msg.sender != operator) revert NotOperator();
        if (authority == address(0)) revert ZeroAddress();
        asset.safeTransfer(authority, amount);
        emit Remitted(asset, authority, amount, referenceId);
    }
}
