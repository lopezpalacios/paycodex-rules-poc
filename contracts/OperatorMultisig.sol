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
    struct Proposal {
        address target;
        bytes   data;
        uint16  approvals;
        bool    executed;
        bool    cancelled;
    }

    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public immutable threshold;

    Proposal[] private _proposals;
    mapping(uint256 => mapping(address => bool)) public approvedBy;

    event ProposalSubmitted(uint256 indexed id, address indexed proposer, address indexed target, bytes data);
    event ProposalApproved(uint256 indexed id, address indexed approver, uint16 approvals);
    event ProposalExecuted(uint256 indexed id, bytes returnData);
    event ProposalCancelled(uint256 indexed id, address indexed canceller);

    error NotOwner();
    error AlreadyApproved();
    error AlreadyExecuted();
    error AlreadyCancelled();
    error ThresholdNotMet();
    error ExecutionFailed(bytes returnData);
    error BadConstructorArgs();
    error UnknownProposal();

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }

    constructor(address[] memory owners_, uint256 threshold_) {
        if (
            owners_.length == 0 ||
            threshold_ == 0 ||
            threshold_ > owners_.length ||
            owners_.length > 32  // keep approval counter safely in uint16
        ) revert BadConstructorArgs();
        for (uint256 i = 0; i < owners_.length; i++) {
            address o = owners_[i];
            if (o == address(0) || isOwner[o]) revert BadConstructorArgs();
            isOwner[o] = true;
            owners.push(o);
        }
        threshold = threshold_;
    }

    function ownersCount() external view returns (uint256) { return owners.length; }
    function proposalsCount() external view returns (uint256) { return _proposals.length; }

    function getProposal(uint256 id) external view returns (Proposal memory) {
        if (id >= _proposals.length) revert UnknownProposal();
        return _proposals[id];
    }

    /// @notice Submit a proposed call. Auto-approved by the proposer (counts toward threshold).
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

    /// @notice Approve a pending proposal. If approvals reach `threshold`, the call executes.
    function approve(uint256 id) external onlyOwner {
        _approve(id);
    }

    /// @notice Cancel a proposal that hasn't executed. Any owner can cancel.
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
