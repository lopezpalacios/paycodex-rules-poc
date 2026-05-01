import { task } from "hardhat/config";
import { readFileSync, readdirSync } from "fs";
import { resolve, join } from "path";

task("validate:rules", "Validate every rules/examples/*.json against rules/schema.json (Ajv 2020)")
  .setAction(async (_args) => {
    const Ajv = (await import("ajv/dist/2020.js")).default;
    const addFormats = (await import("ajv-formats")).default;
    const schema = JSON.parse(readFileSync(resolve("rules/schema.json"), "utf-8"));
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const examplesDir = resolve("rules/examples");
    let failures = 0;
    for (const f of readdirSync(examplesDir).filter((f) => f.endsWith(".json"))) {
      const obj = JSON.parse(readFileSync(join(examplesDir, f), "utf-8"));
      if (validate(obj)) console.log(`  ✔ ${f}`);
      else {
        console.log(`  ✗ ${f}`);
        for (const e of validate.errors ?? []) console.log(`      ${e.instancePath} ${e.message}`);
        failures++;
      }
    }
    if (failures > 0) {
      console.error(`\n${failures} rule(s) failed validation`);
      process.exit(1);
    }
    console.log("\nAll rule examples valid against schema.");
  });
