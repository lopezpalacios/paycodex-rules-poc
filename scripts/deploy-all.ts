// Deploy core + all 8 rule strategies to the current network in a SINGLE process
// (so in-memory hardhat networks persist between rules). For real Besu, a separate
// process per rule would also work, but this is simpler and works for both.
//
// Usage:
//   npx hardhat run scripts/deploy-all.ts --network localhost   (after `npx hardhat node`)
//   npx hardhat run scripts/deploy-all.ts --network besu

import { ethers, network } from "hardhat";
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface Rule {
  ruleId: string;
  description?: string;
  kind: string;
  dayCount: string;
  ratePolicy: any;
  compounding: string;
  postingFrequency: string;
  floorBps?: number;
  capBps?: number;
  withholding?: { enabled: boolean; rateBps: number; regime: string };
  twoTrack?: { ecrPortion: number; hardInterestPortion: number; reserveRequirementBps?: number };
}

const BASIS_ENUM: Record<string, number> = {
  "act/360": 0,
  "act/365": 1,
  "30/360": 2,
  "act/act-isda": 3,
};

function ruleIdToBytes32(id: string): string {
  return ethers.encodeBytes32String(id.slice(0, 31));
}

function depPath(): string {
  return resolve(`.deployments/${network.name}.json`);
}

function loadDeps(): Record<string, string> {
  const p = depPath();
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : {};
}

function saveDeps(d: Record<string, string>) {
  const p = depPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(d, null, 2));
}

async function ensureCore(deps: Record<string, string>) {
  const [signer] = await ethers.getSigners();

  if (!deps.MockUSDC) {
    const F = await ethers.getContractFactory("MockERC20");
    const c = await F.deploy("Mock USDC", "USDC", 6);
    await c.waitForDeployment();
    deps.MockUSDC = await c.getAddress();
    saveDeps(deps);
    console.log(`  MockUSDC → ${deps.MockUSDC}`);
  }
  if (!deps.RuleRegistry) {
    const F = await ethers.getContractFactory("RuleRegistry");
    const c = await F.deploy(signer.address);
    await c.waitForDeployment();
    deps.RuleRegistry = await c.getAddress();
    saveDeps(deps);
    console.log(`  RuleRegistry → ${deps.RuleRegistry}`);
  }
  if (!deps.DepositFactory) {
    const F = await ethers.getContractFactory("DepositFactory");
    const c = await F.deploy(deps.RuleRegistry);
    await c.waitForDeployment();
    deps.DepositFactory = await c.getAddress();
    saveDeps(deps);
    console.log(`  DepositFactory → ${deps.DepositFactory}`);
  }
  if (!deps.MockRateOracle_ESTR) {
    const F = await ethers.getContractFactory("MockRateOracle");
    const c = await F.deploy(350, "ESTR");
    await c.waitForDeployment();
    deps.MockRateOracle_ESTR = await c.getAddress();
    saveDeps(deps);
    console.log(`  MockRateOracle_ESTR → ${deps.MockRateOracle_ESTR}`);
  }
  if (!deps.MockKpiOracle_GHG) {
    const F = await ethers.getContractFactory("MockKpiOracle");
    const c = await F.deploy(0, "GHG");
    await c.waitForDeployment();
    deps.MockKpiOracle_GHG = await c.getAddress();
    saveDeps(deps);
    console.log(`  MockKpiOracle_GHG → ${deps.MockKpiOracle_GHG}`);
  }
}

