#!/usr/bin/env node
// Backend server for the wallet-less UI flow.
// - Reads the deployments file for the configured network
// - Exposes REST endpoints the browser POSTs to
// - Builds and submits transactions via Web3signer (which holds the issuer key)
//
// Run:  WEB3SIGNER_URL=http://127.0.0.1:9000 NETWORK=besu node scripts/server.mjs
//       (default: WEB3SIGNER_URL=http://127.0.0.1:9000 NETWORK=besu PORT=3001)

import express from "express";
import { JsonRpcProvider, Contract, ethers } from "ethers";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.PORT ?? 3001);
const NETWORK = process.env.NETWORK ?? "besu";
const WEB3SIGNER_URL = process.env.WEB3SIGNER_URL ?? "http://127.0.0.1:9000";

const FACTORY_ABI = [
  "function deploy(bytes32 ruleId, address asset, address customer, bool whtEnabled, uint256 whtBps) returns (address)",
  "event DepositDeployed(bytes32 indexed ruleId, address indexed customer, address indexed deposit, address strategy)",
];

const STRATEGY_ABI = [
  "function previewAccrual(uint256 balance, uint64 fromTs, uint64 toTs) view returns (uint256)",
];

function loadDeployments() {
  const p = resolve(`.deployments/${NETWORK}.json`);
  if (!existsSync(p)) {
    throw new Error(`no .deployments/${NETWORK}.json — run \`npm run deploy:all --network ${NETWORK}\` first`);
  }
  return JSON.parse(readFileSync(p, "utf-8"));
}

function ruleIdToBytes32(id) {
  return ethers.encodeBytes32String(id.slice(0, 31));
}

const app = express();
app.use(express.json());
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});
app.options("/{*any}", (_, res) => res.sendStatus(204));

// Web3signer presents itself as a JSON-RPC endpoint to ethers — its `eth_accounts`
// returns the keys it has loaded; `eth_sendTransaction` signs with the matching key
// and forwards to Besu (configured via --downstream-http-host/--downstream-http-port).
// The Browser doesn't need MetaMask; the backend submits on behalf of the issuer.
// Web3signer's eth1 JSON-RPC does not support batched requests. Disable ethers v6 batching.
const provider = new JsonRpcProvider(
  WEB3SIGNER_URL,
  { chainId: 1337, name: "besu-signer" },
  { batchMaxCount: 1, staticNetwork: true },
);

async function getSigner() {
  const accounts = await provider.send("eth_accounts", []);
  if (!accounts.length) throw new Error("Web3signer has no keys loaded");
  return await provider.getSigner(accounts[0]);
}

app.get("/api/health", async (_req, res) => {
  try {
    const accounts = await provider.send("eth_accounts", []);
    const block = await provider.getBlockNumber();
    res.json({ ok: true, network: NETWORK, web3signer: WEB3SIGNER_URL, accounts, blockNumber: block });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/deployments", (_req, res) => {
  try {
    res.json({ network: NETWORK, deployments: loadDeployments() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/preview-onchain", async (req, res) => {
  try {
    const { ruleId, balance, fromTs, toTs } = req.body;
    if (!ruleId || balance === undefined) return res.status(400).json({ error: "missing ruleId or balance" });
    const deps = loadDeployments();
    const stratAddr = deps[`Strategy_${ruleId}`];
    if (!stratAddr) return res.status(404).json({ error: `no strategy for ruleId ${ruleId}` });
    const strat = new Contract(stratAddr, STRATEGY_ABI, provider);
    const gross = await strat.previewAccrual(BigInt(balance), BigInt(fromTs ?? 1700000000), BigInt(toTs ?? 1700000000n + 360n * 86400n));
    res.json({ strategy: stratAddr, gross: gross.toString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/deploy-deposit", async (req, res) => {
  try {
    const { ruleId, customer, whtEnabled, whtBps } = req.body;
    if (!ruleId) return res.status(400).json({ error: "missing ruleId" });
    const deps = loadDeployments();
    if (!deps.DepositFactory || !deps.MockUSDC) {
      return res.status(500).json({ error: "DepositFactory or MockUSDC missing in deployments" });
    }
    const signer = await getSigner();
    const issuerAddr = await signer.getAddress();
    const targetCustomer = customer ?? issuerAddr;
    const factory = new Contract(deps.DepositFactory, FACTORY_ABI, signer);
    // Besu rejects gasPrice=0 under EIP-1559 baseFee>0; use 1 gwei legacy tx.
    const tx = await factory.deploy(
      ruleIdToBytes32(ruleId),
      deps.MockUSDC,
      targetCustomer,
      !!whtEnabled,
      Number(whtBps ?? 0),
      { gasPrice: 1_000_000_000n, type: 0 },
    );
    const rcpt = await tx.wait();
    let depositAddr = null;
    for (const log of rcpt.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed?.name === "DepositDeployed") {
          depositAddr = parsed.args.deposit;
          break;
        }
      } catch {}
    }
    res.json({
      ok: true,
      issuer: issuerAddr,
      customer: targetCustomer,
      txHash: tx.hash,
      blockNumber: rcpt.blockNumber,
      gasUsed: rcpt.gasUsed.toString(),
      deposit: depositAddr,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[server] paycodex-rules-poc backend on :${PORT}`);
  console.log(`[server] network=${NETWORK} web3signer=${WEB3SIGNER_URL}`);
  console.log(`[server] endpoints:`);
  console.log(`  GET  /api/health`);
  console.log(`  GET  /api/deployments`);
  console.log(`  POST /api/preview-onchain   { ruleId, balance, fromTs?, toTs? }`);
  console.log(`  POST /api/deploy-deposit    { ruleId, customer?, whtEnabled?, whtBps? }`);
});
