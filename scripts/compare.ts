// Compare WASM preview vs deployed Solidity strategy for a single rule.
// Usage: npx hardhat run scripts/compare.ts --network <net> -- --rule rules/examples/01-simple-act360.json

import { ethers, network } from "hardhat";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadWasm, preview } from "../wasm/host.mjs";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function main() {
  const rulePath = arg("rule");
  if (!rulePath) throw new Error("missing --rule");
  const balance = BigInt(arg("balance") ?? "1000000");
  const days = BigInt(arg("days") ?? "360");

  const ruleJson = readFileSync(rulePath, "utf-8");
  const rule = JSON.parse(ruleJson);

  const wasmPath = resolve("wasm/build/release.wasm");
  if (!existsSync(wasmPath)) throw new Error("run `npm run wasm:build` first");
  const wasm = await loadWasm(wasmPath);

  const depsPath = resolve(`.deployments/${network.name}.json`);
  if (!existsSync(depsPath)) throw new Error(`no deployment for network ${network.name} — run deploy first`);
  const deps = JSON.parse(readFileSync(depsPath, "utf-8"));
  const depositAddr = deps[`Deposit_${rule.ruleId}`];
  if (!depositAddr) throw new Error(`no Deposit_${rule.ruleId} entry`);

  const fromTs = 1_700_000_000n;
  const toTs = fromTs + days * 86400n;

  // Read current oracle/KPI rates if relevant
  let oracleRate = 0n;
  let kpiDelta = 0n;
  if (rule.kind === "floating" || rule.kind === "kpi-linked") {
    if (rule.kind === "floating") {
      const oracle = await ethers.getContractAt("MockRateOracle", deps.MockRateOracle_ESTR);
      oracleRate = await oracle.getRateBps();
    } else {
      const oracle = await ethers.getContractAt("MockKpiOracle", deps.MockKpiOracle_GHG);
      kpiDelta = BigInt(await oracle.spreadAdjustmentBps());
    }
  }

  const wasmRes = preview(wasm, rule, balance, fromTs, toTs, oracleRate, kpiDelta);

  // Solidity side: query strategy directly (read-only previewAccrual)
  const stratAddr = deps[`Strategy_${rule.ruleId}`];
  const strat = await ethers.getContractAt("IInterestStrategy", stratAddr);
  const solGross = await strat.previewAccrual(balance, fromTs, toTs);

  console.log(`\n=== compare ${rule.ruleId} (${rule.kind}) ===`);
  console.log(`  balance=${balance}  days=${days}  oracle=${oracleRate}  kpi=${kpiDelta}`);
  console.log(`  WASM gross    = ${wasmRes.gross}`);
  console.log(`  Solidity gross= ${solGross}`);
  const diff = wasmRes.gross > solGross ? wasmRes.gross - solGross : solGross - wasmRes.gross;
  console.log(`  abs diff      = ${diff}`);
  // tolerance: 0.01% of solidity result, or 1 if tiny
  const tolerance = solGross / 10000n;
  const pass = diff <= (tolerance > 0n ? tolerance : 1n);
  console.log(`  status        = ${pass ? "PASS" : "FAIL"}\n`);
  if (!pass) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