async function deployStrategy(rule: Rule, deps: Record<string, string>) {
  const basis = BASIS_ENUM[rule.dayCount];
  if (basis === undefined) throw new Error(`unknown dayCount ${rule.dayCount}`);

  switch (rule.kind) {
    case "simple": {
      const F = await ethers.getContractFactory("SimpleStrategy");
      const c = await F.deploy(rule.ratePolicy.fixedBps, basis);
      await c.waitForDeployment();
      return c;
    }
    case "compound": {
      const F = await ethers.getContractFactory("CompoundDailyStrategy");
      const c = await F.deploy(rule.ratePolicy.fixedBps, basis);
      await c.waitForDeployment();
      return c;
    }
    case "tiered": {
      const tiers = rule.ratePolicy.tiers as Array<{ upTo: string; bps: number }>;
      const upTos = tiers.map((t) => (t.upTo === "max" ? ethers.MaxUint256 : BigInt(t.upTo)));
      const bps = tiers.map((t) => t.bps);
      const F = await ethers.getContractFactory("TieredStrategy");
      const c = await F.deploy(upTos, bps, basis);
      await c.waitForDeployment();
      return c;
    }
    case "floating": {
      const floor = rule.floorBps ?? -10001;
      const cap = rule.capBps ?? 10001;
      const F = await ethers.getContractFactory("FloatingStrategy");
      const c = await F.deploy(deps.MockRateOracle_ESTR, rule.ratePolicy.spreadBps, basis, floor, cap);
      await c.waitForDeployment();
      return c;
    }
    case "kpi-linked": {
      const [minD, maxD] = rule.ratePolicy.adjustmentRangeBps;
      const F = await ethers.getContractFactory("KpiLinkedStrategy");
      const c = await F.deploy(deps.MockKpiOracle_GHG, rule.ratePolicy.baseSpreadBps, minD, maxD, basis);
      await c.waitForDeployment();
      return c;
    }
    case "two-track": {
      const hardBps = Math.round((rule.twoTrack!.hardInterestPortion ?? 0) * 10_000);
      const ecrBps = Math.round((rule.twoTrack!.ecrPortion ?? 0) * 10_000);
      const reserveBps = rule.twoTrack!.reserveRequirementBps ?? 0;
      const F = await ethers.getContractFactory("TwoTrackStrategy");
      const c = await F.deploy(rule.ratePolicy.fixedBps, hardBps, ecrBps, reserveBps, basis);
      await c.waitForDeployment();
      return c;
    }
    default:
      throw new Error(`unknown kind ${rule.kind}`);
  }
}

async function main() {
  console.log(`[deploy-all] network=${network.name}\n`);
  // Reset deployments file for this network — we want one consistent state.
  saveDeps({});
  const deps: Record<string, string> = {};
  await ensureCore(deps);

  const examples = readdirSync("rules/examples").filter((f) => f.endsWith(".json")).sort();
  for (const f of examples) {
    const rulePath = resolve("rules/examples", f);
    const ruleJson = readFileSync(rulePath, "utf-8");
    const rule: Rule = JSON.parse(ruleJson);
    console.log(`\n=== ${f} (${rule.ruleId}, kind=${rule.kind}) ===`);

    try {
      const strategy = await deployStrategy(rule, deps);
      const stratAddr = await strategy.getAddress();
      console.log(`  strategy → ${stratAddr}`);

      const Registry = await ethers.getContractAt("RuleRegistry", deps.RuleRegistry);
      const ruleIdB32 = ruleIdToBytes32(rule.ruleId);
      const hash = ethers.keccak256(ethers.toUtf8Bytes(ruleJson));
      const tx = await Registry.register(ruleIdB32, stratAddr, hash);
      await tx.wait();
      console.log(`  registered ruleId=${rule.ruleId} hash=${hash.slice(0, 18)}…`);

      const [signer] = await ethers.getSigners();
      const Factory = await ethers.getContractAt("DepositFactory", deps.DepositFactory);
      const whtEnabled = !!rule.withholding?.enabled;
      const whtBps = rule.withholding?.rateBps ?? 0;
      const dtx = await Factory.deploy(ruleIdB32, deps.MockUSDC, signer.address, whtEnabled, whtBps);
      const rcpt = await dtx.wait();
      let depositAddr = "?";
      for (const log of rcpt!.logs) {
        try {
          const parsed = Factory.interface.parseLog(log);
          if (parsed?.name === "DepositDeployed") {
            depositAddr = parsed.args.deposit;
            break;
          }
        } catch {}
      }
      console.log(`  deposit  → ${depositAddr}`);

      deps[`Strategy_${rule.ruleId}`] = stratAddr;
      deps[`Deposit_${rule.ruleId}`] = depositAddr;
      saveDeps(deps);
    } catch (e: any) {
      console.error(`  FAILED: ${e.message}`);
    }
  }

  console.log(`\n[deploy-all] saved → ${depPath()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
