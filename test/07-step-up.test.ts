import { expect } from "chai";
import { ethers } from "hardhat";

const SECONDS_PER_DAY = 86400n;

describe("StepUpStrategy", function () {
  it("constructor invariants", async () => {
    const F = await ethers.getContractFactory("StepUpStrategy");
    await expect(F.deploy([], [], 0)).to.be.revertedWithCustomError(F, "BadLength");
    await expect(F.deploy([1n], [200n, 300n], 0)).to.be.revertedWithCustomError(F, "BadLength");
    // not strictly ascending
    await expect(F.deploy([200n, 100n], [200n, 300n], 0)).to.be.revertedWithCustomError(F, "NotSorted");
    // duplicate
    await expect(F.deploy([100n, 100n], [200n, 300n], 0)).to.be.revertedWithCustomError(F, "NotSorted");
    // rate > 10000
    await expect(F.deploy([100n], [10001n], 0)).to.be.revertedWithCustomError(F, "RateTooHigh");
  });

  it("integrates two-step schedule across the boundary", async () => {
    const F = await ethers.getContractFactory("StepUpStrategy");
    // Step 0 at t=1_700_000_000 = 200bps, Step 1 at t=1_700_864_000 (10 days later) = 300bps
    const t0 = 1_700_000_000n;
    const t1 = t0 + 10n * SECONDS_PER_DAY;
    const s = await F.deploy([t0, t1], [200n, 300n], 0); // act/360

    const balance = 1_000_000n;
    // Period: [t0, t0+30d] — 10 days at 200bps + 20 days at 300bps
    const interest = await s.previewAccrual(balance, t0, t0 + 30n * SECONDS_PER_DAY);
    // 1_000_000 * 200 * 10 / (10000 * 360) = 555.55... → 555 (integer)
    // 1_000_000 * 300 * 20 / (10000 * 360) = 1666.66... → 1666
    // total ≈ 555 + 1666 = 2221
    const expected = 555n + 1666n;
    expect(interest).to.equal(expected);
  });

  it("zero before first step", async () => {
    const F = await ethers.getContractFactory("StepUpStrategy");
    const t0 = 1_700_000_000n;
    const s = await F.deploy([t0], [200n], 0);
    // Period entirely BEFORE t0
    const interest = await s.previewAccrual(1_000_000n, t0 - 100n * SECONDS_PER_DAY, t0 - 1n);
    expect(interest).to.equal(0n);
  });

  it("last step extends to forever", async () => {
    const F = await ethers.getContractFactory("StepUpStrategy");
    const t0 = 1_700_000_000n;
    const s = await F.deploy([t0], [200n], 0);
    // Period of 360 days starting at t0
    const interest = await s.previewAccrual(1_000_000n, t0, t0 + 360n * SECONDS_PER_DAY);
    // 1_000_000 * 200 * 360 / (10000 * 360) = 20_000
    expect(interest).to.equal(20_000n);
  });

  it("kind() returns 'step-up' and dayCount round-trips", async () => {
    const F = await ethers.getContractFactory("StepUpStrategy");
    const s = await F.deploy([1n], [200n], 1);
    expect(await s.kind()).to.equal("step-up");
    expect(await s.dayCount()).to.equal("act/365");
  });

  it("monotonic in balance (fuzzed sample)", async () => {
    const F = await ethers.getContractFactory("StepUpStrategy");
    const t0 = 1_700_000_000n;
    const s = await F.deploy([t0, t0 + 100n * SECONDS_PER_DAY], [200n, 350n], 0);
    const a = await s.previewAccrual(1_000_000n, t0, t0 + 360n * SECONDS_PER_DAY);
    const b = await s.previewAccrual(2_000_000n, t0, t0 + 360n * SECONDS_PER_DAY);
    expect(b).to.be.greaterThan(a);
    // 2× balance yields ~2× interest (within per-step floor() rounding — 1 unit per step)
    const twoX = a * 2n;
    const diff = b > twoX ? b - twoX : twoX - b;
    expect(diff).to.be.lessThanOrEqual(2n);
  });
});
