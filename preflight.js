#!/usr/bin/env node
/**
 * Validates settings.json against the chain before anything else runs.
 *
 *   node preflight.js
 *
 * Read-only. Checks that addresses are well-formed, that contracts actually
 * exist at them, that they are the contracts they claim to be, and that your
 * wallet owns positions there. Exits non-zero on any failure so it can gate a
 * scheduled run.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const PLACEHOLDERS = [
  "0x698C3A00000000000000000000000000002F48d8", // padded from a truncated UI display
  "0xREPLACE_WITH_YOUR_MAIN_WALLET",
];

// Mainnet defaults. Harmless on chain 1, wrong everywhere else.
const MAINNET_DEFAULTS = {
  positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
};

const NPM_ABI = [
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
];
const ROUTER_ABI = ["function factory() view returns (address)"];
const ERC20_ABI = ["function symbol() view returns (string)"];

let failures = 0;
let warnings = 0;

const ok = (m) => console.log("  ok    " + m);
const bad = (m) => { failures++; console.log("  FAIL  " + m); };
const warn = (m) => { warnings++; console.log("  warn  " + m); };

async function main() {
  const cfg = require("./settings").load();
  console.log("");

  // --- addresses well-formed and not placeholders ---------------------------
  console.log("config shape");
  for (const field of ["ownerAddress", "sweepDestination"]) {
    const v = cfg[field];
    if (!v) { bad(`${field} is missing`); continue; }
    if (PLACEHOLDERS.some((p) => p.toLowerCase() === String(v).toLowerCase())) {
      bad(`${field} is still a placeholder (${v})`);
      continue;
    }
    try {
      // getAddress enforces the capitalisation checksum, which is what catches
      // an address that was retyped rather than copied.
      ethers.getAddress(v);
      ok(`${field} ${v}`);
    } catch {
      bad(`${field} is not a valid checksummed address: ${v}`);
    }
  }

  if (!cfg.rpcUrl || cfg.rpcUrl.includes("REPLACE")) {
    bad("rpcUrl is not set");
    return finish();
  }

  // --- chain matches --------------------------------------------------------
  console.log("");
  console.log("chain");
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  let chainId;
  try {
    chainId = Number((await provider.getNetwork()).chainId);
  } catch (e) {
    bad(`cannot reach ${cfg.rpcUrl}: ${e.shortMessage || e.message}`);
    return finish();
  }
  if (chainId !== Number(cfg.chainId)) {
    bad(`RPC reports chain ${chainId}, config says ${cfg.chainId}`);
  } else {
    ok(`chain ${chainId}`);
  }

  // The failure that motivated this script: a config half-overwritten with
  // mainnet defaults while chainId still said something else.
  if (chainId !== 1) {
    const stale = Object.entries(MAINNET_DEFAULTS).filter(
      ([k, v]) => cfg.contracts?.[k]?.toLowerCase() === v.toLowerCase()
    );
    if (stale.length) {
      bad(
        `${stale.length} contract address(es) are Ethereum mainnet defaults on chain ${chainId}: ` +
          stale.map(([k]) => k).join(", ")
      );
    }
  }

  // --- contracts exist ------------------------------------------------------
  console.log("");
  console.log("contracts");
  const needed = ["positionManager", "factory", "weth"];
  const optional = ["swapRouter02", "quoterV2"];
  const present = {};

  for (const key of [...needed, ...optional]) {
    const addr = cfg.contracts?.[key];
    if (!addr || addr.startsWith("<")) {
      (needed.includes(key) ? bad : warn)(`${key} not set`);
      continue;
    }
    // Check the checksum separately so a mistyped address reports as that,
    // rather than surfacing as an opaque lookup failure.
    try {
      ethers.getAddress(addr);
    } catch {
      bad(`${key} is not a valid checksummed address: ${addr}`);
      continue;
    }
    let code;
    try {
      code = await provider.getCode(addr);
    } catch (e) {
      bad(`${key} lookup failed: ${e.shortMessage || e.message}`);
      continue;
    }
    if (!code || code === "0x") {
      (needed.includes(key) ? bad : warn)(`${key} has no contract at ${addr}`);
    } else {
      present[key] = addr;
      ok(`${key} ${addr}`);
    }
  }

  // --- contracts are what they claim ---------------------------------------
  // Code existing at an address proves nothing about what that code is.
  console.log("");
  console.log("identity");
  if (present.positionManager) {
    const npm = new ethers.Contract(present.positionManager, NPM_ABI, provider);
    try {
      const [name, factory, weth9] = await Promise.all([
        npm.name().catch(() => "?"),
        npm.factory(),
        npm.WETH9(),
      ]);
      ok(`position manager identifies as "${name}"`);

      if (present.factory && factory.toLowerCase() !== present.factory.toLowerCase()) {
        bad(`position manager's factory() is ${factory}, config has ${present.factory}`);
      } else if (present.factory) {
        ok("factory agrees with the position manager");
      }

      if (present.weth && weth9.toLowerCase() !== present.weth.toLowerCase()) {
        bad(`position manager's WETH9() is ${weth9}, config has ${present.weth}`);
      } else if (present.weth) {
        ok("WETH agrees with the position manager");
      }
    } catch (e) {
      bad(`position manager does not answer as one: ${e.shortMessage || e.message}`);
    }
  }

  // A wrong router would send exactInputSingle somewhere unintended.
  if (present.swapRouter02 && present.factory) {
    try {
      const rf = await new ethers.Contract(present.swapRouter02, ROUTER_ABI, provider).factory();
      if (rf.toLowerCase() !== present.factory.toLowerCase()) {
        bad(`router's factory() is ${rf}, expected ${present.factory}`);
      } else {
        ok("router points at the same factory");
      }
    } catch {
      warn("router did not answer factory(); cannot confirm it is a Uniswap router");
    }
  }

  // --- ownership ------------------------------------------------------------
  console.log("");
  console.log("positions");
  if (present.positionManager && cfg.ownerAddress) {
    try {
      const n = await new ethers.Contract(present.positionManager, NPM_ABI, provider)
        .balanceOf(cfg.ownerAddress);
      if (n === 0n) {
        bad(`${cfg.ownerAddress} holds no positions here — wrong wallet or wrong chain`);
      } else {
        ok(`${n} position NFT(s) held (open and closed)`);
      }
    } catch (e) {
      bad(`ownership check failed: ${e.shortMessage || e.message}`);
    }
  }

  // --- pricing reference ----------------------------------------------------
  const stable = cfg.usdReference?.stable;
  if (stable) {
    const code = await provider.getCode(stable).catch(() => "0x");
    if (!code || code === "0x") {
      warn(`usdReference.stable has no contract at ${stable}; values will show without USD`);
    } else {
      const sym = await new ethers.Contract(stable, ERC20_ABI, provider)
        .symbol().catch(() => "?");
      ok(`USD reference ${sym} at ${stable}`);
    }
  } else {
    warn("no usdReference.stable; values will be shown in WETH");
  }

  // --- swap routing ---------------------------------------------------------
  const ov = cfg.swapFeeTierOverrides || {};
  const realOverrides = Object.keys(ov).filter((k) => !k.startsWith("_"));
  if (realOverrides.length === 0) {
    warn("swapFeeTierOverrides is empty; a token held in two fee tiers will not be swapped");
  } else {
    for (const k of realOverrides) {
      try {
        ethers.getAddress(k);
        ok(`swap override ${k} -> ${Number(ov[k]) / 10000}%`);
      } catch {
        bad(`swapFeeTierOverrides key is not an address: ${k}`);
      }
    }
  }

  finish();
}

function finish() {
  console.log("");
  if (failures) {
    console.log(`${failures} failure(s), ${warnings} warning(s). Fix the failures before running.`);
    process.exit(1);
  }
  console.log(`Config valid. ${warnings} warning(s).`);
  process.exit(0);
}

main().catch((e) => {
  console.error("preflight crashed:", e.stack || e.message);
  process.exit(1);
});
