#!/usr/bin/env bash
# Regenerate Besu IBFT2 genesis + validator key using `besu operator generate-blockchain-config`.
# Idempotent — overwrites besu/genesis.json and besu/key. Requires Docker.
#
# Usage:  bash besu/regenerate.sh
#
# After running:
#  1. Update the alloc address in besu/genesis.json if you want a different funded account
#  2. Update hardhat.config.ts `besu.accounts[0]` with the new privkey from besu/key
#  3. Commit the new genesis + key + this script

set -euo pipefail

cd "$(dirname "$0")/.."

# Clean previous output
rm -rf besu/networkFiles

# Run the generator. ibft-config.json is the input spec.
docker run --rm \
  -v "$(pwd)/besu":/data \
  hyperledger/besu:24.3.0 \
  operator generate-blockchain-config \
  --config-file=/data/ibft-config.json \
  --to=/data/networkFiles \
  --private-key-file-name=key

VALIDATOR_DIR="$(ls besu/networkFiles/keys | head -1)"
VALIDATOR_ADDR="$VALIDATOR_DIR"
PRIVKEY="$(cat "besu/networkFiles/keys/$VALIDATOR_DIR/key")"

echo
echo "Validator address: $VALIDATOR_ADDR"
echo "Validator privkey: $PRIVKEY"
echo
echo "Genesis written to besu/networkFiles/genesis.json (rebuild besu/genesis.json with this content + funded alloc)."
echo "Privkey copied to besu/key."

# Auto-replace key
cp "besu/networkFiles/keys/$VALIDATOR_DIR/key" besu/key

# Write a fresh genesis file with the validator funded
python3 <<PY
import json
with open("besu/networkFiles/genesis.json") as f: g = json.load(f)
g["alloc"] = {
    "$VALIDATOR_ADDR": {
        "balance": "0x33b2e3c9fd0803ce8000000",
        "comment": "validator + dev funded account; matches privkey in besu/key."
    }
}
with open("besu/genesis.json", "w") as f: json.dump(g, f, indent=2); f.write("\n")
print("besu/genesis.json updated with funded alloc.")
PY

# Cleanup intermediate files
rm -rf besu/networkFiles

echo
echo "Done. Update hardhat.config.ts besu.accounts[0] with the privkey above, then commit."
