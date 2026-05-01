// AssemblyScript WASM module: interest accrual previews.
// Mirrors Solidity strategies. Compiled to wasm/build/release.wasm via `npm run wasm:build`.
// Caller (browser or Node) parses rule JSON and dispatches to the correct exported function.

const SECONDS_PER_DAY: u64 = 86400;
const BPS_DENOM: u64 = 10_000;

// Day-count basis enum mirrors DayCount.Basis in Solidity:
// 0 = act/360, 1 = act/365, 2 = 30/360, 3 = act/act-isda
function denomFor(basis: i32): u64 {
  if (basis == 0) return 360;
  if (basis == 1) return 365;
  if (basis == 2) return 360;
  return 365;
}

export function daysBetween(fromTs: u64, toTs: u64): u64 {
  if (toTs <= fromTs) return 0;
  return (toTs - fromTs) / SECONDS_PER_DAY;
}

// === Simple interest ===
// interest = balance * rateBps * days / (BPS_DENOM * denom)
export function previewSimple(
  balance: u64,
  rateBps: i32,
  basis: i32,
  fromTs: u64,
  toTs: u64,
): u64 {
  if (balance == 0 || rateBps <= 0) return 0;
  const days = daysBetween(fromTs, toTs);
  if (days == 0) return 0;
  const denom = denomFor(basis);
  const r: u64 = u64(rateBps);
  return (balance * r * days) / (BPS_DENOM * denom);
}

// === Compound (daily) ===
// Uses f64 for exponentiation. Preview-quality; Solidity uses wad rpow which may differ within 1e-4 relative.
export function previewCompound(
  balance: u64,
  rateBps: u32,
  basis: i32,
  fromTs: u64,
  toTs: u64,
): u64 {
  if (balance == 0 || rateBps == 0) return 0;
  const days = daysBetween(fromTs, toTs);
  if (days == 0) return 0;
  const denom = denomFor(basis);
  const r: f64 = f64(rateBps) / 10_000.0;
  const ratePerDay: f64 = r / f64(denom);
  const factor: f64 = Math.pow(1.0 + ratePerDay, f64(days));
  const compounded: f64 = f64(balance) * factor;
  const interest: f64 = compounded - f64(balance);
  if (interest <= 0.0) return 0;
  return u64(interest);
}

// === Tiered ===
// upTos and bpsList must be aligned; upTos sorted ascending; last upTo = u64.MAX_VALUE for "and above".
export function previewTiered(
  balance: u64,
  upTos: StaticArray<u64>,
  bpsList: StaticArray<u32>,
  basis: i32,
  fromTs: u64,
  toTs: u64,
): u64 {
  if (balance == 0) return 0;
  const days = daysBetween(fromTs, toTs);
  if (days == 0) return 0;
  const denom = denomFor(basis);
  let prevBound: u64 = 0;
  let total: u64 = 0;
  for (let i: i32 = 0; i < upTos.length; i++) {
    const upTo = upTos[i];
    const bps = bpsList[i];
    if (balance <= prevBound) break;
    const sliceTop: u64 = balance < upTo ? balance : upTo;
    const slice: u64 = sliceTop - prevBound;
    total += (slice * u64(bps) * days) / (BPS_DENOM * denom);
    prevBound = upTo;
    if (balance <= upTo) break;
  }
  return total;
}

// === Floating ===
export function previewFloating(
  balance: u64,
  oracleBps: i32,
  spreadBps: i32,
  floorBps: i32,
  capBps: i32,
  hasFloor: bool,
  hasCap: bool,
  basis: i32,
  fromTs: u64,
  toTs: u64,
): u64 {
  if (balance == 0) return 0;
  const days = daysBetween(fromTs, toTs);
  if (days == 0) return 0;
  let r: i32 = oracleBps + spreadBps;
  if (hasFloor && r < floorBps) r = floorBps;
  if (hasCap && r > capBps) r = capBps;
  if (r <= 0) return 0;
  const denom = denomFor(basis);
  return (balance * u64(r) * days) / (BPS_DENOM * denom);
}

// === KPI-linked ===
export function previewKpi(
  balance: u64,
  baseSpreadBps: i32,
  kpiDelta: i32,
  minDelta: i32,
  maxDelta: i32,
  basis: i32,
  fromTs: u64,
  toTs: u64,
): u64 {
  if (balance == 0) return 0;
  const days = daysBetween(fromTs, toTs);
  if (days == 0) return 0;
  let d = kpiDelta;
  if (d < minDelta) d = minDelta;
  if (d > maxDelta) d = maxDelta;
  const r: i32 = baseSpreadBps + d;
  if (r <= 0) return 0;
  const denom = denomFor(basis);
  return (balance * u64(r) * days) / (BPS_DENOM * denom);
}

// === Two-track ===
// Returns hard interest portion only (matches Solidity previewAccrual).
// Use previewEcr separately for the ECR portion.
export function previewTwoTrackHard(
  balance: u64,
  rateBps: u32,
  hardPortionBps: u32,
  basis: i32,
  fromTs: u64,
  toTs: u64,
): u64 {
  if (balance == 0 || rateBps == 0) return 0;
  const days = daysBetween(fromTs, toTs);
  if (days == 0) return 0;
  const denom = denomFor(basis);
  const gross: u64 = (balance * u64(rateBps) * days) / (BPS_DENOM * denom);
  return (gross * u64(hardPortionBps)) / BPS_DENOM;
}

export function previewEcr(
  avgCollectedBalance: u64,
  rateBps: u32,
  ecrPortionBps: u32,
  reserveReqBps: u32,
  basis: i32,
  fromTs: u64,
  toTs: u64,
): u64 {
  if (avgCollectedBalance == 0 || rateBps == 0) return 0;
  const days = daysBetween(fromTs, toTs);
  if (days == 0) return 0;
  const denom = denomFor(basis);
  const base: u64 = (avgCollectedBalance * u64(BPS_DENOM - u64(reserveReqBps))) / BPS_DENOM;
  const gross: u64 = (base * u64(rateBps) * days) / (BPS_DENOM * denom);
  return (gross * u64(ecrPortionBps)) / BPS_DENOM;
}

// === Withholding ===
export function applyWithholding(grossInterest: u64, whtBps: u32): u64 {
  const wht: u64 = (grossInterest * u64(whtBps)) / BPS_DENOM;
  return grossInterest - wht;
}
