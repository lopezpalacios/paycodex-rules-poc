# Sanctions blocklist

Address-level deny-list checked at the Express backend before any `deploy-deposit` call.

This is a **stub** for the PoC. Production wires this to the live OFAC SDN list, EU consolidated list, UK OFSI list, or a third-party screening provider (Chainalysis, Elliptic, TRM Labs).

## Format

`blocklist.json` — flat array of lowercase 0x-prefixed Ethereum addresses:

```json
[
  "0x0000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000002"
]
```

The check is exact-match on the lowercase address. No CIDR, no derived-address, no clustering. Production needs all of those.

## Why backend, not on-chain

Two reasons sanctions screening sits at the application boundary instead of in the strategy contract:

1. **List churn** — sanctions lists update many times per week. Pushing every update on-chain is gas-prohibitive and lags reality.
2. **Disclosure** — supervisors don't want sanctioned entities to learn they're listed by transaction-revert side-channel. Reject silently at the boundary; never reach the contract.

For an on-chain enforcement layer (which IS desirable as defense-in-depth), use the T-REX / ERC-3643 allowlist on the underlying tokenized-deposit token. See [`paycodex-onchain/cash-legs/tokenized-deposit.md`](../../../paycodex-onchain/cash-legs/tokenized-deposit.md).

## How to test

The `blocklist.json` here contains the placeholder address `0x0000…01`. To exercise the rejection path:

```bash
curl -s -X POST http://127.0.0.1:3001/api/deploy-deposit \
  -H "Authorization: Bearer ${PAYCODEX_API_KEY}" \
  -H "Content-Type: application/json" \
  --data '{"ruleId":"simple-act360-eur-350","customer":"0x0000000000000000000000000000000000000001"}'
# → HTTP 451 Unavailable For Legal Reasons
# → {"error":"customer address blocked: 0x0000…0001"}
```
