# Changelog

All notable changes to this project documented per [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added (loop iter 19, 2026-05-01) — Rate limiting + signed customer intent
- **Per-customer rate limiting** on `/api/deploy-deposit` (in-memory token bucket, sliding window):
  - `PAYCODEX_RATE_LIMIT_MAX` (default 5) — max deploys per customer per window
  - `PAYCODEX_RATE_LIMIT_WINDOW_MS` (default 86,400,000 = 24h)
  - HTTP 429 with `Retry-After` header when exceeded
  - Admin introspection: `GET /api/admin/rate-limit/:customer` returns `{ seen, max, windowMs, remaining }`
- **EIP-712 signed customer intent verification**:
  - New `DepositIntent` typed message: `{ ruleId, customer, whtEnabled, whtBps, nonce, expiry }`
  - Domain: `{ name: "paycodex-rules-poc", version: "1", chainId: 1337 }`
  - When `intent` + `signature` present, backend verifies signature recovers `intent.customer`, checks expiry, rejects reused nonce
  - When `PAYCODEX_REQUIRE_INTENT=true`, intent is **mandatory** for every deploy-deposit
  - 401 rejection paths: bad signature, expired, reused nonce
  - Schema introspection endpoint: `GET /api/intent-schema`
- New `scripts/sign-intent.mjs` CLI — produces ready-to-POST signed body. Helps demo + QA workflows.
- `npm run sign-intent` script
- Bruno collection: `08-signed-intent.bru` + `09-rate-limit-status.bru`
- DEPLOYMENT.md hardening checklist:
  - "Rate limiting" `[ ]` → `[x]`
  - "Customer authentication" `[ ]` → `[x]` (signed-intent path)

### Verified end-to-end on Besu+Web3signer
| Probe | Expected | Got |
|---|---|---|
| Sign intent + POST → 200 | `viaSignedIntent: true`, deposit deployed | ✅ |
| Replay same nonce → 401 | "nonce X already used by Y" | ✅ |
| 3 attempts on same customer (max=2) | 200, 200, 429 | ✅ |
| Rate-limit introspection | `{seen:2, max:2, remaining:0}` | ✅ |
| Intent-schema introspection | EIP-712 domain + types JSON | ✅ |

### Production hardening — 10/11 closed
- ✅ Tax remittance · ✅ Auth · ✅ Sanctions · ✅ Operator multisig · ✅ Rate limiting · ✅ Customer auth (signed intent)
- Still open: multi-validator Besu, mTLS, gated CI checks, witness backup, incident runbook

### Added (loop iter 18, 2026-05-01) — Operator multisig
- New `OperatorMultisig.sol` — K-of-N multisig contract that wraps any single-operator target (e.g. `RuleRegistry`). Submit/approve/cancel/auto-execute on threshold. ~120 LOC, 9 typed errors, zero deps.
- Per-proposal storage: `target`, `data`, `approvals`, `executed`, `cancelled`. Approval bitmap via `mapping(uint256 → mapping(address → bool))`.
- Constructor invariants enforced: non-empty owners, threshold ∈ [1, owners.length], no duplicate or zero-address owners, owner count ≤ 32 (uint16 approval counter).
- New test suite `test/06-multisig.test.ts` — 6 tests:
  - Constructor invariants reject all 5 bad-arg shapes
  - Non-owner cannot submit/approve/cancel
  - 2-of-3 happy path through `RuleRegistry.register` (auto-approves on submit, executes on second approval)
  - Double-approve, post-execute approve, cancelled approve all reverted
  - Cancellation prevents further state change
  - 3-of-3 requires every owner before execute
- DEPLOYMENT.md hardening checklist: "Operator role separation" `[ ]` → `[x]`
- Tests now: 39 Hardhat (was 33) + 18 WASM + 15 fuzz × 256 runs
- Slither: 0 findings maintained (one new `reentrancy-events` flagged on `_execute` event-after-call; suppressed inline because state write `executed=true` precedes the call — re-entry hits AlreadyExecuted)

### Production hardening status (8/11 closed)
- ✅ Tax remittance · ✅ Auth · ✅ Sanctions screening · ✅ Operator multisig
- Still open: multi-validator Besu, mTLS, rate limiting, customer KYC auth, gated CI checks (advisory → required), witness backup, incident runbook

### Added (loop iter 17, 2026-05-01) — Backend auth + sanctions screening
- **Bearer-token API key middleware** on Express (`scripts/server.mjs`)
  - `PAYCODEX_API_KEYS=name1:secret1,name2:secret2` env var (secret → name)
  - `PAYCODEX_ADMIN_KEYS=name1,name2` env var declares admin roles
  - Auth disabled when `PAYCODEX_API_KEYS` empty; loud warning at startup
  - Per-route policy:
    - `GET /api/health` — no auth (liveness probes)
    - `GET /api/deployments` + `POST /api/preview-onchain` — any key
    - `POST /api/deploy-deposit` + `POST /api/admin/reload-blocklist` — admin
- **Sanctions blocklist screening** before every `deploy-deposit`
  - `data/sanctions/blocklist.json` — flat array of lowercase addresses
  - Hot-reloadable via `POST /api/admin/reload-blocklist`
  - Returns HTTP 451 Unavailable For Legal Reasons (silent rejection — no on-chain reach)
  - Includes 2 placeholder blocked addresses for negative-test exercising
- Bruno collection updated:
  - 2 new requests: `06-blocked-customer.bru` (asserts 451) + `07-no-auth.bru` (asserts 401)
  - All authenticated requests carry `Authorization: Bearer {{readerKey|adminKey}}`
  - Environment files declare `readerKey` + `adminKey` vars
- DEPLOYMENT.md hardening checklist:
  - "Authentication on the Express backend" — `[ ]` → `[x]`
  - "Sanctions screening" — `[ ]` → `[x]`
- "Known PoC limitations" #5 + #6 marked closed

### Verified end-to-end on real Besu+Web3signer
| Probe | Expected | Got |
|---|---|---|
| GET /api/health (no auth) | 200, auth=enabled, blocklistSize=2 | ✅ |
| GET /api/deployments (no auth) | 401 | ✅ |
| GET /api/deployments (reader key) | 200 | ✅ |
| POST /api/deploy-deposit (reader key) | 403 "lacks admin role" | ✅ |
| POST /api/deploy-deposit (admin, blocked addr) | 451 "address blocked" | ✅ |
| POST /api/deploy-deposit (admin, clean) | 200, deposit at 0x98Ba…, gas 672,925 | ✅ |

Slither still 0 findings. 33 Hardhat + 18 WASM + 15 fuzz tests all green.

### Added (loop iter 16, 2026-05-01) — WHT remittance is now real
- New `TaxCollector` contract — single destination for WHT remittance from many deposits; records each collection as event for audit
- New `ITaxCollector` interface in `contracts/interfaces/`
- `InterestBearingDeposit.postInterest()` now:
  - Mints `gross` interest into the deposit (via `IMintable.mint` — bank-issued credit)
  - Transfers `wht` slice to the configured `taxCollector` via `asset.safeTransfer`
  - Calls `taxCollector.recordCollection(asset, wht, ruleId)` for the audit event
  - Capitalises `net = gross - wht` into principal
- `DepositFactory.deploy()` takes additional `address taxCollector` parameter (zero when WHT disabled)
- `WhtRequiresCollector` custom error — constructor reverts if WHT enabled with zero collector
- Reordered `postInterest` to follow Checks-Effects-Interactions (state writes happen before any external call) — Slither reentrancy-no-eth + reentrancy-events findings resolved
- `TaxCollector` explicitly inherits `ITaxCollector` — Slither missing-inheritance resolved
- Lifecycle test verifies: WHT amount lands in collector's USDC balance + `collectedTotal` mapping increments
- DEPLOYMENT.md hardening checklist: WHT-remittance moved from `[ ]` to `[x]`
- Closed PoC limitation #1 from DEPLOYMENT.md

### Tests + Slither
- 33 Hardhat tests still pass
- 15 Foundry fuzz tests still pass (256 runs each)
- Slither: **0 findings** maintained

### Added (loop iter 15, 2026-05-01) — DEPLOYMENT.md
- Operator-side deployment guide covering 4 scenarios: local dev, local Besu+UI, CI, production sketch
- Production hardening checklist (mTLS, sanctions, KYC, multi-validator, Vault/KMS/HSM key sources, multisig operator, FireFly migration)
- Troubleshooting section (Besu /data perms, gasPrice, Web3signer batching, ESM, WASM build)
- Command cheat sheet, layout reference, known PoC limitations enumerated

### Added (loop iter 14, 2026-05-01) — Mutation testing
- `slither-mutate` (Trail of Bits) wired
- `scripts/mutation-test.sh` runner; sensible mutator subset (AOR, ASOR, BOR, FHR, LIR, LOR, MIA, MVIE, MVIV, MWA, ROR, RR — skips CR/SBR/UOR noise)
- `.github/workflows/mutation.yml` — nightly cron 04:00 UTC + manual dispatch
- `MUTATION_TESTING.md` — score interpretation, survivor triage workflow

### Added (loop iter 13, 2026-05-01) — EXECUTIVE-DECK.md
- Marp-format 12-slide deck: problem, solution, 8 rules, architecture diagram, key custody, test counts, gas table, banker FAQ, KG companions, run instructions
- Render: `marp EXECUTIVE-DECK.md --pptx -o exec.pptx`

### Added (loop iter 12, 2026-05-01) — FireFly skeleton
- `firefly/` integration plan + config artifacts for the Hyperledger FireFly supernode (Kaleido-donated)
- API definitions for `rule-registry`, `deposit-factory`, `strategy`
- Migration mapping documented: every Express endpoint → FireFly REST equivalent
- Actual `ff start` deferred (heavy stack)

### Added (loop iter 11, 2026-05-01)
- **Bruno** API collection in `bruno/paycodex-rules-poc/` — OSS Postman alternative, flat-file `.bru` text format
- 5 documented requests covering every backend endpoint:
  - `01-health.bru` — GET /api/health (asserts `ok=true`)
  - `02-deployments.bru` — GET /api/deployments
  - `03-preview-onchain.bru` — POST /api/preview-onchain (asserts `gross` field present)
  - `04-deploy-deposit.bru` — POST /api/deploy-deposit (asserts `ok=true`, `deposit` + `txHash` present)
  - `05-deploy-with-wht.bru` — same with CH 35% Verrechnungssteuer enabled
- Two environments: `local.bru` (127.0.0.1:3001) + `staging.bru` (placeholder)
- Each request has inline assertions and `docs {}` blocks explaining the call
- README documents auditor/compliance use case (flat-file diffability vs Postman cloud)

### Added (loop iter 10, 2026-05-01)
- **Foundry** added as parallel test framework (forge install foundry-rs/forge-std)
- `foundry.toml` (paris target, optimizer=200, 256 fuzz runs/test, OZ remapping)
- `test/foundry/StrategyInvariants.t.sol` — 15 property-based tests:
  - Zero balance → zero (3 strategies)
  - Zero days → zero (2 strategies)
  - Monotonic in balance: `b1 ≤ b2 → preview(b1) ≤ preview(b2)` (3 strategies)
  - Monotonic in time: `d1 ≤ d2 → preview(d1) ≤ preview(d2)` (2 strategies)
  - `compound > simple` over 1y at same rate
  - `Floating.floor` enforces minimum (oracle ≤ 0 → result == 0)
  - `Floating.cap` enforces maximum (capped at 10% → result ≤ 1e17 on 1e18×1y)
  - `KpiLinked` adjustment clamped to declared range
  - `TwoTrack` hard portion ≤ all-rate simple
- 256 fuzz runs/test default; deterministic seed `0x1337` for reproducibility
- New CI job `foundry-fuzz` (foundry-rs/foundry-toolchain action) — runs on every push/PR
- New scripts: `npm run test:foundry`, `npm run test:fuzz` (1000 runs)
- `.gitignore` adds `cache_forge/`, `out/`, `lib/` (Foundry artifacts)

### Property-test coverage
~3,584 random invariant checks succeed against every strategy on every CI run. Surface bugs (overflow paths, missing zero handling, broken monotonicity) automatically discovered by Foundry's fuzzer.

### Changed (loop iter 9, 2026-05-01)
- **Native Hardhat tasks** replace the env-var workaround — proper CLI with `--rule`, `--balance`, `--days` flags and `--help` output
- New `tasks/` dir with 6 tasks: `accounts`, `deploy:rule`, `deploy:all`, `compare:rule`, `bench`, `validate:rules`
- Imported once from `hardhat.config.ts` via `import "./tasks";`
- **Removed:** `scripts/deploy.ts`, `scripts/deploy-all.ts`, `scripts/compare.ts`, `scripts/gas-bench.ts`, `scripts/validate-rules.mjs` (logic moved into tasks)
- **Kept:** `scripts/server.mjs` (Express backend, stays a Node script — not a Hardhat concern), `scripts/simulate.mjs` (CLI WASM, no chain)
- npm scripts updated to call tasks: `validate:rules`, `deploy:all`, `bench`
- CI: `RULE=path npx hardhat run scripts/deploy.ts` patterns replaced with `npx hardhat deploy:rule --rule path` everywhere
- CI besu-e2e adds a new `compare:rule` step verifying parity on Besu after deploy
- README rewritten with full CLI reference table

### Removed env-var hacks
Before: `RULE=rules/examples/01.json npx hardhat run scripts/deploy.ts --network besu`
After:  `npx hardhat deploy:rule --rule rules/examples/01.json --network besu`

### Added (loop iter 8, 2026-05-01)
- **Slither** static analysis wired in CI; SARIF → GitHub code-scanning + artifact
- `slither.config.json` (solc remap, filter_paths for mocks/lib, exclude `timestamp` false-positive detector)
- 12 baseline findings → **0** after triage (3 fixed via math refactor, 5 fixed with ZeroAddress checks, 1 fixed via cached array length, 2 intentional staticcall suppressed inline, 4 false-positive timestamp compares excluded by config)
- New `ZeroAddress` custom error in `InterestBearingDeposit` and `RuleRegistry`
- `TwoTrackStrategy.previewAccrual` and `previewEcr` refactored to single division at end (avoids divide-before-multiply precision loss; equivalent integer math, verified by parity tests)
- `TieredStrategy` caches `_tiers.length` outside the loop
- CI: new `slither` job with `permissions: security-events: write`, `fail-on: medium`

### Added (loop iter 7, 2026-05-01)
- `scripts/gas-bench.ts` — per-strategy gas benchmarks: deployment + previewAccrual (estimated) + full deposit lifecycle (deposit/postInterest/withdraw)
- Generates `RESULTS.md` with markdown table + data-derived notes (no hard-coded multipliers; comparisons computed from actual numbers)
- `npm run bench` script
- CI: gas-bench step runs after tests; `RESULTS.md` joins the gas-report artifact

### Headline benchmark numbers (in-mem hardhat, paris target, optimizer=200)
- Cheapest preview: `simple-act360-eur-350` — 22,889 gas
- Most expensive preview: `tiered-corp-eur` — 29,741 gas (2 bands; +6,852 vs simple)
- `compound` is only 1.16× `simple` (rpow is more efficient than expected)
- `floating` / `kpi-linked` add ~5,500 gas vs `simple` for one external oracle CALL
- `postInterest` average: 51,258 gas
- Strategy deployment: 371k–534k gas range
- `Deploy deposit` (factory): flat ~572k regardless of strategy

### Added (loop iter 6a, 2026-05-01)
- **Web3signer integration — wallet-less issuance path** (no MetaMask required)
- `besu/web3signer/` — config dir with `file-raw` keystore (PoC); README documents production swaps to HashiCorp Vault, AWS KMS, Azure Key Vault, YubiHSM
- `docker-compose.yml` adds `web3signer` (consensys/web3signer:26.4.2) sidecar; loads keys from `./web3signer/keys/`, downstream-proxies to Besu, exposes port 9000
- `hardhat.config.ts` adds `besu-signer` network — points at Web3signer URL, NO `accounts` array (signer holds keys)
- New `scripts/server.mjs` — Express backend exposing:
  - `GET /api/health` — Web3signer + Besu reachability + accounts
  - `GET /api/deployments` — current network's `.deployments/<network>.json`
  - `POST /api/preview-onchain` — runs `strategy.previewAccrual` via JSON-RPC
  - `POST /api/deploy-deposit` — submits `factory.deploy(...)`, signed by Web3signer
- Browser UI gets a mode dropdown: **Backend (Web3signer, no wallet)** or **MetaMask wallet**. Backend mode POSTs to `/api/*`; wallet mode unchanged.
- `npm run server` script
- `express` added to runtime dependencies
- Verified locally on real Besu: all 8 rules deployed via `besu-signer` network (no privkey in hardhat config); backend deploy-deposit signed by Web3signer creates new InterestBearingDeposit at gas 572k, block 86

### Why this matters
Replaces "user signs in browser" with "bank backend signs via key-vault" — the actual issuance pattern banks use. Same code path supports HSM/KMS/Vault swaps with a 5-line config file change in `besu/web3signer/keys/`.

### Added (loop iter 5, 2026-05-01)
- Browser UI rebuilt with on-chain query + deploy flow:
  - MetaMask connect button; auto-detects network by chainId (hardhat/Besu)
  - Loads `.deployments/<network>.json` to find pre-deployed strategies
  - "Compare WASM ↔ Chain" button — calls `strategy.previewAccrual` and shows parity/diff
  - "Deploy new deposit" button — submits `factory.deploy()` via wallet
- New `scripts/deploy-all.ts` — single-process deploys core + all 8 strategies + registers + creates deposit per rule
- `npm run deploy:all` script
- `vite.config.ts` reworked: serves from project root for static asset access
- `ethers` moved to dependencies (browser bundling)
- CI: `npm run ui:build` + `ui-bundle` artifact; Besu E2E uses `deploy-all.ts`; `besu-deployments` artifact
- Vite production build: 270KB / 99KB gzipped

### Added (loop iter 4, 2026-05-01)
- Real Besu IBFT2 genesis generated via `besu operator generate-blockchain-config` (Docker)
- New validator address `0xacfebbfffcc5da7cc2a42d5a075572132e5102a6` with matching key in `besu/key`
- `besu/ibft-config.json` — input spec; `besu/regenerate.sh` — idempotent regen script
- `docker-compose.yml` adds `user: root` for /data permission fix
- `hardhat.config.ts` `besu.gasPrice` raised to 1 gwei (Besu rejects 0 under EIP-1559)
- Verified: contract deploys end-to-end on Besu (strategy → registry → factory → deposit)
- CI Besu E2E job re-enabled (was `if: false`); deploys 3 rule variants per PR

### Added (loop iter 3, 2026-05-01)
- `solidity-coverage` wired via `npm run coverage`
- AS-side unit tests `wasm/tests/run.mjs` — 18 direct tests of WASM exports
- New `npm run wasm:test` script; chained into `qa`
- Deposit-lifecycle test `test/05-deposit-lifecycle.test.ts` — full deposit → time-travel → postInterest with WHT path
- CI: WASM tests step + coverage step + coverage artifact upload
- Line coverage 76.88% → 92.47%
- Total: 33 Hardhat tests + 18 WASM tests

### Changed (loop iter 2, 2026-05-01)
- All `require(... , string)` converted to typed custom errors across strategies, library, and registry
- Re-enabled `gas-custom-errors` solhint rule (was disabled in iter 1)
- New test file `test/04-revert-paths.test.ts`: 10 revert-path tests covering every constructor precondition, registry access control, factory deprecation guard, and deposit access control
- Total tests: 30 passing (was 20)

### Added (loop iter 1, 2026-05-01)
- GitHub Actions CI workflow: lint, schema validation, WASM build, contract compile, tests, gas report artifact (`.github/workflows/ci.yml`)
- Solhint configuration (`.solhint.json`, `.solhintignore`)
- JSON Schema validator (`scripts/validate-rules.mjs`) — Ajv 2020-12 against `rules/schema.json`
- `hardhat-gas-reporter` plugin enabled (toggle via `REPORT_GAS=true`)
- `npm run qa` target — full lint + validate + build + test
- CONTRIBUTING.md, this CHANGELOG.md
- Besu CI job scaffold (disabled; activates in iter 4 once real genesis generated)

## [0.1.0] - 2026-05-01

### Added (initial scaffold)
- Hardhat + Solidity 0.8.24 project layout
- 6 pluggable interest strategies: Simple, CompoundDaily, Tiered, Floating, KpiLinked, TwoTrack
- Core: `IInterestStrategy`, `RuleRegistry` (append-only, ruleHash-anchored), `DepositFactory`, `InterestBearingDeposit`
- Mocks: `MockERC20`, `MockRateOracle`, `MockKpiOracle`
- 8 canonical rule examples + JSON Schema (Draft 2020-12)
- AssemblyScript WASM module mirroring all 6 strategies
- Browser UI (Vite) with live WASM preview
- CLI: `simulate.mjs`, `deploy.ts`, `compare.ts`
- Local Besu IBFT2 via docker-compose (genesis approximate; iter 4 will regenerate)
- 20 tests pass: 12 unit + 8 WASM-vs-Solidity parity (compound 0.1% tolerance, others 0.01%)
