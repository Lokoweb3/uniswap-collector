#!/usr/bin/env node
/**
 * swap-routes.js — how each fee token could be converted into the sweep target on
 * this chain, and what each route actually quotes. Read-only.
 *
 * The collector takes a token's v3 fee tier from the position the fees were earned
 * in. That is wrong wherever the position is v4: a v4 pool's fee (4%, 3.881%) is not
 * a v3 tier, the quote fails, and the token is handed back unconverted instead of
 * swapped. This prints the evidence for every route so the choice can be made on
 * quotes rather than on where the fees happened to come from.
 *
 *   node tools/swap-routes.js
 *   node tools/swap-routes.js --amount=1 --settings=/home/steven/arc-data/settings.json
 */
"use strict";

const fs = require("fs");
const { ethers } = require("ethers");

const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const SETTINGS = arg("settings", "/home/steven/arc-data/settings.json");
const V3_TIERS = [100, 500, 3000, 10000];

async function main() {
  const cfg = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  const provider = new ethers.JsonRpcProvider(cfg.chain.rpcUrl, undefined, { staticNetwork: true });
  const target = ethers.getAddress(cfg.collector.sweep.targetToken);
  const targetDec = cfg.numeraire && cfg.numeraire.decimals ? cfg.numeraire.decimals : 18;
  const targetSym = cfg.numeraire && cfg.numeraire.symbol ? cfg.numeraire.symbol : "target";

  // Every non-target token the watched wallets currently hold fees in, by asking the
  // dashboard what the positions are made of.
  const tokens = new Map();
  for (const a of process.argv.filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x))) tokens.set(ethers.getAddress(a), null);
  if (!tokens.size) {
    const url = arg("dashboard", "http://127.0.0.1:8797") + "/api/watch";
    try {
      const d = await (await fetch(url)).json();
      for (const w of d.wallets || []) for (const p of w.positions || []) {
        for (const t of [p.token0, p.token1]) {
          if (!t || !/^0x[0-9a-fA-F]{40}$/.test(t)) continue;
          const a = ethers.getAddress(t);
          if (a.toLowerCase() !== target.toLowerCase()) tokens.set(a, null);
        }
      }
    } catch (e) { console.error(`could not read positions from ${url}: ${e.message}`); }
  }
  if (!tokens.size) { console.log("No non-target fee tokens found."); return; }

  const erc20 = (a) => new ethers.Contract(a, ["function symbol() view returns (string)", "function decimals() view returns (uint8)"], provider);
  const factory = new ethers.Contract(cfg.contracts.factory, ["function getPool(address,address,uint24) view returns (address)"], provider);
  const quoter = new ethers.Contract(cfg.contracts.quoterV2,
    ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"], provider);

  let v4 = null;
  try { const s = require("../sell-v4").create({ provider, cfg, log: () => {} }); if (s.ready) v4 = s; } catch {}

  console.log(`\nConverting fee tokens into ${targetSym} (${target}) on chain ${Number((await provider.getNetwork()).chainId)}`);
  console.log(`v4 quoting: ${v4 ? "available" : "not available (sell-v4 not ready on this instance)"}\n`);

  for (const addr of tokens.keys()) {
    let sym = addr.slice(0, 10), dec = 18;
    try { sym = await erc20(addr).symbol(); dec = Number(await erc20(addr).decimals()); } catch {}
    const amount = ethers.parseUnits(arg("amount", "1"), dec);
    console.log(`${sym} (${addr})  —  quoting ${arg("amount", "1")} ${sym}`);

    const routes = [];
    for (const fee of V3_TIERS) {
      let pool = ethers.ZeroAddress;
      try { pool = await factory.getPool(addr, target, fee); } catch {}
      if (pool === ethers.ZeroAddress) { console.log(`  v3 ${String(fee / 10000 + "%").padStart(7)}: no pool`); continue; }
      let liq = 0n;
      try { liq = await new ethers.Contract(pool, ["function liquidity() view returns (uint128)"], provider).liquidity(); } catch {}
      let out = null;
      try { out = (await quoter.quoteExactInputSingle.staticCall({ tokenIn: addr, tokenOut: target, amountIn: amount, fee, sqrtPriceLimitX96: 0 }))[0]; } catch (e) { out = null; }
      console.log(`  v3 ${String(fee / 10000 + "%").padStart(7)}: ${out == null ? "no quote" : ethers.formatUnits(out, targetDec) + " " + targetSym}   (liquidity ${liq})`);
      if (out && out > 0n) routes.push({ kind: "v3", fee, out });
    }

    if (v4) {
      try {
        const pools = await v4.discoverPools(addr, target);
        for (const k of pools || []) {
          let out = null;
          try { out = await v4.quoteOut(k, addr, amount); } catch {}
          const fee = Number(k.fee);
          console.log(`  v4 ${String((fee / 10000).toFixed(3) + "%").padStart(7)}: ${out == null || out === 0n ? "no quote" : ethers.formatUnits(out, targetDec) + " " + targetSym}`);
          if (out && out > 0n) routes.push({ kind: "v4", fee, out });
        }
        if (!pools || !pools.length) console.log("  v4        : no pool found for this pair");
      } catch (e) { console.log(`  v4        : discovery failed (${e.shortMessage || e.message})`); }
    }

    routes.sort((a, b) => (b.out > a.out ? 1 : -1));
    const best = routes[0];
    console.log(`  best      : ${best ? `${best.kind} ${best.fee / 10000}% -> ${ethers.formatUnits(best.out, targetDec)} ${targetSym}` : "NO ROUTE — this token cannot be converted here"}`);
    const conf = (cfg.collector.swapFeeTierOverrides || {})[addr] ?? (cfg.collector.swapFeeTierOverrides || {})[addr.toLowerCase()];
    console.log(`  configured: ${conf === undefined ? "no override — the collector would take the tier from the position's own pool" : `override ${conf} (${conf / 10000}%)`}\n`);
  }
}

main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
