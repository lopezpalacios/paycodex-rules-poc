#!/usr/bin/env node
// Validate every rules/examples/*.json against rules/schema.json using Ajv.
// Used by CI and `npm run validate:rules`.

import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

let Ajv, addFormats;
try {
  Ajv = (await import("ajv/dist/2020.js")).default;
  addFormats = (await import("ajv-formats")).default;
} catch (e) {
  console.error("missing deps: install ajv + ajv-formats");
  process.exit(2);
}

const schemaPath = resolve("rules/schema.json");
const examplesDir = resolve("rules/examples");
const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

let failures = 0;
for (const f of readdirSync(examplesDir).filter((f) => f.endsWith(".json"))) {
  const path = join(examplesDir, f);
  const obj = JSON.parse(readFileSync(path, "utf-8"));
  const ok = validate(obj);
  if (ok) {
    console.log(`  ✔ ${f}`);
  } else {
    console.log(`  ✗ ${f}`);
    for (const e of validate.errors ?? []) {
      console.log(`      ${e.instancePath} ${e.message}`);
    }
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} rule(s) failed schema validation`);
  process.exit(1);
}
console.log(`\nAll rule examples valid against schema.`);
