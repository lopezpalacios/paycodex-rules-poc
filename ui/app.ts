// Browser entry. Loads release.wasm, fetches selected rule JSON, runs preview on click.
// With MetaMask connected: also queries the on-chain strategy at the deployed address
// and shows parity (WASM vs Solidity), and can deploy a new InterestBearingDeposit.

import { BrowserProvider, Contract, ethers, type Signer } from "ethers";

const BASIS: Record<string, number> = { "act/360": 0, "act/365": 1, "30/360": 2, "act/act-isda": 3 };

const NETWORK_BY_CHAINID: Record<string, string> = {
  "0x7a69": "hardhat",   // 31337
  "0x539": "besu",       // 1337
};

const STRATEGY_ABI = [
  "function previewAccrual(uint256 balance, uint64 fromTs, uint64 toTs) view returns (uint256)",
  "function kind() view returns (string)",
  "function dayCount() view returns (string)",
];

const REGISTRY_ABI = [
  "function get(bytes32 ruleId) view returns (tuple(address strategy, string kind, string dayCount, bytes32 ruleHash, uint64 registeredAt, bool deprecated))",
  "function count() view returns (uint256)",
  "function ruleIds(uint256) view returns (bytes32)",
];

const FACTORY_ABI = [
  "function deploy(bytes32 ruleId, address asset, address customer, bool whtEnabled, uint256 whtBps) returns (address)",
  "event DepositDeployed(bytes32 indexed ruleId, address indexed customer, address indexed deposit, address strategy)",
];

let wasm: any;
let provider: BrowserProvider | null = null;
let signer: Signer | null = null;
let deployments: Record<string, string> = {};
let networkName = "?";

const BACKEND_URL = (import.meta as any).env?.VITE_BACKEND_URL ?? "http://127.0.0.1:3001";

function currentMode(): "backend" | "wallet" {
  return ((document.getElementById("mode") as HTMLSelectElement)?.value as any) ?? "backend";
}

// === WASM loading ===

async function loadWasm() {
  const res = await fetch("../wasm/build/release.wasm");
  const bytes = await res.arrayBuffer();
  const mod = await WebAssembly.instantiate(bytes, {
    env: {
      abort(_msg: number, _file: number, line: number, col: number) {
        throw new Error(`abort at ${line}:${col}`);
      },
    },
  });
  wasm = (mod.instance as WebAssembly.Instance).exports as any;
}

async function loadRuleFile(filename: string) {
  const res = await fetch(`../rules/examples/${filename}`);
  return await res.json();
}

function ruleIdToBytes32(id: string): string {
  return ethers.encodeBytes32String(id.slice(0, 31));
}

// === Preview dispatch (mirror of test/03-parity.test.ts logic) ===

