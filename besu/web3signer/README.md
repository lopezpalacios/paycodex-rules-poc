# Web3signer config

Provides remote-signing for the Besu chain. Replaces in-browser MetaMask for backend / headless flows.

- `keys/` — one YAML file per loaded key. PoC uses `file-raw` (privkey in plaintext) — **dev only**. For production, swap to `hashicorp`, `aws-kms`, `azure-keyvault`, or `yubihsm`.
- The single key here matches `besu/key` and the funded address in `besu/genesis.json`.

## Production-grade key sources

Web3signer also supports (drop-in by changing the key file's `type`):

```yaml
# HashiCorp Vault
type: "hashicorp"
keyType: "SECP256K1"
tlsEnabled: true
keyPath: "/v1/secret/data/web3signer/key1"
keyName: "value"
serverHost: "vault.internal"
token: "..."
```

```yaml
# AWS KMS
type: "aws-kms"
keyType: "SECP256K1"
accessKeyId: "..."
secretAccessKey: "..."
region: "eu-central-1"
kmsKeyId: "alias/paycodex-deposit-issuer"
```

```yaml
# Azure Key Vault
type: "azure-key-vault"
keyType: "SECP256K1"
clientId: "..."
clientSecret: "..."
tenantId: "..."
vaultName: "paycodex-vault"
keyName: "deposit-issuer"
```

## Why this exists

In a real bank issuing tokenized deposits, customers do not hold or sign with browser wallets. The bank's operator service:

1. Receives a signed customer intent (over HTTPS, after auth)
2. Validates against business rules
3. Submits a tx via Web3signer (which holds the issuer's keys in HSM/KMS/Vault)
4. Returns the deposit address to the customer

This config + the `scripts/server.mjs` backend implements exactly that pattern.
