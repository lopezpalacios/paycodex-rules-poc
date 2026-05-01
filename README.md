# paycodex-rules-poc

Rule-driven interest-bearing deposit factory. Hardhat + AssemblyScript WASM + Besu (Docker, IBFT2).

Companion to [`paycodex`](../paycodex) (incumbent rails KG) and [`paycodex-onchain`](../paycodex-onchain) (DLT/EVM patterns KG).

## What this demos

1. **Rule as data** — JSON describes interest mechanics (kind, day-count, rate policy, compounding, floor/cap, posting frequency, withholding).
2. **WASM preview** — same rule runs in browser via AssemblyScript-compiled WASM module to preview accrual schedule before deploy. No backend.
3. **Solidity execution** — `DepositFactory` deploys an `InterestBearingDeposit` bound to a strategy contract that implements the same rule.
4. **Parity** — WASM preview ≡ on-chain `previewAccrual()` for every rule (tested).
5. **Permissioned chain ready** — single command spins up local Besu IBFT2 node; deploy unchanged.

## Eight canonical rules

| # | Kind | Use |
|---|---|---|
| 1 | Simple act/360 fixed | EUR demand deposit baseline |
| 2 | Compound daily 30/360 | Retail savings |
| 3 | Tiered balance bands | Corporate operating |
| 4 | Floating €STR + 50bps | Wholesale floating |
| 5 | KPI-adjusted ±100bps | ESG-linked |
| 6 | Floor 0% / cap 10% | Negative-rate protection |
| 7 | Two-track ECR/hard 50/50 | US-style commercial |
| 8 | CH 35% withholding | Verrechnungssteuer demo |

## Quick start

```bash
npm install
npm run wasm:build                                # asbuild → wasm/build/release.wasm
npm run compile                                   # hardhat compile
npm test                                          # 20 tests: 12 unit + 8 parity (WASM ≡ Solidity)

# Simulate any rule client-side (no chain needed):
node scripts/simulate.mjs --rule rules/examples/08-ch-withholding.json --balance 1500000 --days 365

# Deploy a rule on local Hardhat (hardhat node spins up automatically for `run`):
RULE=rules/examples/01-simple-act360.json npx hardhat run scripts/deploy.ts --network hardhat

# Spin up local Besu IBFT2, then deploy onto it:
npm run besu:up
RULE=rules/examples/04-floating-estr.json npx hardhat run scripts/deploy.ts --network besu

# Browser UI demo (live WASM preview):
npm run ui
```

Verified results (this repo, 2026-05-01):
- 12/12 strategy unit tests pass
- 8/8 WASM-vs-Solidity parity tests pass (compound tolerance 0.1%, others 0.01%)
- End-to-end deploy: strategy → registry register → factory → InterestBearingDeposit instance
- WASM CLI simulate matches Solidity unit test fixtures (1M @ 3.50% × 90d act/360 = 8,750)

## Layout

```
contracts/      Solidity: factory, registry, deposit, pluggable strategies
rules/          JSON Schema + 8 example rules
wasm/           AssemblyScript module (browser-runnable preview)
besu/           genesis.json + docker-compose for permissioned chain
scripts/        deploy / simulate / compare CLI
ui/             Vite + TS browser demo
test/           Hardhat tests + WASM↔Solidity parity
```

## License

MIT (code) + CC-BY-SA-4.0 (docs).
