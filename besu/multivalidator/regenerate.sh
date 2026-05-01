#!/usr/bin/env bash
# Regenerate the 4-validator IBFT2 genesis + keys + static-nodes.json.
# Idempotent. Requires Docker.
#
# Output:
#   besu/multivalidator/genesis.json                  — chain config + extraData with 4 validators
#   besu/multivalidator/keys/validator-{1..4}/key     — each node's private key
#   besu/multivalidator/keys/validator-{1..4}/key.pub — each node's public key (used in enode URLs)
#   besu/multivalidator/static-nodes.json             — peering manifest used by all 4 nodes
#   besu/multivalidator/funded.json                   — funded dev account (validator-1) for deploys
#
# After running:
#   1. (Optional) edit alloc to fund a different account
#   2. Update Web3signer key in besu/multivalidator/web3signer/keys/<addr>.yaml
#   3. docker compose -f besu/multivalidator/docker-compose.yml up -d

set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=besu/multivalidator
mkdir -p "$OUT/keys"
rm -rf "$OUT/networkFiles"

# 1. Run the generator
docker run --rm \
  -v "$(pwd)/$OUT":/data \
  hyperledger/besu:24.3.0 \
  operator generate-blockchain-config \
  --config-file=/data/ibft-config.json \
  --to=/data/networkFiles \
  --private-key-file-name=key

# 2. Move generator output into a deterministic layout
i=1
for d in "$OUT"/networkFiles/keys/*; do
  ADDR=$(basename "$d")
  mkdir -p "$OUT/keys/validator-$i"
  cp "$d/key"     "$OUT/keys/validator-$i/key"
  cp "$d/key.pub" "$OUT/keys/validator-$i/key.pub"
  echo "$ADDR" > "$OUT/keys/validator-$i/address"
  echo "  validator-$i: $ADDR"
  i=$((i+1))
done

# 3. Genesis: take from generator output, fund validator-1
ADDR_1=$(cat "$OUT/keys/validator-1/address")
python3 <<PY
import json
with open("$OUT/networkFiles/genesis.json") as f: g = json.load(f)
g["alloc"] = {
    "$ADDR_1": {
        "balance": "0x33b2e3c9fd0803ce8000000",
        "comment": "validator-1 + dev funded account; matches keys/validator-1/key"
    }
}
with open("$OUT/genesis.json", "w") as f: json.dump(g, f, indent=2); f.write("\n")
PY

# 4. Build static-nodes.json — list of enode URLs for cross-peering.
#    Besu rejects DNS hostnames in static-nodes.json (must be literal IPs).
#    docker-compose.yml assigns 172.30.30.11..14 to validators 1..4.
#    The pubkey from key.pub is the node ID (64 bytes, hex-encoded).
python3 <<'PY'
import json, os
from pathlib import Path
out = Path(os.environ.get("OUT", "besu/multivalidator"))
nodes = []
for i in range(1, 5):
    pub = (out / f"keys/validator-{i}/key.pub").read_text().strip()
    if pub.startswith("0x"):
        pub = pub[2:]
    nodes.append(f"enode://{pub}@172.30.30.{10+i}:30303")
(out / "static-nodes.json").write_text(json.dumps(nodes, indent=2) + "\n")
PY

# 5. Cleanup intermediate files
rm -rf "$OUT/networkFiles"

echo
echo "Done. Funded address: $ADDR_1"
echo "Run: docker compose -f besu/multivalidator/docker-compose.yml up -d"
