# Deployment guide

This is the operator-side guide for getting `paycodex-rules-poc` running. It covers four scenarios in increasing realism:

1. **Local dev (smallest)** — Hardhat in-mem only, no chain, no UI
2. **Local Besu (medium)** — real permissioned EVM via Docker, Web3signer for signing, browser UI
3. **CI (automated)** — every PR runs the full stack
4. **Production sketch** — what to swap for a real bank issuance

---

## 0. Prerequisites

| Tool | Min version | Required for |
|---|---|---|
| Node.js | 20.x | Hardhat, AssemblyScript, Vite, Express |
| npm | 10.x | bundled with Node 20 |
| Docker + Compose v2 | 24.x / `docker compose` v2 | Besu, Web3signer |
| Python | 3.9+ | Slither (optional, security) |
| Foundry | latest | Property-based fuzz tests (optional) |
| Bruno | latest | Browse the REST collection (optional) |

Install on macOS:

```bash
brew install node docker python forge
brew install --cask docker bruno
pip3 install --user slither-analyzer
curl -L https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup
```

On Linux, replace `brew` with `apt-get install nodejs npm docker.io python3 python3-pip`.

---

## 1. Local dev (smallest)

Just clone, install, build, test. No chain, no UI, no Docker.

```bash
git clone <repo-url> paycodex-rules-poc
cd paycodex-rules-poc
npm install
npm run wasm:build       # AssemblyScript → wasm/build/release.wasm
npm run compile          # Hardhat compile
npm test                 # 33 hardhat tests
npm run wasm:test        # 18 WASM tests
npm run bench            # gas benchmarks → RESULTS.md
```

**What this verifies:** all rule mechanics, WASM ↔ Solidity parity, gas numbers, revert paths.

**What it doesn't verify:** real-chain deploy (uses ephemeral hardhat in-mem), backend signing flow, browser UI.

---

## 2. Local Besu (medium) — full demo

This is what to demo to a stakeholder. Real Besu IBFT2 chain, real Web3signer, real browser UI.

### 2.1 Start the chain stack

```bash
docker compose -f besu/docker-compose.yml up -d
```

This brings up two containers:
- `paycodex-besu` — single-validator IBFT2 chain on `localhost:8545` (HTTP) and `8546` (WS)
- `paycodex-web3signer` — signing service on `localhost:9000`, downstream-proxies to Besu, holds the dev key from `besu/web3signer/keys/`

Wait ~10 seconds for the first block, then verify:

```bash
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  http://127.0.0.1:8545
# → {"jsonrpc":"2.0","id":1,"result":"0x..."}

curl -s http://127.0.0.1:9000/upcheck
# → OK

curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_accounts","params":[],"id":1}' \
  http://127.0.0.1:9000
# → {"jsonrpc":"2.0","id":1,"result":["0xacfebbfffcc5da7cc2a42d5a075572132e5102a6"]}
```

### 2.2 Deploy core + all 8 rules via Web3signer

```bash
npx hardhat deploy:all --network besu-signer
```

The `besu-signer` network in `hardhat.config.ts` has **no `accounts` array** — Hardhat asks Web3signer for `eth_accounts`, Web3signer reports the loaded key, signs every constructor + register tx. **Zero privkeys in code.**

Result: `.deployments/besu-signer.json` with addresses for:
- MockUSDC, RuleRegistry, DepositFactory
- MockRateOracle_ESTR, MockKpiOracle_GHG
- 8× `Strategy_<ruleId>` and 8× `Deposit_<ruleId>`

### 2.3 Start the backend

```bash
NETWORK=besu-signer npm run server
```

Express on `:3001`, exposes:

| Endpoint | What it does |
|---|---|
| `GET /api/health` | Web3signer + Besu liveness, account list, block number |
| `GET /api/deployments` | Reads `.deployments/<network>.json` |
| `POST /api/preview-onchain` | Read-only `strategy.previewAccrual(balance, fromTs, toTs)` |
| `POST /api/deploy-deposit` | `factory.deploy(...)` — Web3signer signs |

Probe with the Bruno collection:

```bash
# In Bruno: Open Collection → bruno/paycodex-rules-poc/
# Pick the "local" environment, click any request, hit Send
```

Or curl:

```bash
curl -s http://127.0.0.1:3001/api/health
curl -s -X POST http://127.0.0.1:3001/api/deploy-deposit \
  -H "Content-Type: application/json" \
  --data '{"ruleId":"simple-act360-eur-350","whtEnabled":false,"whtBps":0}'
```

