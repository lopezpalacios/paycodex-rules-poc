# Incident response runbook

Concrete playbooks for the 7 incident classes that hit a tokenised-deposit issuance stack like this one. Each section is self-contained: severity, detection signals, immediate-response commands, post-incident steps, and which contract/script to reach for.

**Severity levels:**

| Level | Response time | Comms |
|---|---|---|
| **SEV-1** Customer funds at risk | minutes | Wake on-call, exec, regulator notice within hours |
| **SEV-2** Compliance breach (no fund loss) | hour | Wake on-call + compliance |
| **SEV-3** Operational degradation | hours | Eng on-call only |
| **SEV-4** Audit / hygiene | next business day | Async ticket |

If unsure of severity, pick the **higher** one. Downgrading is cheap; upgrading after the fact looks bad in a regulator review.

---

## 1. Sanctioned address detected at deploy time (SEV-2)

### Signals
- Backend log: `[server] BLOCKED deploy-deposit for sanctioned customer 0x… (auth=admin)`
- HTTP 451 returned to caller
- No on-chain transaction was submitted (sanctions screen is at the Express boundary)

### Immediate response

```bash
# 1. Confirm the block fired correctly
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  http://127.0.0.1:3001/api/health | jq '.blocklistSize'

# 2. Pull the audit trail for this customer attempt
journalctl -u paycodex-server --since "5 min ago" | grep BLOCKED

# 3. Notify compliance with: customer address, ruleId, timestamp, requesting API key name
```

### Post-incident
- File an internal SAR (Suspicious Activity Report) — local jurisdiction's required filing
- If the customer was screened-out due to a stale list, update the list and hot-reload:
  ```bash
  vim data/sanctions/blocklist.json
  curl -X POST -H "Authorization: Bearer $ADMIN_KEY" \
    http://127.0.0.1:3001/api/admin/reload-blocklist
  ```
- If the screen failed (sanctioned address slipped through somewhere): SEV-1, see §2.

### What NOT to do
- Don't tell the customer they're on a sanctions list. Backend already returns silent 451 with no detail by design.
- Don't whitelist the customer manually without compliance signoff.

---

## 2. Web3signer / issuer key compromise suspected (SEV-1)

### Signals
- Unauthorised contract calls signed by the issuer address
- Web3signer host shows unexpected outbound traffic
- Backup or HSM access alerts
- Anomalous `factory.deploy()` invocations not matching customer-onboarding records

### Immediate response (in this order; do not skip)

```bash
# 1. STOP THE BLEEDING — pause the backend so no more txs are submitted
docker compose -f besu/docker-compose.yml stop web3signer
# (Web3signer down → backend's deploy-deposit returns 500; safer than partial)

# 2. Capture forensic state
docker compose -f besu/docker-compose.yml logs --since 1h web3signer > /tmp/incident-w3s.log
docker compose -f besu/docker-compose.yml logs --since 1h besu > /tmp/incident-besu.log

# 3. Snapshot the chain BEFORE deciding next step
bash besu/backup.sh   # writes besu/backups/besu-data-<ts>.tar.gz

# 4. Enumerate impact: what did the suspect signer do?
ISSUER=0xacFEbBFFFcc5DA7CC2a42d5A075572132e5102a6   # adjust per env
# All txs sent by issuer in the last hour:
cast block-by-number --rpc-url http://127.0.0.1:8545 latest \
  | jq '.transactions[] | select(.from == "'$ISSUER'")'
```

### Recovery path

1. **Rotate keys.** Generate a fresh signing key (HSM/Vault/KMS workflow). Update `besu/web3signer/keys/<new-addr>.yaml`. The old key MUST be revoked at the source — KMS DisableKey, Vault revoke, HSM destroy.
2. **Deprecate any rule whose `deposit` was deployed by the suspect issuer in the suspect window.** Through the multisig:
   ```bash
   # Encode: registry.deprecate(ruleId)
   DATA=$(cast calldata "deprecate(bytes32)" "$RULE_ID")
   # Submit to multisig (any owner)
   cast send $MULTISIG "submit(address,bytes)" $REGISTRY $DATA
   # Other owners approve until threshold
   cast send $MULTISIG "approve(uint256)" $PROPOSAL_ID
   ```
3. **Resume traffic** with the new key only after compliance + security signoff.

### Why deprecate vs. pause

The contracts have **no global pause** — deprecation per-rule is the only on-chain kill switch. This is by design: a global pause is a single point of failure that an attacker who compromised one operator could trigger maliciously.

### Post-incident
- 24-hour timeline reconstruction → regulator notice (CH FINMA, EU national, UK FCA — depending on cash leg)
- 7-day post-mortem with Trail of Bits / external auditor
- Slither + mutation campaign re-run on any contracts touched

