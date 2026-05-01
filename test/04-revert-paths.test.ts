// Revert-path tests: every constructor / library precondition is enforced
// with a typed custom error. Confirms the iter-2 require→custom-error refactor.

import { expect } from "chai";
import { ethers } from "hardhat";

const SECONDS_PER_DAY = 86400n;

describe("Custom errors: constructor preconditions", function () {
  it("SimpleStrategy reverts when |rate| > 10000bps", async () => {
    const F = await ethers.getContractFactory("SimpleStrategy");
    await expect(F.deploy(10001n, 0)).to.be.revertedWithCustomError(F, "RateOutOfRange");
    await expect(F.deploy(-10001n, 0)).to.be.revertedWithCustomError(F, "RateOutOfRange");
  });

  it("CompoundDailyStrategy reverts when rate > 10000bps", async () => {
    const F = await ethers.getContractFactory("CompoundDailyStrategy");
    await expect(F.deploy(10001n, 0)).to.be.revertedWithCustomError(F, "RateTooHigh");
  });

  it("TieredStrategy reverts on bad length, not-sorted, and rate > 10000", async () => {
    const F = await ethers.getContractFactory("TieredStrategy");
    await expect(F.deploy([], [], 0)).to.be.revertedWithCustomError(F, "BadLength");
    await expect(F.deploy([100n], [200n, 300n], 0)).to.be.revertedWithCustomError(F, "BadLength");
    await expect(F.deploy([200n, 100n], [200n, 300n], 0)).to.be.revertedWithCustomError(F, "NotSorted");
    await expect(F.deploy([100n, 200n], [200n, 10001n], 0)).to.be.revertedWithCustomError(F, "RateTooHigh");
  });

  it("KpiLinkedStrategy reverts when maxDelta < minDelta", async () => {
    const O = await ethers.getContractFactory("MockKpiOracle");
    const o = await O.deploy(0, "GHG");
    const F = await ethers.getContractFactory("KpiLinkedStrategy");
    await expect(F.deploy(await o.getAddress(), 100, 50, 10, 0)).to.be.revertedWithCustomError(F, "BadRange");
  });

  it("TwoTrackStrategy reverts on portion overflow, rate, reserve", async () => {
    const F = await ethers.getContractFactory("TwoTrackStrategy");
    await expect(F.deploy(350, 6000, 6000, 1000, 0)).to.be.revertedWithCustomError(F, "PortionOverflow");
    await expect(F.deploy(10001, 5000, 5000, 1000, 0)).to.be.revertedWithCustomError(F, "RateTooHigh");
    await expect(F.deploy(350, 5000, 5000, 10001, 0)).to.be.revertedWithCustomError(F, "ReserveTooHigh");
  });
});

describe("Custom errors: registry + factory access control", function () {
  it("RuleRegistry rejects non-operator register", async () => {
    const [op, intruder] = await ethers.getSigners();
    const R = await ethers.getContractFactory("RuleRegistry");
    const reg = await R.connect(op).deploy(op.address);
    const S = await ethers.getContractFactory("SimpleStrategy");
    const s = await S.deploy(350n, 0);
    await expect(
      reg.connect(intruder).register(ethers.encodeBytes32String("x"), await s.getAddress(), ethers.ZeroHash),
    ).to.be.revertedWithCustomError(reg, "NotOperator");
  });

  it("RuleRegistry rejects double-register and unknown lookup", async () => {
    const [op] = await ethers.getSigners();
    const R = await ethers.getContractFactory("RuleRegistry");
    const reg = await R.deploy(op.address);
    const S = await ethers.getContractFactory("SimpleStrategy");
    const s = await S.deploy(350n, 0);
    const id = ethers.encodeBytes32String("dup-rule");
    await reg.register(id, await s.getAddress(), ethers.ZeroHash);
    await expect(reg.register(id, await s.getAddress(), ethers.ZeroHash)).to.be.revertedWithCustomError(reg, "AlreadyRegistered");
    await expect(reg.get(ethers.encodeBytes32String("missing"))).to.be.revertedWithCustomError(reg, "UnknownRule");
  });

  it("RuleRegistry rejects strategy without introspection", async () => {
    const [op] = await ethers.getSigners();
    const R = await ethers.getContractFactory("RuleRegistry");
    const reg = await R.deploy(op.address);
    // Use any contract that does NOT implement kind()/dayCount() — MockERC20 fits.
    const M = await ethers.getContractFactory("MockERC20");
    const m = await M.deploy("X", "X", 6);
    await expect(
      reg.register(ethers.encodeBytes32String("bad"), await m.getAddress(), ethers.ZeroHash),
    ).to.be.revertedWithCustomError(reg, "MissingIntrospection");
  });

  it("DepositFactory rejects deprecated rule", async () => {
    const [op] = await ethers.getSigners();
    const R = await ethers.getContractFactory("RuleRegistry");
    const reg = await R.deploy(op.address);
    const S = await ethers.getContractFactory("SimpleStrategy");
    const s = await S.deploy(350n, 0);
    const id = ethers.encodeBytes32String("dep-rule");
    await reg.register(id, await s.getAddress(), ethers.ZeroHash);
    await reg.deprecate(id);
    const F = await ethers.getContractFactory("DepositFactory");
    const fac = await F.deploy(await reg.getAddress());
    const M = await ethers.getContractFactory("MockERC20");
    const m = await M.deploy("USDC", "USDC", 6);
    await expect(
      fac.deploy(id, await m.getAddress(), op.address, false, 0, ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(fac, "RuleDeprecated");
  });
});

describe("Custom errors: deposit access control", function () {
  it("InterestBearingDeposit rejects non-customer deposit/withdraw", async () => {
    const [customer, intruder] = await ethers.getSigners();
    const R = await ethers.getContractFactory("RuleRegistry");
    const reg = await R.deploy(customer.address);
    const S = await ethers.getContractFactory("SimpleStrategy");
    const s = await S.deploy(350n, 0);
    const id = ethers.encodeBytes32String("simp");
    await reg.register(id, await s.getAddress(), ethers.ZeroHash);
    const F = await ethers.getContractFactory("DepositFactory");
    const fac = await F.deploy(await reg.getAddress());
    const M = await ethers.getContractFactory("MockERC20");
    const m = await M.deploy("USDC", "USDC", 6);
    const tx = await fac.deploy(id, await m.getAddress(), customer.address, false, 0, ethers.ZeroAddress);
    const rcpt = await tx.wait();
    const log = rcpt!.logs.find((l: any) => {
      try {
        return fac.interface.parseLog(l)?.name === "DepositDeployed";
      } catch {
        return false;
      }
    });
    const depositAddr = fac.interface.parseLog(log!)!.args.deposit;
    const dep = await ethers.getContractAt("InterestBearingDeposit", depositAddr);
    await expect(dep.connect(intruder).deposit(100n)).to.be.revertedWithCustomError(dep, "NotCustomer");
    await expect(dep.connect(intruder).withdraw(100n)).to.be.revertedWithCustomError(dep, "NotCustomer");
  });
});
