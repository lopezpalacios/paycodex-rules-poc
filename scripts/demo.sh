#!/usr/bin/env bash
# `npm run demo` — single-command end-to-end demo for the devcontainer
# (and the devcontainer.yml CI workflow). Deploys all rules to in-memory
# Hardhat, runs WASM-vs-Solidity parity, runs the no-chain simulator.
#
# This is intentionally the SAME flow the devcontainer CI runs in CI,
# so a green `npm run demo` locally implies a green CI demo.

set -euo pipefail

green() { printf "\033[32m%s\033[0m\n" "$*"; }
gray()  { printf "\033[90m%s\033[0m\n" "$*"; }

green "▶ build wasm + compile contracts"
npm run wasm:build
npm run compile
gray ""

green "▶ deploy 9 rules + 9 pools to in-memory hardhat"
npx hardhat deploy:all --with-pools
gray ""

green "▶ deployment registry"
if command -v jq >/dev/null 2>&1; then
  jq 'to_entries | map({key, value}) | sort_by(.key)' .deployments/hardhat.json | head -80
else
  cat .deployments/hardhat.json
fi
gray ""

green "▶ wasm parity tests (WASM ↔ Solidity)"
npm run wasm:test
gray ""

green "▶ simulator: rule 01 simple-act/360 over 360 days on 1,000,000 base units"
node scripts/simulate.mjs --rule rules/examples/01-simple-act360.json --balance 1000000 --days 360
gray ""

green "✓ demo complete"
cat <<'BANNER'

Next steps:
  npm test                          # full Hardhat suite (60+ tests)
  npm run besu:up                   # spin up real Besu + Web3signer (DinD)
  npm run server                    # backend on :3001 (needs deployments)
  npm run ui                        # Vite UI on :5173

BANNER
