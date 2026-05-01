# Besu IBFT2 — single-validator dev chain

Permissioned EVM, instant finality, free gas. **Demo-only — DO NOT use this key/genesis in any non-local environment.**

## Topology

- 1 validator node, IBFT2 consensus, 2s block period
- Chain ID `1337`
- Validator + pre-funded dev account: `0xacfebbfffcc5da7cc2a42d5a075572132e5102a6`
- Validator privkey in `besu/key` (committed; dev-only)
- Genesis `extraData` produced by `besu operator generate-blockchain-config` — guaranteed valid IBFT2 RLP

## Run

```bash
docker compose -f besu/docker-compose.yml up -d   # start
docker compose -f besu/docker-compose.yml logs -f # tail
docker compose -f besu/docker-compose.yml down    # stop
docker compose -f besu/docker-compose.yml down -v # stop + nuke chain data
```

## Verify

```bash
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  http://localhost:8545
# → {"jsonrpc":"2.0","id":1,"result":"0x..."}
```

## Deploy a rule against Besu

```bash
RULE=rules/examples/01-simple-act360.json npx hardhat run scripts/deploy.ts --network besu
```

## Regenerating genesis

If you need to regenerate (different chain ID, multiple validators, different keys):

```bash
bash besu/regenerate.sh
```

This runs `besu operator generate-blockchain-config` in a one-shot Docker container, replaces `besu/genesis.json` and `besu/key`. Manually update `hardhat.config.ts` with the new privkey afterward.

Input spec is `besu/ibft-config.json`. Adjust validator count, chain ID, gas limit, IBFT2 params there.

## Why Besu (vs anvil/Hardhat in-mem)

- Real permissioned-EVM banks use Besu (or Quorum, which is a Besu fork).
- IBFT2 = byzantine-fault-tolerant consensus, what tokenized-deposit consortia run.
- Free gas (`min-gas-price=0`) keeps demo simple but the deployment story is identical.

## Files

| File | Purpose |
|---|---|
| `genesis.json` | Chain config + IBFT2 extraData (validator set encoded in RLP) |
| `key` | Validator node private key (matches the validator address in `extraData` and the funded alloc) |
| `docker-compose.yml` | One-validator Besu container with HTTP + WS RPC exposed |
| `ibft-config.json` | Input spec for `besu operator generate-blockchain-config` |
| `regenerate.sh` | Idempotent regeneration script |
