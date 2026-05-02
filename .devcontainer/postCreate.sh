#!/usr/bin/env bash
# postCreateCommand for the paycodex-rules-poc devcontainer.
# Runs once when the container is first created (and after rebuilds).
# Idempotent — safe to re-run.

set -euo pipefail

# Ensure both Foundry and pip --user bin dirs are on PATH for THIS script's
# subshells. devcontainer.json's `remoteEnv` sets PATH for interactive shells
# but the postCreate runs in a non-login non-interactive shell where it isn't
# guaranteed to apply. Be explicit.
export PATH="$HOME/.local/bin:$HOME/.foundry/bin:$PATH"

echo "::group::Install Foundry"
if ! command -v forge >/dev/null 2>&1; then
  curl -L https://foundry.paradigm.xyz | bash
  foundryup
else
  echo "  forge already installed: $(forge --version | head -1)"
fi
echo "::endgroup::"

echo "::group::Install slither-analyzer + solc 0.8.24"
pip install --user --upgrade slither-analyzer solc-select
# Re-export PATH after pip install (idempotent, doesn't hurt).
export PATH="$HOME/.local/bin:$PATH"
hash -r
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
║  One-shot demo (no chain):                                         ║
║    npm run demo                   # build + deploy + parity + sim   ║
║                                                                    ║
║  Full stack (besu + web3signer + backend, in containers):          ║
║    npm run dev:up                 # ports 8545, 9000, 3001          ║
║    npm run ui                     # then UI on port 5173            ║
║    npm run dev:down               # tear down                       ║
║                                                                    ║
║  Other:                                                            ║
║    npm test                       # 60+ Hardhat tests               ║
║    npm run wasm:test              # WASM ↔ Solidity parity          ║
║    npx hardhat deploy:all --with-pools                             ║
║                                                                    ║
║  Real chain (requires DinD up):                                    ║
║    npm run besu:up                # besu + web3signer (8545/9000)   ║
║    npx hardhat deploy:all --with-pools --network besu              ║
╚════════════════════════════════════════════════════════════════════╝
BANNER
