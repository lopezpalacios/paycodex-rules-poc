## Summary

<!-- 1–3 bullets on what changes and why -->

## Type of change

- [ ] Bug fix
- [ ] New feature / strategy
- [ ] Refactor (no behavior change)
- [ ] CI/CD or tooling
- [ ] Dependency bump
- [ ] Docs

## Solidity / contracts (skip if N/A)

- [ ] No new external entry points OR each new entry point is reentrancy-safe (CEI + `nonReentrant` where needed)
- [ ] No new strategy that breaks WASM ↔ Solidity parity (run `npx hardhat compare:rule` for the touched rule)
- [ ] Slither passes locally (`slither .`) with 0 findings ≥ medium
- [ ] Foundry fuzz tests cover the new code path

## WASM / rule engine (skip if N/A)

- [ ] `npm run wasm:test` passes
- [ ] `wasm/tests/run.mjs` updated for any new rule kind
- [ ] JSON schema (`rules/schema.json`) extended if a new rule kind landed

## CI / infra (skip if N/A)

- [ ] Workflow change tested locally with `act` or self-hosted runner
- [ ] No secret/credential added to image or workflow inputs
- [ ] Branch-protection required checks still apply

## Test plan

<!-- What did you actually run? Paste relevant output if useful. -->

- [ ] `npm test` (Hardhat suite)
- [ ] `npm run wasm:test`
- [ ] `npm run lint:sol`

## Linked issues / context

<!-- Closes #N, refs #M, etc. -->
