import { task } from "hardhat/config";

task("accounts", "List signer accounts (the keys hardhat-ethers can sign with on the current network)")
  .setAction(async (_args, hre) => {
    const signers = await hre.ethers.getSigners();
    console.log(`network: ${hre.network.name}`);
    for (const s of signers) {
      const addr = await s.getAddress();
      const bal = await hre.ethers.provider.getBalance(addr);
      console.log(`  ${addr}   ${bal} wei`);
    }
  });