function previewWasm(rule: any, balance: bigint, fromTs: bigint, toTs: bigint, oracle = 0n, kpi = 0n) {
  const basis = BASIS[rule.dayCount];
  let gross = 0n;
  let ecr: bigint | null = null;

  switch (rule.kind) {
    case "simple":
      gross = wasm.previewSimple(balance, rule.ratePolicy.fixedBps, basis, fromTs, toTs);
      break;
    case "compound":
      gross = wasm.previewCompound(balance, rule.ratePolicy.fixedBps, basis, fromTs, toTs);
      break;
    case "tiered": {
      // JS-side slice (mirrors test/03-parity.test.ts)
      const tiers = rule.ratePolicy.tiers;
      let prev = 0n;
      let sum = 0n;
      for (const t of tiers) {
        const upTo = t.upTo === "max" ? 0xffffffffffffffffn : BigInt(t.upTo);
        if (balance <= prev) break;
        const sliceTop = balance < upTo ? balance : upTo;
        const slice = sliceTop - prev;
        sum += wasm.previewSimple(slice, t.bps, basis, fromTs, toTs);
        prev = upTo;
        if (balance <= upTo) break;
      }
      gross = sum;
      break;
    }
    case "floating": {
      const hasFloor = rule.floorBps !== undefined;
      const hasCap = rule.capBps !== undefined;
      gross = wasm.previewFloating(
        balance,
        Number(oracle),
        rule.ratePolicy.spreadBps,
        rule.floorBps ?? 0,
        rule.capBps ?? 0,
        hasFloor,
        hasCap,
        basis,
        fromTs,
        toTs,
      );
      break;
    }
    case "kpi-linked": {
      const [minD, maxD] = rule.ratePolicy.adjustmentRangeBps;
      gross = wasm.previewKpi(
        balance,
        rule.ratePolicy.baseSpreadBps,
        Number(kpi),
        minD,
        maxD,
        basis,
        fromTs,
        toTs,
      );
      break;
    }
    case "step-up": {
      // Iterate the schedule and call previewSimple per segment (matches StepUpStrategy.previewAccrual)
      const steps = rule.ratePolicy.schedule as Array<{ atTimestamp: number; bps: number }>;
      let sum = 0n;
      for (let i = 0; i < steps.length; i++) {
        const stepStart = BigInt(steps[i].atTimestamp);
        const stepEnd = i + 1 < steps.length ? BigInt(steps[i + 1].atTimestamp) : 0xffffffffffffffffn;
        const subFrom = fromTs > stepStart ? fromTs : stepStart;
        const subTo = toTs < stepEnd ? toTs : stepEnd;
        if (subFrom >= subTo) continue;
        sum += wasm.previewSimple(balance, steps[i].bps, basis, subFrom, subTo);
      }
      gross = sum;
      break;
    }
    case "two-track": {
      const hardBps = Math.round((rule.twoTrack.hardInterestPortion ?? 0) * 10_000);
      const ecrBps = Math.round((rule.twoTrack.ecrPortion ?? 0) * 10_000);
      const reserveBps = rule.twoTrack.reserveRequirementBps ?? 0;
      gross = wasm.previewTwoTrackHard(balance, rule.ratePolicy.fixedBps, hardBps, basis, fromTs, toTs);
      ecr = wasm.previewEcr(balance, rule.ratePolicy.fixedBps, ecrBps, reserveBps, basis, fromTs, toTs);
      break;
    }
  }

  let net = gross;
  if (rule.withholding && rule.withholding.enabled) {
    net = wasm.applyWithholding(gross, rule.withholding.rateBps);
  }
  return { gross, net, ecr };
}

// === Connect (mode-aware) ===

async function connect() {
  const banner = document.getElementById("wallet-banner")!;
  const statusEl = document.getElementById("wallet-status")!;
  banner.className = "";
  if (currentMode() === "backend") {
    try {
      const res = await fetch(`${BACKEND_URL}/api/health`);
      const j = await res.json();
      if (!j.ok) throw new Error(j.error ?? "backend not reachable");
      networkName = j.network;
      banner.classList.add("connected");
      statusEl.textContent = `Backend OK: issuer=${j.accounts[0].slice(0, 8)}…${j.accounts[0].slice(-4)}, network=${j.network}, block=${j.blockNumber}`;
      const dres = await fetch(`${BACKEND_URL}/api/deployments`);
      const dj = await dres.json();
      deployments = dj.deployments;
      renderDeployments();
      enableChainButtons();
    } catch (e: any) {
      banner.classList.add("error");
      statusEl.textContent = `Backend connect failed: ${e.message}. Start with: npm run server`;
    }
    return;
  }
  // wallet mode
  const eth = (window as any).ethereum;
  if (!eth) {
    banner.classList.add("error");
    statusEl.textContent = "No window.ethereum — install MetaMask or switch to Backend mode.";
    return;
  }
  try {
    provider = new BrowserProvider(eth);
    await eth.request({ method: "eth_requestAccounts" });
    signer = await provider.getSigner();
    const addr = await signer.getAddress();
    const cid: string = await eth.request({ method: "eth_chainId" });
    networkName = NETWORK_BY_CHAINID[cid] ?? "?";
    banner.classList.add("connected");
    statusEl.textContent = `Wallet: ${addr.slice(0, 8)}…${addr.slice(-4)} on chainId=${parseInt(cid, 16)} (${networkName})`;
    await loadDeploymentsFromFile();
    enableChainButtons();
  } catch (e: any) {
    banner.classList.add("error");
    statusEl.textContent = `Wallet connect failed: ${e.message}`;
  }
}

async function loadDeploymentsFromFile() {
  try {
    const res = await fetch(`../.deployments/${networkName}.json`);
    if (!res.ok) {
      document.getElementById("deployments")!.textContent =
        `No .deployments/${networkName}.json — run \`npm run deploy:all --network ${networkName}\` first.`;
      return;
    }
    deployments = await res.json();
    renderDeployments();
  } catch (e: any) {
    document.getElementById("deployments")!.textContent = `Error: ${e.message}`;
  }
}

