import { expect } from "chai";
import { ethers, network } from "hardhat";

const SECONDS_PER_DAY = 86400n;

async function advance(days: bigint) {
  await network.provider.send("evm_increaseTime", [Number(days * SECONDS_PER_DAY)]);
  await network.provider.send("evm_mine");
}

describe("PoolFactory", function () {
  async function setupRegistered() {
    const [op, alice] = await ethers.getSigners();

    const M = await ethers.getContractFactory("MockERC20");
    const usdc = await M.deploy("USDC", "USDC", 6);
    await usdc.transfer(alice.address, 10_000_000n);

    const R = await ethers.getContractFactory("RuleRegistry");
    const reg = await R.deploy(op.address);

    const S = await ethers.getContractFactory("SimpleStrategy");
    const strat = await S.deploy(350n, 0); // 3.50% act/360
    const ruleId = ethers.encodeBytes32String("simple-pool-test");
    await reg.register(ruleId, await strat.getAddress(), ethers.ZeroHash);

    const F = await ethers.getContractFactory("PoolFactory");
    const fac = await F.deploy(await reg.getAddress());

    return { op, alice, usdc, reg, strat, fac, ruleId };
  }

  it("deploys a pool wired to the right strategy", async () => {
    const { fac, usdc, strat, ruleId } = await setupRegistered();
    const tx = await fac.deploy(ruleId, await usdc.getAddress());
    const rcpt = await tx.wait();
    const log = rcpt!.logs.find((l: any) => {
      try { return fac.interface.parseLog(l)?.name === "PoolDeployed"; } catch { return false; }
    });
    const poolAddr = fac.interface.parseLog(log!)!.args.pool;
    const pool = await ethers.getContractAt("InterestBearingPool", poolAddr);
    expect(await pool.strategy()).to.equal(await strat.getAddress());
    expect(await pool.asset()).to.equal(await usdc.getAddress());
    expect(await pool.ruleId()).to.equal(ruleId);
    expect(await pool.liquidityIndex()).to.equal(10n ** 27n); // RAY
  });

  it("rejects deprecated rules", async () => {
    const { fac, reg, usdc, ruleId } = await setupRegistered();
    await reg.deprecate(ruleId);
    await expect(fac.deploy(ruleId, await usdc.getAddress()))
      .to.be.revertedWithCustomError(fac, "RuleDeprecated");
  });

  it("rejects unknown rules", async () => {
    const { fac, reg, usdc } = await setupRegistered();
    const unknown = ethers.encodeBytes32String("never-registered");
    await expect(fac.deploy(unknown, await usdc.getAddress()))
      .to.be.revertedWithCustomError(reg, "UnknownRule");
  });

  it("end-to-end: factory → pool → deposit → accrue → withdraw", async () => {
    const { alice, usdc, fac, ruleId } = await setupRegistered();
    const tx = await fac.deploy(ruleId, await usdc.getAddress());
    const rcpt = await tx.wait();
    const log = rcpt!.logs.find((l: any) => {
      try { return fac.interface.parseLog(l)?.name === "PoolDeployed"; } catch { return false; }
    });
    const poolAddr = fac.interface.parseLog(log!)!.args.pool;
    const pool = await ethers.getContractAt("InterestBearingPool", poolAddr);

    await usdc.connect(alice).approve(poolAddr, 1_000_000n);
    await pool.connect(alice).deposit(1_000_000n);
    expect(await pool.balanceOf(alice.address)).to.equal(1_000_000n);

    await advance(360n);
    expect(await pool.balanceOf(alice.address)).to.equal(1_035_000n);

    await pool.connect(alice).withdraw(500_000n);
    const remaining = await pool.balanceOf(alice.address);
    expect(remaining).to.be.greaterThanOrEqual(534_999n);
    expect(remaining).to.be.lessThanOrEqual(535_001n);
  });

  it("multiple pools for the same rule are independent", async () => {
    const { fac, usdc, ruleId } = await setupRegistered();
    const t1 = await fac.deploy(ruleId, await usdc.getAddress());
    const r1 = await t1.wait();
    const t2 = await fac.deploy(ruleId, await usdc.getAddress());
    const r2 = await t2.wait();
    const get = (rcpt: any) => fac.interface.parseLog(
      rcpt!.logs.find((l: any) => { try { return fac.interface.parseLog(l)?.name === "PoolDeployed"; } catch { return false; } })!,
    )!.args.pool;
    expect(get(r1)).to.not.equal(get(r2));
  });
});
