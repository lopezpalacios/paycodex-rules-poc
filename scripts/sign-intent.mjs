#!/usr/bin/env node
// CLI helper: produce an EIP-712 signed DepositIntent for POSTing to /api/deploy-deposit.
// The customer signs locally; the backend verifies the signature recovers intent.customer.
//
// Usage:
//   node scripts/sign-intent.mjs \
//     --privkey 0xac0974be... \
//     --rule simple-act360-eur-350 \
//     [--wht-enabled] \
//     [--wht-bps 3500] \
//     [--expiry-seconds 3600]
//
// Default privkey: hardhat default account #0 (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 / 0xac0974be...).

import { ethers } from "ethers";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const privkey = arg("privkey", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const ruleId = arg("rule");
if (!ruleId) {
  console.error("missing --rule <ruleId>");
  process.exit(1);
}
const whtEnabled = flag("wht-enabled");
const whtBps = Number(arg("wht-bps", "0"));
const expirySeconds = Number(arg("expiry-seconds", "3600"));

const wallet = new ethers.Wallet(privkey);
const expiry = Math.floor(Date.now() / 1000) + expirySeconds;
const nonce = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

const domain = { name: "paycodex-rules-poc", version: "1", chainId: 1337 };
const types = {
  DepositIntent: [
    { name: "ruleId",     type: "string"  },
    { name: "customer",   type: "address" },
    { name: "whtEnabled", type: "bool"    },
    { name: "whtBps",     type: "uint256" },
    { name: "nonce",      type: "uint256" },
    { name: "expiry",     type: "uint256" },
  ],
};
const intent = {
  ruleId,
  customer: wallet.address,
  whtEnabled,
  whtBps,
  nonce: nonce.toString(),
  expiry: expiry.toString(),
};

const signature = await wallet.signTypedData(domain, types, intent);

const body = {
  intent: {
    ...intent,
    nonce: intent.nonce,
    expiry: intent.expiry,
  },
  signature,
};

console.log(JSON.stringify(body, null, 2));
console.error(`[sign-intent] signer=${wallet.address}  ruleId=${ruleId}  nonce=${intent.nonce}  expiry=${expiry}`);
console.error("");
console.error("POST it:");
console.error("  curl -X POST http://127.0.0.1:3001/api/deploy-deposit \\");
console.error("    -H 'Content-Type: application/json' \\");
console.error("    -H 'Authorization: Bearer <admin-key>' \\");
console.error("    --data @- <<EOF");
console.error(JSON.stringify(body, null, 2));
console.error("EOF");
