// Parity test: for each rule kind, the WASM preview must match the Solidity strategy
// within tolerance. Compound has wider tolerance because WASM uses f64 Math.pow whereas
// Solidity uses integer rpow.

import { expect } from "chai";
import { ethers } from "hardhat";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const RULES = [
  "rules/examples/01-simple-act360.json",
  "rules/examples/02-compound-daily.json",
  "rules/examples/03-tiered-savings.json",
  "rules/examples/04-floating-estr.json",
  "rules/examples/05-esg-kpi.json",
  "rules/examples/06-floor-cap.json",
  "rules/examples/07-two-track-ecr.json",
  "rules/examples/08-ch-withholding.json",
];

const BASIS_ENUM: Record<string, number> = {
  "act/360": 0,
  "act/365": 1,
  "30/360": 2,
  "act/act-isda": 3,
};

async function loadWasm(): Promise<any> {
  const bytes = readFileSync(resolve("wasm/build/release.wasm"));
  const mod = await WebAssembly.instantiate(bytes, {
    env: {
      abort(_msg: number, _file: number, line: number, col: number) {
        throw new Error(`abort at ${line}:${col}`);
      },
    },
  });
  return (mod.instance as WebAssembly.Instance).exports as any;
}

function previewFromWasm(
  wasm: any,
  rule: any,
  balance: bigint,
  fromTs: bigint,
  toTs: bigint,
  oracleBps = 0n,
  kpiBps = 0n,
): { gross: bigint; net: bigint; ecr?: bigint } {
  const basis = BASIS_ENUM[rule.dayCount];
  let gross = 0n;
  let ecr: bigint | undefined;

  switch (rule.kind) {
    case "simple":
      gross = wasm.previewSimple(balance, rule.ratePolicy.fixedBps, basis, fromTs, toTs);
      break;
    case "compound":
      gross = wasm.previewCompound(balance, rule.ratePolicy.fixedBps, basis, fromTs, toTs);
      break;
    case "tiered": {
      // Slice balance across tier bands JS-side, sum previewSimple for each slice.
      // Equivalent to the in-WASM previewTiered (avoids AS array marshalling boilerplate in test).
      const tiers = rule.ratePolicy.tiers;
      let prev = 0n;
      let sum = 0n;
      for (const t of tiers) {
        const upTo = t.upTo === "max" ? 0xffffffffffffffffn : BigInt(t.upTo);
        if (balance <= prev) break;
        const sliceTop = balance < upTo ? balance : upTo;
        const slice = sliceTop - prev;
        sum += wasm.previewSimple(slice, t.bps, basis, fromTs, toTs);
        prev = upTo;
        if (balance <= upTo) break;
      }
      gross = sum;
      break;
    }
    case "floating": {
      const hasFloor = rule.floorBps !== undefined;
      const hasCap = rule.capBps !== undefined;
      gross = wasm.previewFloating(
        balance,
        Number(oracleBps),
        rule.ratePolicy.spreadBps,
        rule.floorBps ?? 0,
        rule.capBps ?? 0,
        hasFloor,
        hasCap,
        basis,
        fromTs,
        toTs,
      );
      break;
    }
    case "kpi-linked": {
      const [minD, maxD] = rule.ratePolicy.adjustmentRangeBps;
      gross = wasm.previewKpi(
        balance,
        rule.ratePolicy.baseSpreadBps,
        Number(kpiBps),
        minD,
        maxD,
        basis,
        fromTs,
        toTs,
      );
      break;
    }
    case "two-track": {
      const hardBps = Math.round(rule.twoTrack.hardInterestPortion * 10_000);
      const ecrBps = Math.round(rule.twoTrack.ecrPortion * 10_000);
      const reserveBps = rule.twoTrack.reserveRequirementBps ?? 0;
      gross = wasm.previewTwoTrackHard(balance, rule.ratePolicy.fixedBps, hardBps, basis, fromTs, toTs);
      ecr = wasm.previewEcr(balance, rule.ratePolicy.fixedBps, ecrBps, reserveBps, basis, fromTs, toTs);
      break;
    }
  }

  let net = gross;
  if (rule.withholding && rule.withholding.enabled) {
    net = wasm.applyWithholding(gross, rule.withholding.rateBps);
  }
  return { gross, net, ecr };
}

