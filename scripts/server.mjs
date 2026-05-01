#!/usr/bin/env node
// Backend server for the wallet-less UI flow.
// - Reads the deployments file for the configured network
// - Exposes REST endpoints the browser POSTs to
// - Builds and submits transactions via Web3signer (which holds the issuer key)
// - Authenticates clients via API key (Bearer token) — admin role required to deploy
// - Screens the customer address against a sanctions blocklist before deploy
//
// Run:
//   PAYCODEX_API_KEYS='reader:read-secret,admin:admin-secret' \
//   PAYCODEX_ADMIN_KEYS='admin' \
//   NETWORK=besu-signer node scripts/server.mjs
//
// PAYCODEX_API_KEYS  — comma-separated `name:secret` pairs (any caller with one of these
//                      passes auth on read endpoints)
// PAYCODEX_ADMIN_KEYS — comma-separated names from the above that may use write endpoints
// PAYCODEX_BLOCKLIST  — path to JSON array of blocked addresses (default: data/sanctions/blocklist.json)
//
// If PAYCODEX_API_KEYS is empty, auth is disabled (dev mode). Logged loudly at startup.

import express from "express";
import { JsonRpcProvider, Contract, ethers } from "ethers";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.PORT ?? 3001);
const NETWORK = process.env.NETWORK ?? "besu";
const WEB3SIGNER_URL = process.env.WEB3SIGNER_URL ?? "http://127.0.0.1:9000";
const BLOCKLIST_PATH = process.env.PAYCODEX_BLOCKLIST ?? "data/sanctions/blocklist.json";

const FACTORY_ABI = [
  "function deploy(bytes32 ruleId, address asset, address customer, bool whtEnabled, uint256 whtBps, address taxCollector) returns (address)",
  "event DepositDeployed(bytes32 indexed ruleId, address indexed customer, address indexed deposit, address strategy)",
];

const STRATEGY_ABI = [
  "function previewAccrual(uint256 balance, uint64 fromTs, uint64 toTs) view returns (uint256)",
];

// === Auth setup ===

function parseKeys(raw) {
  if (!raw || !raw.trim()) return new Map();
  const m = new Map();
  for (const pair of raw.split(",")) {
    const [name, secret] = pair.split(":").map((s) => s?.trim());
    if (name && secret) m.set(secret, name);
  }
  return m;
}

