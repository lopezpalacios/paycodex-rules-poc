# Contributing

## Local dev

```bash
npm install
npm run qa     # lint + validate rules + build WASM + compile + test (must pass before PR)
```

## Adding a new interest rule

1. Add JSON file under `rules/examples/` matching `rules/schema.json`
2. `npm run validate:rules` to confirm
3. If new `kind`, also add: WASM export in `wasm/assembly/index.ts` + Solidity strategy in `contracts/strategies/` + dispatch case in `scripts/deploy.ts` and `test/03-parity.test.ts`
4. Parity test in `test/03-parity.test.ts` MUST pass within tolerance (0.01% generic, 0.1% compound)

## Adding a strategy

- Implement `IInterestStrategy` (`previewAccrual`, `kind`, `dayCount`)
- One strategy = one rule kind. Don't make a strategy multi-kind.
- Strategy is read-only — all writes happen in `InterestBearingDeposit`.
- Constructor parameters MUST be range-checked (`require(rateBps_ <= 10000, ...)`).

## Style

- Solidity ^0.8.24, optimiser runs=200
- Solhint must pass (`npm run lint:sol`)
- TypeScript strict; no `any` in new code unless justified
- AssemblyScript: keep mathematical functions f64-free where possible (compound is the exception)

## CI

GitHub Actions runs on every PR:
- Solhint
- Rule schema validation (Ajv)
- WASM build
- Contract compile
- 20 tests (must all pass)
- Gas report (artifact)

Besu E2E job is currently disabled (`if: false`). Will be enabled in iter 4 once real `extraData` genesis is generated.
