# Changelog

All notable changes to this project documented per [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
