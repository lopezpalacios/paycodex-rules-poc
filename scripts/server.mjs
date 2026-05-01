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
//   PAYCODEX_RATE_LIMIT_MAX=5 \
//   PAYCODEX_RATE_LIMIT_WINDOW_MS=86400000 \
//   PAYCODEX_REQUIRE_INTENT=false \
//   NETWORK=besu-signer node scripts/server.mjs
//
// PAYCODEX_API_KEYS         — comma-separated `name:secret` pairs (key → role mapping)
// PAYCODEX_ADMIN_KEYS       — comma-separated names from the above that may use write endpoints
// PAYCODEX_BLOCKLIST        — path to JSON array of blocked addresses (default: data/sanctions/blocklist.json)
// PAYCODEX_RATE_LIMIT_MAX   — max deploy-deposit calls per customer per window (default: 5)
// PAYCODEX_RATE_LIMIT_WINDOW_MS — sliding window length in ms (default: 86400000 = 24h)
// PAYCODEX_REQUIRE_INTENT   — if "true", deploy-deposit MUST include EIP-712 signed customer intent (default: false)
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
const RATE_LIMIT_MAX = Number(process.env.PAYCODEX_RATE_LIMIT_MAX ?? 5);
const RATE_LIMIT_WINDOW_MS = Number(process.env.PAYCODEX_RATE_LIMIT_WINDOW_MS ?? 86_400_000);
const REQUIRE_INTENT = (process.env.PAYCODEX_REQUIRE_INTENT ?? "false").toLowerCase() === "true";

const EIP712_DOMAIN = {
  name: "paycodex-rules-poc",
  version: "1",
  chainId: 1337,
};

const EIP712_TYPES = {
  DepositIntent: [
    { name: "ruleId",     type: "string"  },
    { name: "customer",   type: "address" },
    { name: "whtEnabled", type: "bool"    },
    { name: "whtBps",     type: "uint256" },
    { name: "nonce",      type: "uint256" },
    { name: "expiry",     type: "uint256" },
  ],
};

const FACTORY_ABI = [
  "function deploy(bytes32 ruleId, address asset, address customer, bool whtEnabled, uint256 whtBps, address taxCollector) returns (address)",
  "event DepositDeployed(bytes32 indexed ruleId, address indexed customer, address indexed deposit, address strategy)",
];

const POOL_FACTORY_ABI = [
  "function deploy(bytes32 ruleId, address asset) returns (address)",
  "event PoolDeployed(bytes32 indexed ruleId, address indexed pool, address strategy)",
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

// === Per-customer rate limiting (in-memory; production swap: Redis) ===

const customerHits = new Map();   // lowercase address → bigint[] of timestamps (ms)

function checkRateLimit(customer) {
  const key = String(customer).toLowerCase();
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const prior = customerHits.get(key) ?? [];
  const live = prior.filter((t) => t > cutoff);
  if (live.length >= RATE_LIMIT_MAX) {
    const oldest = Math.min(...live);
    return { ok: false, retryAfterSec: Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000), seen: live.length };
  }
  live.push(now);
  customerHits.set(key, live);
  return { ok: true, seen: live.length };
}

// === EIP-712 signed customer intent ===
//
// Customer signs `DepositIntent` off-chain with their banking-app key. Backend
// verifies the signature recovers `intent.customer`, checks expiry + nonce
// uniqueness, then submits factory.deploy on the customer's behalf.
//
// Helper to produce a signature: `node scripts/sign-intent.mjs --help`.

const seenNonces = new Map();   // customer (lowercase) → Set<nonce>

