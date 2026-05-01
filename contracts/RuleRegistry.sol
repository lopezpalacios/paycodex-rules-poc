// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RuleRegistry
/// @notice On-chain catalogue of deployed (ruleId → strategy address) mappings.
/// @dev Append-only registry; one strategy per ruleId. Operator role can deprecate but not overwrite.
contract RuleRegistry {
    struct Entry {
        address strategy;
        string  kind;       // "simple", "compound", "tiered", ...
        string  dayCount;   // "act/360", ...
        bytes32 ruleHash;   // keccak256 of canonical rule JSON (off-chain integrity anchor)
        uint64  registeredAt;
        bool    deprecated;
    }

    address public immutable operator;
    mapping(bytes32 => Entry) private _entries;
    bytes32[] public ruleIds;

    event RuleRegistered(bytes32 indexed ruleId, address indexed strategy, string kind, bytes32 ruleHash);
    event RuleDeprecated(bytes32 indexed ruleId);

    error NotOperator();
    error AlreadyRegistered(bytes32 ruleId);
    error UnknownRule(bytes32 ruleId);
    error MissingIntrospection();

    constructor(address operator_) {
        operator = operator_;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    function register(bytes32 ruleId, address strategy, bytes32 ruleHash) external onlyOperator {
        if (_entries[ruleId].strategy != address(0)) revert AlreadyRegistered(ruleId);
        // Read kind/dayCount lazily via static calls to avoid hard ABI coupling
        (bool okK, bytes memory rK) = strategy.staticcall(abi.encodeWithSignature("kind()"));
        (bool okD, bytes memory rD) = strategy.staticcall(abi.encodeWithSignature("dayCount()"));
        if (!okK || !okD) revert MissingIntrospection();
        string memory k = abi.decode(rK, (string));
        string memory dc = abi.decode(rD, (string));

        _entries[ruleId] = Entry({
            strategy: strategy,
            kind: k,
            dayCount: dc,
            ruleHash: ruleHash,
            registeredAt: uint64(block.timestamp),
            deprecated: false
        });
        ruleIds.push(ruleId);
        emit RuleRegistered(ruleId, strategy, k, ruleHash);
    }

    function deprecate(bytes32 ruleId) external onlyOperator {
        if (_entries[ruleId].strategy == address(0)) revert UnknownRule(ruleId);
        _entries[ruleId].deprecated = true;
        emit RuleDeprecated(ruleId);
    }

    function get(bytes32 ruleId) external view returns (Entry memory) {
        if (_entries[ruleId].strategy == address(0)) revert UnknownRule(ruleId);
        return _entries[ruleId];
    }

    function count() external view returns (uint256) {
        return ruleIds.length;
    }
}
