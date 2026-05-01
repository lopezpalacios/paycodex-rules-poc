// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IInterestStrategy} from "./interfaces/IInterestStrategy.sol";
import {ITaxCollector} from "./interfaces/ITaxCollector.sol";

/// @title IMintable
/// @notice Optional minting interface that `asset` must implement for interest credits.
///         The bank's treasury authority gates this in production.
interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @title InterestBearingDeposit
/// @author paycodex-rules-poc
/// @notice Single-customer interest-bearing deposit. Customer deposits and withdraws an underlying
///         ERC20; interest accrues continuously per the bound `IInterestStrategy` and is capitalised
///         into principal on demand via `postInterest`. When WHT is enabled, the withheld portion is
///         routed to a `TaxCollector` for audit + remittance.
/// @dev Single-holder by design — pooled multi-holder deposits would use Pattern B (Aave-style index).
///      Avg-daily-balance is approximated by the point-in-time balance, which is accurate when
///      principal is stable but undercounts interest if the customer deposits/withdraws mid-period.
///      `_accrueToNow` is called on every state-changing entry point so the snapshot always
///      reflects accrual up to `block.timestamp`.
contract InterestBearingDeposit {
    using SafeERC20 for IERC20;

    /// @notice Underlying asset (e.g. tokenised deposit, USDC). Must implement `IMintable` for
    ///         `postInterest` to credit fresh interest tokens.
    IERC20 public immutable asset;
    /// @notice Pluggable interest accrual logic. Reads point-in-time `principal` and `[fromTs,toTs]`.
    IInterestStrategy public immutable strategy;
    /// @notice The single owner of this deposit. Only this address may `deposit`/`withdraw`.
    address public immutable customer;
    /// @notice Identifier of the rule this deposit was deployed against. Pinned for audit; not used
    ///         in any control-flow decision (control flow is via `strategy`).
    bytes32 public immutable ruleId;

    /// @notice Current outstanding principal (excludes accrued-but-unposted interest)
    uint256 public principal;
    /// @notice Interest that has accrued since `lastPostedAt` but has not yet been capitalised
    uint256 public accruedInterest;
    /// @notice Last time `accrueToNow` ran. Updated on every deposit/withdraw/postInterest.
    uint64  public lastPostedAt;

    /// @notice Whether withholding tax applies on `postInterest`
    bool    public immutable whtEnabled;
    /// @notice WHT rate in basis points (e.g. 3500 = 35% for CH-VST)
    uint256 public immutable whtBps;
    /// @notice Address that receives the WHT slice on every post. Zero when `whtEnabled = false`.
    address public immutable taxCollector;

    /// @notice Emitted when the customer deposits more principal
    event Deposited(uint256 amount, uint256 newPrincipal);
    /// @notice Emitted when the customer withdraws principal
    event Withdrawn(uint256 amount, uint256 newPrincipal);
    /// @notice Emitted on every `postInterest`. `grossInterest = whtAmount + netCredited`.
    /// @param grossInterest Total interest credited from the bank's treasury this period
    /// @param whtAmount WHT routed to the tax collector
    /// @param netCredited Amount added to `principal`
    /// @param atTs `block.timestamp` of the posting
    event Posted(uint256 grossInterest, uint256 whtAmount, uint256 netCredited, uint64 atTs);

    /// @notice Caller is not the configured `customer`
    error NotCustomer();
    /// @notice Withdraw amount exceeds current `principal`
    error InsufficientFunds();
    /// @notice Constructor passed a zero address where one isn't allowed
    error ZeroAddress();
    /// @notice Tried to enable WHT without supplying a non-zero `taxCollector`
    error WhtRequiresCollector();

    /// @param asset_ Underlying ERC20 (must implement `IMintable.mint`)
    /// @param strategy_ Interest accrual logic; bound for the lifetime of this deposit
    /// @param customer_ Single-holder address; only they can deposit/withdraw
    /// @param ruleId_ Identifier of the rule this deposit was deployed against (audit anchor)
    /// @param whtEnabled_ Whether WHT applies on `postInterest`
    /// @param whtBps_ WHT rate (basis points); ignored if `whtEnabled_ = false`
    /// @param taxCollector_ Required when `whtEnabled_ = true`; zero address otherwise
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

    /// @notice Restricts to the configured `customer`
    modifier onlyCustomer() {
        if (msg.sender != customer) revert NotCustomer();
        _;
    }

    /// @notice Customer adds principal. Caller must have approved `address(this)` for `amount` of `asset`.
    /// @dev Pre-accrues so the new principal earns interest only from now forward.
    /// @param amount Tokens to deposit (in `asset` base units)
    function deposit(uint256 amount) external onlyCustomer {
        _accrueToNow();
        asset.safeTransferFrom(msg.sender, address(this), amount);
        principal += amount;
        emit Deposited(amount, principal);
    }

    /// @notice Customer removes principal. Reverts `InsufficientFunds` if `amount > principal`.
    /// @dev Pre-accrues so withdrawal doesn't lose accrued-but-unposted interest.
    /// @param amount Tokens to withdraw (in `asset` base units)
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

    /// @notice Read-only total accrual = already-accrued + freshly-accrued since `lastPostedAt`.
    /// @return Sum of stored `accruedInterest` and what would be added by `_accrueToNow()` if called now
    function previewAccrual() external view returns (uint256) {
        uint256 freshly = strategy.previewAccrual(principal, lastPostedAt, uint64(block.timestamp));
        return accruedInterest + freshly;
    }

    /// @dev Snapshot interest accrual into `accruedInterest` and advance `lastPostedAt`. Idempotent
    ///      within a single block (no-op when `nowTs <= lastPostedAt`).
    function _accrueToNow() internal {
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs <= lastPostedAt) return;
        uint256 freshly = strategy.previewAccrual(principal, lastPostedAt, nowTs);
        accruedInterest += freshly;
        lastPostedAt = nowTs;
    }
}
