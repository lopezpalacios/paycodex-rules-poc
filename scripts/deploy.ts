// Deploys core (RuleRegistry + DepositFactory + MockERC20) once, then deploys the strategy
// matching `--rule rules/examples/<file>.json`, registers it, and emits a deployment receipt.
//
// Usage:
//   npx hardhat run scripts/deploy.ts --network hardhat -- --rule rules/examples/01-simple-act360.json
//   npx hardhat run scripts/deploy.ts --network besu    -- --rule rules/examples/04-floating-estr.json
//
// Reads core addresses from .deployments/<network>.json if present; otherwise deploys core first.

import { ethers, network } from "hardhat";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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

function parseArgs(): { rulePath: string } {
  // Accept either env var (recommended for `hardhat run`) or --rule flag.
  const env = process.env.RULE;
  if (env) return { rulePath: env };
  const idx = process.argv.findIndex((a) => a === "--rule");
  if (idx < 0 || idx === process.argv.length - 1) {
    throw new Error("missing rule path: set RULE=<path> or pass --rule <path>");
  }
  return { rulePath: process.argv[idx + 1] };
}

function ruleIdToBytes32(id: string): string {
  return ethers.encodeBytes32String(id.slice(0, 31));
}

function ruleHash(ruleJson: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(ruleJson));
}

function depPath(): string {
  return resolve(`.deployments/${network.name}.json`);
}

function loadDeps(): Record<string, string> {
  const p = depPath();
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf-8"));
}

function saveDeps(d: Record<string, string>) {
  const p = depPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(d, null, 2));
}

async function ensureCore() {
  let deps = loadDeps();
  const [signer] = await ethers.getSigners();

  if (!deps.MockUSDC) {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("Mock USDC", "USDC", 6);
    await usdc.waitForDeployment();
    deps.MockUSDC = await usdc.getAddress();
  }

  if (!deps.RuleRegistry) {
    const Registry = await ethers.getContractFactory("RuleRegistry");
    const reg = await Registry.deploy(signer.address);
    await reg.waitForDeployment();
    deps.RuleRegistry = await reg.getAddress();
  }

  if (!deps.DepositFactory) {
    const Factory = await ethers.getContractFactory("DepositFactory");
    const fac = await Factory.deploy(deps.RuleRegistry);
    await fac.waitForDeployment();
    deps.DepositFactory = await fac.getAddress();
  }

  saveDeps(deps);
  return deps;
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
      // ensure mock oracle exists
      if (!deps.MockRateOracle_ESTR) {
        const Oracle = await ethers.getContractFactory("MockRateOracle");
        const o = await Oracle.deploy(350, rule.ratePolicy.referenceName ?? "ESTR");
        await o.waitForDeployment();
        deps.MockRateOracle_ESTR = await o.getAddress();
        saveDeps(deps);
      }
      const floor = rule.floorBps ?? -10001;
      const cap = rule.capBps ?? 10001;
      const F = await ethers.getContractFactory("FloatingStrategy");
      const c = await F.deploy(deps.MockRateOracle_ESTR, rule.ratePolicy.spreadBps, basis, floor, cap);
      await c.waitForDeployment();
      return c;
    }
    case "kpi-linked": {
      if (!deps.MockKpiOracle_GHG) {
        const Oracle = await ethers.getContractFactory("MockKpiOracle");
        const o = await Oracle.deploy(0, "GHG");
        await o.waitForDeployment();
        deps.MockKpiOracle_GHG = await o.getAddress();
        saveDeps(deps);
      }
      const [minD, maxD] = rule.ratePolicy.adjustmentRangeBps;
      const F = await ethers.getContractFactory("KpiLinkedStrategy");
      const c = await F.deploy(
        deps.MockKpiOracle_GHG,
        rule.ratePolicy.baseSpreadBps,
        minD,
        maxD,
        basis,
      );
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
  const { rulePath } = parseArgs();
  const ruleJson = readFileSync(rulePath, "utf-8");
  const rule: Rule = JSON.parse(ruleJson);

  console.log(`[deploy] network=${network.name} rule=${rule.ruleId} kind=${rule.kind}`);
  const deps = await ensureCore();

  const strategy = await deployStrategy(rule, deps);
  const stratAddr = await strategy.getAddress();
  console.log(`[deploy] strategy ${rule.kind} → ${stratAddr}`);

  const Registry = await ethers.getContractAt("RuleRegistry", deps.RuleRegistry);
  const ruleIdB32 = ruleIdToBytes32(rule.ruleId);
  const hash = ruleHash(ruleJson);
  const tx = await Registry.register(ruleIdB32, stratAddr, hash);
  await tx.wait();
  console.log(`[deploy] registered ruleId=${rule.ruleId} hash=${hash}`);

  const [signer] = await ethers.getSigners();
  const Factory = await ethers.getContractAt("DepositFactory", deps.DepositFactory);
  const whtEnabled = !!rule.withholding?.enabled;
  const whtBps = rule.withholding?.rateBps ?? 0;
  const depTx = await Factory.deploy(ruleIdB32, deps.MockUSDC, signer.address, whtEnabled, whtBps);
  const receipt = await depTx.wait();
  // Find DepositDeployed event
  const log = receipt!.logs.find((l: any) => {
    try {
      const parsed = Factory.interface.parseLog(l);
      return parsed?.name === "DepositDeployed";
    } catch {
      return false;
    }
  });
  let depositAddr = "?";
  if (log) {
    const parsed = Factory.interface.parseLog(log);
    depositAddr = parsed!.args.deposit;
  }
  console.log(`[deploy] InterestBearingDeposit → ${depositAddr}`);

  // record receipt
  deps[`Deposit_${rule.ruleId}`] = depositAddr;
  deps[`Strategy_${rule.ruleId}`] = stratAddr;
  saveDeps(deps);
  console.log(`[deploy] saved → ${depPath()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
