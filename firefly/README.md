# Hyperledger FireFly integration

[FireFly](https://hyperledger.org/projects/firefly) is the open-source supernode that Kaleido contributed to Hyperledger. It sits **on top of** the same Web3signer + Besu stack we already run in `besu/`, and replaces the ad-hoc Express backend (`scripts/server.mjs`) with a production-grade orchestrator.

## What FireFly adds (vs. the iter 6a Express backend)

| Concern | iter 6a backend (`scripts/server.mjs`) | FireFly supernode |
|---|---|---|
| Tx submission | Hand-rolled ethers | Managed connector with retry, gas mgmt, nonce coordination |
| Identity | Anonymous | DIDs per organisation/node, mTLS between members |
| Multi-party messaging | None | Off-chain private data + on-chain pinning |
| Token API | Manual ABI calls | Built-in `tokens-erc20-erc721` microservice |
| Contract API generation | Manual ABI loading | Auto from compile artifacts (see `data-types/`) |
| Audit log | Express access log | First-class events streamed to webhook/Kafka |
| Multi-bank consortium | Out of scope | `org` per bank, shared chain |
| Compliance (KYC, sanctions) | Out of scope | Pluggable identity + signing checks |
| Operator UX | curl + Bruno | Web UI at `/ui` per node |

For a **single-bank closed-loop demo**, the Express backend is fine. For a **multi-bank tokenized-deposit consortium** (the realistic regulated future), FireFly is what supervisors expect.

## Setup (manual — heavy stack)

FireFly stacks are spun up with the `ff` CLI. Each stack is a docker-compose with: FireFly core, evmconnect, dataexchange, sandbox, postgres, plus the same Besu+Web3signer we already have.

### 1. Install the `ff` CLI

```bash
brew install hyperledger/firefly/firefly-cli
# or:
curl -sSL https://raw.githubusercontent.com/hyperledger/firefly-cli/main/install.sh | bash
```

### 2. Initialize a stack pointing at our Besu

```bash
ff init paycodex \
  --type ethereum \
  --connector evmconnect \
  --blockchain-provider besu \
  --external-blockchain http://127.0.0.1:8545 \
  --signer http://127.0.0.1:9000 \
  --members 1
```

This generates `~/.firefly/stacks/paycodex/` with all compose files. Edit `docker-compose.override.yml` if you want to point at our own Besu instead of FireFly's bundled one.

### 3. Start

```bash
ff start paycodex
ff logs paycodex -f
```

UI lands at `http://localhost:5000/ui`.

### 4. Register our contract APIs

FireFly auto-generates a REST API per contract from a compiled artifact. The mapping below documents which artifacts to upload:

| Contract | Artifact path | Suggested FireFly API name |
|---|---|---|
| `RuleRegistry` | `artifacts/contracts/RuleRegistry.sol/RuleRegistry.json` | `rule-registry` |
| `DepositFactory` | `artifacts/contracts/DepositFactory.sol/DepositFactory.json` | `deposit-factory` |
| `InterestBearingDeposit` | `artifacts/contracts/InterestBearingDeposit.sol/InterestBearingDeposit.json` | `deposit` |
| `IInterestStrategy` | `artifacts/contracts/interfaces/IInterestStrategy.sol/IInterestStrategy.json` | `strategy` |

Upload via either:

```bash
# A. CLI
ff contracts upload paycodex artifacts/contracts/DepositFactory.sol/DepositFactory.json

# B. REST
curl -X POST http://localhost:5000/api/v1/namespaces/default/apis \
  -H "Content-Type: application/json" \
  --data @firefly/configs/deposit-factory-api.json
```

### 5. Hit the auto-REST API

After upload FireFly exposes:

- `POST http://localhost:5000/api/v1/namespaces/default/apis/deposit-factory/invoke/deploy` — calls `DepositFactory.deploy()`
- `GET  http://localhost:5000/api/v1/namespaces/default/apis/rule-registry/query/get` — calls `RuleRegistry.get(ruleId)`

The new browser UI (`ui/app.ts`) would point at FireFly's URL instead of our Express in this mode — same JSON shapes.

## Migration path

```
NOW:   browser → /api/* (Express, scripts/server.mjs) → Web3signer → Besu
NEXT:  browser → /api/v1/namespaces/default/apis/*  (FireFly) → evmconnect → Web3signer → Besu
```

The Express endpoints in `scripts/server.mjs` map cleanly:

| Express endpoint | FireFly equivalent |
|---|---|
| `GET /api/health` | `GET /api/v1/status` |
| `GET /api/deployments` | `GET /api/v1/namespaces/default/apis` (lists registered contracts) |
| `POST /api/preview-onchain` | `POST /api/v1/.../strategy-{ruleId}/query/previewAccrual` |
| `POST /api/deploy-deposit` | `POST /api/v1/.../deposit-factory/invoke/deploy` |

## Why deferred to a future iter

FireFly stack init pulls ~10 Docker images (~3GB) and takes 5+ minutes to come up. Integration testing requires the full stack. This iter ships the configuration and migration plan; actual `ff start` + retesting is a follow-up.

## See also

- FireFly docs: https://hyperledger.github.io/firefly/
- evmconnect: https://github.com/hyperledger/firefly-evmconnect
- firefly-signer (alternative to Web3signer): https://github.com/hyperledger/firefly-signer

The architecture file in this PoC's KG: [`paycodex-onchain/architecture/programmable-interest-pattern.md`](../../paycodex-onchain/architecture/programmable-interest-pattern.md).