const API_KEYS = parseKeys(process.env.PAYCODEX_API_KEYS);   // secret → name
const ADMIN_NAMES = new Set(
  (process.env.PAYCODEX_ADMIN_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);
const AUTH_DISABLED = API_KEYS.size === 0;

function extractKey(req) {
  const h = req.header("authorization") ?? req.header("Authorization") ?? "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  return null;
}

function requireAuth(role /* "any" | "admin" */) {
  return (req, res, next) => {
    if (AUTH_DISABLED) return next();
    const key = extractKey(req);
    if (!key) return res.status(401).json({ error: "missing Authorization: Bearer <key>" });
    const name = API_KEYS.get(key);
    if (!name) return res.status(403).json({ error: "invalid api key" });
    if (role === "admin" && !ADMIN_NAMES.has(name)) {
      return res.status(403).json({ error: `key '${name}' lacks admin role` });
    }
    req.apiKeyName = name;
    next();
  };
}

// === Sanctions blocklist ===

function loadBlocklist() {
  if (!existsSync(BLOCKLIST_PATH)) {
    console.warn(`[server] WARNING: blocklist ${BLOCKLIST_PATH} missing — sanctions screening DISABLED`);
    return new Set();
  }
  const arr = JSON.parse(readFileSync(BLOCKLIST_PATH, "utf-8"));
  return new Set(arr.map((a) => String(a).toLowerCase()));
}
let BLOCKLIST = loadBlocklist();

function reloadBlocklist() {
  BLOCKLIST = loadBlocklist();
  return BLOCKLIST.size;
}

// === Provider ===

function loadDeployments() {
  const p = resolve(`.deployments/${NETWORK}.json`);
  if (!existsSync(p)) {
    throw new Error(`no .deployments/${NETWORK}.json — run \`npx hardhat deploy:all --network ${NETWORK}\` first`);
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});
app.options("/{*any}", (_, res) => res.sendStatus(204));

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

// === Endpoints ===

// Liveness probe — ALWAYS unauthenticated so monitoring/k8s can hit it.
app.get("/api/health", async (_req, res) => {
  try {
    const accounts = await provider.send("eth_accounts", []);
    const block = await provider.getBlockNumber();
    res.json({
      ok: true,
      network: NETWORK,
      web3signer: WEB3SIGNER_URL,
      accounts,
      blockNumber: block,
      auth: AUTH_DISABLED ? "disabled" : "enabled",
      blocklistSize: BLOCKLIST.size,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/deployments", requireAuth("any"), (_req, res) => {
  try {
    res.json({ network: NETWORK, deployments: loadDeployments() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/preview-onchain", requireAuth("any"), async (req, res) => {
  try {
    const { ruleId, balance, fromTs, toTs } = req.body;
    if (!ruleId || balance === undefined) return res.status(400).json({ error: "missing ruleId or balance" });
    const deps = loadDeployments();
    const stratAddr = deps[`Strategy_${ruleId}`];
    if (!stratAddr) return res.status(404).json({ error: `no strategy for ruleId ${ruleId}` });
    const strat = new Contract(stratAddr, STRATEGY_ABI, provider);
    const gross = await strat.previewAccrual(
      BigInt(balance),
      BigInt(fromTs ?? 1700000000),
      BigInt(toTs ?? 1700000000n + 360n * 86400n),
    );
    res.json({ strategy: stratAddr, gross: gross.toString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/deploy-deposit", requireAuth("admin"), async (req, res) => {
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

    // Sanctions screen
    if (BLOCKLIST.has(String(targetCustomer).toLowerCase())) {
      console.warn(`[server] BLOCKED deploy-deposit for sanctioned customer ${targetCustomer} (auth=${req.apiKeyName ?? "disabled"})`);
      return res.status(451).json({ error: `customer address blocked: ${targetCustomer}` });
    }

    const factory = new Contract(deps.DepositFactory, FACTORY_ABI, signer);
    const collector = whtEnabled ? (deps.TaxCollector ?? ethers.ZeroAddress) : ethers.ZeroAddress;
    const tx = await factory.deploy(
      ruleIdToBytes32(ruleId),
      deps.MockUSDC,
      targetCustomer,
      !!whtEnabled,
      Number(whtBps ?? 0),
      collector,
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
      authedAs: req.apiKeyName ?? null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin-only: hot-reload the blocklist without restarting the server
app.post("/api/admin/reload-blocklist", requireAuth("admin"), (_req, res) => {
  const size = reloadBlocklist();
  res.json({ ok: true, blocklistSize: size });
});

app.listen(PORT, () => {
  console.log(`[server] paycodex-rules-poc backend on :${PORT}`);
  console.log(`[server] network=${NETWORK} web3signer=${WEB3SIGNER_URL}`);
  if (AUTH_DISABLED) {
    console.warn(`[server] WARNING: PAYCODEX_API_KEYS unset — auth is DISABLED. Do NOT use in any non-local environment.`);
  } else {
    console.log(`[server] auth: enabled, ${API_KEYS.size} key(s), admin roles: [${[...ADMIN_NAMES].join(", ")}]`);
  }
  console.log(`[server] sanctions blocklist: ${BLOCKLIST.size} address(es) loaded from ${BLOCKLIST_PATH}`);
  console.log(`[server] endpoints:`);
  console.log(`  GET  /api/health                       (no auth)`);
  console.log(`  GET  /api/deployments                  (any auth)`);
  console.log(`  POST /api/preview-onchain              (any auth)`);
  console.log(`  POST /api/deploy-deposit               (admin auth + sanctions screen)`);
  console.log(`  POST /api/admin/reload-blocklist       (admin auth)`);
});
