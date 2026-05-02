#!/usr/bin/env bash
# `npm run dev:up` — one-command full stack for the devcontainer / devpod / Codespaces.
#
# Brings up Besu IBFT2 + Web3signer + the paycodex backend (containerized) on
# their forwarded ports. UI runs separately on the host via `npm run ui`.
#
# Idempotent: down + up. Safe to re-run.

set -euo pipefail

green() { printf "\033[32m%s\033[0m\n" "$*"; }
gray()  { printf "\033[90m%s\033[0m\n" "$*"; }

# Default dev secrets — NOT for production. devcontainer.json forwards
# port 3001 with notify so the operator sees the Express endpoint pop up.
: "${PAYCODEX_API_KEYS:=dev:s3cret}"
: "${PAYCODEX_ADMIN_KEYS:=s3cret}"
export PAYCODEX_API_KEYS PAYCODEX_ADMIN_KEYS

green "▶ down (clean slate)"
docker compose -f besu/docker-compose.yml --profile backend down --remove-orphans 2>&1 | tail -3 || true
gray ""

green "▶ up (besu + web3signer + backend), build backend image fresh"
docker compose -f besu/docker-compose.yml --profile backend up -d --build
gray ""

green "▶ wait for besu RPC to respond"
for i in {1..60}; do
  BLOCK=$(curl -fs -X POST -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    http://127.0.0.1:8545 2>/dev/null | grep -oE '"result":"0x[0-9a-f]+"' || true)
  if [ -n "$BLOCK" ]; then
    echo "  ✓ besu up: $BLOCK"; break
  fi
  [ "$i" -eq 60 ] && { echo "::error::besu didn't come up in 60s"; docker compose -f besu/docker-compose.yml logs --tail=50; exit 1; }
  sleep 1
done
gray ""

green "▶ wait for backend /api/health"
for i in {1..30}; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/api/health || echo 000)
  if [ "$CODE" = "200" ] || [ "$CODE" = "500" ]; then
    echo "  ✓ backend up: HTTP=$CODE  (500 here just means deployments not yet loaded)"
    break
  fi
  [ "$i" -eq 30 ] && { echo "::error::backend didn't bind in 30s"; docker compose -f besu/docker-compose.yml logs backend --tail=30; exit 1; }
  sleep 1
done
gray ""

green "✓ stack up"
cat <<BANNER

  Ports (auto-forwarded by devcontainer.json on devpod/Codespaces):
    8545  Besu JSON-RPC HTTP
    9000  Web3signer (eth1, downstream → besu)
    3001  paycodex backend (auth + sanctions + rate-limit pipeline)
    5173  Vite UI dev server (run separately: npm run ui)

  Try it:
    curl http://127.0.0.1:3001/api/health | jq .
    curl -H "Authorization: Bearer s3cret" http://127.0.0.1:3001/api/deployments | jq .

  Then deploy a rule:
    npx hardhat deploy:rule --rule rules/examples/01-simple-act360.json --network besu-signer

  Tear down:
    npm run dev:down

BANNER
