import { task } from "hardhat/config";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const BASIS: Record<string, number> = { "act/360": 0, "act/365": 1, "30/360": 2, "act/act-isda": 3 };

task("compare:rule", "Compare WASM preview against on-chain Solidity strategy for a deployed rule")
  .addParam("rule", "Path to a rule JSON file")
  .addOptionalParam("balance", "Balance in base units", "1000000")
  .addOptionalParam("days", "Period in days", "360")
  .setAction(async (args: { rule: string; balance: string; days: string }, hre: any) => {
    const ruleJson = readFileSync(args.rule, "utf-8");
    const rule = JSON.parse(ruleJson);
    const balance = BigInt(args.balance);
    const days = BigInt(args.days);
    const fromTs = 1_700_000_000n;
    const toTs = fromTs + days * 86400n;

    const wasmPath = resolve("wasm/build/release.wasm");
    if (!existsSync(wasmPath)) throw new Error("wasm/build/release.wasm missing — run `npm run wasm:build`");
    const bytes = readFileSync(wasmPath);
    const mod = await WebAssembly.instantiate(bytes, {
      env: { abort(_m: number, _f: number, l: number, c: number) { throw new Error(`abort ${l}:${c}`); } },
    });
    const wasm = (mod.instance as WebAssembly.Instance).exports as any;
    const basis = BASIS[rule.dayCount];

    let oracleRate = 0n;
    let kpiDelta = 0n;
    const depsPath = resolve(`.deployments/${hre.network.name}.json`);
    if (!existsSync(depsPath)) throw new Error(`no .deployments/${hre.network.name}.json — run \`hardhat deploy:all\``);
    const deps = JSON.parse(readFileSync(depsPath, "utf-8"));
    const stratAddr = deps[`Strategy_${rule.ruleId}`];
    if (!stratAddr) throw new Error(`no Strategy_${rule.ruleId} in deployments`);

    if (rule.kind === "floating") {
      const oracle = await hre.ethers.getContractAt("MockRateOracle", deps.MockRateOracle_ESTR);
      oracleRate = await oracle.getRateBps();
    } else if (rule.kind === "kpi-linked") {
      const oracle = await hre.ethers.getContractAt("MockKpiOracle", deps.MockKpiOracle_GHG);
      kpiDelta = BigInt(await oracle.spreadAdjustmentBps());
    }

    let wasmGross: bigint = 0n;
    switch (rule.kind) {
      case "simple": wasmGross = wasm.previewSimple(balance, rule.ratePolicy.fixedBps, basis, fromTs, toTs); break;
      case "compound": wasmGross = wasm.previewCompound(balance, rule.ratePolicy.fixedBps, basis, fromTs, toTs); break;
      case "tiered": {
        let prev = 0n; let sum = 0n;
        for (const t of rule.ratePolicy.tiers) {
          const upTo = t.upTo === "max" ? 0xffffffffffffffffn : BigInt(t.upTo);
          if (balance <= prev) break;
          const sliceTop = balance < upTo ? balance : upTo;
          sum += wasm.previewSimple(sliceTop - prev, t.bps, basis, fromTs, toTs);
          prev = upTo;
          if (balance <= upTo) break;
        }
        wasmGross = sum; break;
      }
      case "floating":
        wasmGross = wasm.previewFloating(balance, Number(oracleRate), rule.ratePolicy.spreadBps, rule.floorBps ?? 0, rule.capBps ?? 0, rule.floorBps !== undefined, rule.capBps !== undefined, basis, fromTs, toTs);
        break;
      case "kpi-linked": {
        const [minD, maxD] = rule.ratePolicy.adjustmentRangeBps;
        wasmGross = wasm.previewKpi(balance, rule.ratePolicy.baseSpreadBps, Number(kpiDelta), minD, maxD, basis, fromTs, toTs);
        break;
      }
      case "two-track": {
        const hardBps = Math.round(rule.twoTrack.hardInterestPortion * 10_000);
        wasmGross = wasm.previewTwoTrackHard(balance, rule.ratePolicy.fixedBps, hardBps, basis, fromTs, toTs);
        break;
      }
    }

    const strat = await hre.ethers.getContractAt("IInterestStrategy", stratAddr);
    const solGross: bigint = await strat.previewAccrual(balance, fromTs, toTs);

    const diff = wasmGross > solGross ? wasmGross - solGross : solGross - wasmGross;
    const tol = rule.kind === "compound" ? solGross / 1000n : solGross / 10000n;
    const pass = diff <= (tol > 0n ? tol : 1n);

    console.log(`\n=== compare ${rule.ruleId} (${rule.kind}) on ${hre.network.name} ===`);
    console.log(`  balance=${balance}  days=${days}  oracle=${oracleRate}  kpi=${kpiDelta}`);
    console.log(`  WASM gross    = ${wasmGross}`);
    console.log(`  Solidity gross= ${solGross}`);
    console.log(`  abs diff      = ${diff}   (tolerance ${tol})`);
    console.log(`  status        = ${pass ? "✔ PASS" : "✗ FAIL"}\n`);
    if (!pass) process.exit(1);
  });
