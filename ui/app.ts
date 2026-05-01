// Browser entry. Loads release.wasm, fetches selected rule JSON, runs preview on click.
// To deploy on-chain: see README — uses Hardhat scripts/deploy.ts (browser deploy via MetaMask is intentionally
// out of scope for this PoC; preview parity with Solidity is the demo target).

const BASIS: Record<string, number> = { "act/360": 0, "act/365": 1, "30/360": 2, "act/act-isda": 3 };

let wasm: any;

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

function preview(rule: any, balance: bigint, fromTs: bigint, toTs: bigint, oracle = 0n, kpi = 0n) {
  const basis = BASIS[rule.dayCount];
  let gross: bigint = 0n;
  let ecr: bigint | null = null;

  switch (rule.kind) {
    case "simple":
      gross = wasm.previewSimple(balance, rule.ratePolicy.fixedBps, basis, fromTs, toTs);
      break;
    case "compound":
      gross = wasm.previewCompound(balance, rule.ratePolicy.fixedBps, basis, fromTs, toTs);
      break;
    case "tiered": {
      const tiers = rule.ratePolicy.tiers;
      const upTos = tiers.map((t: any) => (t.upTo === "max" ? 0xffffffffffffffffn : BigInt(t.upTo)));
      const bps = tiers.map((t: any) => t.bps);
      const ut = wasm.__newArray(wasm.StaticArray_u64_ID, upTos);
      const bp = wasm.__newArray(wasm.StaticArray_u32_ID, bps);
      gross = wasm.previewTiered(balance, ut, bp, basis, fromTs, toTs);
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

  const btn = document.getElementById("run") as HTMLButtonElement;
  btn.addEventListener("click", () => {
    try {
      const rule = JSON.parse(ta.value);
      const balance = BigInt((document.getElementById("balance") as HTMLInputElement).value);
      const days = BigInt((document.getElementById("days") as HTMLInputElement).value);
      const oracle = BigInt((document.getElementById("oracle") as HTMLInputElement).value);
      const kpi = BigInt((document.getElementById("kpi") as HTMLInputElement).value);
      const fromTs = 1_700_000_000n;
      const toTs = fromTs + days * 86400n;
      const r = preview(rule, balance, fromTs, toTs, oracle, kpi);
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