### 2.4 Browser UI

```bash
npm run ui                    # vite dev server :5173
```

Visit `http://localhost:5173/ui/`. Pick **Backend (Web3signer, no wallet)** mode, click **Connect**, then:
- **Preview (WASM)** — runs in browser, no chain
- **Compare WASM ↔ Chain** — POSTs to `/api/preview-onchain`, runs WASM locally, asserts parity
- **Deploy new deposit** — POSTs to `/api/deploy-deposit`, Web3signer signs

### 2.5 Tear down

```bash
npm run besu:down            # docker compose down
docker compose -f besu/docker-compose.yml down -v   # also nuke volume
```

---

## 3. CI

GitHub Actions runs **5 jobs** on every push/PR (see `.github/workflows/ci.yml`):

| Job | Time | What it asserts |
|---|---|---|
| `slither` | ~3 min | 0 medium+ findings; SARIF → GitHub code-scanning |
| `foundry-fuzz` | ~2 min | 15 invariant tests × 256 runs each |
| `build-test` | ~5 min | lint, schema validation, WASM build, contract compile, 33 tests, gas report, coverage, UI bundle |
| `besu-e2e` | ~6 min | Full Besu IBFT2 boot, all 8 rules deployed, parity check on simple-act360 |
| `mutation` (nightly only, separate workflow) | ~60 min | mutation score on `contracts/strategies/` |

Required GitHub configuration:

- **Permissions** (already in `.github/workflows/ci.yml`):
  - `contents: read`
  - `security-events: write` (for SARIF upload)
- **Artifacts uploaded per run:**
  - `gas-report` — per-function gas + `RESULTS.md`
  - `solidity-coverage` — HTML + lcov + summary
  - `wasm-build` — release `.wasm` + `.wat` + `.d.ts`
  - `ui-bundle` — production Vite build
  - `besu-deployments` — `.deployments/besu.json`
  - `slither-sarif` — security findings
  - `forge-coverage` — Foundry-side coverage (best effort)
  - `mutation-campaign` — survivors + diffs (nightly)

---

## 4. Production sketch

The PoC ships dev keys and `file-raw` config. Real bank deployment changes three things:

### 4.1 Replace Web3signer key source

Edit `besu/web3signer/keys/<addr>.yaml`:

```yaml
# PoC (dev only)
type: "file-raw"
keyType: "SECP256K1"
privateKey: "0xcfb7..."

# Production — pick ONE
# A. HashiCorp Vault
type: "hashicorp"
keyType: "SECP256K1"
keyPath: "/v1/secret/data/web3signer/issuer"
keyName: "value"
serverHost: "vault.bank.internal"
token: "${VAULT_TOKEN}"

# B. AWS KMS (envelope-signing)
type: "aws-kms"
keyType: "SECP256K1"
accessKeyId: "${AWS_ACCESS_KEY_ID}"
secretAccessKey: "${AWS_SECRET_ACCESS_KEY}"
region: "eu-central-1"
kmsKeyId: "alias/paycodex-deposit-issuer"

# C. Azure Key Vault
type: "azure-key-vault"
keyType: "SECP256K1"
clientId: "..."
tenantId: "..."
vaultName: "paycodex-vault"
keyName: "deposit-issuer"

# D. YubiHSM (on-prem)
type: "yubihsm2"
keyType: "SECP256K1"
authId: 1
password: "${YUBIHSM_PIN}"
keyId: 1
connector: "http://yubihsm-connector:12345"
```

No other code changes required. Web3signer abstracts the source.

### 4.2 Replace MockUSDC + mock oracles

For real deposits:

| Mock | Production swap |
|---|---|
| `MockERC20` (`MockUSDC`) | A real tokenized-deposit contract per [`paycodex-onchain/cash-legs/tokenized-deposit.md`](../paycodex-onchain/cash-legs/tokenized-deposit.md) |
| `MockRateOracle` (€STR) | Chainlink ESTR feed, RedStone push feed, or central-bank-attested signed publisher |
| `MockKpiOracle` | Real KPI attestation oracle (e.g. signed by an audited ESG verifier) |

### 4.3 Hardening checklist

Beyond the PoC scope but required before issuance:

