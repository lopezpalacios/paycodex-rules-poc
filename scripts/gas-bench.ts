// Gas benchmarking — measures per-strategy deployment + previewAccrual cost,
// plus full deposit lifecycle (deposit → time-travel → postInterest → withdraw).
// Writes RESULTS.md mirroring the paycodex-factory pattern.
//
// Usage:  npx hardhat run scripts/gas-bench.ts

import { ethers, network } from "hardhat";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface Row {
  rule: string;
  kind: string;
  deployStrategy: bigint;
  deployDeposit: bigint;
  previewAccrual: bigint;
  depositCall: bigint;
  postInterest: bigint;
  withdraw: bigint;
}

const SECONDS_PER_DAY = 86400n;
const FROM_TS = 1_700_000_000n;
const TO_TS = FROM_TS + 360n * SECONDS_PER_DAY;
const PRINCIPAL = 1_000_000n;

async function deployStrategy(kind: string): Promise<{ contract: any; gas: bigint }> {
  let f, c;
  switch (kind) {
    case "simple":
      f = await ethers.getContractFactory("SimpleStrategy");
      c = await f.deploy(350n, 0);
      break;
    case "compound":
      f = await ethers.getContractFactory("CompoundDailyStrategy");
      c = await f.deploy(300n, 1);
      break;
    case "tiered":
      f = await ethers.getContractFactory("TieredStrategy");
      c = await f.deploy(
        [BigInt("1000000000000000000000000"), ethers.MaxUint256],
        [200n, 350n],
        0,
      );
      break;
    case "floating": {
      const O = await ethers.getContractFactory("MockRateOracle");
      const o = await O.deploy(350, "ESTR");
      await o.waitForDeployment();
      f = await ethers.getContractFactory("FloatingStrategy");
      c = await f.deploy(await o.getAddress(), 50, 0, -10001, 10001);
      break;
    }
    case "kpi-linked": {
      const O = await ethers.getContractFactory("MockKpiOracle");
      const o = await O.deploy(-25, "GHG");
      await o.waitForDeployment();
      f = await ethers.getContractFactory("KpiLinkedStrategy");
      c = await f.deploy(await o.getAddress(), 400, -100, 100, 0);
      break;
    }
    case "two-track":
      f = await ethers.getContractFactory("TwoTrackStrategy");
      c = await f.deploy(350, 5000, 5000, 1000, 0);
      break;
    default:
      throw new Error(`unknown kind ${kind}`);
  }
  await c.waitForDeployment();
  const tx = c.deploymentTransaction();
  const rcpt = await tx!.wait();
  return { contract: c, gas: rcpt!.gasUsed };
}

