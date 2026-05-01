# Changelog

All notable changes to this project documented per [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
