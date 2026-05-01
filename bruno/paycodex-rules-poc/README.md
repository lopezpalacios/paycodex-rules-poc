# Bruno collection — paycodex-rules-poc backend API

Open-source [Bruno](https://www.usebruno.com/) collection covering every endpoint exposed by `scripts/server.mjs`.

Bruno is an OSS Postman alternative; the collection is a flat directory of `.bru` text files (no proprietary cloud sync). Commit it, diff it, review it like any other source.

## Install Bruno

```bash
brew install bruno     # macOS
# or download from https://www.usebruno.com/
```

## Open the collection

1. Bruno → **Open Collection** → point at `bruno/paycodex-rules-poc/`
2. Top-right env picker → **local** (default points at `http://127.0.0.1:3001`)
3. Make sure the backend is running:
   ```bash
   docker compose -f besu/docker-compose.yml up -d   # Besu + Web3signer
   npx hardhat deploy:all --network besu-signer       # populate registry
   npm run server                                     # Express on :3001
   ```
4. Click any request → **Send**. All requests have inline `assert {}` blocks so a green tick = the API works as documented.

## Requests

| # | Method | Path | What it does |
|---|---|---|---|
| 1 | GET | `/api/health` | Probe Web3signer + Besu liveness; show issuer address + block number |
| 2 | GET | `/api/deployments` | Read `.deployments/<network>.json` (the address book) |
| 3 | POST | `/api/preview-onchain` | Read-only `strategy.previewAccrual` for a rule |
| 4 | POST | `/api/deploy-deposit` | Submit `factory.deploy()` — **signed by Web3signer**, no wallet |
| 5 | POST | `/api/deploy-deposit` (WHT) | Same, but with Swiss 35% Verrechnungssteuer enabled |

## Environments

- `local.bru` — `http://127.0.0.1:3001`, `ruleId=simple-act360-eur-350`
- `staging.bru` — placeholder for a staging deployment

Override per-request via the URL bar or by editing the `vars` block in the env file.

## Why Bruno (not Postman)

- **No cloud account required** — collection lives in this repo
- **Reviewable diffs** — `.bru` files are plain text; PRs show what changed
- **No vendor lock-in** — works offline, exports are stable
- **Auditor-friendly** — compliance reviewers can read flat files without installing Bruno
