#!/usr/bin/env bash
# Run every QA gate locally and print a green/red summary. Used as a
# pre-commit + pre-PR sanity check. Mirrors what CI runs minus the
# Docker-Besu E2E (since that requires a running Docker daemon).
#
# Usage:
#   bash scripts/healthcheck.sh           # full check
#   bash scripts/healthcheck.sh --fast    # skip slow gates (coverage, mutation, gas)
#
# Exit code: 0 if every required gate passes, 1 otherwise.

set -uo pipefail
cd "$(dirname "$0")/.."

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

# ANSI colours for terminal output (degrade gracefully under non-tty)
if [ -t 1 ]; then
  GREEN="\033[32m" RED="\033[31m" YELLOW="\033[33m" BOLD="\033[1m" RESET="\033[0m"
else
  GREEN="" RED="" YELLOW="" BOLD="" RESET=""
fi

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

printf "${BOLD}paycodex-rules-poc · healthcheck${RESET}\n\n"

run_gate() {
  local name="$1"
  local cmd="$2"
  local required="${3:-yes}"

  printf "  %-35s " "$name"
  local out
  if out=$(bash -c "$cmd" 2>&1); then
    printf "${GREEN}✔ pass${RESET}\n"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    if [ "$required" = "no" ]; then
      printf "${YELLOW}⚠ skip (optional, errored)${RESET}\n"
      SKIP_COUNT=$((SKIP_COUNT + 1))
    else
      printf "${RED}✗ fail${RESET}\n"
      printf "${RED}      ↳ %s${RESET}\n" "$(echo "$out" | tail -3 | head -1)"
      FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
  fi
}

run_gate "schema validation"      "npm run validate:rules > /dev/null"
run_gate "Solidity lint (solhint)" "npm run lint:sol > /dev/null"
run_gate "WASM build"              "npm run wasm:build > /dev/null"
run_gate "Solidity compile"        "npm run compile > /dev/null"
run_gate "Hardhat tests"           "npm test > /dev/null"
run_gate "WASM unit tests"         "npm run wasm:test > /dev/null"

# Foundry tests are optional — only run if forge is on PATH (works in CI runner via foundry-toolchain action)
if command -v forge >/dev/null 2>&1; then
  run_gate "Foundry fuzz tests"    "forge test > /dev/null"
else
  printf "  %-35s ${YELLOW}⚠ skip (forge not installed)${RESET}\n" "Foundry fuzz tests"
  SKIP_COUNT=$((SKIP_COUNT + 1))
fi

# Slither: optional (requires Python + slither-analyzer)
if command -v slither >/dev/null 2>&1; then
  run_gate "Slither static analysis" "slither . --config-file slither.config.json --triage-mode > /dev/null 2>&1 || slither . --config-file slither.config.json > /dev/null"
else
  printf "  %-35s ${YELLOW}⚠ skip (slither not installed)${RESET}\n" "Slither static analysis"
  SKIP_COUNT=$((SKIP_COUNT + 1))
fi

if [ "$FAST" = "0" ]; then
  run_gate "Solidity coverage"     "npm run coverage > /dev/null" "no"
  run_gate "Gas benchmark"         "npm run bench > /dev/null" "no"
  run_gate "UI bundle build"       "npm run ui:build > /dev/null" "no"
fi

printf "\n  ${BOLD}summary${RESET}: ${GREEN}%d pass${RESET}, ${RED}%d fail${RESET}, ${YELLOW}%d skip${RESET}\n" \
  "$PASS_COUNT" "$FAIL_COUNT" "$SKIP_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  printf "\n  ${RED}healthcheck FAILED — fix the above before committing or opening a PR.${RESET}\n"
  exit 1
fi

printf "\n  ${GREEN}healthcheck OK${RESET} — safe to commit / open PR.\n"
