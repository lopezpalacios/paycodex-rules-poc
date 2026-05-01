# Multi-validator Besu IBFT2

4-validator IBFT2 chain. Tolerates 1 byzantine fault (`F = (N-1)/3`, so 4 nodes tolerate 1).

| Property | Value |
|---|---|
| Chain ID | 1338 (vs. 1337 for the single-node demo, so the two stacks coexist) |
| Validator count | 4 |
| Byzantine tolerance | 1 (F = (4-1)/3 = 1) |
| Block period | 2 s |
| Consensus | IBFT2 |
| Discovery | Disabled — peers loaded from `static-nodes.json` |
| RPC exposure | Only validator-1 → host port 8545 (others reachable only on the docker network) |

## Why 4, not 1

Single-validator chains are a single point of failure. IBFT2 byzantine tolerance requires `N ≥ 3F+1` for `F` faults. Tokenised-deposit consortia typically run 4–7 validators per bank for both crash + byzantine resilience.

## Setup

### 1. Generate keys + genesis + static-nodes manifest

```bash
bash besu/multivalidator/regenerate.sh
```

Produces:
- `keys/validator-{1..4}/{key,key.pub,address}` — one keypair per validator
- `genesis.json` — IBFT2 extraData includes all 4 validator addresses; alloc funds validator-1
- `static-nodes.json` — list of `enode://...@besu-N:30303` URLs for cross-peering
- `funded.json` — convenience pointer to the funded address

### 2. Wire Web3signer to validator-1's signing key

```bash
ADDR=$(cat besu/multivalidator/keys/validator-1/address)
KEY=$(cat besu/multivalidator/keys/validator-1/key)
cat > "besu/multivalidator/web3signer/keys/${ADDR}.yaml" <<EOF
type: "file-raw"
keyType: "SECP256K1"
privateKey: "${KEY}"
EOF
```

For production: replace `file-raw` with a HashiCorp Vault / AWS KMS / Azure Key Vault config — see the single-validator `besu/web3signer/README.md`.

### 3. Boot the chain

```bash
docker compose -f besu/multivalidator/docker-compose.yml up -d
```

This starts:
- `paycodex-besu-1` (RPC on host :8545, P2P internal-only)
- `paycodex-besu-2`, `paycodex-besu-3`, `paycodex-besu-4` (no host RPC)
- `paycodex-web3signer-multi` (host :9000, downstream to besu-1)

### 4. Verify all 4 are mining together

```bash
# Block number on validator-1
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  http://127.0.0.1:8545

# IBFT validators (should be the 4 generated addresses)
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"ibft_getValidatorsByBlockNumber","params":["latest"],"id":1}' \
  http://127.0.0.1:8545
```

Expect 4 distinct validator addresses from `ibft_getValidatorsByBlockNumber`. Block number should advance every ~2 seconds.

### 5. Deploy contracts

The `hardhat.config.ts` `besu-signer` network points at Web3signer on `:9000`, which proxies to validator-1. Same deploy commands as the single-node setup:

```bash
npx hardhat deploy:all --network besu-signer
```

Note: `chainId: 1337` in `hardhat.config.ts` `besu-signer` network needs to be flipped to `1338` to match this chain. Add a separate `besu-multi-signer` network in the config if you want both stacks usable simultaneously.

### 6. Tolerance demo: kill one validator

```bash
docker compose -f besu/multivalidator/docker-compose.yml stop besu-3
# Block production continues — 3-of-4 still > 2*F+1 = 3
curl ... eth_blockNumber       # advances
docker compose -f besu/multivalidator/docker-compose.yml start besu-3
# besu-3 catches up
```

Stop a second validator and block production halts — that's IBFT2 working as designed (`N=4 → F=1`).

## Production notes

| PoC simplification | Production change |
|---|---|
| All 4 nodes on one Docker host | One node per AZ / region / data centre |
| `discovery-enabled=false` + static-nodes | Bootnode + discovery, OR maintained static manifest in config-management |
| All RPC paths exposed | RPC behind mTLS + L7 firewall, only `eth_*` exposed to apps |
| `min-gas-price=0` | Real gas economics or permissioned `--allow-tx-from` policy |
| `--rpc-http-cors-origins=all` | Specific allowed origins |
| Web3signer points at single besu-1 | LB across all 4 RPC endpoints with health checks |
| Validator keys live in `keys/` | HSM / KMS / Vault per node |

## Status: configuration ready, peering needs operator tuning

This iter ships:
- ✅ 4-validator genesis generator (`regenerate.sh`)
- ✅ Compose with 4 Besu services + static IPs (172.30.30.11..14) + Web3signer
- ✅ Per-validator key directories with addresses
- ✅ `static-nodes.json` with IP-based enode URLs (Besu rejects DNS hostnames)
- ✅ All 4 containers boot under Besu 24.3.0
- ⚠️ Peering is **intermittent** with `--discovery-enabled=false` + `static-nodes.json`. Each Besu validates incoming peer identities aggressively; static-only peering can fail to reach the `2F+1 = 3` quorum needed for IBFT2 round 0 commits. Symptoms: `net_peerCount` flickers 0–2, `admin_peers` empty, block 0 frozen.

### What to fix in the next iter or production

| Problem | Fix |
|---|---|
| Static-nodes only sometimes connects | Enable bootnode + discovery: `--bootnodes=enode://...@172.30.30.11:30303` on validators 2-4, drop `--discovery-enabled=false` on all |
| Containers race-start | Add `depends_on:` `service_started` chains so besu-2/3/4 wait for besu-1 |
| Peer-identity rejection | Pre-share `permissions_nodes_config.toml` with all 4 enodes; pass `--permissions-nodes-config-file-enabled` |
| AZ partition tolerance in real deployment | Bootnode + discovery + a permanent overlay (e.g. WireGuard) between regions |

The single-node `besu/` setup remains the per-PR E2E target. This 4-node stack is the **architecture template** for production deployments; full local boot verification is deferred to ops once bootnode + permissions-nodes are wired (estimated half-day of follow-up work).

## See also

- Single-node sibling: [`../docker-compose.yml`](../docker-compose.yml) + [`../README.md`](../README.md)
- Hyperledger FireFly migration plan: [`../../firefly/README.md`](../../firefly/README.md)
- Production deployment guide: [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md) §4 "Production sketch"