async function bench(rule: string, kind: string): Promise<Row> {
  const [signer] = await ethers.getSigners();
  const { contract: strat, gas: deployStrategyGas } = await deployStrategy(kind);
  const stratAddr = await strat.getAddress();

  // Estimate gas for previewAccrual (view function — eth_estimateGas works)
  const previewAccrualGas = await strat.previewAccrual.estimateGas(PRINCIPAL, FROM_TS, TO_TS);

  // Build full deposit lifecycle to measure deposit/postInterest/withdraw gas
  const M = await ethers.getContractFactory("MockERC20");
  const usdc = await M.deploy("USDC", "USDC", 6);
  await usdc.waitForDeployment();
  await (await usdc.transfer(signer.address, PRINCIPAL * 10n)).wait();

  const R = await ethers.getContractFactory("RuleRegistry");
  const reg = await R.deploy(signer.address);
  await reg.waitForDeployment();
  const ruleId = ethers.encodeBytes32String(rule.slice(0, 31));
  await (await reg.register(ruleId, stratAddr, ethers.ZeroHash)).wait();

  const F = await ethers.getContractFactory("DepositFactory");
  const fac = await F.deploy(await reg.getAddress());
  await fac.waitForDeployment();

  const dtx = await fac.deploy(ruleId, await usdc.getAddress(), signer.address, false, 0);
  const drcpt = await dtx.wait();
  const deployDepositGas = drcpt!.gasUsed;
  let depositAddr = "?";
  for (const log of drcpt!.logs) {
    try {
      const parsed = fac.interface.parseLog(log);
      if (parsed?.name === "DepositDeployed") { depositAddr = parsed.args.deposit; break; }
    } catch {}
  }
  const dep = await ethers.getContractAt("InterestBearingDeposit", depositAddr);

  // deposit
  await (await usdc.approve(depositAddr, PRINCIPAL)).wait();
  const depTx = await dep.deposit(PRINCIPAL);
  const depRcpt = await depTx.wait();
  const depositCallGas = depRcpt!.gasUsed;

  // advance 360 days, then postInterest
  await network.provider.send("evm_increaseTime", [Number(360n * SECONDS_PER_DAY)]);
  await network.provider.send("evm_mine");
  const postTx = await dep.postInterest();
  const postRcpt = await postTx.wait();
  const postInterestGas = postRcpt!.gasUsed;

  // withdraw half
  const wTx = await dep.withdraw(PRINCIPAL / 2n);
  const wRcpt = await wTx.wait();
  const withdrawGas = wRcpt!.gasUsed;

  return {
    rule,
    kind,
    deployStrategy: deployStrategyGas,
    deployDeposit: deployDepositGas,
    previewAccrual: previewAccrualGas,
    depositCall: depositCallGas,
    postInterest: postInterestGas,
    withdraw: withdrawGas,
  };
}

function fmtCommas(n: bigint): string {
  return n.toLocaleString("en-US");
}

