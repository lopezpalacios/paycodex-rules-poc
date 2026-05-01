# Security policy

## Status

This is a **proof-of-concept** repository, not a production system. The contracts have not been audited by a third party. Do not use this code as-is to issue customer-facing financial products.

That said: the architecture is the architecture. If you find a vulnerability that would matter in production, we want to hear about it.

## Supported versions

| Version | Supported |
|---|---|
| `main` | ✅ — always; we ship to `main` directly |
| Tagged releases | None published yet |

The single-validator `besu/` stack is the per-PR E2E target. The `besu/multivalidator/` stack is template-quality (peering caveat documented in [`besu/multivalidator/README.md`](besu/multivalidator/README.md) and tracked in [`DEPLOYMENT.md`](DEPLOYMENT.md) §4.3).

## Reporting a vulnerability

**Do not open a public GitHub issue for security-sensitive findings.**

Email the issuer directly:

- **Email**: `jesus@lopezpalacios.com`
- **Subject prefix**: `[paycodex-rules-poc SECURITY]`
- **PGP**: not currently published; encrypt at-rest if the report is sensitive

Include:

1. **Affected component** — contract path, line numbers, or backend endpoint
2. **Severity assessment** — your reading of customer-funds risk vs. compliance-only vs. operational
3. **Repro steps** — minimum test or curl that triggers the issue
4. **Impact analysis** — what an attacker gains if exploited
5. **Suggested fix** — optional, but appreciated

## Response SLAs

| Severity | Initial response | Fix target |
|---|---|---|
| **Critical** (customer funds at immediate risk) | 24 hours | 72 hours, with public disclosure within 7 days post-fix |
| **High** (compromise possible under attacker effort) | 3 business days | 14 days |
| **Medium** (compliance breach without fund loss) | 5 business days | 30 days |
| **Low** (DoS, information leak) | 10 business days | best-effort |

These are aspirational targets for a PoC project; production teams should set their own contractual SLAs.

## Scope

### In scope

- All Solidity contracts under `contracts/`
- Backend Express server `scripts/server.mjs`
- AssemblyScript WASM module under `wasm/`
- Hardhat task scripts under `tasks/`
- CI workflows under `.github/workflows/`
- Configuration files (`hardhat.config.ts`, `foundry.toml`, `slither.config.json`, `besu/web3signer/keys/*`)

### Out of scope

- Third-party dependencies (report upstream — OpenZeppelin, ethers, Hardhat, Besu, Web3signer)
- Documentation typos, spelling, formatting (open a PR instead)
- The `paycodex` and `paycodex-onchain` knowledge-graph repos (separate repos with their own scope)
- Issues that depend on dev-only configurations (e.g. the committed dev privkey in `besu/key`, the placeholder API keys in `bruno/`)

### Known and accepted risks (not bugs)

- `besu/key`, `besu/multivalidator/keys/validator-*/key`, and `besu/web3signer/keys/*.yaml` contain dev-only private keys committed to source control. This is intentional — they only fund accounts on the local Besu chain (chain ID 1337/1338) which has no value.
- `MockERC20.mint()` is permissionless. This is intentional — the iter-16 `IMintable.mint(...)` integration in `InterestBearingDeposit.postInterest` would otherwise need a real bank-treasury authority that this PoC doesn't simulate.
- The Express backend's static API keys (`PAYCODEX_API_KEYS=name:secret,...`) are env-configured rather than KMS-derived. Production should swap to OAuth2 / mTLS / SPIFFE — documented in [`DEPLOYMENT.md`](DEPLOYMENT.md) §4.3.
- The 4-validator Besu stack does not reliably reach IBFT2 quorum under Besu 24.3.0. Documented in [`besu/multivalidator/README.md`](besu/multivalidator/README.md) and [`CHANGELOG.md`](CHANGELOG.md) iters 20–22.

If you find a way to escalate any of the above into a real-money loss, it's a real bug — please report it.

## Disclosure timeline

For each accepted finding:

1. **Day 0**: report received → acknowledgement within SLA
2. **Day +N**: fix shipped to `main`
3. **Day +N+7**: public disclosure (CHANGELOG entry, optional GitHub Security Advisory)

The reporter's name is credited in CHANGELOG unless they request anonymity.

## What this PoC does well already

- 0 Slither findings on `main` (run via `slither . --config-file slither.config.json`)
- ~3,584 random property checks per CI run via Foundry fuzz (15 invariants × 256 runs)
- 92.5% Solidity line coverage
- 39 Hardhat tests + 18 WASM tests across happy path, revert paths, and end-to-end lifecycle
- All public-surface contracts have NatSpec
- Append-only registry + multisig operator + customer-signed-intent verification

## What this PoC explicitly skips

- Multi-validator Besu in production posture (template only)
- mTLS / TLS termination (operator concern)
- Real OFAC SDN feed (uses local `data/sanctions/blocklist.json`)
- Real KYC / tax-residency cert flow (assumes upstream service)
- Real bank treasury mint authority (uses permissionless `MockERC20.mint`)
- Real WHT remittance to authority (TaxCollector hoards; `remit(...)` is operator-driven)

These are intentional scope cuts; reports of "the PoC doesn't do X" where X is one of the above are out of scope, but reports of "X is documented as out-of-scope but the implementation actually accidentally implements a partial version that has a bug" are very much in scope.

## See also

- [`DEPLOYMENT.md`](DEPLOYMENT.md) §4.3 — production hardening checklist with current status
- [`docs/INCIDENT.md`](docs/INCIDENT.md) — incident response runbook
- [`MUTATION_TESTING.md`](MUTATION_TESTING.md) — mutation campaign workflow
- [`slither.config.json`](slither.config.json) — static-analysis configuration
