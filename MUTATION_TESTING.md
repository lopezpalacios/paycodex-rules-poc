# Mutation testing

Mutation testing complements coverage. Coverage tells you "the test runs through this line"; mutation testing tells you "if I change this line, do the tests notice?"

## The score

For each mutation operator, slither-mutate replaces a piece of code (e.g. `+` → `-`, `>=` → `>`, `revert` → no-op) and runs the full test suite. A mutant is **caught** if any test fails after the mutation. **Mutation score** = `caught / total mutants`.

A score of 100% means every alteration is detected by some test. Realistic ceiling for production codebases is 70-90%.

## Running locally

```bash
# Whole codebase (30-60 min on a beefy laptop)
bash scripts/mutation-test.sh contracts/

# One file (fast iteration)
bash scripts/mutation-test.sh contracts/strategies/SimpleStrategy.sol
```

Output goes to `mutation_campaign/`:

```
mutation_campaign/
├── mutants_results.json     # per-mutant: caught / not-caught / failed-to-compile
├── mutants_diff/            # one .diff per surviving mutant
└── tests_logs/              # the test-run log per mutant
```

Inspect surviving mutants — those are real test gaps.

## Reading a survivor

Example surviving mutant in `mutation_campaign/mutants_diff/`:

```diff
--- contracts/strategies/SimpleStrategy.sol
+++ contracts/strategies/SimpleStrategy.sol (mutant)
@@ -25,7 +25,7 @@
-        return (balance * uint256(rateBps) * daysCount) / (10000 * denom);
+        return (balance * uint256(rateBps) * daysCount) / (10000 + denom);
```

If this survives, our tests don't pin down the denominator semantics — meaning a real bug that swaps `*` for `+` in the divisor would ship. **Add a test that pins the magnitude precisely** (we already do via the `8750` and `15000` fixtures, so this specific mutator should be caught).

## Why nightly, not per-PR

Full campaign takes ~60 min on standard CI runners. PRs would block too long. The nightly workflow (`.github/workflows/mutation.yml`) runs at 04:00 UTC and uploads the campaign artifact; reviewers triage survivors over coffee.

Override / manual run: GitHub Actions → workflow_dispatch on the `Mutation testing (nightly)` job.

## Mutators we run

Subset of slither-mutate's 15 operators (see `scripts/mutation-test.sh`):

| Code | Name | What it replaces |
|---|---|---|
| AOR  | Arithmetic operator replacement | `+` ⇄ `-`, `*` ⇄ `/`, etc. |
| ASOR | Assignment operator replacement | `+=` ⇄ `-=`, etc. |
| BOR  | Bitwise operator replacement | `&` ⇄ `|`, `<<` ⇄ `>>` |
| FHR  | Function header replacement | `external` ⇄ `public`, `view` removed, etc. |
| LIR  | Literal integer replacement | `1` → `0`, `10000` → `1`, etc. |
| LOR  | Logical operator replacement | `&&` ⇄ `||` |
| MIA  | If construct around statement | wraps statement in `if (true)` |
| MVIE | Variable initialization (expression) | replaces RHS of an assignment |
| MVIV | Variable initialization (value) | replaces literal in init |
| MWA  | While construct around statement | wraps statement in `while (false)` |
| ROR  | Relational operator replacement | `<` ⇄ `>`, `<=` ⇄ `<`, etc. |
| RR   | Revert replacement | `revert(...)` → empty / `return` |

Excluded: `CR` (comment-only), `SBR` (high false-positive), `UOR` (mostly redundant under solidity 0.8 overflow checks).

## Triage workflow

1. Open the artifact from the latest mutation run
2. Sort by category (compile-failed mutants are noise, ignore)
3. For each `not-caught` mutant: read the diff, decide if a test should detect it
4. **Real gap:** add a test in the appropriate `test/` file
5. **Equivalent mutant:** comment in `slither.config.json` excluding that line, or add to `MUTATION_EXCLUSIONS.md`
6. Re-run until the score plateau is acceptable

Target: ≥80% mutation score on `contracts/strategies/` (the load-bearing math).