function renderDeployments() {
  const lines = Object.entries(deployments).map(([k, v]) => `  ${k.padEnd(40)} ${v}`);
  document.getElementById("deployments")!.textContent = `network: ${networkName}\n${lines.join("\n")}`;
}

function enableChainButtons() {
  const ok = Object.keys(deployments).length > 0 && (currentMode() === "backend" || signer !== null);
  (document.getElementById("compare") as HTMLButtonElement).disabled = !ok;
  (document.getElementById("deploy") as HTMLButtonElement).disabled = !ok;
  (document.getElementById("deploy-pool") as HTMLButtonElement).disabled = !ok;
}

// === Compare WASM vs on-chain ===

async function compareWithChain() {
  const out = document.getElementById("output") as HTMLDivElement;
  try {
    const ta = document.getElementById("ruleJson") as HTMLTextAreaElement;
    const rule = JSON.parse(ta.value);
    const balance = BigInt((document.getElementById("balance") as HTMLInputElement).value);
    const days = BigInt((document.getElementById("days") as HTMLInputElement).value);
    const oracle = BigInt((document.getElementById("oracle") as HTMLInputElement).value);
    const kpi = BigInt((document.getElementById("kpi") as HTMLInputElement).value);
    const fromTs = 1_700_000_000n;
    const toTs = fromTs + days * 86400n;

    let onChainGross: bigint;
    let stratAddr: string;
    if (currentMode() === "backend") {
      const r = await fetch(`${BACKEND_URL}/api/preview-onchain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleId: rule.ruleId, balance: balance.toString(), fromTs: fromTs.toString(), toTs: toTs.toString() }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      stratAddr = j.strategy;
      onChainGross = BigInt(j.gross);
    } else {
      if (!signer) { out.textContent = "wallet not connected."; return; }
      stratAddr = deployments[`Strategy_${rule.ruleId}`];
      if (!stratAddr) {
        out.textContent = `No deployed strategy for ruleId ${rule.ruleId}.`;
        return;
      }
      const strat = new Contract(stratAddr, STRATEGY_ABI, signer);
      onChainGross = await strat.previewAccrual(balance, fromTs, toTs);
    }

    const wasmRes = previewWasm(rule, balance, fromTs, toTs, oracle, kpi);
    const diff = wasmRes.gross > onChainGross ? wasmRes.gross - onChainGross : onChainGross - wasmRes.gross;
    const tolerance = rule.kind === "compound" ? wasmRes.gross / 1000n : wasmRes.gross / 10000n;
    const pass = diff <= (tolerance > 0n ? tolerance : 1n);

    const lines = [
      `rule:           ${rule.ruleId}`,
      `kind:           ${rule.kind}`,
      `mode:           ${currentMode()}`,
      `network:        ${networkName}`,
      `strategy:       ${stratAddr}`,
      `balance:        ${balance}`,
      `period:         ${days} days`,
      ``,
      `WASM gross:     ${wasmRes.gross}`,
      `Solidity gross: ${onChainGross}`,
      `abs diff:       ${diff}   (tolerance ${tolerance})`,
      `parity:         ${pass ? "✔ PASS" : "✗ FAIL"}`,
    ];
    if (wasmRes.ecr !== null) lines.push(`WASM ecr:       ${wasmRes.ecr}`);
    out.textContent = lines.join("\n");
  } catch (e: any) {
    out.textContent = `error: ${e.message}`;
  }
}

// === Deploy a new InterestBearingDeposit via factory ===

async function deployDeposit() {
  const out = document.getElementById("output") as HTMLDivElement;
  try {
    const ta = document.getElementById("ruleJson") as HTMLTextAreaElement;
    const rule = JSON.parse(ta.value);
    const whtEnabled = !!rule.withholding?.enabled;
    const whtBps = rule.withholding?.rateBps ?? 0;

    if (currentMode() === "backend") {
      out.textContent = "submitting deploy via backend (Web3signer signs)…";
      const r = await fetch(`${BACKEND_URL}/api/deploy-deposit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleId: rule.ruleId, whtEnabled, whtBps }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      out.textContent = `deposit deployed at ${j.deposit}\nissuer: ${j.issuer}\ncustomer: ${j.customer}\ntx: ${j.txHash}\ngas: ${j.gasUsed}\nblock: ${j.blockNumber}\n(signed by Web3signer — no wallet involved)`;
      return;
    }

    if (!signer) { out.textContent = "wallet not connected."; return; }
    const factoryAddr = deployments["DepositFactory"];
    const usdcAddr = deployments["MockUSDC"];
    if (!factoryAddr || !usdcAddr) {
      out.textContent = "DepositFactory or MockUSDC missing.";
      return;
    }
    const factory = new Contract(factoryAddr, FACTORY_ABI, signer);
    const ruleIdB32 = ruleIdToBytes32(rule.ruleId);
    const customer = await signer.getAddress();
    out.textContent = "submitting deploy tx — confirm in MetaMask…";
    const tx = await factory.deploy(ruleIdB32, usdcAddr, customer, whtEnabled, whtBps);
    const rcpt = await tx.wait();
    let depositAddr = "?";
    for (const log of rcpt!.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed?.name === "DepositDeployed") {
          depositAddr = parsed.args.deposit;
          break;
        }
      } catch {}
    }
    out.textContent = `deposit deployed at ${depositAddr}\ntx: ${tx.hash}\ngas used: ${rcpt!.gasUsed}\nblock: ${rcpt!.blockNumber}`;
  } catch (e: any) {
    out.textContent = `error: ${e.message}`;
  }
}

