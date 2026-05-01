import { task } from "hardhat/config";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

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

task("deploy:pool", "Deploy an InterestBearingPool bound to a registered rule (Pattern B, multi-holder)")
  .addParam("rule", "Path to a rule JSON file (must already be registered via deploy:rule)")
  .setAction(async (args: { rule: string }, hre: any) => {
    const { ethers } = hre;
    const ruleJson = readFileSync(args.rule, "utf-8");
    const rule = JSON.parse(ruleJson);
    console.log(`[deploy:pool] network=${hre.network.name} rule=${rule.ruleId}`);

    const deps = loadDeps(hre.network.name);
    if (!deps.RuleRegistry) {
      throw new Error("RuleRegistry not deployed; run `npx hardhat deploy:rule` for this rule first");
    }
    if (!deps[`Strategy_${rule.ruleId}`]) {
      throw new Error(`Strategy_${rule.ruleId} not registered; run \`npx hardhat deploy:rule --rule ${args.rule}\` first`);
    }
    if (!deps.MockUSDC) {
      throw new Error("MockUSDC not deployed; run `deploy:rule` for any rule first to bootstrap");
    }
    if (!deps.PoolFactory) {
      const F = await ethers.getContractFactory("PoolFactory");
      const fac = await F.deploy(deps.RuleRegistry);
      await fac.waitForDeployment();
      deps.PoolFactory = await fac.getAddress();
      saveDeps(hre.network.name, deps);
      console.log(`  PoolFactory → ${deps.PoolFactory}`);
    }

    const Factory = await ethers.getContractAt("PoolFactory", deps.PoolFactory);
    const ruleIdB32 = ethers.encodeBytes32String(rule.ruleId.slice(0, 31));
    const tx = await Factory.deploy(ruleIdB32, deps.MockUSDC);
    const rcpt = await tx.wait();
    let poolAddr = "?";
    for (const log of rcpt!.logs) {
      try {
        const parsed = Factory.interface.parseLog(log);
        if (parsed?.name === "PoolDeployed") {
          poolAddr = parsed.args.pool;
          break;
        }
      } catch {}
    }
    console.log(`  pool → ${poolAddr}`);

    deps[`Pool_${rule.ruleId}`] = poolAddr;
    saveDeps(hre.network.name, deps);
    console.log(`  saved → ${depPath(hre.network.name)}`);
  });
