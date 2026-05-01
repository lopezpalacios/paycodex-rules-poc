---
marp: true
theme: default
paginate: true
header: "paycodex-rules-poc · interest-rule engine on tokenized deposits"
footer: "© 2026 · MIT (code) · CC-BY-SA-4.0 (docs)"
---

<!-- _class: lead -->

# paycodex-rules-poc

### Rule-driven interest-bearing deposits on EVM
### Hardhat + AssemblyScript WASM + Besu IBFT2

A runnable proof-of-concept for tokenized commercial-bank deposits where the interest mechanics are **declarative**, **previewable in the browser**, and **cryptographically anchored** to the deployed Solidity strategy.

---

## The problem

Banks issuing tokenized deposits today face three frictions:

1. **Each rate variant is a code change.** New product = new contract = new audit.
2. **Interest math drifts between systems.** Core banking, customer statement, and chain often disagree at the basis-point level.
3. **Customer-facing demo asks for MetaMask.** Real bank UX never does.

---

## The solution

### Three primitives, one workflow

| Layer | Source of truth |
|---|---|
| **JSON Schema** | What "interest" means for a product (kind, day-count, rate, compounding, withholding) |
| **AssemblyScript WASM** | Browser-runnable preview, byte-identical math intent |
| **Solidity strategies** | On-chain authority, parity-tested against WASM |

**One rule JSON file → preview in browser → deploy to chain → no code changes.**

---

## The 8 canonical rules

| # | Kind | Use case |
|---|---|---|
| 1 | Simple act/360 fixed 3.50% | EUR demand deposit |
| 2 | Compound daily 30/360 | Retail savings |
| 3 | Tiered (2M/10M/max bands) | Corporate operating |
| 4 | Floating €STR + 50bps | Wholesale floating |
| 5 | KPI-adjusted ±100bps | ESG-linked |
| 6 | Floor 0% / cap 10% | Negative-rate protection |
| 7 | Two-track ECR/hard 50/50 | US commercial |
| 8 | CH 35% Verrechnungssteuer | Swiss withholding |

Adding a 9th rule = one JSON file + one strategy contract + one parity test.

---

## Architecture

```
┌──────────────┐    ┌────────────┐    ┌─────────────┐
│ Browser UI   │───▶│ Express    │───▶│ Web3signer  │
│ (WASM prev)  │    │ backend    │    │ (HSM/Vault) │
└──────────────┘    └────────────┘    └──────┬──────┘
                                              │ signs
                                              ▼
                                       ┌─────────────┐
                                       │ Besu IBFT2  │
                                       │ (permissioned)
                                       └──────┬──────┘
                                              │
                              ┌───────────────┼─────────────────┐
                              ▼               ▼                 ▼
                       RuleRegistry   DepositFactory   InterestBearingDeposit
                                              │
                                  pluggable IInterestStrategy
                                              │
              ┌─────────┬─────────┬───────────┼──────────┬───────────┐
              ▼         ▼         ▼           ▼          ▼           ▼
           Simple   Compound   Tiered    Floating    KpiLinked   TwoTrack
```

---

## Where keys live

| Layer | What it holds | What it does |
|---|---|---|
| Browser | Nothing | Submits intent JSON to backend |
| Express | Nothing | Validates, builds tx, forwards to Web3signer |
| Web3signer | The bank's signing key | Signs tx, forwards to Besu |
| Production swap (5-line config) | HashiCorp Vault / AWS KMS / Azure Key Vault / YubiHSM | Same |

**No customer wallet. No privkey on the backend host. Same code path for all backends.**

---

## What's measured

| Test bucket | Count | Method |
|---|---|---|
| Hardhat unit + parity + revert + lifecycle | 33 | mocha + chai |
| AssemblyScript WASM unit | 18 | node:assert |
| Foundry property-based fuzz | 15 × 256 runs ≈ 3,584 | forge test |
| Slither static analysis findings | **0** | crytic-compile |
| Solidity line coverage | **92%** | solidity-coverage |
| Schema-validated rules | 8 / 8 | Ajv 2020 |
| WASM ↔ Solidity parity tolerance | ≤ 0.01% (compound: 0.1%) | per-rule round-trip |

---

## Gas (in-mem hardhat, paris, optimizer=200)

| Strategy | previewAccrual | postInterest |
|---|---:|---:|
| simple | 22,889 | 48,376 |
| compound | 26,557 (1.16×) | 51,311 |
| tiered (2 bands) | 29,741 (+6,852) | 53,858 |
| floating | 28,343 (+5,454 oracle) | 52,740 |
| kpi-linked | 28,368 (+5,479 oracle) | 52,760 |
| two-track | 23,050 (+161) | 48,505 |

Auto-regenerated into `RESULTS.md` by `npx hardhat bench` on every CI run.

---

## What banks should ask

1. **"Where does the issuer key live?"** → Web3signer + HSM/Vault config in `besu/web3signer/keys/`
2. **"How do we audit a rule?"** → JSON file + `ruleHash` anchored on-chain in RuleRegistry
3. **"How do we add a product?"** → 1 JSON file + 1 strategy contract + 1 parity test
4. **"How do we go multi-bank?"** → migrate Express → Hyperledger FireFly (same chain, same keys)
5. **"What's the kill switch?"** → `RuleRegistry.deprecate(ruleId)`; existing instances continue, no new deploys

---

## Companion graphs

This PoC sits between two knowledge graphs:

- [`paycodex`](../paycodex) — incumbent CH/EU/UK rails (314 MD files; SEPA, CHAPS, T2S, RTGS, ECR, withholding, IRRBB, FTP)
- [`paycodex-onchain`](../paycodex-onchain) — DLT/EVM patterns (161 MD files; tokenized deposits, ERC-3643 T-REX, ERC-4626, oracle trust models)

Each rule in this PoC cross-links to its incumbent equivalent in `paycodex` and its DLT pattern in `paycodex-onchain`.

---

## Run it

```bash
git clone … paycodex-rules-poc && cd paycodex-rules-poc
npm install
npm run wasm:build
docker compose -f besu/docker-compose.yml up -d        # Besu + Web3signer
npx hardhat deploy:all --network besu-signer            # 8 rules
npm run server &                                        # Express :3001
npm run ui                                              # browser :5173
```

Bruno collection in `bruno/` for API exploration. Foundry fuzz tests with `forge test`. Hardhat tasks: `npx hardhat --help`.

---

## License

- **Code** (Solidity, TypeScript, AssemblyScript) — [MIT](LICENSE)
- **Documentation** (markdown, slide decks) — CC-BY-SA-4.0

GitHub Actions CI runs lint, schema validation, WASM build, contract compile, parity tests, fuzz tests, gas benchmarks, coverage, Slither, and full Besu E2E deploy on every PR.