- [ ] **Multi-validator Besu** — minimum 4 validators for IBFT2 byzantine tolerance, distributed across availability zones
- [ ] **mTLS on RPC** — Besu and Web3signer endpoints behind TLS with client cert auth
- [ ] **Authentication on the Express backend** — current PoC accepts any caller; add OAuth2 / mutual-TLS / API keys per consumer
- [ ] **Rate limiting on `/api/deploy-deposit`** — limit per-customer per-day deploys
- [ ] **Sanctions screening** — check `customer` against OFAC/EU sanctions lists before deploying
- [ ] **Customer authentication** — KYC + tax residency cert; map signed customer intent → backend deploy
- [x] **Tax remittance contract** — `TaxCollector.sol` shipped iter 16. Each `postInterest()` mints the gross interest, transfers the WHT slice to the collector, and emits `recordCollection` audit event. Production: replace the open `MockERC20.mint` with a real bank treasury authority + wire `TaxCollector.remit(...)` to the actual tax-authority address (CH ESTV, etc.) on the regulator's schedule.
- [ ] **Operator role separation** — `RuleRegistry.operator` should be a multisig, not a single EOA
- [ ] **Slither + mutation runs gated on merge** — currently advisory; flip to required status checks
- [ ] **Witness data backup** — Besu chain data → S3 / GCS with point-in-time recovery
- [ ] **Incident response runbook** — what to do if a strategy is exploited; `RuleRegistry.deprecate(ruleId)` is the kill switch

### 4.4 Going multi-bank

For a consortium (each bank issues its own tokenized deposit token, all on the same chain):

1. **Migrate Express → Hyperledger FireFly** — see [`firefly/README.md`](firefly/README.md). Each bank runs its own FireFly node; the chain is shared.
2. **Tenant-scope ruleIds** — `keccak(orgId || ruleVersion)` so banks don't see each other's rules.
3. **Shared validator set** — IBFT2 with N validators across the consortium banks.
4. **DvP across banks** — when bank A's customer pays bank B's customer, atomic swap of two distinct tokenized-deposit tokens.

This is the path that gets supervisory approval. The PoC's architecture (rule registry, factory pattern, Web3signer) is correct; FireFly is the orchestration glue.

---

## 5. Troubleshooting

### Besu won't start: "permission denied /data/VERSION_METADATA.json"

Already fixed in `besu/docker-compose.yml` via `user: root`. If you see it: `docker compose down -v` and bring up again.

### `npx hardhat deploy:all --network besu` fails: "Gas price below configured minimum"

Besu enforces a minimum gas price even with `--min-gas-price=0` once EIP-1559 baseFee > 0. The hardhat config sets `gasPrice: 1_000_000_000` (1 gwei) — keep it; Besu accepts it as legacy tx with no real cost.

### Web3signer `eth_accounts` returns `[]`

Verify the YAML file is at `besu/web3signer/keys/<address>.yaml` (lowercase address, no `0x` prefix in filename). Check container logs: `docker compose -f besu/docker-compose.yml logs web3signer`.

### "Web3signer eth1 JSON-RPC: Parse error"

ethers v6 sends batched JSON-RPC by default; Web3signer `eth1` mode rejects batches. The Express backend has `batchMaxCount: 1, staticNetwork: true` set. If writing your own client, do the same.

### Hardhat ESM error: "Your project is an ESM project but your Hardhat config file uses the .js extension"

Don't add `"type": "module"` to package.json. Hardhat ecosystem is largely CJS; the existing config works as long as `package.json` does NOT declare ESM.

### Vite `Cannot find module '../wasm/build/release.wasm'`

Run `npm run wasm:build` first. The WASM binary is git-ignored.

---

## 6. Layout reference

