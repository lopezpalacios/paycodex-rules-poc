// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IInterestStrategy} from "./interfaces/IInterestStrategy.sol";
import {ITaxCollector} from "./interfaces/ITaxCollector.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @title InterestBearingDeposit
/// @notice Single-customer deposit that accrues interest per a pluggable strategy.
///         Interest is posted on demand. WHT (when enabled) is transferred to a
///         TaxCollector on every post, with the deposit's principal credited net.
/// @dev Demo: avg-daily-balance approximated by point-in-time balance at posting.
contract InterestBearingDeposit {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;
    IInterestStrategy public immutable strategy;
    address public immutable customer;
    bytes32 public immutable ruleId;

    uint256 public principal;       // current outstanding principal
    uint256 public accruedInterest; // accrued but unposted
    uint64  public lastPostedAt;

    // Withholding (optional)
    bool    public immutable whtEnabled;
    uint256 public immutable whtBps;
    address public immutable taxCollector;   // zero when WHT not enabled

    event Deposited(uint256 amount, uint256 newPrincipal);
    event Withdrawn(uint256 amount, uint256 newPrincipal);
    event Posted(uint256 grossInterest, uint256 whtAmount, uint256 netCredited, uint64 atTs);

    error NotCustomer();
    error InsufficientFunds();
    error ZeroAddress();
    error WhtRequiresCollector();

    constructor(
        IERC20 asset_,
        IInterestStrategy strategy_,
        address customer_,
        bytes32 ruleId_,
        bool whtEnabled_,
        uint256 whtBps_,
        address taxCollector_
    ) {
        if (address(asset_) == address(0) || address(strategy_) == address(0) || customer_ == address(0)) {
            revert ZeroAddress();
        }
        if (whtEnabled_ && taxCollector_ == address(0)) revert WhtRequiresCollector();
        asset = asset_;
        strategy = strategy_;
        customer = customer_;
        ruleId = ruleId_;
        whtEnabled = whtEnabled_;
        whtBps = whtBps_;
        taxCollector = taxCollector_;
        lastPostedAt = uint64(block.timestamp);
    }

    modifier onlyCustomer() {
        if (msg.sender != customer) revert NotCustomer();
        _;
    }

    function deposit(uint256 amount) external onlyCustomer {
        _accrueToNow();
        asset.safeTransferFrom(msg.sender, address(this), amount);
        principal += amount;
        emit Deposited(amount, principal);
    }

    function withdraw(uint256 amount) external onlyCustomer {
        _accrueToNow();
        if (amount > principal) revert InsufficientFunds();
        principal -= amount;
        asset.safeTransfer(msg.sender, amount);
        emit Withdrawn(amount, principal);
    }

    /// @notice Post accrued interest: bank mints `gross` of `asset` into the deposit's
    ///         balance (covering interest credit), the WHT slice is transferred to the
    ///         tax collector, and the net is capitalised into principal.
    /// @dev For PoC: `asset` is MockERC20 with permissionless `mint(...)`. Real bank
    ///      deployment uses a controlled mint authority (treasury operations) that
    ///      this contract is permissioned to invoke. The mint represents the bank
    ///      crediting interest from its NIM book — see CHANGELOG iter 16 +
    ///      paycodex/concepts/interest-calculation.md.
    function postInterest() external returns (uint256 netCredited) {
        _accrueToNow();
        // === Checks + Effects (state writes happen BEFORE any external call) ===
        uint256 gross = accruedInterest;
        accruedInterest = 0;
        uint256 wht = whtEnabled && gross > 0 ? (gross * whtBps) / 10000 : 0;
        netCredited = gross - wht;
        principal += netCredited;
        emit Posted(gross, wht, netCredited, uint64(block.timestamp));

        // === Interactions (last, after all state writes) ===
        if (gross > 0) {
            // Mint gross interest into this deposit (bank-issued credit). For PoC,
            // MockERC20 has permissionless mint; production wires this to the bank's
            // treasury / mint authority.
            IMintable(address(asset)).mint(address(this), gross);
            if (wht > 0) {
                asset.safeTransfer(taxCollector, wht);
                ITaxCollector(taxCollector).recordCollection(asset, wht, ruleId);
            }
        }
    }

    /// @notice Read-only preview of accrual from `lastPostedAt` to `block.timestamp`, plus already-accrued.
    function previewAccrual() external view returns (uint256) {
        uint256 freshly = strategy.previewAccrual(principal, lastPostedAt, uint64(block.timestamp));
        return accruedInterest + freshly;
    }

    function _accrueToNow() internal {
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs <= lastPostedAt) return;
        uint256 freshly = strategy.previewAccrual(principal, lastPostedAt, nowTs);
        accruedInterest += freshly;
        lastPostedAt = nowTs;
    }
}
