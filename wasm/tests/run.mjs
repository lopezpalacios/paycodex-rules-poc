#!/usr/bin/env node
// AS-side WASM unit tests — exercise exported functions directly, no Solidity involved.
// Run with `npm run wasm:test`. Exits 1 on failure.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";

const wasmPath = resolve("wasm/build/release.wasm");
const bytes = readFileSync(wasmPath);
const mod = await WebAssembly.instantiate(bytes, {
  env: {
    abort(_msg, _file, line, col) {
      throw new Error(`abort at ${line}:${col}`);
    },
  },
});
const w = mod.instance.exports;

const SECONDS_PER_DAY = 86400n;
const FROM = 1_700_000_000n;

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

console.log("WASM exports — direct unit tests\n");

test("daysBetween: 90 days at SECONDS_PER_DAY = 90", () => {
  const r = w.daysBetween(FROM, FROM + 90n * SECONDS_PER_DAY);
  assert.equal(r, 90n);
});

test("daysBetween: same ts → 0", () => {
  assert.equal(w.daysBetween(FROM, FROM), 0n);
});

test("daysBetween: toTs < fromTs → 0", () => {
  assert.equal(w.daysBetween(FROM, FROM - 1n), 0n);
});

test("previewSimple act/360 350bps × 90d × 1M = 8750", () => {
  const r = w.previewSimple(1_000_000n, 350, 0, FROM, FROM + 90n * SECONDS_PER_DAY);
  assert.equal(r, 8750n);
});

test("previewSimple act/365 150bps × 365d × 1M = 15000", () => {
  const r = w.previewSimple(1_000_000n, 150, 1, FROM, FROM + 365n * SECONDS_PER_DAY);
  assert.equal(r, 15_000n);
});

test("previewSimple negative rate → 0", () => {
  const r = w.previewSimple(1_000_000n, -100, 0, FROM, FROM + 360n * SECONDS_PER_DAY);
  assert.equal(r, 0n);
});

test("previewCompound act/365 300bps × 365d × 1e18 ≈ 0.030453e18", () => {
  const r = w.previewCompound(10n ** 18n, 300, 1, FROM, FROM + 365n * SECONDS_PER_DAY);
  const expected = 30_453_000_000_000_000n;
  const diff = r > expected ? r - expected : expected - r;
  assert.ok(diff < 10n ** 14n, `compound off by ${diff}`);
});

test("previewCompound > previewSimple over 1y at 3%", () => {
  const sim = w.previewSimple(10n ** 18n, 300, 1, FROM, FROM + 365n * SECONDS_PER_DAY);
  const cmp = w.previewCompound(10n ** 18n, 300, 1, FROM, FROM + 365n * SECONDS_PER_DAY);
  assert.ok(cmp > sim, "compound should exceed simple over a full year");
});

test("previewFloating no-bounds: oracle 350 + spread 50 = 400bps × 1M × 360d = 40000", () => {
  const r = w.previewFloating(1_000_000n, 350, 50, 0, 0, false, false, 0, FROM, FROM + 360n * SECONDS_PER_DAY);
  assert.equal(r, 40_000n);
});

test("previewFloating floor 0 blocks negative oracle (-100 + 50 → 0)", () => {
  const r = w.previewFloating(1_000_000n, -100, 50, 0, 0, true, false, 0, FROM, FROM + 360n * SECONDS_PER_DAY);
  assert.equal(r, 0n);
});

test("previewFloating cap 1000bps binds when oracle 2000+50", () => {
  const r = w.previewFloating(1_000_000n, 2000, 50, 0, 1000, false, true, 0, FROM, FROM + 360n * SECONDS_PER_DAY);
  assert.equal(r, 100_000n);  // 1M × 1000 / 10000 = 100k
});

test("previewKpi base 400 with delta -50 inside range → 350bps", () => {
  const r = w.previewKpi(1_000_000n, 400, -50, -100, 100, 0, FROM, FROM + 360n * SECONDS_PER_DAY);
  assert.equal(r, 35_000n);
});

test("previewKpi delta clamped to range", () => {
  const r = w.previewKpi(1_000_000n, 400, 999, -100, 100, 0, FROM, FROM + 360n * SECONDS_PER_DAY);
  // delta clamped to +100 → 500bps → 50000
  assert.equal(r, 50_000n);
});

test("previewTwoTrackHard: 350bps × 50% hard portion", () => {
  const r = w.previewTwoTrackHard(1_000_000n, 350, 5000, 0, FROM, FROM + 360n * SECONDS_PER_DAY);
  assert.equal(r, 17_500n);
});

test("previewEcr: reserveBps reduces base; ecrBps takes portion", () => {
  // base = 1M × (10000 - 1000) / 10000 = 900_000
  // gross = 900_000 × 350 / 10000 = 31_500
  // ecr = 31_500 × 5000/10000 = 15_750
  const r = w.previewEcr(1_000_000n, 350, 5000, 1000, 0, FROM, FROM + 360n * SECONDS_PER_DAY);
  assert.equal(r, 15_750n);
});

test("applyWithholding: 22500 gross @ 35% = 14625 net", () => {
  assert.equal(w.applyWithholding(22_500n, 3500), 14_625n);
});

test("applyWithholding: zero rate → no change", () => {
  assert.equal(w.applyWithholding(1000n, 0), 1000n);
});

test("zero balance → all preview functions return 0", () => {
  assert.equal(w.previewSimple(0n, 350, 0, FROM, FROM + 90n * SECONDS_PER_DAY), 0n);
  assert.equal(w.previewCompound(0n, 300, 1, FROM, FROM + 365n * SECONDS_PER_DAY), 0n);
  assert.equal(w.previewFloating(0n, 350, 50, 0, 0, false, false, 0, FROM, FROM + 360n * SECONDS_PER_DAY), 0n);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