```
.
├── contracts/                 Solidity sources (paris target, optimizer=200)
│   ├── interfaces/            IInterestStrategy, IRateOracle, IKpiOracle
│   ├── lib/                   DayCount, WadMath
│   ├── mocks/                 MockERC20, MockRateOracle, MockKpiOracle
│   ├── strategies/            6 IInterestStrategy implementations
│   ├── DepositFactory.sol
│   ├── InterestBearingDeposit.sol
│   └── RuleRegistry.sol
├── tasks/                     6 Hardhat custom tasks (deploy:rule, deploy:all, compare:rule, bench, validate:rules, accounts)
├── scripts/
│   ├── server.mjs             Express backend (Web3signer-signed)
│   ├── simulate.mjs           CLI WASM previewer (no chain)
│   └── mutation-test.sh       slither-mutate runner
├── test/
│   ├── 01..05*.test.ts        Hardhat tests (33 total, mocha)
│   └── foundry/               15 fuzz tests × 256 runs (forge)
├── wasm/
│   ├── assembly/index.ts      AssemblyScript source
│   ├── tests/run.mjs          18 WASM unit tests (no chain)
│   └── build/                 (gitignored) release.wasm + bindings
├── rules/
│   ├── schema.json            JSON Schema 2020-12
│   └── examples/              8 canonical rules
├── ui/
│   ├── index.html
│   ├── app.ts                 ethers + WASM, MetaMask OR Backend mode
│   └── vite.config.ts
├── besu/
│   ├── docker-compose.yml     Besu IBFT2 + Web3signer
│   ├── genesis.json           generator-produced extraData
│   ├── ibft-config.json       input spec for regenerate.sh
│   ├── key                    validator privkey (DEV ONLY)
│   ├── web3signer/keys/       *.yaml — pick file-raw / vault / kms
│   └── regenerate.sh          one-shot Docker-based regeneration
├── bruno/                     OSS Postman alternative collection
├── firefly/                   FireFly migration plan + API definitions
├── .github/workflows/
│   ├── ci.yml                 4 jobs: slither, foundry-fuzz, build-test, besu-e2e
│   └── mutation.yml           Nightly mutation campaign
├── slither.config.json
├── foundry.toml
├── hardhat.config.ts          Imports tasks/, networks: hardhat / besu / besu-signer
├── package.json
├── README.md                  Project overview
├── CHANGELOG.md
├── DEPLOYMENT.md              ← this file
├── EXECUTIVE-DECK.md          Marp slides
├── MUTATION_TESTING.md
├── RESULTS.md                 (regenerated by `npx hardhat bench`)
└── CONTRIBUTING.md
```

---

## 7. Cheat sheet

| Goal | Command |
|---|---|
| Install everything | `npm install && npm run wasm:build && npm run compile` |
| Run all tests | `npm test && npm run wasm:test && forge test` |
| Run gas benchmark | `npx hardhat bench` |
| Lint Solidity | `npm run lint:sol` |
| Static security scan | `slither . --config-file slither.config.json` |
| Mutation campaign | `bash scripts/mutation-test.sh` |
| Coverage | `npm run coverage` |
| Boot chain stack | `docker compose -f besu/docker-compose.yml up -d` |
| Deploy 1 rule | `npx hardhat deploy:rule --rule rules/examples/01-simple-act360.json --network besu-signer` |
| Deploy all 8 rules | `npx hardhat deploy:all --network besu-signer` |
| Verify chain ↔ WASM parity for a rule | `npx hardhat compare:rule --rule rules/examples/02-compound-daily.json --network besu-signer` |
| List signers (test Web3signer) | `npx hardhat accounts --network besu-signer` |
| Start backend | `NETWORK=besu-signer npm run server` |
| Start UI | `npm run ui` |
| Build production UI | `npm run ui:build` |
| Render exec deck | `marp EXECUTIVE-DECK.md --pptx -o exec.pptx` |
| Validate all rules against schema | `npx hardhat validate:rules` |
| Tear down chain stack | `docker compose -f besu/docker-compose.yml down -v` |

---

## 8. Known limitations of the PoC

(Tracked here so reviewers don't have to grep for caveats.)

1. ~~WHT remittance is accounting only~~ — **Closed in iter 16.** `TaxCollector.sol` receives WHT via `asset.safeTransfer` and records each collection with a `Collected` event for audit. Operator can call `TaxCollector.remit(...)` to forward to the real tax-authority address.
2. **Single-customer deposits** — production would use a pooled `Pattern B` (Aave-style index) for many holders per strategy
3. **30/360 day-count** — approximated as act/360 in the math library; true 30/360 needs a date library (not gas-cheap)
4. **act/act-ISDA** — simplified to act/365; leap-year handling not implemented
5. **Sanctions screening** — none in the on-chain path; would integrate at the Express backend or via `T-REX` allowlist on the cash-leg token
6. **Customer authentication** — none; backend accepts any POST. See production hardening checklist (§4.3).
7. **Mock oracles only** — no real Chainlink/Pyth integration; production must replace per ADR 0008
8. **Coverage gaps** — current 92% line coverage; some library helpers (DayCount.fromString) only indirectly tested
9. **Mutation testing** — workflow scaffolded but not yet baseline-run; first nightly campaign establishes the score

These are deliberate scope cuts to keep the PoC focused on the rule-engine + WASM + Web3signer story.
