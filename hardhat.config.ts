import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-gas-reporter";
import "./tasks";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
    besu: {
      url: process.env.BESU_RPC ?? "http://127.0.0.1:8545",
      chainId: 1337,
      // Generator-produced validator key (besu/key); funded in genesis alloc.
      // To regenerate: see besu/README.md.
      accounts: [
        "0xcfb783f7e27a219c60aea627810ab4d3dd8352539f45c75d3eda3c9e4a401e1d",
      ],
      // Besu enforces a minimum even when --min-gas-price=0 if EIP-1559 baseFee > 0.
      // Use 1 gwei type-0 (legacy) transactions to keep cost trivial but above floor.
      gasPrice: 1_000_000_000,
    },
    "besu-signer": {
      // Routes JSON-RPC through Web3signer (which signs eth_sendTransaction
      // using the keys it has loaded, then forwards to Besu). NO accounts here —
      // Hardhat queries the node for accounts; Web3signer reports its loaded keys.
      url: process.env.WEB3SIGNER_RPC ?? "http://127.0.0.1:9000",
      chainId: 1337,
      gasPrice: 1_000_000_000,
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    excludeContracts: ["MockERC20", "MockRateOracle", "MockKpiOracle"],
  },
  mocha: { timeout: 120000 },
};

export default config;