function renderResultsMd(rows: Row[]): string {
  const ts = new Date().toISOString();
  const lines: string[] = [];
  lines.push("# Gas benchmarks");
  lines.push("");
  lines.push("Generated by `scripts/gas-bench.ts` against the Hardhat in-memory EVM (paris target, optimizer runs=200).");
  lines.push("");
  lines.push(`Last run: ${ts}`);
  lines.push("");
  lines.push("Numbers are real `gasUsed` values from receipt-logs (deployment + state-changing calls) and `eth_estimateGas` (view calls).");
  lines.push("");
  lines.push("## Per-strategy (1 customer, 1M USDC, 360 days @ rate-policy)");
  lines.push("");
  lines.push("| Rule | Kind | Deploy strategy | Deploy deposit | previewAccrual (view) | deposit() | postInterest() | withdraw() |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    lines.push(
      `| \`${r.rule}\` | ${r.kind} | ${fmtCommas(r.deployStrategy)} | ${fmtCommas(r.deployDeposit)} | ${fmtCommas(r.previewAccrual)} | ${fmtCommas(r.depositCall)} | ${fmtCommas(r.postInterest)} | ${fmtCommas(r.withdraw)} |`,
    );
  }
  lines.push("");
  lines.push("## Headline numbers");
  lines.push("");
  const cheapest = rows.reduce((a, b) => a.previewAccrual < b.previewAccrual ? a : b);
  const dearest = rows.reduce((a, b) => a.previewAccrual > b.previewAccrual ? a : b);
  lines.push(`- **Cheapest preview:** \`${cheapest.rule}\` (${cheapest.kind}) — ${fmtCommas(cheapest.previewAccrual)} gas`);
  lines.push(`- **Most expensive preview:** \`${dearest.rule}\` (${dearest.kind}) — ${fmtCommas(dearest.previewAccrual)} gas`);
  const avgPostInterest = rows.reduce((s, r) => s + r.postInterest, 0n) / BigInt(rows.length);
  lines.push(`- **Average postInterest:** ${fmtCommas(avgPostInterest)} gas`);
  const avgDeployStrat = rows.reduce((s, r) => s + r.deployStrategy, 0n) / BigInt(rows.length);
  lines.push(`- **Average strategy deployment:** ${fmtCommas(avgDeployStrat)} gas`);
  lines.push("");
  lines.push("## Notes (data-derived)");
  lines.push("");
  const byKind: Record<string, Row> = Object.fromEntries(rows.map((r) => [r.kind, r]));
  if (byKind.simple && byKind.compound) {
    const ratio = (Number(byKind.compound.previewAccrual) / Number(byKind.simple.previewAccrual)).toFixed(2);
    lines.push(`- \`compound\` preview is ${ratio}× \`simple\` (rpow over wad-scaled \`(1+r/n)^days\`).`);
  }
  if (byKind.simple && byKind.floating) {
    const overhead = byKind.floating.previewAccrual - byKind.simple.previewAccrual;
    lines.push(`- \`floating\` adds one external CALL to the rate oracle: +${fmtCommas(overhead)} gas vs \`simple\`.`);
  }
  if (byKind.simple && byKind["kpi-linked"]) {
    const overhead = byKind["kpi-linked"].previewAccrual - byKind.simple.previewAccrual;
    lines.push(`- \`kpi-linked\` adds one external CALL to the KPI oracle: +${fmtCommas(overhead)} gas vs \`simple\`.`);
  }
  if (byKind.simple && byKind.tiered) {
    const overhead = byKind.tiered.previewAccrual - byKind.simple.previewAccrual;
    lines.push(`- \`tiered\` (2 bands) adds +${fmtCommas(overhead)} gas vs \`simple\`. Cost scales linearly with band count.`);
  }
  if (byKind.simple && byKind["two-track"]) {
    const overhead = byKind["two-track"].previewAccrual - byKind.simple.previewAccrual;
    lines.push(`- \`two-track\` previewAccrual returns hard-interest portion only: +${fmtCommas(overhead)} gas vs \`simple\` (one extra multiply by hardPortionBps).`);
  }
  lines.push("- `postInterest` cost is dominated by the inner accrual call + storage writes to `accruedInterest` and `principal`.");
  const minDeploy = rows.reduce((m, r) => r.deployStrategy < m ? r.deployStrategy : m, rows[0].deployStrategy);
  const maxDeploy = rows.reduce((m, r) => r.deployStrategy > m ? r.deployStrategy : m, 0n);
  lines.push(`- Strategy deployment cost ranges ${fmtCommas(minDeploy)} – ${fmtCommas(maxDeploy)} gas. Constructors with oracles, tiers, or two-track portions cost more.`);
  lines.push(`- \`Deploy deposit\` (factory creating an InterestBearingDeposit instance) is essentially flat at ~${fmtCommas(byKind.simple?.deployDeposit ?? 0n)} gas regardless of strategy.`);
  lines.push("");
  lines.push("## Companion artifact");
  lines.push("");
  lines.push("Hardhat-gas-reporter (toolbox plugin) produces a per-function table when run with `REPORT_GAS=true npm test`. CI uploads both artifacts.");
  return lines.join("\n") + "\n";
}

async function main() {
  console.log("[gas-bench] starting on hardhat in-mem...\n");
  const cases: Array<{ rule: string; kind: string }> = [
    { rule: "simple-act360-eur-350", kind: "simple" },
    { rule: "compound-daily-eur-300", kind: "compound" },
    { rule: "tiered-corp-eur", kind: "tiered" },
    { rule: "floating-estr-plus-50", kind: "floating" },
    { rule: "esg-kpi-linked", kind: "kpi-linked" },
    { rule: "two-track-ecr-50-50", kind: "two-track" },
  ];
  const rows: Row[] = [];
  for (const c of cases) {
    const r = await bench(c.rule, c.kind);
    console.log(`  ${c.rule.padEnd(28)} kind=${c.kind.padEnd(11)} preview=${fmtCommas(r.previewAccrual).padStart(8)} post=${fmtCommas(r.postInterest)}`);
    rows.push(r);
  }
  const md = renderResultsMd(rows);
  const path = resolve("RESULTS.md");
  writeFileSync(path, md);
  console.log(`\n[gas-bench] wrote ${path} (${md.length} bytes, ${rows.length} rules)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
