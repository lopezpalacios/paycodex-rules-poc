# Changelog

All notable changes to this project documented per [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
