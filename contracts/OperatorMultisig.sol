// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title OperatorMultisig
/// @notice K-of-N multisig that wraps any single-operator contract (e.g. `RuleRegistry`).
///         Owners propose calls; once `threshold` approvals accumulate, the call executes
///         on the configured target. Any contract that gates on `msg.sender == operator`
///         can be wrapped by setting its operator to an instance of this multisig.
/// @dev Minimal in-tree implementation. Production banks would reuse a battle-tested
///      Safe (Gnosis Safe) instead — same interface, more features (modules, guards,
///      replay protection, EIP-712 signatures).
contract OperatorMultisig {
    /// @notice Pending or completed multisig proposal record
    /// @param target Contract the call will execute against
    /// @param data Calldata to send to `target`
    /// @param approvals Running count of distinct owner approvals (capped at 32 to fit `uint16`)
    /// @param executed `true` once the call ran (success-only — reverted attempts don't flip this)
    /// @param cancelled `true` if any owner called `cancel(id)` before execution
    struct Proposal {
        address target;
        bytes   data;
        uint16  approvals;
        bool    executed;
        bool    cancelled;
    }

    /// @notice Ordered list of all configured owners
    address[] public owners;
    /// @notice O(1) owner check; used by `onlyOwner`
    mapping(address => bool) public isOwner;
    /// @notice Number of distinct owner approvals required before a proposal auto-executes
    uint256 public immutable threshold;

    Proposal[] private _proposals;

    /// @notice Tracks which owners have approved which proposal (id → owner → bool). Used to
    ///         prevent the same owner double-counting toward `threshold`.
    mapping(uint256 => mapping(address => bool)) public approvedBy;

    /// @notice Emitted when an owner submits a new proposal. Auto-approval by submitter is in a
    ///         separate `ProposalApproved` event with `approvals=1`.
    event ProposalSubmitted(uint256 indexed id, address indexed proposer, address indexed target, bytes data);
    /// @notice Emitted on every approval (including the submitter's auto-approval). Includes the
    ///         running `approvals` count for off-chain observers to know if threshold is met.
    event ProposalApproved(uint256 indexed id, address indexed approver, uint16 approvals);
    /// @notice Emitted when threshold is reached and the call succeeds. `returnData` is whatever
    ///         the target call returned (ABI-encoded; decode per the target ABI).
    event ProposalExecuted(uint256 indexed id, bytes returnData);
    /// @notice Emitted when any owner cancels a still-pending proposal
    event ProposalCancelled(uint256 indexed id, address indexed canceller);

    /// @notice Caller is not in the configured owner set
    error NotOwner();
    /// @notice This owner has already approved this proposal
    error AlreadyApproved();
    /// @notice Cannot operate on an already-executed proposal
    error AlreadyExecuted();
    /// @notice Cannot operate on an already-cancelled proposal
    error AlreadyCancelled();
    /// @notice Internal sanity check: caller tried to execute below threshold
    error ThresholdNotMet();
    /// @notice The target call reverted; the inner revert data is bubbled up
    /// @param returnData Raw revert bytes from the target
    error ExecutionFailed(bytes returnData);
    /// @notice Constructor args fail invariants — see code path for which one
    error BadConstructorArgs();
    /// @notice Operating on a proposal id past `proposalsCount()`
    error UnknownProposal();

    /// @notice Restricts to addresses in the owner set
    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }

    /// @notice Configure the multisig
    /// @dev Reverts `BadConstructorArgs` if any of: owners empty, threshold zero, threshold > owners.length,
    ///      duplicate owner, zero-address owner, or owners.length > 32 (uint16 approvals overflow guard)
    /// @param owners_ Addresses authorised to submit/approve/cancel
    /// @param threshold_ Minimum distinct approvals required to execute
    constructor(address[] memory owners_, uint256 threshold_) {
        if (
            owners_.length == 0 ||
            threshold_ == 0 ||
            threshold_ > owners_.length ||
            owners_.length > 32
        ) revert BadConstructorArgs();
        for (uint256 i = 0; i < owners_.length; i++) {
            address o = owners_[i];
            if (o == address(0) || isOwner[o]) revert BadConstructorArgs();
            isOwner[o] = true;
            owners.push(o);
        }
        threshold = threshold_;
    }

    /// @notice Number of configured owners
    function ownersCount() external view returns (uint256) { return owners.length; }
    /// @notice Total proposals ever created (including executed and cancelled)
    function proposalsCount() external view returns (uint256) { return _proposals.length; }

    /// @notice Read a proposal's current state
    /// @param id Proposal index returned by `submit`
    /// @return The `Proposal` struct
    function getProposal(uint256 id) external view returns (Proposal memory) {
        if (id >= _proposals.length) revert UnknownProposal();
        return _proposals[id];
    }

    /// @notice Submit a proposed call. The submitter's auto-approval counts toward `threshold`.
    /// @param target Contract to call once threshold is met
    /// @param data ABI-encoded calldata to send to `target`
    /// @return id Index of the new proposal (use with `approve`/`cancel`/`getProposal`)
    function submit(address target, bytes calldata data) external onlyOwner returns (uint256 id) {
        id = _proposals.length;
        _proposals.push(Proposal({
            target: target,
            data: data,
            approvals: 0,
            executed: false,
            cancelled: false
        }));
        emit ProposalSubmitted(id, msg.sender, target, data);
        _approve(id);
    }

    /// @notice Approve a pending proposal. Auto-executes if approvals reach `threshold`.
    /// @dev Reverts `AlreadyApproved` if the caller has already approved this id.
    /// @param id Proposal index returned by `submit`
    function approve(uint256 id) external onlyOwner {
        _approve(id);
    }

    /// @notice Cancel a proposal that hasn't executed. Any owner can cancel; no threshold required.
    /// @dev Once cancelled, future `approve`/`cancel` revert `AlreadyCancelled`.
    /// @param id Proposal index returned by `submit`
    function cancel(uint256 id) external onlyOwner {
        if (id >= _proposals.length) revert UnknownProposal();
        Proposal storage p = _proposals[id];
        if (p.executed) revert AlreadyExecuted();
        if (p.cancelled) revert AlreadyCancelled();
        p.cancelled = true;
        emit ProposalCancelled(id, msg.sender);
    }

    function _approve(uint256 id) internal {
        if (id >= _proposals.length) revert UnknownProposal();
        Proposal storage p = _proposals[id];
        if (p.executed) revert AlreadyExecuted();
        if (p.cancelled) revert AlreadyCancelled();
        if (approvedBy[id][msg.sender]) revert AlreadyApproved();
        approvedBy[id][msg.sender] = true;
        p.approvals += 1;
        emit ProposalApproved(id, msg.sender, p.approvals);
        if (uint256(p.approvals) >= threshold) {
            _execute(id);
        }
    }

    function _execute(uint256 id) internal {
        Proposal storage p = _proposals[id];
        if (uint256(p.approvals) < threshold) revert ThresholdNotMet();
        // Effect first: mark executed BEFORE external call so any re-entry hits AlreadyExecuted.
        p.executed = true;
        // slither-disable-next-line low-level-calls,reentrancy-events
        (bool ok, bytes memory ret) = p.target.call(p.data);
        if (!ok) revert ExecutionFailed(ret);
        // Post-call event includes returnData; reentry-protection is in the executed=true write above.
        // slither-disable-next-line reentrancy-events
        emit ProposalExecuted(id, ret);
    }
}
