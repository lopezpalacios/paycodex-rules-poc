import { expect } from "chai";
import { ethers } from "hardhat";

const SECONDS_PER_DAY = 86400n;

describe("TieredStrategy", function () {
  it("3 tiers, balance straddling top tier", async () => {
    const Tiered = await ethers.getContractFactory("TieredStrategy");
    // Tiers: [1M @ 200bps, 10M @ 300bps, max @ 350bps], basis act/360
    const t = await Tiered.deploy(
      [1_000_000n * 10n ** 18n, 10_000_000n * 10n ** 18n, ethers.MaxUint256],
      [200n, 300n, 350n],
      0,
    );
    const balance = 5_000_000n * 10n ** 18n; // sits in tier 2
    const fromTs = 1_700_000_000n;
    const toTs = fromTs + 360n * SECONDS_PER_DAY; // 360 days, denom 360 → factor = 1y
    const interest = await t.previewAccrual(balance, fromTs, toTs);
    // tier1: 1M @ 2% = 20_000
    // tier2: 4M @ 3% = 120_000
    // total = 140_000 (in 1e18 units)
    const expected = 140_000n * 10n ** 18n;
    expect(interest).to.equal(expected);
  });

  it("balance below first tier accrues only at first tier rate", async () => {
    const Tiered = await ethers.getContractFactory("TieredStrategy");
    const t = await Tiered.deploy(
      [1_000_000n, ethers.MaxUint256],
      [200n, 350n],
      0,
    );
    const fromTs = 1_700_000_000n;
    const toTs = fromTs + 360n * SECONDS_PER_DAY;
    const interest = await t.previewAccrual(500_000n, fromTs, toTs);
    // 500_000 * 200 * 360 / (10000 * 360) = 10_000
    expect(interest).to.equal(10_000n);
  });
});

describe("FloatingStrategy", function () {
  it("oracle 350bps + spread 50bps = 400bps", async () => {
    const Oracle = await ethers.getContractFactory("MockRateOracle");
    const o = await Oracle.deploy(350n, "ESTR");
    const Floating = await ethers.getContractFactory("FloatingStrategy");
    const f = await Floating.deploy(await o.getAddress(), 50, 0, -10001, 10001); // no floor/cap
    const balance = 1_000_000n;
    const fromTs = 1_700_000_000n;
    const toTs = fromTs + 360n * SECONDS_PER_DAY;
    const interest = await f.previewAccrual(balance, fromTs, toTs);
    // 1_000_000 * 400 * 360 / (10000 * 360) = 40_000
    expect(interest).to.equal(40_000n);
  });

  it("floor at 0% blocks negative oracle pass-through", async () => {
    const Oracle = await ethers.getContractFactory("MockRateOracle");
    const o = await Oracle.deploy(-100n, "ESTR"); // -1% policy rate
    const Floating = await ethers.getContractFactory("FloatingStrategy");
    const f = await Floating.deploy(await o.getAddress(), 50, 0, 0, 10001); // floor at 0
    const balance = 1_000_000n;
    const fromTs = 1_700_000_000n;
    const toTs = fromTs + 360n * SECONDS_PER_DAY;
    const interest = await f.previewAccrual(balance, fromTs, toTs);
    // -100 + 50 = -50, floored to 0 → zero interest
    expect(interest).to.equal(0n);
  });

  it("cap at 10% binds when oracle spikes", async () => {
    const Oracle = await ethers.getContractFactory("MockRateOracle");
    const o = await Oracle.deploy(2000n, "ESTR"); // 20%
    const Floating = await ethers.getContractFactory("FloatingStrategy");
    const f = await Floating.deploy(await o.getAddress(), 50, 0, -10001, 1000); // cap 10%
    const balance = 1_000_000n;
    const fromTs = 1_700_000_000n;
    const toTs = fromTs + 360n * SECONDS_PER_DAY;
    const interest = await f.previewAccrual(balance, fromTs, toTs);
    // capped at 1000bps → 1_000_000 * 1000 * 360 / (10000 * 360) = 100_000
    expect(interest).to.equal(100_000n);
  });
});

describe("KpiLinkedStrategy", function () {
  it("KPI met (-50bps) reduces effective spread", async () => {
    const Kpi = await ethers.getContractFactory("MockKpiOracle");
    const k = await Kpi.deploy(-50, "GHG");
    const Strat = await ethers.getContractFactory("KpiLinkedStrategy");
    const s = await Strat.deploy(await k.getAddress(), 400, -100, 100, 0);
    const balance = 1_000_000n;
    const fromTs = 1_700_000_000n;
    const toTs = fromTs + 360n * SECONDS_PER_DAY;
    const interest = await s.previewAccrual(balance, fromTs, toTs);
    // 400 - 50 = 350bps → 1_000_000 * 350 / 10000 = 35_000
    expect(interest).to.equal(35_000n);
  });
});

describe("TwoTrackStrategy", function () {
  it("hard portion vs ECR portion", async () => {
    const Strat = await ethers.getContractFactory("TwoTrackStrategy");
    // 3.50% rate, 50/50 split, 10% reserve req, act/360
    const s = await Strat.deploy(350, 5000, 5000, 1000, 0);
    const balance = 1_000_000n;
    const fromTs = 1_700_000_000n;
    const toTs = fromTs + 360n * SECONDS_PER_DAY;
    const hard = await s.previewAccrual(balance, fromTs, toTs);
    // gross = 1_000_000 * 350 / 10000 = 35_000; hard = 50% = 17_500
    expect(hard).to.equal(17_500n);
    const ecr = await s.previewEcr(balance, fromTs, toTs);
    // ecr base = 1_000_000 * 9000/10000 = 900_000; gross = 900_000 * 350/10000 = 31_500; ecr portion = 50% = 15_750
    expect(ecr).to.equal(15_750n);
  });
});
