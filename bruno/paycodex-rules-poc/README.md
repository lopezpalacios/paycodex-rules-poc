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

| # | Method | Path | Auth | What it does |
|---|---|---|---|---|
| 1 | GET | `/api/health` | none | Probe Web3signer + Besu liveness; show issuer address + block number |
| 2 | GET | `/api/deployments` | reader | Read `.deployments/<network>.json` |
| 3 | POST | `/api/preview-onchain` | reader | Read-only `strategy.previewAccrual` for a rule |
| 4 | POST | `/api/deploy-deposit` | admin | Submit `factory.deploy()` — Web3signer signs |
| 5 | POST | `/api/deploy-deposit` (WHT) | admin | Same, with CH 35% Verrechnungssteuer + WHT routed to TaxCollector |
| 6 | POST | `/api/deploy-deposit` (sanctioned) | admin | Negative test — backend returns HTTP 451, no tx submitted |
| 7 | GET | `/api/deployments` (no auth) | none | Negative test — backend returns HTTP 401 |

## Environments

- `local.bru` — `http://127.0.0.1:3001`, `ruleId=simple-act360-eur-350`, `readerKey=read-secret-1234`, `adminKey=admin-secret-5678`
- `staging.bru` — placeholder; replace dev keys with real key-vault references

## Auth setup

The backend uses Bearer-token API keys. Start the server with:

```bash
PAYCODEX_API_KEYS='reader:read-secret-1234,admin:admin-secret-5678' \
PAYCODEX_ADMIN_KEYS='admin' \
NETWORK=besu-signer npm run server
```

If `PAYCODEX_API_KEYS` is empty, auth is disabled and a loud warning is logged at startup. Never run that way in production.

Override per-request via the URL bar or by editing the `vars` block in the env file.

## Why Bruno (not Postman)

- **No cloud account required** — collection lives in this repo
- **Reviewable diffs** — `.bru` files are plain text; PRs show what changed
- **No vendor lock-in** — works offline, exports are stable
- **Auditor-friendly** — compliance reviewers can read flat files without installing Bruno
