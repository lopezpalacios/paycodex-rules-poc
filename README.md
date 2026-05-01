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
npm test                                          # 51 tests: 33 hardhat (12 unit + 8 parity + 10 revert + 3 lifecycle) + 18 WASM

# Simulate any rule client-side (no chain needed):
node scripts/simulate.mjs --rule rules/examples/08-ch-withholding.json --balance 1500000 --days 365

# Hardhat custom tasks (run `npx hardhat` to list all):
npx hardhat deploy:rule --rule rules/examples/01-simple-act360.json --network hardhat
npx hardhat deploy:all --network hardhat
npx hardhat compare:rule --rule rules/examples/01-simple-act360.json --balance 1000000 --days 360 --network hardhat
npx hardhat bench                                 # writes RESULTS.md
npx hardhat validate:rules                        # Ajv against schema
npx hardhat accounts --network besu               # list signers

# Spin up local Besu IBFT2 + Web3signer, then deploy onto it:
npm run besu:up
npx hardhat deploy:all --network besu             # via hardhat-config'd dev key
npx hardhat deploy:all --network besu-signer      # via Web3signer (no privkey in config)

# Backend server for wallet-less browser deploys (Web3signer signs):
npm run server &
npm run ui                                        # Vite + browser UI; pick "Backend (Web3signer, no wallet)" mode
```

### CLI reference

| Task | What it does |
|---|---|
| `deploy:rule --rule <path>` | Deploy strategy + register + create deposit for one rule |
| `deploy:all` | Reset deployments file + deploy core + 8 strategies + 8 deposits |
| `compare:rule --rule <path> [--balance N] [--days N]` | Run WASM preview, query on-chain `previewAccrual`, assert parity |
| `bench` | Run gas benchmarks for all 6 kinds, write `RESULTS.md` |
| `validate:rules` | Ajv 2020 validate every `rules/examples/*.json` |
| `accounts` | List `eth_accounts` and balances on the current network |

### Verified results

- 33 Hardhat tests + 18 WASM tests = 51 total, all green
- Slither static analysis: 0 findings
- Solidity coverage: ~92% lines
- Real Besu IBFT2 deploy: all 8 rules registered + deposits created
- Web3signer wallet-less path: same 8 rules deploy without any in-config privkey
- WASM CLI matches Solidity unit fixtures (1M @ 3.50% × 90d act/360 = 8,750)

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
