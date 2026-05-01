import { task } from "hardhat/config";
import { readdirSync } from "fs";
import { resolve } from "path";
import { writeFileSync } from "fs";
import { dirname, resolve as resolvePath } from "path";
import { mkdirSync } from "fs";
import { deployRule } from "./deploy-rule";

task("deploy:all", "Deploy core (USDC, registry, factory, oracles) + all 8 example rules to the current network")
  .setAction(async (_args, hre: any) => {
    console.log(`[deploy:all] network=${hre.network.name}\n`);
    // Reset deployments file for this network so we have one consistent state
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
    console.log(`\n[deploy:all] saved → ${depPath}`);
  });
