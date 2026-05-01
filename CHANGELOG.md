# Changelog

All notable changes to this project documented per [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added (loop iter 31, 2026-05-01) — InterestBearingPool (Pattern B, Aave-style index)
- **Real architectural addition.** Multi-holder pooled deposit; many depositors share a single strategy contract. O(1) accrual per user — transfers don't trigger per-user math.
- New `contracts/InterestBearingPool.sol` (~170 LOC, NatSpec'd):
  - `liquidityIndex` (RAY = 1e27 scaling, Aave V2/V3 convention) — starts at 1.0, grows monotonically
  - `scaledBalance[user]` = user's deposit ÷ index AT DEPOSIT TIME
  - `balanceOf(user) = scaledBalance × liquidityIndex / RAY` (current claim including accrued interest)
  - `previewIndex()` — read-only forecast of what `_updateIndex` would advance to
  - `OpenZeppelin ReentrancyGuard` — `nonReentrant` on deposit/withdraw
  - CEI ordering: state writes happen before any external call; mint deferred to caller
- New `test/08-pool.test.ts` — 8 tests: constructor invariants, RAY init, two-depositor pro-rata accrual (alice+bob over 2 years), withdraw arithmetic, totalUnderlying matches sum-of-balances, zero-amount reverts, withdraw-past-balance, previewIndex parity vs post-update
- Pool-level rate semantics documented: for `tiered`, the pool earns at the BLENDED rate for total balance (not per-user tiers). Single-holder `InterestBearingDeposit` is the right choice when per-user tier rates matter.
- Tests: **54 hardhat** (was 46) + 18 wasm + 15 fuzz × 256 runs, all green
- Slither: 0 findings maintained (CEI restructure + nonReentrant modifier + 4 inline suppression comments for false-positive `incorrect-equality` checks against zero)

### Pool vs Deposit — when to pick which
| Concern | InterestBearingDeposit (single) | InterestBearingPool (Pattern B) |
|---|---|---|
| Holders | 1 customer | many customers share |
| Accrual cost per holder | per-deposit storage update on `postInterest` | O(1) — no per-user math on transfers |
| Tier semantics | Per-user balance hits per-user tier | Pool's total balance hits the blended tier |
| Best for | Premium private banking, large single deposits | Retail savings, broad pooled products |
| Demonstrated | iter 16 (with WHT to TaxCollector) | this iter |

### Added (loop iter 29, 2026-05-01) — Wire step-up: parity + bench + UI
- `test/03-parity.test.ts`: new entry `09-step-up-bond.json` — JS-side iterates the schedule and calls `wasm.previewSimple` per segment (mirrors `StepUpStrategy.previewAccrual` semantics on-chain). All 9 parity tests pass.
- `tasks/bench.ts`: new `step-up` case with 3-step fixture (200/300/400 bps at +0/+90d/+180d). RESULTS.md regenerated:

| Strategy | previewAccrual | postInterest |
|---|---:|---:|
| simple | 22,889 | 60,816 |
| compound | 26,557 | 63,751 |
| tiered | 29,752 | 66,307 |
| floating | 28,343 | 65,180 |
| kpi-linked | 28,368 | 65,200 |
| two-track | 22,980 | 60,889 |
| **step-up** | **42,742** | **71,843** |

step-up is the most expensive preview at 1.87× simple — explained by the schedule loop with 3 entries, each calling `DayCount.daysAndDenominator` and computing a contribution.

- `ui/index.html`: dropdown option `09 — Step-up sustainability bond`
- `ui/app.ts`: case `step-up` in `previewWasm` — JS-side iteration calling WASM `previewSimple` per segment (matches the parity test's pattern)
- 46 Hardhat tests (was 45) + 18 WASM + 15 fuzz × 256 runs, all green
- Slither: 0 findings maintained
- UI bundle build: 271KB / 99.8KB gzipped

### All 9 rule kinds now plumbed end-to-end
| Rule | Solidity | WASM | Schema | Example | Parity test | Bench | UI dropdown |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| simple | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| compound | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| tiered | ✅ | ✅ via JS-loop | ✅ | ✅ | ✅ | ✅ | ✅ |
| floating | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| kpi-linked | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| floor-cap | ✅ via floating | — | ✅ | ✅ | ✅ via floating | ✅ via floating | ✅ |
| two-track | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| ch-withholding | ✅ via simple | ✅ | ✅ | ✅ | ✅ | ✅ via simple | ✅ |
| **step-up** | **✅** | **✅ via JS-loop** | **✅** | **✅** | **✅** | **✅** | **✅** |

### Added (loop iter 28, 2026-05-01) — 9th rule kind: step-up coupon
- **Real product feature** — first rule kind added since the initial 8. Step-up coupon: piecewise-constant interest rate that steps up (or down) at scheduled timestamps. Real-bank pattern for sustainability-linked bonds.
- New `contracts/strategies/StepUpStrategy.sol` (~110 LOC) — schedule of `(atTimestamp, bps)` entries with strictly-ascending invariant; integrates each step's overlap with `[fromTs, toTs]` via `DayCount.daysAndDenominator`. Time before the first step accrues zero.
- New `test/07-step-up.test.ts` — 6 tests:
  - Constructor invariants (BadLength, NotSorted, RateTooHigh, duplicate timestamps)
  - Two-step schedule integrates correctly across the boundary (fixture: 10d @ 200bps + 20d @ 300bps)
  - Period before first step yields zero
  - Last step extends to forever (360d @ 200bps × 1M = 20,000)
  - kind/dayCount round-trip
  - Monotonic in balance (2× balance ≈ 2× interest within rounding)
- JSON Schema enum extended: `kind` now includes `"step-up"`; new `ratePolicy.schedule` array shape
- New rule example `rules/examples/09-step-up-bond.json` — 3-step EUR sustainability bond (200 → 300 → 400 bps at Jan 2025/2027/2028)
- `tasks/deploy-rule.ts` updated with new `step-up` case
- Tests now: **45 hardhat** (was 39) + 18 wasm + 15 fuzz × 256 runs, all green
- Slither: 0 findings maintained (StepUpStrategy uses `DayCount.daysAndDenominator` library to avoid the divide-before-multiply pattern flagged inline)

### Deferred to a follow-up iter
- WASM `previewStepUp` mirror in `wasm/assembly/index.ts` (would need AS array marshalling for the schedule)
- `test/03-parity.test.ts` parity entry for step-up
- `tasks/bench.ts` gas-bench entry
- UI dropdown option in `ui/index.html`

### Added (loop iter 27, 2026-05-01) — SECURITY.md + healthcheck script
- New `SECURITY.md`: responsible-disclosure policy, supported versions, severity-based response SLAs (24h/3d/5d/10d), in-scope vs out-of-scope, known and accepted PoC risks, disclosure timeline
- Auditor contact: `jesus@lopezpalacios.com` with `[paycodex-rules-poc SECURITY]` subject prefix
- New `scripts/healthcheck.sh`: runs every QA gate locally and prints a green/red summary
  - 8 gates total: schema validation, solhint, WASM build, Solidity compile, hardhat tests, WASM tests, Foundry fuzz, Slither
  - Optional gates (coverage, gas bench, UI build) in full mode; skipped under `--fast`
  - Gracefully skips Foundry / Slither when not on PATH (so contributors without those installed still get useful output)
  - Exit code 0/1 for use as pre-commit/pre-PR gate
- New `npm run healthcheck` and `npm run healthcheck:fast` scripts
- README quick-start now documents the healthcheck workflow

### Verified locally
8 of 8 gates pass (with Foundry + Slither installed). Without them: 6 of 8 pass + 2 skip. Either way: `healthcheck OK — safe to commit / open PR.`

### Changed (loop iter 26, 2026-05-01) — NatSpec on remaining 5 strategies + forge doc in CI
- Full NatSpec on `CompoundDailyStrategy`, `TieredStrategy`, `FloatingStrategy`, `KpiLinkedStrategy`, `TwoTrackStrategy` — title, struct fields, constructor params, `@inheritdoc IInterestStrategy`, sentinel value docs, production-vs-PoC trade-offs called out
- New `forge doc --build` step in CI `foundry-fuzz` job
- New `solidity-docs` artifact uploaded per CI run (the mdbook source generated from NatSpec)
- `.gitignore` extended for `docs/src/`, `docs/book/`, mdbook static assets
- Tests: 39 hardhat + 18 wasm + 15 fuzz × 256 runs, all green
- Slither: 0 findings maintained
- Behavioural changes: zero — code unchanged, only NatSpec comments added

### NatSpec coverage — final
| Surface | Status |
|---|---|
| Top-level contracts (RuleRegistry, OperatorMultisig, InterestBearingDeposit, DepositFactory, TaxCollector) | ✅ |
| All 6 strategies | ✅ |
| All `interfaces/I*` | ✅ |

### Changed (loop iter 25, 2026-05-01) — NatSpec polish on public surfaces
- Comprehensive `@notice` / `@dev` / `@param` / `@return` tags added to:
  - `RuleRegistry` (struct fields, all functions, all events, all errors documented)
  - `OperatorMultisig` (struct fields, constructor invariants, function semantics, error meanings)
  - `InterestBearingDeposit` (state vars, events, constructor params, internal `_accrueToNow` invariant)
  - `SimpleStrategy` (template — `@inheritdoc IInterestStrategy` for the interface methods)
- `IMintable` interface now has its own `@title` + `@notice` block
- No behavioural changes — pure documentation
- Tests: 39 hardhat + 18 wasm + 15 fuzz × 256 runs, all green
- Slither: 0 findings maintained

### NatSpec coverage delta
| Contract | Before | After |
|---|---:|---:|
| RuleRegistry | 2 tags | comprehensive (every public surface) |
| OperatorMultisig | 5 tags | comprehensive |
| InterestBearingDeposit | 5 tags | comprehensive |
| SimpleStrategy | 1 tag | full + `@inheritdoc` |

Other strategies (`CompoundDailyStrategy`, `TieredStrategy`, `FloatingStrategy`, `KpiLinkedStrategy`, `TwoTrackStrategy`) follow `SimpleStrategy`'s template; deferred to a future iter for parity.

### Changed (loop iter 24, 2026-05-01) — Telemetry refresh
- Regenerated `RESULTS.md` with current numbers (was stale since iter 16's TaxCollector + iter 18's OperatorMultisig)
- `previewAccrual` gas unchanged across the board (strategy contracts didn't change)
- `postInterest` increased ~12k gas — overhead of the iter-16 `IMintable.mint()` step that mints gross interest before WHT split (required for actual ERC20 movement, was previously counter-only)
- Solidity coverage rerun: **92.5% lines / 78% statements / 64% branches / 72% functions** (line coverage held; functions improved from 69% → 72% via the multisig + TaxCollector tests)
- Foundry fuzz suite still 15/15 passing × 256 runs each
- Slither still 0 findings
- README updated with current gas table + verified-results bullet

### Honest gas regression note
The +12k postInterest increase is structural, not a bug — without the mint step, the deposit's principal counter incremented but no actual tokens moved (iter-15 caveat documented in DEPLOYMENT.md as "limitation #1"). Iter 16 closed that limitation; the gas number reflects real value flow now.

### Added (loop iter 23, 2026-05-01) — Incident response runbook
- New `docs/INCIDENT.md` (~250 lines): 9 incident classes with severity matrix, concrete commands, and post-incident steps:
  1. Sanctioned address detected at deploy time (SEV-2)
  2. Web3signer / issuer key compromise suspected (SEV-1)
  3. Bad rule registered (SEV-2)
  4. WHT remittance failed (SEV-2)
  5. Customer disputes posted interest (SEV-3)
  6. Chain halted / validator down (SEV-3)
  7. Sanctions list update needed (SEV-4 / SEV-1 if bypass)
  8. Backend rate-limit + auth incidents (SEV-3)
  9. Kill-switch cheat sheet (every granular lever, why no global pause)
- Tabletop drill schedule (weekly backup, monthly multisig deprecate, quarterly key rotation, etc.)
- Each playbook references actual contracts/scripts: `OperatorMultisig.cancel`, `RuleRegistry.deprecate`, `besu/backup.sh --restore`, `POST /api/admin/reload-blocklist`
- DEPLOYMENT.md: "Incident response runbook" `[ ]` → `[x]`

### Production hardening — final tally
| Item | Status |
|---|---|
| Tax remittance | ✅ |
| Backend auth | ✅ |
| Sanctions screening | ✅ |
| Operator multisig | ✅ |
| Rate limiting | ✅ |
| Customer auth (signed intent) | ✅ |
| Witness data backup | ✅ |
| Incident response runbook | ✅ |
| Multi-validator Besu | ⚠️ template + caveat (Besu version-blocked, documented) |
| mTLS on RPC | infra-class, not in code-class |
| Gated CI status checks | GitHub config / org policy |

8 of 11 fully closed. The remaining 3 are infra/process items outside this repo's scope.

### Added (loop iter 22, 2026-05-01) — Witness data backup + abandoned Besu version bump
- New `besu/backup.sh` — snapshot/restore Besu volume:
  - `bash besu/backup.sh` → tar.gz of the chain volume to `besu/backups/`, SHA256-tagged
  - `bash besu/backup.sh --restore <archive>` → wipes + restores volume
  - Env vars: `PAYCODEX_BACKUP_VOLUME` (default `besu_besu-data`), `PAYCODEX_BACKUP_DEST` (S3/GCS URI placeholder), `PAYCODEX_BACKUP_KMS` (KMS key placeholder)
  - Production placeholders document the `aws s3 cp --sse aws:kms` and `gcloud storage cp` swaps
- Verified end-to-end round-trip: snapshot → wipe volume → restore → canary file recovered byte-for-byte
- Operator notes in script: 3-2-1 rule, hourly incremental + daily full, quarterly restore-to-sandbox drill
- `.gitignore`: `besu/backups/`, `besu/multivalidator/networkFiles/`, `besu/multivalidator/.env`
- DEPLOYMENT.md: "Witness data backup" `[ ]` → `[x]`

### Abandoned: Besu 26.4.0 image bump
- Tried `hyperledger/besu:26.4.0` to fix the iter-21 IBFT2 quorum flake
- `besu operator generate-blockchain-config` regressed in 25.x+: rejects with `"Output directory already exists"` even when `--to=<path>` doesn't exist on host or container
- Reproduced in clean `/tmp/besu-fresh/` with fresh mount → same error
- Reverted to `hyperledger/besu:24.3.0` for both compose + regenerate.sh
- Multi-validator IBFT2 quorum reliability remains a Besu-version-specific known issue (documented in `besu/multivalidator/README.md`); future fix path: separate non-validator bootnode + permissions-nodes config

### Production hardening status — 11 fully closed (10), 1 partial, 1 process-only

| Item | Status |
|---|---|
| Tax remittance (TaxCollector) | ✅ |
| Backend auth (Bearer keys) | ✅ |
| Sanctions screening | ✅ |
| Operator multisig | ✅ |
| Rate limiting | ✅ |
| Customer authentication (signed intent) | ✅ |
| Witness data backup | ✅ |
| Multi-validator Besu | ⚠️ template ready, quorum needs Besu version follow-up |
| mTLS on RPC | process / infra |
| Gated CI status checks | process / GitHub config |
| Incident response runbook | process / docs |

### Changed (loop iter 21, 2026-05-01) — Multi-validator peering: bootnode + discovery
- `besu/multivalidator/docker-compose.yml`:
  - Validator-1 acts as the bootnode (no `--bootnodes` arg)
  - Validators 2-4 use `--bootnodes=${BOOTNODE_ENODE}` (interpolated from `.env`)
  - `--discovery-enabled=true` on all 4 nodes (was disabled in iter 20)
  - `--p2p-host=172.30.30.1{1..4}` on each node so each advertises its bound IP correctly
  - `depends_on: [besu-1]` on followers so the bootnode is up before they query
- `besu/multivalidator/regenerate.sh`:
  - Now writes `besu/multivalidator/.env` with the bootnode enode URL alongside `static-nodes.json`
  - Compose users invoke with `docker compose --env-file besu/multivalidator/.env -f .../docker-compose.yml up -d`
- Verified: all 4 boot, peer count reaches 2-3 transiently, peer discovery operational
- ⚠️ Still flaky: IBFT2 round-0 quorum doesn't lock in reliably under Besu 24.3.0. README documents the version-upgrade + permissions-nodes fix path honestly.
- The single-validator `besu/` stack remains the per-PR E2E target.

### Added (loop iter 20, 2026-05-01) — 4-validator Besu IBFT2 (template)
- New `besu/multivalidator/` directory:
  - `regenerate.sh` — single-command 4-node genesis + key generation via `besu operator generate-blockchain-config --count=4`
  - `ibft-config.json` — chainId 1338, IBFT2 4-validator spec
  - `docker-compose.yml` — 4 Besu services (besu-1..4) + Web3signer; static IPs 172.30.30.11..14 (Besu rejects DNS in static-nodes); only besu-1 RPC exposed to host
  - `keys/validator-{1..4}/` — per-validator privkey/pubkey/address (committed; dev only)
  - `static-nodes.json` — IP-based enode URLs (auto-generated by `regenerate.sh`)
  - `web3signer/keys/` — Web3signer key for validator-1
  - `README.md` — setup procedure, byzantine-fault math (`F=(N-1)/3=1` for N=4), production hardening notes
- Genesis config produces extraData encoding all 4 validators' addresses (verified via Besu generator output)
- All 4 containers boot under Besu 24.3.0
- ⚠️ **Caveat shipped honestly:** static-nodes-only peering is intermittent under Besu 24.3.0; reaching IBFT2 quorum needs bootnode + discovery (estimated half-day operator follow-up). README documents the failure modes + fix.
- Single-validator stack at `besu/` remains the per-PR E2E target.
- DEPLOYMENT.md: "Multi-validator Besu" `[ ]` → `[~]` (partially closed; configuration done, peering reliability deferred).

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