function within(a: bigint, b: bigint, relTolerance = 0.0001): boolean {
  if (a === b) return true;
  const big = a > b ? a : b;
  const diff = a > b ? a - b : b - a;
  if (big < 1000n) return diff <= 1n;
  const tol = (big * BigInt(Math.round(relTolerance * 1_000_000))) / 1_000_000n;
  return diff <= tol;
}

describe("Parity: WASM ≡ Solidity", function () {
  this.timeout(120_000);
  let wasm: any;

  before(async function () {
    const wasmPath = resolve("wasm/build/release.wasm");
    if (!existsSync(wasmPath)) {
      console.log("[skip] wasm/build/release.wasm missing — run `npm run wasm:build`");
      this.skip();
    }
    wasm = await loadWasm();
  });

  for (const rulePath of RULES) {
    it(`matches: ${rulePath}`, async () => {
      const rule = JSON.parse(readFileSync(rulePath, "utf-8"));
      const basis = BASIS_ENUM[rule.dayCount];
      const balance = 1_000_000n;
      const fromTs = 1_700_000_000n;
      const toTs = fromTs + 360n * 86400n;

      let oracleRate = 0n;
      let kpiDelta = 0n;
      let strat: any;

      if (rule.kind === "simple") {
        const F = await ethers.getContractFactory("SimpleStrategy");
        strat = await F.deploy(rule.ratePolicy.fixedBps, basis);
      } else if (rule.kind === "compound") {
        const F = await ethers.getContractFactory("CompoundDailyStrategy");
        strat = await F.deploy(rule.ratePolicy.fixedBps, basis);
      } else if (rule.kind === "tiered") {
        const tiers = rule.ratePolicy.tiers;
        const upTos = tiers.map((t: any) =>
          t.upTo === "max" ? ethers.MaxUint256 : BigInt(t.upTo),
        );
        const bps = tiers.map((t: any) => t.bps);
        const F = await ethers.getContractFactory("TieredStrategy");
        strat = await F.deploy(upTos, bps, basis);
      } else if (rule.kind === "floating") {
        const O = await ethers.getContractFactory("MockRateOracle");
        const o = await O.deploy(350, "ESTR");
        oracleRate = await o.getRateBps();
        const floor = rule.floorBps ?? -10001;
        const cap = rule.capBps ?? 10001;
        const F = await ethers.getContractFactory("FloatingStrategy");
        strat = await F.deploy(await o.getAddress(), rule.ratePolicy.spreadBps, basis, floor, cap);
      } else if (rule.kind === "kpi-linked") {
        const O = await ethers.getContractFactory("MockKpiOracle");
        const o = await O.deploy(-25, "GHG");
        kpiDelta = BigInt(await o.spreadAdjustmentBps());
        const [minD, maxD] = rule.ratePolicy.adjustmentRangeBps;
        const F = await ethers.getContractFactory("KpiLinkedStrategy");
        strat = await F.deploy(await o.getAddress(), rule.ratePolicy.baseSpreadBps, minD, maxD, basis);
      } else if (rule.kind === "two-track") {
        const hardBps = Math.round(rule.twoTrack.hardInterestPortion * 10_000);
        const ecrBps = Math.round(rule.twoTrack.ecrPortion * 10_000);
        const reserveBps = rule.twoTrack.reserveRequirementBps ?? 0;
        const F = await ethers.getContractFactory("TwoTrackStrategy");
        strat = await F.deploy(rule.ratePolicy.fixedBps, hardBps, ecrBps, reserveBps, basis);
      }

      const solGross = await strat.previewAccrual(balance, fromTs, toTs);
      const wasmRes = previewFromWasm(wasm, rule, balance, fromTs, toTs, oracleRate, kpiDelta);
      const tolerance = rule.kind === "compound" ? 0.001 : 0.0001;
      const ok = within(wasmRes.gross, solGross, tolerance);
      expect(ok).to.equal(
        true,
        `WASM=${wasmRes.gross} Solidity=${solGross} diff=${wasmRes.gross > solGross ? wasmRes.gross - solGross : solGross - wasmRes.gross}`,
      );
    });
  }
});