---

## 3. Bad rule registered (SEV-2)

### Signals
- Mismatched `ruleHash` audit on a registered rule (chain hash != JSON file hash)
- Strategy contract has a bug discovered post-deploy (e.g. compound rate truncation)
- Compliance team rejects the rule's WHT regime

### Immediate response

```bash
# Mark the rule deprecated. New deposits with this ruleId become impossible
# (DepositFactory reverts RuleDeprecated). Existing deposits keep accruing
# under the old strategy — that's intentional; you can't unilaterally
# change customer-agreed terms.
DATA=$(cast calldata "deprecate(bytes32)" "$RULE_ID")
cast send $MULTISIG "submit(address,bytes)" $REGISTRY $DATA --private-key $OPERATOR_KEY_1
# Capture the proposal id from the event log, then have other owners approve.
```

### Communicating with affected customers

- Existing deposits: post a notice that this ruleId is deprecated; new deposits will use ruleId `<new>`.
- Honour the original rate agreement on existing deposits unless legal disagrees.

### Post-incident
- Audit the test that should have caught the bug. Add it.
- Update the JSON Schema to make the bad shape unrepresentable if possible.
- Re-run Slither + Foundry fuzz against the corrected contract.

---

## 4. WHT remittance failed (SEV-2)

### Signals
- `Posted` event emitted with `wht > 0` but `Collected` event from `TaxCollector` not seen for the same block
- Quarterly remittance manifest doesn't reconcile with `TaxCollector.collectedTotal[asset]`
- Customer dispute: "you withheld 35% but I'm not Swiss-resident"

### Immediate response

```bash
# 1. Reconcile on-chain TaxCollector totals against the bank's tax sub-ledger
TC=$(jq -r '.TaxCollector' .deployments/besu-signer.json)
USDC=$(jq -r '.MockUSDC' .deployments/besu-signer.json)
cast call --rpc-url http://127.0.0.1:8545 $TC "collectedTotal(address)" $USDC

# 2. Pull the events for the last 24h
cast logs --from-block -10000 --address $TC --rpc-url http://127.0.0.1:8545
```

### Recovery path

| Failure mode | Fix |
|---|---|
| Post emit but no Collected | Bug — `recordCollection` failed silently. Check Slither + post-mortem. |
| Reconciliation mismatch | Manual journal entry in the bank's tax sub-ledger to true up; quarterly remittance to authority is unaffected. |
| Wrong customer regime | Repost via the operator path with `whtEnabled=false`; refund via separate ledger entry. Do NOT try to "un-post" — interest is committed. |

### Post-incident
- Add a per-block invariant test: `sum(Posted.wht) - sum(Collected.amount) == 0` for the same block.

---

## 5. Customer disputes posted interest (SEV-3)

### Signals
- Customer service ticket: "you posted X but I expected Y"
- Internal NIM forecast variance > 1 bp on a specific account

### Immediate response

```bash
# Reproduce the customer's expectation locally
node scripts/simulate.mjs \
  --rule rules/examples/01-simple-act360.json \
  --balance 1000000 --days 30
# Compare against on-chain
npx hardhat compare:rule \
  --rule rules/examples/01-simple-act360.json \
  --balance 1000000 --days 30 \
  --network besu-signer
```

If WASM and Solidity match each other but disagree with the customer:
- The customer's expectation is mis-modelled (rate, day-count, balance basis)
- Send the rule's `ruleHash` from `RuleRegistry.get(ruleId)` and the matching JSON in `rules/examples/`
- Most disputes here resolve at "act/360 vs act/365" or "ADB vs PIT balance"

If WASM and Solidity disagree:
- The strategy contract was deployed with parameters that don't match the rule JSON. Check `ruleHash` matches `keccak256(file)`. If not, **SEV-1 → §2**: someone registered a rule with a hash mismatch.

### Post-incident
- Strengthen the registry-side invariant in CI: nightly job that checks every `Strategy_<ruleId>` deployment matches its rule's JSON keccak.

---

## 6. Chain halted / validator down (SEV-3)

### Signals
- `eth_blockNumber` not advancing
- Backend `/api/health` returns OK on Web3signer but stale `blockNumber`
- Customers can't deposit

### Immediate response (single-node setup)

```bash
# 1. Diagnose
docker compose -f besu/docker-compose.yml ps
docker compose -f besu/docker-compose.yml logs --tail=50 besu

# 2. Restart Besu (no data loss — chain state is in the volume)
docker compose -f besu/docker-compose.yml restart besu

# 3. If volume is corrupt
docker compose -f besu/docker-compose.yml down
bash besu/backup.sh --restore besu/backups/besu-data-<latest>.tar.gz
docker compose -f besu/docker-compose.yml up -d
```