function verifyIntent(intent, signature) {
  if (!intent || !signature) throw new Error("intent + signature required");
  const required = ["ruleId", "customer", "whtEnabled", "whtBps", "nonce", "expiry"];
  for (const f of required) {
    if (intent[f] === undefined) throw new Error(`intent.${f} missing`);
  }
  const now = Math.floor(Date.now() / 1000);
  if (Number(intent.expiry) <= now) throw new Error(`intent expired (expiry=${intent.expiry}, now=${now})`);

  const recovered = ethers.verifyTypedData(EIP712_DOMAIN, EIP712_TYPES, intent, signature);
  if (recovered.toLowerCase() !== String(intent.customer).toLowerCase()) {
    throw new Error(`signature mismatch: recovered=${recovered} intent.customer=${intent.customer}`);
  }

  const ckey = String(intent.customer).toLowerCase();
  const seen = seenNonces.get(ckey) ?? new Set();
  if (seen.has(String(intent.nonce))) throw new Error(`nonce ${intent.nonce} already used by ${intent.customer}`);
  seen.add(String(intent.nonce));
  seenNonces.set(ckey, seen);
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
    const { ruleId, customer, whtEnabled, whtBps, intent, signature } = req.body;
    if (!ruleId && !intent) return res.status(400).json({ error: "missing ruleId (or intent)" });

    // === Optional EIP-712 intent verification ===
    let resolvedRuleId = ruleId;
    let resolvedCustomer = customer;
    let resolvedWht = !!whtEnabled;
    let resolvedWhtBps = Number(whtBps ?? 0);
    if (intent || REQUIRE_INTENT) {
      if (!intent || !signature) {
        return res.status(400).json({ error: "PAYCODEX_REQUIRE_INTENT enabled or partial intent: both `intent` and `signature` required" });
      }
      try {
        verifyIntent(intent, signature);
      } catch (e) {
        console.warn(`[server] INTENT REJECTED: ${e.message}`);
        return res.status(401).json({ error: `intent rejected: ${e.message}` });
      }
      resolvedRuleId = intent.ruleId;
      resolvedCustomer = intent.customer;
      resolvedWht = !!intent.whtEnabled;
      resolvedWhtBps = Number(intent.whtBps);
    }

    const deps = loadDeployments();
    if (!deps.DepositFactory || !deps.MockUSDC) {
      return res.status(500).json({ error: "DepositFactory or MockUSDC missing in deployments" });
    }
    const signer = await getSigner();
    const issuerAddr = await signer.getAddress();
    const targetCustomer = resolvedCustomer ?? issuerAddr;

    // Sanctions screen
    if (BLOCKLIST.has(String(targetCustomer).toLowerCase())) {
      console.warn(`[server] BLOCKED deploy-deposit for sanctioned customer ${targetCustomer} (auth=${req.apiKeyName ?? "disabled"})`);
      return res.status(451).json({ error: `customer address blocked: ${targetCustomer}` });
    }

    // Rate limit (per customer)
    const rl = checkRateLimit(targetCustomer);
    if (!rl.ok) {
      console.warn(`[server] RATE-LIMITED ${targetCustomer}: ${rl.seen} hits in window, retry after ${rl.retryAfterSec}s`);
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      return res.status(429).json({
        error: `rate limit exceeded for customer ${targetCustomer}`,
        max: RATE_LIMIT_MAX,
        windowMs: RATE_LIMIT_WINDOW_MS,
        retryAfterSec: rl.retryAfterSec,
      });
    }

    const factory = new Contract(deps.DepositFactory, FACTORY_ABI, signer);
    const collector = resolvedWht ? (deps.TaxCollector ?? ethers.ZeroAddress) : ethers.ZeroAddress;
    const tx = await factory.deploy(
      ruleIdToBytes32(resolvedRuleId),
      deps.MockUSDC,
      targetCustomer,
      resolvedWht,
      resolvedWhtBps,
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
      viaSignedIntent: !!intent,
      rateLimitSeen: rl.seen,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pattern B: deploy a pooled (Aave-style index) instance instead of a single-holder deposit.
// Same auth / sanctions / rate-limit pipeline as deploy-deposit. Customer field is informational
// here — pools are multi-holder, so the rate-limit key is the deployer (issuer) for now.
app.post("/api/deploy-pool", requireAuth("admin"), async (req, res) => {
  try {
    const { ruleId } = req.body;
    if (!ruleId) return res.status(400).json({ error: "missing ruleId" });
    const deps = loadDeployments();
    if (!deps.PoolFactory || !deps.MockUSDC) {
      return res.status(500).json({ error: "PoolFactory or MockUSDC missing — run `npx hardhat deploy:pool --rule …` once first" });
    }
    if (!deps[`Strategy_${ruleId}`]) {
      return res.status(404).json({ error: `Strategy_${ruleId} not registered — deploy:rule first` });
    }
    const signer = await getSigner();
    const issuerAddr = await signer.getAddress();

    // Sanctions screen on the issuer (sanctioned operator → 451)
    if (BLOCKLIST.has(String(issuerAddr).toLowerCase())) {
      console.warn(`[server] BLOCKED deploy-pool: issuer ${issuerAddr} is sanctioned`);
      return res.status(451).json({ error: `issuer address blocked: ${issuerAddr}` });
    }

    // Rate-limit on the issuer for pool deployments (pools are infrequent ops)
    const rl = checkRateLimit(issuerAddr);
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      return res.status(429).json({
        error: `rate limit exceeded for issuer ${issuerAddr}`,
        max: RATE_LIMIT_MAX,
        windowMs: RATE_LIMIT_WINDOW_MS,
        retryAfterSec: rl.retryAfterSec,
      });
    }

    const factory = new Contract(deps.PoolFactory, POOL_FACTORY_ABI, signer);
    const tx = await factory.deploy(ruleIdToBytes32(ruleId), deps.MockUSDC, {
      gasPrice: 1_000_000_000n,
      type: 0,
    });
    const rcpt = await tx.wait();
    let poolAddr = null;
    for (const log of rcpt.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed?.name === "PoolDeployed") {
          poolAddr = parsed.args.pool;
          break;
        }
      } catch {}
    }
    res.json({
      ok: true,
      issuer: issuerAddr,
      txHash: tx.hash,
      blockNumber: rcpt.blockNumber,
      gasUsed: rcpt.gasUsed.toString(),
      pool: poolAddr,
      authedAs: req.apiKeyName ?? null,
      rateLimitSeen: rl.seen,
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

// Admin-only: introspect the rate-limit state for a specific customer
app.get("/api/admin/rate-limit/:customer", requireAuth("admin"), (req, res) => {
  const key = String(req.params.customer).toLowerCase();
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const live = (customerHits.get(key) ?? []).filter((t) => t > cutoff);
  res.json({
    customer: req.params.customer,
    seen: live.length,
    max: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
    remaining: Math.max(0, RATE_LIMIT_MAX - live.length),
  });
});

// Admin-only: serve the EIP-712 domain + types so clients can sign without hard-coding
app.get("/api/intent-schema", requireAuth("any"), (_req, res) => {
  res.json({ domain: EIP712_DOMAIN, types: EIP712_TYPES });
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
  console.log(`[server] rate limit: ${RATE_LIMIT_MAX} deploys per customer per ${Math.round(RATE_LIMIT_WINDOW_MS/3600000)}h sliding window`);
  console.log(`[server] customer-intent: ${REQUIRE_INTENT ? "REQUIRED (EIP-712 signature)" : "optional"}`);
  console.log(`[server] endpoints:`);
  console.log(`  GET  /api/health                       (no auth)`);
  console.log(`  GET  /api/deployments                  (any auth)`);
  console.log(`  GET  /api/intent-schema                (any auth)`);
  console.log(`  POST /api/preview-onchain              (any auth)`);
  console.log(`  POST /api/deploy-deposit               (admin auth + sanctions + rate-limit + optional EIP-712 intent)`);
  console.log(`  POST /api/deploy-pool                  (admin auth + sanctions + rate-limit, Pattern B pool)`);
  console.log(`  POST /api/admin/reload-blocklist       (admin auth)`);
  console.log(`  GET  /api/admin/rate-limit/:customer   (admin auth)`);
});
