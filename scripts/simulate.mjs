#!/usr/bin/env node
// CLI: load WASM, simulate accrual for a rule + balance + days. No chain interaction.
//
// Usage:
//   node scripts/simulate.mjs --rule rules/examples/01-simple-act360.json --balance 1000000 --days 90
//   node scripts/simulate.mjs --rule rules/examples/04-floating-estr.json --balance 1000000 --days 360 --oracle 350
//   node scripts/simulate.mjs --rule rules/examples/05-esg-kpi.json     --balance 1000000 --days 360 --kpi -50

import { loadWasm, loadRule, preview } from "../wasm/host.mjs";
import { resolve } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}

const rulePath = arg("rule");
if (!rulePath) {
  console.error("usage: simulate.mjs --rule <path> --balance <n> --days <n> [--oracle bps] [--kpi bps]");
  process.exit(1);
}
const balance = BigInt(arg("balance", "1000000"));
const days = BigInt(arg("days", "360"));
const oracle = BigInt(arg("oracle", "0"));
const kpi = BigInt(arg("kpi", "0"));

const wasmPath = resolve("wasm/build/release.wasm");
const wasm = await loadWasm(wasmPath);
const rule = await loadRule(rulePath);

const fromTs = 1_700_000_000n;
const toTs = fromTs + days * 86400n;

const result = preview(wasm, rule, balance, fromTs, toTs, oracle, kpi);

console.log(JSON.stringify(
  {
    rule: rule.ruleId,
    kind: rule.kind,
    dayCount: rule.dayCount,
    balance: balance.toString(),
    days: days.toString(),
    oracleBps: oracle.toString(),
    kpiBps: kpi.toString(),
    grossInterest: result.gross.toString(),
    netInterest: result.net.toString(),
    ecrInterest: result.ecr ? result.ecr.toString() : null,
  },
  null,
  2,
));
