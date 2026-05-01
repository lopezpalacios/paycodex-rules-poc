import { expect } from "chai";
import { ethers, network } from "hardhat";

const SECONDS_PER_DAY = 86400n;
const RAY = 10n ** 27n;

async function advance(days: bigint) {
  await network.provider.send("evm_increaseTime", [Number(days * SECONDS_PER_DAY)]);
  await network.provider.send("evm_mine");
}

describe("InterestBearingPool (Pattern B)", function () {
  async function setup(rateBps = 350n) {
    const [signer, alice, bob] = await ethers.getSigners();
    const M = await ethers.getContractFactory("MockERC20");
    const usdc = await M.deploy("USDC", "USDC", 6);
    await usdc.transfer(alice.address, 10_000_000n);
    await usdc.transfer(bob.address, 10_000_000n);

    const S = await ethers.getContractFactory("SimpleStrategy");
    const strat = await S.deploy(rateBps, 0); // act/360

    const P = await ethers.getContractFactory("InterestBearingPool");
    const pool = await P.deploy(
      await usdc.getAddress(),
      await strat.getAddress(),
      ethers.encodeBytes32String("simple-pool"),
    );
    return { signer, alice, bob, usdc, strat, pool };
  }

  it("constructor invariants", async () => {
    const P = await ethers.getContractFactory("InterestBearingPool");
    const S = await ethers.getContractFactory("SimpleStrategy");
    const strat = await S.deploy(350n, 0);
    await expect(
      P.deploy(ethers.ZeroAddress, await strat.getAddress(), ethers.ZeroHash),
    ).to.be.revertedWithCustomError(P, "ZeroAddress");
    const M = await ethers.getContractFactory("MockERC20");
    const usdc = await M.deploy("U", "U", 6);
    await expect(
      P.deploy(await usdc.getAddress(), ethers.ZeroAddress, ethers.ZeroHash),
    ).to.be.revertedWithCustomError(P, "ZeroAddress");
  });

  it("liquidityIndex starts at RAY (1.0)", async () => {
    const { pool } = await setup();
    expect(await pool.liquidityIndex()).to.equal(RAY);
    expect(await pool.totalScaledBalance()).to.equal(0n);
  });

  it("two depositors share interest pro-rata", async () => {
    const { alice, bob, usdc, pool } = await setup();
    const poolAddr = await pool.getAddress();
    const usdcAddr = await usdc.getAddress();

    // Alice deposits 1M
    await usdc.connect(alice).approve(poolAddr, 1_000_000n);
    await pool.connect(alice).deposit(1_000_000n);
    expect(await pool.balanceOf(alice.address)).to.equal(1_000_000n);

    // Advance 360 days at 3.5% act/360 → 35,000 interest on 1M
    await advance(360n);
    const aliceBalance = await pool.balanceOf(alice.address);
    expect(aliceBalance).to.equal(1_035_000n);

    // Bob deposits 1M now (after Alice's interest already accrued)
    await usdc.connect(bob).approve(poolAddr, 1_000_000n);
    await pool.connect(bob).deposit(1_000_000n);

    // Bob's claim is the 1M he just put in (index has advanced, ±1 for floor-rounding when scaling)
    const bobImmediate = await pool.balanceOf(bob.address);
    const bobDiff = bobImmediate > 1_000_000n ? bobImmediate - 1_000_000n : 1_000_000n - bobImmediate;
    expect(bobDiff).to.be.lessThanOrEqual(1n);
    // Alice's claim unchanged
    expect(await pool.balanceOf(alice.address)).to.equal(1_035_000n);

    // Advance another 360 days. Pool now holds ~2,035,000 notional and earns 3.5% on it.
    await advance(360n);
    const aliceFinal = await pool.balanceOf(alice.address);
    const bobFinal = await pool.balanceOf(bob.address);

    // Alice's gain ratio over second year: roughly proportional to her share (~50.86%)
    // Pool earns ~71,225 on 2,035,000. Alice gets ~71,225 * 1,035,000/2,035,000 ≈ 36,234.
    const aliceGain = aliceFinal - 1_035_000n;
    const bobGain = bobFinal - 1_000_000n;
    expect(aliceGain).to.be.greaterThan(bobGain);   // Alice has more principal
    expect(aliceGain).to.be.lessThan(40_000n);
    expect(bobGain).to.be.greaterThan(33_000n);
  });

  it("withdraw burns the right amount of scaled balance", async () => {
    const { alice, usdc, pool } = await setup();
    const poolAddr = await pool.getAddress();

    await usdc.connect(alice).approve(poolAddr, 1_000_000n);
    await pool.connect(alice).deposit(1_000_000n);

    await advance(360n);
    expect(await pool.balanceOf(alice.address)).to.equal(1_035_000n);

    // Withdraw 500k. Remaining claim should be ~535k.
    await pool.connect(alice).withdraw(500_000n);
    const remaining = await pool.balanceOf(alice.address);
    // Allow ±1 for round-up rounding
    expect(remaining).to.be.greaterThanOrEqual(534_999n);
    expect(remaining).to.be.lessThanOrEqual(535_001n);
  });

  it("totalUnderlying matches sum of balances", async () => {
    const { alice, bob, usdc, pool } = await setup();
    const poolAddr = await pool.getAddress();
    await usdc.connect(alice).approve(poolAddr, 500_000n);
    await pool.connect(alice).deposit(500_000n);
    await usdc.connect(bob).approve(poolAddr, 1_500_000n);
    await pool.connect(bob).deposit(1_500_000n);
    await advance(180n);
    const aliceBalance = await pool.balanceOf(alice.address);
    const bobBalance = await pool.balanceOf(bob.address);
    const total = await pool.totalUnderlying();
    // Sum of individual balances should equal totalUnderlying within rounding
    const diff = total > aliceBalance + bobBalance ? total - aliceBalance - bobBalance : aliceBalance + bobBalance - total;
    expect(diff).to.be.lessThanOrEqual(2n);
  });

  it("zero-amount deposit and withdraw revert", async () => {
    const { alice, pool } = await setup();
    await expect(pool.connect(alice).deposit(0n)).to.be.revertedWithCustomError(pool, "ZeroAmount");
    await expect(pool.connect(alice).withdraw(0n)).to.be.revertedWithCustomError(pool, "ZeroAmount");
  });

  it("withdraw past balance reverts", async () => {
    const { alice, usdc, pool } = await setup();
    const poolAddr = await pool.getAddress();
    await usdc.connect(alice).approve(poolAddr, 1_000n);
    await pool.connect(alice).deposit(1_000n);
    await expect(pool.connect(alice).withdraw(1_000_000n)).to.be.revertedWithCustomError(pool, "InsufficientBalance");
  });

  it("previewIndex matches the index after _updateIndex runs", async () => {
    const { alice, usdc, pool } = await setup();
    const poolAddr = await pool.getAddress();
    await usdc.connect(alice).approve(poolAddr, 1_000_000n);
    await pool.connect(alice).deposit(1_000_000n);
    await advance(180n);
    const previewed = await pool.previewIndex();
    // Trigger an update via a tiny deposit
    await usdc.connect(alice).approve(poolAddr, 1n);
    await pool.connect(alice).deposit(1n);
    expect(await pool.liquidityIndex()).to.equal(previewed);
  });
});
