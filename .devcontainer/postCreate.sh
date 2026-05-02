#!/usr/bin/env bash
# postCreateCommand for the paycodex-rules-poc devcontainer.
# Runs once when the container is first created (and after rebuilds).
# Idempotent — safe to re-run.

set -euo pipefail

echo "::group::Install Foundry"
if ! command -v forge >/dev/null 2>&1; then
  curl -L https://foundry.paradigm.xyz | bash
  # foundryup needs $FOUNDRY_DIR/bin on PATH (devcontainer.json sets it)
  export PATH="$HOME/.foundry/bin:$PATH"
  foundryup
else
  echo "  forge already installed: $(forge --version | head -1)"
fi
echo "::endgroup::"

echo "::group::Install slither-analyzer + solc 0.8.24"
pip install --user --upgrade slither-analyzer solc-select
# pip --user puts bins at ~/.local/bin which is on PATH in this image
solc-select install 0.8.24
solc-select use 0.8.24
echo "::endgroup::"

echo "::group::Install Node deps"
# .npmrc has legacy-peer-deps=true
npm ci
echo "::endgroup::"

echo "::group::Build WASM + compile contracts"
npm run wasm:build
npm run compile
echo "::endgroup::"

echo "::group::Self-check"
npm run lint:sol
npx hardhat validate:rules
echo "::endgroup::"

cat <<'BANNER'

╔════════════════════════════════════════════════════════════════════╗
║  paycodex-rules-poc devcontainer ready                             ║
╠════════════════════════════════════════════════════════════════════╣
║  One-shot demo:                                                    ║
║    npm run demo                   # build + deploy + parity + sim   ║
║                                                                    ║
║  Other commands:                                                   ║
║    npm test                       # 60+ Hardhat tests               ║
║    npm run wasm:test              # WASM ↔ Solidity parity          ║
║    npx hardhat deploy:all --with-pools                             ║
║    npm run server                 # backend (port 3001)             ║
║    npm run ui                     # UI dev (port 5173)              ║
║                                                                    ║
║  Real chain (requires DinD up):                                    ║
║    npm run besu:up                # besu + web3signer (8545/9000)   ║
║    npx hardhat deploy:all --with-pools --network besu              ║
╚════════════════════════════════════════════════════════════════════╝
BANNER
