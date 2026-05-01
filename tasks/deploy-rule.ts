import { task } from "hardhat/config";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

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

function depPath(networkName: string): string {
  return resolve(`.deployments/${networkName}.json`);
}
function loadDeps(networkName: string): Record<string, string> {
  const p = depPath(networkName);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : {};
}
function saveDeps(networkName: string, d: Record<string, string>) {
  const p = depPath(networkName);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(d, null, 2));
}

async function ensureCore(hre: any, deps: Record<string, string>) {
  const { ethers } = hre;
  const [signer] = await ethers.getSigners();

  if (!deps.MockUSDC) {
    const c = await (await ethers.getContractFactory("MockERC20")).deploy("Mock USDC", "USDC", 6);
    await c.waitForDeployment();
    deps.MockUSDC = await c.getAddress();
  }
  if (!deps.RuleRegistry) {
    const c = await (await ethers.getContractFactory("RuleRegistry")).deploy(signer.address);
    await c.waitForDeployment();
    deps.RuleRegistry = await c.getAddress();
  }
  if (!deps.DepositFactory) {
    const c = await (await ethers.getContractFactory("DepositFactory")).deploy(deps.RuleRegistry);
    await c.waitForDeployment();
    deps.DepositFactory = await c.getAddress();
  }
  if (!deps.MockRateOracle_ESTR) {
    const c = await (await ethers.getContractFactory("MockRateOracle")).deploy(350, "ESTR");
    await c.waitForDeployment();
    deps.MockRateOracle_ESTR = await c.getAddress();
  }
  if (!deps.MockKpiOracle_GHG) {
    const c = await (await ethers.getContractFactory("MockKpiOracle")).deploy(0, "GHG");
    await c.waitForDeployment();
    deps.MockKpiOracle_GHG = await c.getAddress();
  }
  if (!deps.TaxCollector) {
    const c = await (await ethers.getContractFactory("TaxCollector")).deploy(signer.address, "MULTI");
    await c.waitForDeployment();
    deps.TaxCollector = await c.getAddress();
  }
  saveDeps(hre.network.name, deps);
}

async function deployStrategy(hre: any, rule: Rule, deps: Record<string, string>) {
  const { ethers } = hre;
  const basis = BASIS_ENUM[rule.dayCount];
  if (basis === undefined) throw new Error(`unknown dayCount ${rule.dayCount}`);

  switch (rule.kind) {
    case "simple": {
      const c = await (await ethers.getContractFactory("SimpleStrategy")).deploy(rule.ratePolicy.fixedBps, basis);
      await c.waitForDeployment(); return c;
    }
    case "compound": {
      const c = await (await ethers.getContractFactory("CompoundDailyStrategy")).deploy(rule.ratePolicy.fixedBps, basis);
      await c.waitForDeployment(); return c;
    }
    case "tiered": {
      const tiers = rule.ratePolicy.tiers as Array<{ upTo: string; bps: number }>;
      const upTos = tiers.map((t) => (t.upTo === "max" ? ethers.MaxUint256 : BigInt(t.upTo)));
      const bps = tiers.map((t) => t.bps);
      const c = await (await ethers.getContractFactory("TieredStrategy")).deploy(upTos, bps, basis);
      await c.waitForDeployment(); return c;
    }
    case "floating": {
      const floor = rule.floorBps ?? -10001;
      const cap = rule.capBps ?? 10001;
      const c = await (await ethers.getContractFactory("FloatingStrategy")).deploy(
        deps.MockRateOracle_ESTR, rule.ratePolicy.spreadBps, basis, floor, cap,
      );
      await c.waitForDeployment(); return c;
    }
    case "kpi-linked": {
      const [minD, maxD] = rule.ratePolicy.adjustmentRangeBps;
      const c = await (await ethers.getContractFactory("KpiLinkedStrategy")).deploy(
        deps.MockKpiOracle_GHG, rule.ratePolicy.baseSpreadBps, minD, maxD, basis,
      );
      await c.waitForDeployment(); return c;
    }
    case "two-track": {
      const hardBps = Math.round((rule.twoTrack!.hardInterestPortion ?? 0) * 10_000);
      const ecrBps = Math.round((rule.twoTrack!.ecrPortion ?? 0) * 10_000);
      const reserveBps = rule.twoTrack!.reserveRequirementBps ?? 0;
      const c = await (await ethers.getContractFactory("TwoTrackStrategy")).deploy(
        rule.ratePolicy.fixedBps, hardBps, ecrBps, reserveBps, basis,
      );
      await c.waitForDeployment(); return c;
    }
    default:
      throw new Error(`unknown kind ${rule.kind}`);
  }
}

export async function deployRule(hre: any, rulePath: string) {
  const { ethers } = hre;
  const ruleJson = readFileSync(rulePath, "utf-8");
  const rule: Rule = JSON.parse(ruleJson);
  console.log(`[deploy:rule] network=${hre.network.name} rule=${rule.ruleId} kind=${rule.kind}`);

  const deps = loadDeps(hre.network.name);
  await ensureCore(hre, deps);

  const strategy = await deployStrategy(hre, rule, deps);
  const stratAddr = await strategy.getAddress();
  console.log(`  strategy → ${stratAddr}`);

  const Registry = await ethers.getContractAt("RuleRegistry", deps.RuleRegistry);
  const ruleIdB32 = ethers.encodeBytes32String(rule.ruleId.slice(0, 31));
  const hash = ethers.keccak256(ethers.toUtf8Bytes(ruleJson));
  await (await Registry.register(ruleIdB32, stratAddr, hash)).wait();
  console.log(`  registered  hash=${hash.slice(0, 18)}…`);

  const [signer] = await ethers.getSigners();
  const Factory = await ethers.getContractAt("DepositFactory", deps.DepositFactory);
  const whtEnabled = !!rule.withholding?.enabled;
  const whtBps = rule.withholding?.rateBps ?? 0;
  const collector = whtEnabled ? deps.TaxCollector : ethers.ZeroAddress;
  const tx = await Factory.deploy(ruleIdB32, deps.MockUSDC, signer.address, whtEnabled, whtBps, collector);
  const rcpt = await tx.wait();
  let depositAddr = "?";
  for (const log of rcpt!.logs) {
    try {
      const parsed = Factory.interface.parseLog(log);
      if (parsed?.name === "DepositDeployed") { depositAddr = parsed.args.deposit; break; }
    } catch {}
  }
  console.log(`  deposit  → ${depositAddr}`);

  deps[`Strategy_${rule.ruleId}`] = stratAddr;
  deps[`Deposit_${rule.ruleId}`] = depositAddr;
  saveDeps(hre.network.name, deps);
  console.log(`  saved → ${depPath(hre.network.name)}`);
  return { strategy: stratAddr, deposit: depositAddr, ruleId: rule.ruleId };
}

task("deploy:rule", "Deploy a strategy + register in RuleRegistry + create an InterestBearingDeposit instance for a single rule")
  .addParam("rule", "Path to a rule JSON file (rules/examples/*.json)")
  .setAction(async (args: { rule: string }, hre: any) => {
    await deployRule(hre, args.rule);
  });
