// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IInterestStrategy} from "./interfaces/IInterestStrategy.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @title InterestBearingPool
/// @author paycodex-rules-poc
/// @notice Multi-holder pooled deposit with Aave-style liquidity index. Many depositors share
///         a single strategy contract; each holds a "scaled balance" that, when multiplied by
///         the pool-wide `liquidityIndex`, gives their current claim. Index grows over time as
///         interest accrues to the pool. O(1) per user — transfers don't trigger per-user
///         interest math.
/// @dev Pool-level rate semantics: the strategy is consulted once per `_updateIndex` against
///      the pool's total notional balance. For non-rate-balance-dependent strategies (`simple`,
///      `compound`, `floating`, `kpi-linked`, `two-track`, `step-up`) all depositors earn the
///      same effective rate. For `tiered`, the pool earns at the BLENDED tier rate for its
///      total balance — depositors get the same blended rate, not their individual tier rates.
///      Use `InterestBearingDeposit` (single-holder) when per-user tier rates matter.
///
///      RAY = 1e27 fixed-point scaling for `liquidityIndex` (matches Aave V2/V3 convention).
///      `liquidityIndex` starts at `RAY` (= 1.0) and grows monotonically. `scaledBalance[user]`
///      is the user's deposit divided by the index AT THE TIME OF DEPOSIT.
///
///      Withdrawals burn token-tier amount (not scaled). The mapping handles the conversion.
contract InterestBearingPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant RAY = 1e27;

    /// @notice Underlying asset (must implement `IMintable.mint` for accrual)
    IERC20 public immutable asset;
    /// @notice Pluggable accrual logic
    IInterestStrategy public immutable strategy;
    /// @notice Identifier of the rule this pool is bound to
    bytes32 public immutable ruleId;

    /// @notice Cumulative liquidity index, RAY-scaled. Starts at RAY (1.0) and only ever grows.
    uint256 public liquidityIndex;
    /// @notice Last time `_updateIndex` ran. Updated on every state-changing call.
    uint64 public lastUpdateTs;

    /// @notice Per-user scaled balance. `actualBalance(user) = scaledBalance[user] × liquidityIndex / RAY`.
    mapping(address => uint256) public scaledBalance;
    /// @notice Sum of all `scaledBalance` values; used to compute pool-level notional for accrual.
    uint256 public totalScaledBalance;

    /// @notice Emitted when a user deposits
    /// @param user The depositor
    /// @param amount Tokens deposited (in `asset` base units)
    /// @param scaledMinted Scaled-balance shares minted to `user`
    /// @param newIndex Liquidity index AFTER `_updateIndex` ran
    event Deposited(address indexed user, uint256 amount, uint256 scaledMinted, uint256 newIndex);
    /// @notice Emitted when a user withdraws
    event Withdrawn(address indexed user, uint256 amount, uint256 scaledBurnt, uint256 newIndex);
    /// @notice Emitted whenever the index advances. `dt` is seconds since last update.
    event IndexUpdated(uint256 newIndex, uint256 mintedToAccrue, uint64 dt);

    error ZeroAddress();
    error InsufficientBalance();
    error ZeroAmount();

    /// @param asset_ Underlying ERC20 (must implement `IMintable.mint`)
    /// @param strategy_ Interest accrual logic; bound for the pool's lifetime
    /// @param ruleId_ Identifier of the rule this pool was deployed against
    constructor(IERC20 asset_, IInterestStrategy strategy_, bytes32 ruleId_) {
        if (address(asset_) == address(0) || address(strategy_) == address(0)) revert ZeroAddress();
        asset = asset_;
        strategy = strategy_;
        ruleId = ruleId_;
        liquidityIndex = RAY;
        lastUpdateTs = uint64(block.timestamp);
    }

    /// @notice Deposit `amount` into the pool. Caller must have approved `address(this)` for `amount`.
    /// @param amount Tokens to deposit
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        // _updateIndex doesn't perform any external call (returns the delta for the caller to mint).
        uint256 freshInterest = _updateIndex();
        // === Effects ===
        uint256 scaledMinted = (amount * RAY) / liquidityIndex;
        scaledBalance[msg.sender] += scaledMinted;
        totalScaledBalance += scaledMinted;
        emit Deposited(msg.sender, amount, scaledMinted, liquidityIndex);
        // === Interactions (last; nonReentrant guards re-entry) ===
        if (freshInterest > 0) IMintable(address(asset)).mint(address(this), freshInterest);
        asset.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Withdraw `amount` (in underlying token units) from the pool.
    /// @param amount Tokens to withdraw
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 freshInterest = _updateIndex();
        // === Effects ===
        uint256 scaledBurnt = (amount * RAY + liquidityIndex - 1) / liquidityIndex; // round up
        if (scaledBurnt > scaledBalance[msg.sender]) revert InsufficientBalance();
        scaledBalance[msg.sender] -= scaledBurnt;
        totalScaledBalance -= scaledBurnt;
        emit Withdrawn(msg.sender, amount, scaledBurnt, liquidityIndex);
        // === Interactions ===
        if (freshInterest > 0) IMintable(address(asset)).mint(address(this), freshInterest);
        asset.safeTransfer(msg.sender, amount);
    }

    /// @notice Read the current claim of `user` in underlying tokens (includes accrued interest).
    /// @param user Account to query
    function balanceOf(address user) external view returns (uint256) {
        uint256 idx = _previewIndex();
        return (scaledBalance[user] * idx) / RAY;
    }

    /// @notice Total underlying balance the pool manages, including accrued-but-unminted interest.
    function totalUnderlying() external view returns (uint256) {
        uint256 idx = _previewIndex();
        return (totalScaledBalance * idx) / RAY;
    }

    /// @notice Preview the liquidity index that would result if `_updateIndex` were called now.
    function previewIndex() external view returns (uint256) {
        return _previewIndex();
    }

    /// @dev Read-only computation of what the index would advance to. Mirrors `_updateIndex`'s
    ///      math without the storage write or mint.
    function _previewIndex() internal view returns (uint256) {
        uint64 nowTs = uint64(block.timestamp);
        // slither-disable-next-line incorrect-equality
        if (nowTs <= lastUpdateTs || totalScaledBalance == 0) return liquidityIndex;
        uint256 currentNotional = (totalScaledBalance * liquidityIndex) / RAY;
        // slither-disable-next-line incorrect-equality
        if (currentNotional == 0) return liquidityIndex;
        uint256 freshInterest = strategy.previewAccrual(currentNotional, lastUpdateTs, nowTs);
        // slither-disable-next-line incorrect-equality
        if (freshInterest == 0) return liquidityIndex;
        // Index growth proportional to interest/balance: newIndex = oldIndex * (1 + I/B)
        return liquidityIndex + (liquidityIndex * freshInterest) / currentNotional;
    }

    /// @dev Snapshot interest accrual into `liquidityIndex`. Returns the amount of fresh interest
    ///      that the CALLER must mint into the pool (so token balance stays in sync with the index).
    ///      No external calls inside this function — keeps deposit/withdraw's CEI clean.
    function _updateIndex() internal returns (uint256 freshInterest) {
        uint64 nowTs = uint64(block.timestamp);
        // slither-disable-next-line incorrect-equality
        if (nowTs <= lastUpdateTs || totalScaledBalance == 0) {
            lastUpdateTs = nowTs;
            return 0;
        }
        uint256 currentNotional = (totalScaledBalance * liquidityIndex) / RAY;
        // slither-disable-next-line incorrect-equality
        if (currentNotional == 0) {
            lastUpdateTs = nowTs;
            return 0;
        }
        freshInterest = strategy.previewAccrual(currentNotional, lastUpdateTs, nowTs);
        uint64 dt = nowTs - lastUpdateTs;
        lastUpdateTs = nowTs;
        if (freshInterest > 0) {
            liquidityIndex = liquidityIndex + (liquidityIndex * freshInterest) / currentNotional;
            emit IndexUpdated(liquidityIndex, freshInterest, dt);
        }
    }
}
