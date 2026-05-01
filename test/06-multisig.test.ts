import { expect } from "chai";
import { ethers } from "hardhat";

describe("OperatorMultisig", function () {
  async function deploy(threshold: number, ownerCount = 3) {
    const signers = await ethers.getSigners();
    const owners = signers.slice(0, ownerCount).map((s) => s.address);
    const F = await ethers.getContractFactory("OperatorMultisig");
    const multi = await F.deploy(owners, threshold);
    await multi.waitForDeployment();
    return { multi, owners, signers };
  }

  it("constructor enforces invariants", async () => {
    const F = await ethers.getContractFactory("OperatorMultisig");
    await expect(F.deploy([], 1)).to.be.revertedWithCustomError(F, "BadConstructorArgs");
    const [a, b] = await ethers.getSigners();
    await expect(F.deploy([a.address, b.address], 0)).to.be.revertedWithCustomError(F, "BadConstructorArgs");
    await expect(F.deploy([a.address, b.address], 3)).to.be.revertedWithCustomError(F, "BadConstructorArgs");
    await expect(F.deploy([a.address, a.address], 1)).to.be.revertedWithCustomError(F, "BadConstructorArgs");
    await expect(F.deploy([ethers.ZeroAddress, a.address], 1)).to.be.revertedWithCustomError(F, "BadConstructorArgs");
  });

  it("non-owner cannot submit/approve/cancel", async () => {
    const { multi, signers } = await deploy(2);
    const intruder = signers[5];
    await expect(multi.connect(intruder).submit(ethers.ZeroAddress, "0x"))
      .to.be.revertedWithCustomError(multi, "NotOwner");
  });

  it("2-of-3 happy path: submit auto-approves, second approval executes", async () => {
    const { multi, signers } = await deploy(2);
    const Reg = await ethers.getContractFactory("RuleRegistry");
    const reg = await Reg.deploy(await multi.getAddress());

    const S = await ethers.getContractFactory("SimpleStrategy");
    const strat = await S.deploy(350, 0);

    const ruleId = ethers.encodeBytes32String("multi-rule");
    const data = reg.interface.encodeFunctionData("register", [ruleId, await strat.getAddress(), ethers.ZeroHash]);

    // Owner 0 submits → 1 approval (auto)
    const tx0 = await multi.connect(signers[0]).submit(await reg.getAddress(), data);
    const rcpt0 = await tx0.wait();
    const log = rcpt0!.logs.find((l: any) => {
      try { return multi.interface.parseLog(l)?.name === "ProposalSubmitted"; } catch { return false; }
    });
    const id = multi.interface.parseLog(log!)!.args.id;
    expect((await multi.getProposal(id)).approvals).to.equal(1);
    expect((await multi.getProposal(id)).executed).to.equal(false);

    // Registry should NOT have the rule yet
    await expect(reg.get(ruleId)).to.be.revertedWithCustomError(reg, "UnknownRule");

    // Owner 1 approves → threshold 2 reached, auto-executes
    await expect(multi.connect(signers[1]).approve(id))
      .to.emit(multi, "ProposalExecuted");
    expect((await multi.getProposal(id)).executed).to.equal(true);

    // Registry now has the rule
    const e = await reg.get(ruleId);
    expect(e.strategy).to.equal(await strat.getAddress());
  });

  it("rejects double-approve, post-execute approve, cancelled approve", async () => {
    const { multi, signers } = await deploy(2);
    const Reg = await ethers.getContractFactory("RuleRegistry");
    const reg = await Reg.deploy(await multi.getAddress());
    const data = reg.interface.encodeFunctionData("register", [ethers.encodeBytes32String("x"), signers[0].address, ethers.ZeroHash]);
    // signers[0] address isn't a strategy — registry will revert MissingIntrospection
    // but that's after approval-threshold, surfaced as ExecutionFailed
    const tx = await multi.connect(signers[0]).submit(await reg.getAddress(), data);
    const rcpt = await tx.wait();
    const id = multi.interface.parseLog(rcpt!.logs.find((l: any) => {
      try { return multi.interface.parseLog(l)?.name === "ProposalSubmitted"; } catch { return false; }
    })!)!.args.id;

    // Same owner cannot approve twice (already auto-approved by submit)
    await expect(multi.connect(signers[0]).approve(id)).to.be.revertedWithCustomError(multi, "AlreadyApproved");

    // Threshold-met execution will revert because the target call fails
    await expect(multi.connect(signers[1]).approve(id)).to.be.revertedWithCustomError(multi, "ExecutionFailed");

    // Submit a fresh, valid proposal and execute, then assert post-execute approval is rejected
    const S = await ethers.getContractFactory("SimpleStrategy");
    const strat = await S.deploy(350, 0);
    const validData = reg.interface.encodeFunctionData("register", [ethers.encodeBytes32String("ok"), await strat.getAddress(), ethers.ZeroHash]);
    const tx2 = await multi.connect(signers[0]).submit(await reg.getAddress(), validData);
    const rcpt2 = await tx2.wait();
    const id2 = multi.interface.parseLog(rcpt2!.logs.find((l: any) => {
      try { return multi.interface.parseLog(l)?.name === "ProposalSubmitted"; } catch { return false; }
    })!)!.args.id;
    await multi.connect(signers[1]).approve(id2); // executes
    await expect(multi.connect(signers[2]).approve(id2)).to.be.revertedWithCustomError(multi, "AlreadyExecuted");
  });

  it("cancellation prevents further approval / execution", async () => {
    const { multi, signers } = await deploy(2);
    const Reg = await ethers.getContractFactory("RuleRegistry");
    const reg = await Reg.deploy(await multi.getAddress());
    const S = await ethers.getContractFactory("SimpleStrategy");
    const strat = await S.deploy(350, 0);
    const data = reg.interface.encodeFunctionData("register", [ethers.encodeBytes32String("cnc"), await strat.getAddress(), ethers.ZeroHash]);
    const tx = await multi.connect(signers[0]).submit(await reg.getAddress(), data);
    const rcpt = await tx.wait();
    const id = multi.interface.parseLog(rcpt!.logs.find((l: any) => {
      try { return multi.interface.parseLog(l)?.name === "ProposalSubmitted"; } catch { return false; }
    })!)!.args.id;
    await multi.connect(signers[2]).cancel(id);
    await expect(multi.connect(signers[1]).approve(id)).to.be.revertedWithCustomError(multi, "AlreadyCancelled");
    await expect(multi.connect(signers[2]).cancel(id)).to.be.revertedWithCustomError(multi, "AlreadyCancelled");
  });

  it("3-of-3 requires every owner before execute", async () => {
    const { multi, signers } = await deploy(3);
    const Reg = await ethers.getContractFactory("RuleRegistry");
    const reg = await Reg.deploy(await multi.getAddress());
    const S = await ethers.getContractFactory("SimpleStrategy");
    const strat = await S.deploy(350, 0);
    const data = reg.interface.encodeFunctionData("register", [ethers.encodeBytes32String("3of3"), await strat.getAddress(), ethers.ZeroHash]);
    const tx = await multi.connect(signers[0]).submit(await reg.getAddress(), data);
    const rcpt = await tx.wait();
    const id = multi.interface.parseLog(rcpt!.logs.find((l: any) => {
      try { return multi.interface.parseLog(l)?.name === "ProposalSubmitted"; } catch { return false; }
    })!)!.args.id;
    await multi.connect(signers[1]).approve(id);
    expect((await multi.getProposal(id)).executed).to.equal(false);
    await multi.connect(signers[2]).approve(id);
    expect((await multi.getProposal(id)).executed).to.equal(true);
  });
});
