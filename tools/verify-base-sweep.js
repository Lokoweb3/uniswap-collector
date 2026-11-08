#!/usr/bin/env node
// Read-only on-chain proof of the Base sweep: the router, quoter and factory, the three single-hop pools, a probe quote per route, the TWAP
// the guard needs, and (when configured) the vault. Only eth_call and eth_getCode: no key is read, nothing is ever sent. In the style of
// tools/verify-arc-vault.js: one line per check, "ok" or "FAIL", exit code 1 when any check failed.
//
//   node tools/verify-base-sweep.js            (RPC: LP_BASE_RPC_URL, else the public Base RPC; vault from settings baseSweep.vault)
"use strict";
const { ethers } = require("ethers");
const S = require("../collector-base-sweep-logic");
const sweep = require("../collector-base-sweep");

const PROBE = { WETH: 10n ** 15n, cbBTC: 100_000n, LAPTOP: 100n * 10n ** 18n }; // about 2, 60 and 5 USDC

/** Runs every check against `provider`; `out(line)` receives each line. -> { bad, lines } */
async function run(provider, { vault = null, owners = [], out = () => {}, vaultImplementations } = {}) {
  const lines = [];
  let bad = 0;
  const emit = (line) => { lines.push(line); out(line); };
  const check = (ok, what) => { if (!ok) bad++; emit(`  ${ok ? "ok  " : "FAIL"}  ${what}`); };
  const guard = async (what, fn) => { try { await fn(); } catch (err) { check(false, `${what}: ${String((err && (err.shortMessage || err.message)) || err).split("\n")[0].slice(0, 120)}`); } };
  const sw = S.config({ enabled: true, vault: vault || undefined });

  emit("code is where it should be");
  for (const [n, a] of [["SwapRouter02", S.ROUTER], ["QuoterV2", S.QUOTER], ["Uniswap v3 factory", S.FACTORY], ["USDC", S.USDC]]) {
    await guard(n, async () => { const c = await provider.getCode(a); check(c !== "0x", `${n} ${a} ${c === "0x" ? "has NO CODE" : `${(c.length - 2) / 2} bytes`}`); });
  }
  await guard("USDC decimals", async () => {
    const d = Number(await new ethers.Contract(S.USDC, sweep.ERC20_ABI, provider).decimals());
    check(d === S.USDC_DECIMALS, `USDC decimals() is ${d} (must be 6)`);
  });

  for (const route of Object.values(S.ROUTES)) {
    emit(`\nroute ${route.symbol} -> USDC (fee ${route.fee})`);
    await guard(`${route.symbol} token`, async () => {
      check((await provider.getCode(route.token)) !== "0x", `token ${route.token} has code`);
      const d = Number(await new ethers.Contract(route.token, sweep.ERC20_ABI, provider).decimals());
      check(d === route.decimals, `token decimals() is ${d} (expected ${route.decimals})`);
    });
    const proof = await sweep.proveRoute(provider, route);
    check(proof.ok, proof.ok ? `factory.getPool == ${route.pool}; pool.factory(), token0/token1 and fee() agree` : `route proof: ${proof.reason}`);
    if (!proof.ok) continue;
    await guard(`${route.symbol} pool state`, async () => {
      const facts = await sweep.readFacts(provider, sw, route, PROBE[route.symbol]);
      check(facts.sqrtPriceX96 > 0n, "pool price is set");
      check(facts.liquidity > 0n, `in-range liquidity ${facts.liquidity}`);
      check(facts.poolUsdc >= S.usdcRaw(sw.minPoolUsdc), `pool USDC balance ${S.fmtUsdc(facts.poolUsdc)} (minPoolUsdc ${sw.minPoolUsdc})`);
      check(facts.twapTick !== null, facts.twapTick === null ? `observe([${sw.twapSeconds}, 0]) reverts: too little oracle cardinality, the sweep would fail closed and send ${route.symbol} unswapped` : `${sw.twapSeconds} s TWAP tick ${facts.twapTick}, spot ${facts.tick}, deviation ${Math.abs(facts.tick - facts.twapTick)} (max ${sw.twapMaxDeviationBps})`);
      check(facts.quote !== null && facts.quote > 0n, facts.quote ? `probe quote ${S.fmtUsdc(facts.quote)} USDC` : "the quoter returned nothing");
      if (facts.quote) {
        const d = S.decideSwap(sw, facts);
        emit(`        probe decision: ${d.swap ? "swap" : `unswapped (${d.reason})`}; impact ${d.impactBps} bps`);
      }
    });
  }

  emit("\nvault");
  if (!vault || vault.tba === null || vault.tba === undefined || vault.tba === "") emit("  ok    vault.tba is null: the split is 0% and no vault address is ever used (gated off)");
  else {
    const v = await sweep.verifyVault(provider, sw, { operator: null, owners, implementations: vaultImplementations });
    check(v.ok, v.ok ? `vault ${v.tba} verified; effective split ${v.pct}%` : `vault refused: ${v.reason}`);
  }
  emit(`\n${bad ? `${bad} CHECK(S) FAILED` : "All checks passed."}`);
  return { bad, lines };
}

async function main() {
  const rpc = process.env.LP_BASE_RPC_URL || "https://mainnet.base.org";
  const provider = new ethers.JsonRpcProvider(rpc, S.CHAIN_ID, { staticNetwork: true });
  let vault = null;
  let owners = [];
  try { const cfg = require("../settings").load({ fresh: true }); vault = (cfg.baseSweep || {}).vault || null; owners = require("../collector-base-logic").owners(cfg).map((o) => o.address); } catch { vault = null; }
  console.log(`Base ${(await provider.getNetwork()).chainId} at block ${await provider.getBlockNumber()}\n`);
  const { bad } = await run(provider, { vault, owners, out: (l) => console.log(l) });
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main().catch((e) => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
module.exports = { run };
