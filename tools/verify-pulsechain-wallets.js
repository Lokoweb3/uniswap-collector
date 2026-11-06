#!/usr/bin/env node
/**
 * tools/verify-pulsechain-wallets.js -- what each PulseChain wallet in
 * settings.pulsechain.example.json holds, read straight from the chain with the same
 * reader the dashboard uses (v2lp.js). Read-only: view calls and one public explorer GET
 * per wallet. It signs nothing, sends nothing and writes no file (no scan cursor, no token cache).
 *
 *   node tools/verify-pulsechain-wallets.js            # a table per wallet
 *   node tools/verify-pulsechain-wallets.js --json     # the same as JSON
 *   PULSE_RPC=https://...   or  LP_PULSE_RPC_URL=...   # another RPC (validated; shown as an origin only)
 *   EXAMPLE=/path/settings.pulsechain.example.json     # another settings file
 *
 * Per wallet: native PLS, WPLS and the bridged DAI / USDC / USDT balances; every PulseX v1/v2 LP
 * position (pair, reserves, totalSupply, share, value; an LP is accepted only if pair.factory() is a
 * configured PulseX factory); and PulseX farm stakes. Values come from WPLS/USD (the reference pair
 * in the settings) and pools other than the position's own; thin pools are flagged, an unpriced side
 * gives "no price", never 0.
 */
"use strict";
const path = require("path");
const { ethers } = require("ethers");
const endpoint = require("../endpoint");

const ERC20_BAL = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);

