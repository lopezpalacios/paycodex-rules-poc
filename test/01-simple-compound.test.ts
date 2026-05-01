import { expect } from "chai";
import { ethers } from "hardhat";

const SECONDS_PER_DAY = 86400n;

describe("SimpleStrategy", function () {
  it("act/360, 3.50%, 90 days, 1_000_000 → 8750", async () => {
    const Simple = await ethers.getContractFactory("SimpleStrategy");
    const s = await Simple.deploy(350, 0); // basis ACT_360 = 0
    const balance = 1_000_000n;
    const fromTs = 1_700_000_000n;
    const toTs = fromTs + 90n * SECONDS_PER_DAY;
    const interest = await s.previewAccrual(balance, fromTs, toTs);
    // 1_000_000 * 350 * 90 / (10000 * 360) = 8750
    expect(interest).to.equal(8750n);
  });

  it("act/365, 1.50%, 365 days, 1_000_000 → 15000", async () => {
    const Simple = await ethers.getContractFactory("SimpleStrategy");
    const s = await Simple.deploy(150, 1); // basis ACT_365 = 1
    const balance = 1_000_000n;
    const fromTs = 1_700_000_000n;
    const toTs = fromTs + 365n * SECONDS_PER_DAY;
    const interest = await s.previewAccrual(balance, fromTs, toTs);
    expect(interest).to.equal(15000n);
  });

  it("zero days → zero", async () => {
    const Simple = await ethers.getContractFactory("SimpleStrategy");
    const s = await Simple.deploy(350, 0);
    const interest = await s.previewAccrual(1_000_000n, 1n, 1n);
    expect(interest).to.equal(0n);
  });
});

describe("CompoundDailyStrategy", function () {
  it("act/365, 3.00%, 365 days, 1e18 ≈ 0.030453e18", async () => {
    const Compound = await ethers.getContractFactory("CompoundDailyStrategy");
    const c = await Compound.deploy(300, 1);
    const balance = 10n ** 18n;
    const fromTs = 1_700_000_000n;
    const toTs = fromTs + 365n * SECONDS_PER_DAY;
    const interest = await c.previewAccrual(balance, fromTs, toTs);
    // expected ≈ 1e18 * (1.03045326...) - 1e18 ≈ 3.0453e16
    // tolerance: ±1e14 (wad math rounding)
    const expected = 30_453_000_000_000_000n; // 0.030453e18
    const diff = interest > expected ? interest - expected : expected - interest;
    expect(diff).to.be.lessThan(10n ** 14n);
  });

  it("compound > simple over 1y at same rate", async () => {
    const fromTs = 1_700_000_000n;
    const toTs = fromTs + 365n * SECONDS_PER_DAY;
    const balance = 10n ** 18n;
    const Simple = await ethers.getContractFactory("SimpleStrategy");
    const Compound = await ethers.getContractFactory("CompoundDailyStrategy");
    const s = await Simple.deploy(300, 1);
    const c = await Compound.deploy(300, 1);
    const sI = await s.previewAccrual(balance, fromTs, toTs);
    const cI = await c.previewAccrual(balance, fromTs, toTs);
    expect(cI).to.be.greaterThan(sI);
  });
});