// === Deploy a new InterestBearingPool (Pattern B, multi-holder) ===

async function deployPool() {
  const out = document.getElementById("output") as HTMLDivElement;
  try {
    const ta = document.getElementById("ruleJson") as HTMLTextAreaElement;
    const rule = JSON.parse(ta.value);

    if (currentMode() === "backend") {
      out.textContent = "submitting deploy-pool via backend (Web3signer signs)…";
      const r = await fetch(`${BACKEND_URL}/api/deploy-pool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleId: rule.ruleId }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      out.textContent = `pool deployed at ${j.pool}\nissuer: ${j.issuer}\ntx: ${j.txHash}\ngas: ${j.gasUsed}\nblock: ${j.blockNumber}\n(Aave-style index, multi-holder; signed by Web3signer)`;
      return;
    }

    out.textContent = "Deploy-pool from MetaMask not yet implemented in UI; use Backend mode or `npx hardhat deploy:pool`.";
  } catch (e: any) {
    out.textContent = `error: ${e.message}`;
  }
}

// === Init ===

async function init() {
  await loadWasm();
  const sel = document.getElementById("rule") as HTMLSelectElement;
  const ta = document.getElementById("ruleJson") as HTMLTextAreaElement;
  const refresh = async () => {
    const rule = await loadRuleFile(sel.value);
    ta.value = JSON.stringify(rule, null, 2);
  };
  sel.addEventListener("change", refresh);
  await refresh();

  document.getElementById("connect-wallet")!.addEventListener("click", connect);
  document.getElementById("compare")!.addEventListener("click", compareWithChain);
  document.getElementById("deploy")!.addEventListener("click", deployDeposit);
  document.getElementById("deploy-pool")!.addEventListener("click", deployPool);

  document.getElementById("run")!.addEventListener("click", () => {
    try {
      const rule = JSON.parse(ta.value);
      const balance = BigInt((document.getElementById("balance") as HTMLInputElement).value);
      const days = BigInt((document.getElementById("days") as HTMLInputElement).value);
      const oracle = BigInt((document.getElementById("oracle") as HTMLInputElement).value);
      const kpi = BigInt((document.getElementById("kpi") as HTMLInputElement).value);
      const fromTs = 1_700_000_000n;
      const toTs = fromTs + days * 86400n;
      const r = previewWasm(rule, balance, fromTs, toTs, oracle, kpi);
      const lines = [
        `rule:    ${rule.ruleId}`,
        `kind:    ${rule.kind}`,
        `period:  ${days} days  (${rule.dayCount})`,
        `balance: ${balance}`,
        `gross:   ${r.gross}`,
        `net:     ${r.net}` + (rule.withholding?.enabled ? `   (after ${rule.withholding.rateBps}bps WHT, ${rule.withholding.regime})` : ""),
      ];
      if (r.ecr !== null) lines.push(`ecr:     ${r.ecr}   (fee offset, not capitalised)`);
      const out = document.getElementById("output") as HTMLDivElement;
      out.textContent = lines.join("\n");
    } catch (e: any) {
      const out = document.getElementById("output") as HTMLDivElement;
      out.textContent = "error: " + e.message;
    }
  });
}

init().catch((e) => console.error(e));
