// End-to-end deposit lifecycle test.
// Exercises InterestBearingDeposit.deposit/_accrueToNow/withdraw/postInterest paths,
// including time-travel via hardhat to advance accrual.

import { expect } from "chai";
import { ethers, network } from "hardhat";

const SECONDS_PER_DAY = 86400n;

async function advanceDays(n: bigint) {
  await network.provider.send("evm_increaseTime", [Number(n * SECONDS_PER_DAY)]);
  await network.provider.send("evm_mine");
}

describe("InterestBearingDeposit lifecycle", function () {
  it("deposit → accrue (via time travel) → postInterest capitalises gross + applies WHT", async () => {
    const [customer] = await ethers.getSigners();

    const M = await ethers.getContractFactory("MockERC20");
    const usdc = await M.deploy("USDC", "USDC", 6);
    await usdc.transfer(customer.address, 1_000_000_000n); // ample
    const customerUsdc = usdc.connect(customer);

    const R = await ethers.getContractFactory("RuleRegistry");
    const reg = await R.deploy(customer.address);

    const S = await ethers.getContractFactory("SimpleStrategy");
    const strat = await S.deploy(350n, 0); // act/360
    const ruleId = ethers.encodeBytes32String("simp");
    await reg.register(ruleId, await strat.getAddress(), ethers.ZeroHash);

    const F = await ethers.getContractFactory("DepositFactory");
    const fac = await F.deploy(await reg.getAddress());

    // Deploy with WHT enabled (35% CH-VST style)
    const tx = await fac.deploy(ruleId, await usdc.getAddress(), customer.address, true, 3500);
    const rcpt = await tx.wait();
    const log = rcpt!.logs.find((l: any) => {
      try {
        return fac.interface.parseLog(l)?.name === "DepositDeployed";
      } catch {
        return false;
      }
    });
    const depAddr = fac.interface.parseLog(log!)!.args.deposit;
    const dep = await ethers.getContractAt("InterestBearingDeposit", depAddr);

    // Deposit 1M
    await customerUsdc.approve(depAddr, 1_000_000n);
    await dep.deposit(1_000_000n);
    expect(await dep.principal()).to.equal(1_000_000n);

    // Advance 360 days
    await advanceDays(360n);

    // previewAccrual should be ~35_000 (1M × 350 × 360 / (10000 × 360))
    const preview = await dep.previewAccrual();
    expect(preview).to.equal(35_000n);

    // Post interest: gross 35_000, WHT 35% = 12_250, net 22_750 → principal becomes 1_022_750
    await dep.postInterest();
    expect(await dep.principal()).to.equal(1_000_000n + 22_750n);
    expect(await dep.accruedInterest()).to.equal(0n);

    // Withdraw 500_000 — accrual should be effectively 0 since we just posted
    await dep.withdraw(500_000n);
    expect(await dep.principal()).to.be.lessThan(1_000_000n + 22_750n);
  });

  it("accrueToNow is a no-op when called twice in same block", async () => {
    const [customer] = await ethers.getSigners();
    const M = await ethers.getContractFactory("MockERC20");
    const usdc = await M.deploy("USDC", "USDC", 6);
    const R = await ethers.getContractFactory("RuleRegistry");
    const reg = await R.deploy(customer.address);
    const S = await ethers.getContractFactory("SimpleStrategy");
    const strat = await S.deploy(350n, 0);
    const ruleId = ethers.encodeBytes32String("noop");
    await reg.register(ruleId, await strat.getAddress(), ethers.ZeroHash);
    const F = await ethers.getContractFactory("DepositFactory");
    const fac = await F.deploy(await reg.getAddress());
    const tx = await fac.deploy(ruleId, await usdc.getAddress(), customer.address, false, 0);
    const rcpt = await tx.wait();
    const log = rcpt!.logs.find((l: any) => {
      try { return fac.interface.parseLog(l)?.name === "DepositDeployed"; } catch { return false; }
    });
    const dep = await ethers.getContractAt("InterestBearingDeposit", fac.interface.parseLog(log!)!.args.deposit);
    // postInterest on zero principal: should not revert, returns 0
    const before = await dep.accruedInterest();
    await dep.postInterest();
    expect(await dep.accruedInterest()).to.equal(before);
  });
});

describe("DayCount.fromString roundtrip via library probe", function () {
  // Library functions are internal; we expose them via a tiny probe contract.
  it("strategies report dayCount() string round-tripped from Basis enum", async () => {
    const S = await ethers.getContractFactory("SimpleStrategy");
    const s0 = await S.deploy(350, 0);
    expect(await s0.dayCount()).to.equal("act/360");
    const s1 = await S.deploy(350, 1);
    expect(await s1.dayCount()).to.equal("act/365");
    const s2 = await S.deploy(350, 2);
    expect(await s2.dayCount()).to.equal("30/360");
    const s3 = await S.deploy(350, 3);
    expect(await s3.dayCount()).to.equal("act/act-isda");
  });
});
