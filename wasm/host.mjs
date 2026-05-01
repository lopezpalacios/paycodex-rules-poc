// JS-side dispatcher: parses rule JSON, calls the right WASM export.
// Used by both `scripts/simulate.mjs` (Node CLI) and `ui/app.ts` (browser).

import { readFile } from "node:fs/promises";

const BASIS = { "act/360": 0, "act/365": 1, "30/360": 2, "act/act-isda": 3 };

export async function loadWasm(wasmPath) {
  const bytes = await readFile(wasmPath);
  const mod = await WebAssembly.instantiate(bytes, {
    env: {
      abort(_msg, _file, line, col) {
        throw new Error(`abort at ${line}:${col}`);
      },
    },
  });
  return mod.instance.exports;
}

/**
 * Run the matching preview function for a rule.
 * @param wasm exports object from loadWasm()
 * @param rule parsed rule JSON
 * @param balance bigint
 * @param fromTs bigint (unix seconds)
 * @param toTs bigint
 * @param oracleRateBps current reference rate (for floating)
 * @param kpiDeltaBps current KPI delta (for kpi-linked)
 * @returns { gross: bigint, net: bigint, ecr?: bigint }
 */
export function preview(wasm, rule, balance, fromTs, toTs, oracleRateBps = 0n, kpiDeltaBps = 0n) {
  const basis = BASIS[rule.dayCount];
  if (basis === undefined) throw new Error(`unknown dayCount ${rule.dayCount}`);
  const b = BigInt(balance);
  const f = BigInt(fromTs);
  const t = BigInt(toTs);
  let gross = 0n;
  let ecr;

  switch (rule.kind) {
    case "simple":
      gross = wasm.previewSimple(b, rule.ratePolicy.fixedBps, basis, f, t);
      break;
    case "compound":
      gross = wasm.previewCompound(b, rule.ratePolicy.fixedBps, basis, f, t);
      break;
    case "tiered": {
      const upTos = rule.ratePolicy.tiers.map((tt) =>
        tt.upTo === "max" ? 0xffffffffffffffffn : BigInt(tt.upTo),
      );
      const bpsList = rule.ratePolicy.tiers.map((tt) => tt.bps);
      // pass via heap helpers — for AS StaticArray<u64> + StaticArray<u32>
      const upTosPtr = wasm.__newArray(wasm.StaticArray_u64_ID, upTos);
      const bpsPtr = wasm.__newArray(wasm.StaticArray_u32_ID, bpsList);
      gross = wasm.previewTiered(b, upTosPtr, bpsPtr, basis, f, t);
      break;
    }
    case "floating": {
      const hasFloor = rule.floorBps !== undefined;
      const hasCap = rule.capBps !== undefined;
      gross = wasm.previewFloating(
        b,
        Number(oracleRateBps),
        rule.ratePolicy.spreadBps,
        rule.floorBps ?? 0,
        rule.capBps ?? 0,
        hasFloor,
        hasCap,
        basis,
        f,
        t,
      );
      break;
    }
    case "kpi-linked": {
      const [minD, maxD] = rule.ratePolicy.adjustmentRangeBps;
      gross = wasm.previewKpi(
        b,
        rule.ratePolicy.baseSpreadBps,
        Number(kpiDeltaBps),
        minD,
        maxD,
        basis,
        f,
        t,
      );
      break;
    }
    case "two-track": {
      const hardBps = Math.round((rule.twoTrack.hardInterestPortion ?? 0) * 10_000);
      const ecrBps = Math.round((rule.twoTrack.ecrPortion ?? 0) * 10_000);
      const reserveBps = rule.twoTrack.reserveRequirementBps ?? 0;
      gross = wasm.previewTwoTrackHard(b, rule.ratePolicy.fixedBps, hardBps, basis, f, t);
      ecr = wasm.previewEcr(b, rule.ratePolicy.fixedBps, ecrBps, reserveBps, basis, f, t);
      break;
    }
    default:
      throw new Error(`unknown rule kind ${rule.kind}`);
  }

  let net = gross;
  if (rule.withholding && rule.withholding.enabled) {
    net = wasm.applyWithholding(gross, rule.withholding.rateBps);
  }
  return { gross, net, ecr };
}

export async function loadRule(path) {
  const text = await readFile(path, "utf-8");
  return JSON.parse(text);
}
