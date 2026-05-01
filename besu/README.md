# Besu IBFT2 — single-validator dev chain

Permissioned EVM, instant finality, free gas. Demo-only — DO NOT use this key/genesis in any non-local environment.

## Topology

- 1 validator node
- IBFT2 consensus, 2s block period
- Chain ID `1337`
- Pre-funded dev account `0xd8782f7e3a0b6c66e2bbeb31aa1f06f0d8e1bd9d`
  - Private key `0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63`
  - Used as both validator and Hardhat deploy account

## Run

```bash
docker-compose up -d        # start
docker-compose logs -f      # tail logs
docker-compose down         # stop
docker-compose down -v      # stop + nuke chain data
```

## Verify

```bash
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  http://localhost:8545
# → {"jsonrpc":"2.0","id":1,"result":"0x..."}
```

## Why Besu (vs anvil/Hardhat in-mem)

- Real permissioned-EVM banks use Besu (or Quorum, which is a Besu fork).
- IBFT2 = byzantine-fault-tolerant consensus, what tokenized-deposit consortia run.
- Free gas (`min-gas-price=0`) keeps demo simple but the deployment story is identical.

## Genesis details

`extraData` encodes the IBFT2 validator set per [Besu IBFT2 docs](https://besu.hyperledger.org/private-networks/how-to/configure/consensus/ibft).
The single validator address is the coinbase of the dev account above.
