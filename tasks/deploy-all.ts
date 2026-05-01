import { task } from "hardhat/config";
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { deployRule } from "./deploy-rule";

task("deploy:all", "Deploy core (USDC, registry, factory, oracles) + all example rules to the current network")
  .addFlag("withPools", "Also deploy an InterestBearingPool (Pattern B) for each rule")
  .setAction(async (args: { withPools: boolean }, hre: any) => {
    const { ethers } = hre;
    console.log(`[deploy:all] network=${hre.network.name} withPools=${args.withPools}\n`);
    const depPath = resolve(`.deployments/${hre.network.name}.json`);
    mkdirSync(dirname(depPath), { recursive: true });
    writeFileSync(depPath, "{}\n");

    const examples = readdirSync("rules/examples").filter((f) => f.endsWith(".json")).sort();
    for (const f of examples) {
      const path = resolve("rules/examples", f);
      console.log(`\n=== ${f} ===`);
      try {
        await deployRule(hre, path);
      } catch (e: any) {
        console.error(`  FAILED: ${e.message}`);
      }
    }

    if (args.withPools) {
      console.log(`\n[deploy:all] --with-pools: deploying Pattern B pool for each rule\n`);
      const deps: Record<string, string> = existsSync(depPath)
        ? JSON.parse(readFileSync(depPath, "utf-8"))
        : {};
      if (!deps.PoolFactory) {
        const F = await ethers.getContractFactory("PoolFactory");
        const fac = await F.deploy(deps.RuleRegistry);
        await fac.waitForDeployment();
        deps.PoolFactory = await fac.getAddress();
        writeFileSync(depPath, JSON.stringify(deps, null, 2));
        console.log(`  PoolFactory → ${deps.PoolFactory}`);
      }
      const Factory = await ethers.getContractAt("PoolFactory", deps.PoolFactory);
      for (const f of examples) {
        const rule = JSON.parse(readFileSync(resolve("rules/examples", f), "utf-8"));
        if (!deps[`Strategy_${rule.ruleId}`]) {
          console.log(`  skip ${rule.ruleId} (no strategy)`);
          continue;
        }
        try {
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
          deps[`Pool_${rule.ruleId}`] = poolAddr;
          console.log(`  Pool_${rule.ruleId} → ${poolAddr}`);
        } catch (e: any) {
          console.error(`  pool FAILED for ${rule.ruleId}: ${e.message}`);
        }
      }
      writeFileSync(depPath, JSON.stringify(deps, null, 2));
    }
    console.log(`\n[deploy:all] saved → ${depPath}`);
  });
