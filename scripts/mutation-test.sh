#!/usr/bin/env bash
# Run slither-mutate over the contract suite using the existing hardhat test
# command as the oracle. WARNING: a full run takes 30-60 minutes (every mutator
# × every contract × full test re-run per mutant).
#
# Usage:  bash scripts/mutation-test.sh [target-file-or-dir]
#         bash scripts/mutation-test.sh contracts/strategies/SimpleStrategy.sol

set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-contracts/strategies/}"
OUT="${2:-mutation_campaign}"

# Skip mutators that are too noisy or too expensive for our codebase:
# - CR (Comment Replacement) — irrelevant
# - SBR (Solidity Based Replacement) — many false positives
# - UOR — most uses already eliminated by 0.8 overflow
MUTATORS="AOR,ASOR,BOR,FHR,LIR,LOR,MIA,MVIE,MVIV,MWA,ROR,RR"

echo "[mutation] target=$TARGET out=$OUT mutators=$MUTATORS"
echo "[mutation] using `npx hardhat test` as test oracle (~30s per mutant)"

slither-mutate "$TARGET" \
  --test-cmd 'npx hardhat test' \
  --test-dir test \
  --ignore-dirs 'node_modules,artifacts,cache,coverage,test/foundry,lib,out' \
  --output-dir "$OUT" \
  --mutators-to-run "$MUTATORS" \
  --timeout 90 \
  --verbose

echo "[mutation] done. See $OUT/ for surviving mutants (test gaps)."