### Multi-validator setup (consortium production)

If using `besu/multivalidator/`:

```bash
# Identify which validator is unhealthy
for i in 1 2 3 4; do
  echo "=== validator-$i ==="
  docker compose -f besu/multivalidator/docker-compose.yml logs --tail=10 besu-$i
done

# Restart just the bad one
docker compose -f besu/multivalidator/docker-compose.yml restart besu-3

# IBFT2 with N=4, F=1: chain produces blocks while ≥3 are healthy.
# If two validators die, chain halts deterministically until one returns.
```

### Post-incident
- Snapshot for forensics before any recovery action
- Update `besu/backups/` retention if the corruption windowed out

---

## 7. Sanctions list update needed (SEV-4 routine, SEV-1 if bypass found)

### Routine update

```bash
# 1. Pull the latest list (production: from OFAC SDN, EU consolidated, Chainalysis API, etc.)
# 2. Edit data/sanctions/blocklist.json — keep it sorted, lowercase
# 3. Hot-reload without restart
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  http://127.0.0.1:3001/api/admin/reload-blocklist
# 4. Confirm size
curl -s http://127.0.0.1:3001/api/health | jq '.blocklistSize'
```

### If a sanctioned address slipped through

This is **SEV-1**: a sanctioned entity received service. Branch to §2 (treat the issuer key as compromised in effect — your screening was bypassed) AND immediately:

```bash
# Find the deposit they have
DEPOSIT=$(jq -r ".\"Deposit_<ruleId>\"" .deployments/besu-signer.json)
# Multisig-call deprecate(ruleId) so no NEW deposits with this rule deploy
# (existing deposit keeps state; off-chain compliance freezes asset transfers)
```

Notify regulator within 24h. Customer-side: legal + compliance handle communication, not engineering.

---

## 8. Backend rate-limit + auth incidents (SEV-3)

### Signals
- Spike in 429 responses for a specific customer (rate limit triggered)
- Spike in 403 responses (key invalid or insufficient role)
- Anomalous "valid admin key + suspicious pattern" pattern

### Immediate response

```bash
# Check rate-limit state for a specific customer
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  http://127.0.0.1:3001/api/admin/rate-limit/$CUSTOMER

# Rotate the admin API key (key compromise → §2 if signing key also compromised)
# 1. Add new key to PAYCODEX_API_KEYS env var
# 2. Roll out to backend
# 3. Revoke old key (remove from env, restart)
# 4. Notify all consumer apps of the key swap
```

---

## 9. Cheat sheet — kill switches

| Threat | Lever | Command |
|---|---|---|
| One bad rule | `RuleRegistry.deprecate(ruleId)` | via multisig propose+approve |
| Web3signer compromise | Pause Web3signer | `docker compose -f besu/docker-compose.yml stop web3signer` |
| Sanctioned address slipping through | Hot-reload blocklist | `POST /api/admin/reload-blocklist` |
| Backend exposed | Pause backend | `pkill -f scripts/server.mjs` (production: revoke API keys) |
| Total halt | Tear down chain (last resort, breaks customer SLAs) | `docker compose -f besu/docker-compose.yml down` |

The system has **no global pause function** by design — every kill switch is granular. This is intentional. A compromised global pause = a censorship vector. Granular tools force the operator to pick the smallest blast-radius response.

---

## 10. Tabletop drill schedule

Cron in `.github/workflows/incident-drill.yml` (TBD — future iter):

| Drill | Cadence | Rotation |
|---|---|---|
| Backup → restore round-trip | Weekly | Eng on-call |
| Multisig deprecate rule | Monthly | Multisig owners |
| Web3signer key rotation | Quarterly | Security + ops |
| Full chain rebuild from backup | Quarterly | Eng + ops |
| Sanctions blocklist update flow | Monthly | Compliance + eng |

Untested runbooks rot. The schedule above ensures every command in this document has been executed by a human within the last quarter.

---

## See also

- [`DEPLOYMENT.md`](../DEPLOYMENT.md) — deployment scenarios + production hardening checklist
- [`besu/backup.sh`](../besu/backup.sh) — snapshot/restore script (used in §2, §6)
- [`contracts/OperatorMultisig.sol`](../contracts/OperatorMultisig.sol) — kill-switch authority
- [`contracts/RuleRegistry.sol`](../contracts/RuleRegistry.sol) — `deprecate(ruleId)` is the per-rule kill switch
- [`scripts/server.mjs`](../scripts/server.mjs) — backend with `/api/admin/reload-blocklist` and `/api/admin/rate-limit/:customer`
