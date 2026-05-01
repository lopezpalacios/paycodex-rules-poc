// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RuleRegistry
/// @author paycodex-rules-poc
/// @notice On-chain catalogue mapping `ruleId` → strategy contract address. Append-only;
///         the operator can register new rules and deprecate existing ones, but cannot
///         overwrite a registered entry. Each entry pins the off-chain rule JSON's keccak
///         hash so reviewers can prove the deployed strategy matches the published rule.
/// @dev Operator should be an `OperatorMultisig` in production, not an EOA. The append-only
///      invariant is what makes this registry safely shared by multiple deposits — a customer's
///      InterestBearingDeposit reads its strategy lazily via `Entry.strategy` and trusts the
///      registry not to swap it from under them. Deprecation does not change `Entry.strategy`;
///      it only blocks `DepositFactory.deploy(...)` from minting new instances against this rule.
contract RuleRegistry {
    /// @notice Per-rule registry entry. Persisted under `ruleId` once and never mutated except
    ///         to flip `deprecated` to `true`.
    /// @param strategy Address of the deployed `IInterestStrategy` for this rule
    /// @param kind String returned by `strategy.kind()` (e.g. "simple", "compound")
    /// @param dayCount String returned by `strategy.dayCount()` (e.g. "act/360")
    /// @param ruleHash `keccak256` of the canonical rule JSON file in `rules/examples/`. Off-chain
    ///                 reviewers check this matches what the rule says before trusting the strategy.
    /// @param registeredAt Unix-second block timestamp at registration (`uint64` is sufficient through 2554)
    /// @param deprecated `true` once deprecated. New deposits via `DepositFactory.deploy` are blocked;
    ///                   existing deposits keep using the same strategy at the same parameters.
    struct Entry {
        address strategy;
        string  kind;
        string  dayCount;
        bytes32 ruleHash;
        uint64  registeredAt;
        bool    deprecated;
    }

    /// @notice Single principal authorised to call `register` / `deprecate`. Set in constructor and
    ///         immutable thereafter. Use an `OperatorMultisig` in production for K-of-N approval.
    address public immutable operator;

    mapping(bytes32 => Entry) private _entries;

    /// @notice Append-only list of every `ruleId` ever registered, in registration order.
    ///         Use `count()` for length.
    bytes32[] public ruleIds;

    /// @notice Emitted once per registered rule. Indexers should track this to discover new rules.
    /// @param ruleId The 32-byte rule identifier
    /// @param strategy The strategy contract bound to this rule
    /// @param kind String tag from the strategy's `kind()` getter
    /// @param ruleHash keccak256 of the rule JSON file
    event RuleRegistered(bytes32 indexed ruleId, address indexed strategy, string kind, bytes32 ruleHash);

    /// @notice Emitted when a rule is deprecated. Existing deposits are unaffected; only new
    ///         `DepositFactory.deploy` calls are blocked.
    /// @param ruleId The 32-byte rule identifier
    event RuleDeprecated(bytes32 indexed ruleId);

    /// @notice Caller is not the configured operator
    error NotOperator();
    /// @notice This `ruleId` already has a registered strategy
    /// @param ruleId The conflicting identifier
    error AlreadyRegistered(bytes32 ruleId);
    /// @notice This `ruleId` has never been registered
    /// @param ruleId The unknown identifier
    error UnknownRule(bytes32 ruleId);
    /// @notice The strategy contract did not respond to `kind()` or `dayCount()` introspection.
    ///         Either the supplied address is not a strategy, or it implements an older interface.
    error MissingIntrospection();
    /// @notice A required address argument was the zero address
    error ZeroAddress();

    /// @notice Deploy with a single-operator role. Pass an `OperatorMultisig` address for K-of-N.
    /// @param operator_ Authority allowed to call `register` and `deprecate`
    constructor(address operator_) {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
    }

    /// @notice Restricts to the configured operator
    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    /// @notice Register a strategy for `ruleId` and pin the off-chain JSON's hash.
    /// @dev Reads `kind()` + `dayCount()` from the strategy via `staticcall` — both must succeed
    ///      and return ABI-decodable strings, or the call reverts with `MissingIntrospection`.
    /// @param ruleId 32-byte stable identifier (typically `bytes32` of the rule's `ruleId` JSON field)
    /// @param strategy Deployed `IInterestStrategy` contract; must not be zero address
    /// @param ruleHash `keccak256` of the canonical rule JSON file
    function register(bytes32 ruleId, address strategy, bytes32 ruleHash) external onlyOperator {
        if (strategy == address(0)) revert ZeroAddress();
        if (_entries[ruleId].strategy != address(0)) revert AlreadyRegistered(ruleId);
        // Read kind/dayCount lazily via static calls to avoid hard ABI coupling to a specific
        // IInterestStrategy version — supports incremental interface evolution.
        // slither-disable-next-line low-level-calls
        (bool okK, bytes memory rK) = strategy.staticcall(abi.encodeWithSignature("kind()"));
        // slither-disable-next-line low-level-calls
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

    /// @notice Mark a rule deprecated. Blocks new `DepositFactory.deploy` calls; existing deposits
    ///         keep their bound strategy at original parameters.
    /// @param ruleId Identifier to deprecate
    function deprecate(bytes32 ruleId) external onlyOperator {
        if (_entries[ruleId].strategy == address(0)) revert UnknownRule(ruleId);
        _entries[ruleId].deprecated = true;
        emit RuleDeprecated(ruleId);
    }

    /// @notice Read the registered entry for a rule. Reverts if the rule was never registered.
    /// @param ruleId Identifier
    /// @return The full `Entry` struct (caller can check `.deprecated`)
    function get(bytes32 ruleId) external view returns (Entry memory) {
        if (_entries[ruleId].strategy == address(0)) revert UnknownRule(ruleId);
        return _entries[ruleId];
    }

    /// @notice Total number of rules ever registered (including deprecated ones)
    function count() external view returns (uint256) {
        return ruleIds.length;
    }
}