/** A tiny anonymous explorer client: only the configured (validated) explorer host, JSON GET, no key. */
function explorerFetch(base) {
  const root = endpoint.validateEndpoint(base, "chain.blockscout").replace(/\/$/, "");
  return (p, { timeoutMs = 20000 } = {}) => fetch(`${root}/api${p}`, { headers: { Accept: "application/json", "User-Agent": "lp-dashboard-verify/1" }, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Read every wallet. `provider` is injected (a test passes a stub that throws on anything but views).
 * cfg: settings.load() of the PulseChain settings. Returns plain data.
 */
async function run({ provider, cfg, bsFetch = null, log = { warn() {}, error() {} } }) {
  const v2lp = require("../v2lp");
  const set = v2lp.createSet({ provider, cfg, bsFetch, log, persist: false });
  const S = set.shared;
  const px = (cfg.contracts && cfg.contracts.pulsex) || {};
  const stables = (px.stables || []).slice();
  // WPLS/USD from the reference pair, through the same function the server uses (token metadata via S, nothing cached on disk).
  const u = { getToken: async (a) => (await S.tokenMeta([a]))[0] };
  const wethUsd = await require("../pricing").makeGetWethUsd({ cfg, unit: cfg.numeraire, factory: null, provider, u })();
  const wallets = [{ name: cfg.ownerLabel || "Main", address: cfg.ownerAddress }, ...(cfg.watchWallets || []).map((w) => ({ name: w.label || w.address, address: w.address }))];
  const addrs = [cfg.contracts.weth, ...stables];
  const meta = await S.tokenMeta(addrs);
  const out = { chainId: Number(cfg.chainId), rpc: endpoint.publicRpc(cfg), wplsUsd: wethUsd, wallets: [] };
  for (const w of wallets) {
    const entry = { name: w.name, address: w.address, pls: null, tokens: {}, lp: [], farm: [], lpValueUsd: 0, thinValueUsd: 0, unpricedLp: 0, thinLp: 0, notCounted: {}, notCountedUsd: {}, notes: [], errors: [] };
    try { entry.pls = Number(ethers.formatEther(await provider.getBalance(w.address))); } catch (e) { entry.errors.push(`PLS balance: ${endpoint.redactText(String(e.shortMessage || e.message)).slice(0, 100)}`); }
    const bal = await S.batch(addrs.map((a) => ({ target: a, data: ERC20_BAL.encodeFunctionData("balanceOf", [w.address]) })));
    addrs.forEach((a, i) => { const b = S.dec(ERC20_BAL, "balanceOf", bal[i]); const m = meta[i]; entry.tokens[m ? m.symbol : a] = b == null || !m ? null : Number(ethers.formatUnits(b, m.decimals)); });
    // New token price look-ups are budgeted per refresh (the dashboard resolves the rest on later refreshes);
    // a one-shot report reads again until none is deferred, at most six passes.
    let r = await set.positionsOf(w.address, wethUsd);
    for (let pass = 1; pass < 6 && r.positions.some((p) => /look-up deferred/.test(p.valueNote || "")); pass++) r = await set.positionsOf(w.address, wethUsd);
    entry.notes = r.notes;
    entry.errors.push(...r.errors.map((e) => `${e.tokenId}: ${e.error}`));
    entry.partial = r.partial;
    for (const p of r.positions) {
      const row = {
        protocol: p.protocol, pair: p.pair, pairAddress: p.pairAddress, reserve0: p.reserve0, reserve1: p.reserve1, symbol0: p.symbol0, symbol1: p.symbol1,
        totalSupply: p.totalSupply, lpBalance: p.lpBalance, sharePct: p.sharePct, amount0: p.amount0, amount1: p.amount1, valueUsd: p.valueUsd, thin: p.thin, counted: p.counted, countNote: p.countNote || null, priceGapPct: p.priceGapPct == null ? null : p.priceGapPct, valueNote: p.valueNote || null,
        staked: p.staked, ...(p.staked ? { farm: p.farm, pid: p.pid, pendingReward: p.rewards ? { symbol: p.rewards.symbol, amount: p.rewards.amount } : null } : {}),
      };
      (p.staked ? entry.farm : entry.lp).push(row);
      // Counted as in the dashboard totals: not thin, no price-gap flag, an anchor side (p.counted). The rest is shown, not counted.
      if (p.valueUsd == null) entry.unpricedLp++;
      else if (p.counted === false || p.thin) {
        entry.thinValueUsd += p.valueUsd; // value shown but not counted (any reason)
        const why = p.thin ? "thin" : p.priceGapPct != null ? "gap" : "noAnchor";
        entry.notCounted[why] = (entry.notCounted[why] || 0) + 1;
        entry.notCountedUsd[why] = (entry.notCountedUsd[why] || 0) + p.valueUsd;
      } else entry.lpValueUsd += p.valueUsd;
      if (p.thin) entry.thinLp++;
    }
    entry.lp.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
    out.wallets.push(entry);
  }
  return out;
}

const n = (x, d = 2) => (x == null ? "n/a" : Number(x).toLocaleString("en-US", { maximumFractionDigits: d }));
const usd = (x) => (x == null ? "no price" : `$${n(x, 2)}`);

function render(data) {
  const L = [];
  L.push(`PulseChain (${data.chainId}) wallets via ${data.rpc || "?"}; WPLS = ${data.wplsUsd == null ? "unpriced" : "$" + data.wplsUsd.toExponential(4)}`);
  for (const w of data.wallets) {
    L.push("", `== ${w.name}  ${w.address}`);
    L.push(`   PLS ${n(w.pls)}   ${Object.entries(w.tokens).map(([s, v]) => `${s} ${n(v)}`).join("   ")}`);
    L.push(`   PulseX LP: ${w.lp.length} position(s), ${usd(w.lpValueUsd)} priced${w.unpricedLp ? `, ${w.unpricedLp} without a price` : ""}${w.thinValueUsd ? `, ${usd(w.thinValueUsd)} shown but not counted (${Object.entries(w.notCounted).map(([k, c]) => `${c} ${k === "noAnchor" ? "no anchor side" : k === "gap" ? "price gap" : "thin"}: ${usd(w.notCountedUsd[k])}`).join(", ")})` : ""}${w.partial ? "  [PARTIAL]" : ""}`);
    for (const p of w.lp) {
      L.push(`     ${p.protocol.replace("pulsex-", "")} ${p.pairAddress} ${p.pair}  reserves ${n(p.reserve0, 0)} / ${n(p.reserve1, 0)}  supply ${n(p.totalSupply, 4)}  share ${p.sharePct.toFixed(3)}%  ${usd(p.valueUsd)}${p.thin ? "  [thin]" : ""}${p.priceGapPct != null ? "  [gap]" : ""}${p.counted === false ? "  [not counted]" : ""}${p.valueNote ? `  (${p.valueNote.slice(0, 90)})` : ""}`);
    }
    L.push(`   Farm stakes: ${w.farm.length ? "" : "none"}`);
    for (const p of w.farm) L.push(`     ${p.farm} pid ${p.pid}  ${p.pairAddress} ${p.pair}  staked share ${p.sharePct.toFixed(3)}%  ${usd(p.valueUsd)}  pending ${p.pendingReward ? `${n(p.pendingReward.amount, 4)} ${p.pendingReward.symbol}` : "n/a"}`);
    for (const x of w.notes) L.push(`   note: ${x}`);
    for (const x of w.errors) L.push(`   error: ${x}`);
  }
  return L.join("\n");
}

async function main() {
  const json = process.argv.includes("--json");
  const file = process.env.EXAMPLE || path.join(__dirname, "..", "settings.pulsechain.example.json");
  const envRpc = process.env.PULSE_RPC || process.env.LP_PULSE_RPC_URL || "";
  if (envRpc) { endpoint.validateEndpoint(envRpc, "PULSE_RPC"); endpoint.registerEndpoint(envRpc, { env: true }); }
  const cfg = require("../settings").load({ file });
  const url = envRpc || cfg.rpcUrl;
  const provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const net = Number((await provider.getNetwork()).chainId);
  if (net !== 369) throw new Error(`the endpoint answers chain ${net}, not 369`);
  const live = { ...cfg, rpcUrl: url, rpcPublic: cfg.rpcPublic || cfg.rpcUrl };
  const data = await run({ provider, cfg: live, bsFetch: cfg.blockscout ? explorerFetch(cfg.blockscout) : null, log: { warn: (m) => process.stderr.write(endpoint.redactText(String(m)) + "\n"), error() {} } });
  const text = json ? JSON.stringify(data, null, 2) : render(data);
  process.stdout.write(endpoint.redactText(text) + "\n");
}

module.exports = { run, render, explorerFetch };
if (require.main === module) main().catch((e) => { console.error(`verify-pulsechain-wallets: ${endpoint.redactText(String(e.shortMessage || e.message))}`); process.exit(1); });
