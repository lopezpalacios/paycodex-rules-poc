# Rules

JSON-schema-typed interest-rule definitions. One rule = one deployable interest-bearing instrument.

- `schema.json` — JSON Schema 2020-12 contract
- `examples/01-..08-*.json` — eight canonical rules, see [project README](../README.md)

## Validation

```bash
npx ajv-cli validate -s schema.json -d "examples/*.json"
```

## Adding a rule

1. Pick `kind` from `simple|compound|tiered|floating|kpi-linked|two-track`
2. Stable `ruleId` (kebab, ≤64 chars) — becomes `bytes32` registry key
3. `dayCount`, `ratePolicy`, `compounding`, `postingFrequency` required
4. Optional: `floorBps`, `capBps`, `withholding`, `twoTrack`
5. Validate against `schema.json` before deploy

## Field semantics

- **Rates**: bps (basis points) integer. 350 = 3.50%. Negative legal where supported (capped at -10000).
- **Balances in tiers**: decimal string, base units of underlying asset (wei for ETH-token, 6-decimals for USDC).
- **Oracle addresses**: zero-address means "fill at deploy time" (mock or real oracle is wired by `scripts/deploy.ts`).
- **Day counts**: `act/360` (EUR money market), `act/365` (CHF, GBP money market), `30/360` (US bond), `act/act-isda` (sovereign).
