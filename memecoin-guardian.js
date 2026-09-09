#!/usr/bin/env node
/**
 * Memecoin guardian: a standalone watcher for the risky LP positions listed
 * under `memecoins` in config.json, plus every v4 position in the main wallet
 * and the collected watched wallets, discovered from the dashboard (entry price
 * from the hourly price log at mint, else the first sample; see watchList).
 * Every 60 seconds it reads each position
 * and its v4 pool straight from the chain, keeps a rolling history, writes
 * memecoin-status.json for the dashboard's "Memecoin Watch" section, sends
 * Telegram alerts (guardian-logic.js decides), and, only for entries with
 * `autoClose: true`, closes a position through close-position.js while the
 * collector is armed (the operator key signs; everything is paid to the
 * position's owner wallet).
 *
 *   node memecoin-guardian.js                 # run forever (start-all.sh does this)
 *   node memecoin-guardian.js --once          # one cycle, then exit
 *   node memecoin-guardian.js --close <id>    # close one listed position now (needs the armed cache)
 *
 * Logs: memecoin-guardian.log (stdout via start-all.sh), closes and refusals
 * in memecoin-guardian-log.json, samples in memecoin-guardian-state.json.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const v4 = require("./univ4");
const u = require("./univ3");
const logic = require("./guardian-logic");
const closer = require("./close-position");

const HERE = __dirname;
const CONFIG_FILE = path.join(HERE, "config.json");
const STATE_FILE = path.join(HERE, "memecoin-guardian-state.json");
const STATUS_FILE = path.join(HERE, "memecoin-status.json");
const LOG_FILE = path.join(HERE, "memecoin-guardian-log.json");
const INTERVAL_MS = 60 * 1000;
const CONFIRM_CYCLES = 3; // consecutive cycles an auto-close trigger must hold
const KEEP_MS = 24 * 3600 * 1000;
const DASHBOARD = `http://127.0.0.1:${process.env.LP_DASHBOARD_PORT || 8787}`;

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return d;
  }
};
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o));

const cfg = readJson(CONFIG_FILE, null);
if (!cfg) throw new Error("config.json missing");
const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, Number(cfg.chainId));
const posm = new ethers.Contract(cfg.contracts.v4.positionManager, v4.POSM_ABI, provider);
const stateView = new ethers.Contract(cfg.contracts.v4.stateView, [...v4.STATE_VIEW_ABI, "function getLiquidity(bytes32) view returns (uint128)", "function getFeeGrowthGlobals(bytes32) view returns (uint256,uint256)"], provider);
const npm = new ethers.Contract(cfg.contracts.positionManager, ["function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)"], provider);

let state = readJson(STATE_FILE, { positions: {}, sent: {} });
let alerts = null;
try {
  alerts = require("./alerts").create();
} catch {}

async function send(text) {
  log(`ALERT ${text}`);
  if (alerts && alerts.enabled) {
    try {
      await alerts.send(text);
    } catch (err) {
      log(`telegram failed: ${err.message}`);
    }
  }
}

/** ETH price in USD: the dashboard's payload, else the price log's newest hour. */
async function ethUsd() {
  try {
    const r = await fetch(`${DASHBOARD}/api/positions`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (j.wethUsd) return j.wethUsd;
  } catch {}
  const pl = readJson(path.join(HERE, "price-log.json"), { hours: {} });
  const hours = Object.keys(pl.hours || {}).sort();
  for (let i = hours.length - 1; i >= 0; i--) if (pl.hours[hours[i]].eth) return pl.hours[hours[i]].eth;
  return null;
}

const WETH_ADDR = (cfg.contracts.weth || "").toLowerCase();
const STABLE_ADDR = ((cfg.usdReference && cfg.usdReference.stable) || "").toLowerCase();
const isEth = (a) => a === ethers.ZeroAddress || String(a).toLowerCase() === WETH_ADDR;
const isStable = (a) => !!STABLE_ADDR && String(a).toLowerCase() === STABLE_ADDR;
const addrOf = (t) => (typeof t === "string" ? t : t && t.address) || null;

// ---------------------------------------------------------------------------
// Discovery: every v4 position in the main wallet and in watched wallets the
// collector serves is watched without a config entry (config.json `memecoins`
// entries still win and can pin an entry price). Discovered entries live in
// memecoin-discovered.json so the entry price stays fixed across restarts;
// defaults come from `memecoinDefaults`; `memecoinDiscovery: false` turns it off.
// ---------------------------------------------------------------------------
const DISCOVERED_FILE = path.join(HERE, "memecoin-discovered.json");
const DEFAULTS = { maxDrawdownPct: 50, autoClose: false, alertOnly: true, outOfRangeCloseMinutes: 120 };

async function getJson(pathname) {
  const r = await fetch(`${DASHBOARD}${pathname}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${pathname} -> HTTP ${r.status}`);
  return r.json();
}

/** v4 positions the dashboard knows, across the main wallet and collected watched wallets. */
async function livePositions() {
  const out = [];
  const push = (p, wallet, walletAddress) => {
    if (p.version !== 4) return;
    out.push({ tokenId: String(p.nftId || String(p.tokenId).replace(/^v4-/, "")), version: 4, pair: p.pair, wallet, walletAddress,
      token0: addrOf(p.token0), token1: addrOf(p.token1), since: p.pnlSince || null });
  };
  try {
    const j = await getJson("/api/positions");
    if (j && j.ok) for (const p of j.positions || []) push(p, j.ownerLabel || "Main", j.owner || cfg.ownerAddress);
  } catch (err) { log(`discovery: /api/positions failed: ${err.message}`); }
  try {
    const j = await getJson("/api/watch");
    if (j && j.ok) for (const w of j.wallets || []) {
      if (!w.ok) continue;
      const served = w.collector ? w.collector.enabled : w.label === "Trading";
      if (!served) continue;
      for (const p of w.positions || []) push(p, w.label || w.address, w.address);
    }
  } catch (err) { log(`discovery: /api/watch failed: ${err.message}`); }
  return out;
}

/** Token-per-quote price from the hourly price log nearest `t` (within 3h), or null. */
function priceLogAt(tokenAddr, quoteAddr, t) {
  if (!tokenAddr || !t) return null;
  const pl = readJson(path.join(HERE, "price-log.json"), { hours: {} });
  let best = null;
  for (const h of Object.keys(pl.hours || {})) {
    const d = Math.abs(Number(h) - t);
    if (d <= 3 * 3600 * 1000 && (!best || d < best.d)) best = { h, d };
  }
  if (!best) return null;
  const row = pl.hours[best.h];
  const tokUsd = row[String(tokenAddr).toLowerCase()];
  const quoteUsd = isEth(quoteAddr) ? row.eth : isStable(quoteAddr) ? 1 : null;
  if (!(tokUsd > 0) || !(quoteUsd > 0)) return null;
  return quoteUsd / tokUsd;
}

/**
 * The watch list for this cycle: config entries first, then discovered
 * positions. New discoveries get their entry price from the price log at the
 * mint time when it has the token, else from their first sample (filled in by
 * the caller); closed ones are dropped from the discovered file.
 */
async function watchList(live) {
  const listed = Array.isArray(live.memecoins) ? live.memecoins : [];
  if (live.memecoinDiscovery === false) return listed;
  const defaults = { ...DEFAULTS, ...(live.memecoinDefaults || {}) };
  const discovered = readJson(DISCOVERED_FILE, []);
  const have = new Set([...listed, ...discovered].map((m) => String(m.tokenId)));
  let changed = false;
  for (const p of await livePositions()) {
    if (have.has(p.tokenId)) continue;
    const quote = isEth(p.token0) || (!isEth(p.token1) && isStable(p.token0)) ? p.token0 : p.token1;
    const token = quote === p.token0 ? p.token1 : p.token0;
    const atMint = priceLogAt(token, quote, p.since);
    const entry = { ...defaults, tokenId: p.tokenId, version: 4, pair: p.pair, wallet: p.wallet, walletAddress: p.walletAddress,
      entryPrice: atMint || null, entrySource: atMint ? "price log at mint" : "first seen", entryAt: atMint ? p.since : null, discovered: true };
    discovered.push(entry);
    have.add(p.tokenId);
    changed = true;
    log(`discovered ${p.pair} #${p.tokenId} (${p.wallet})${atMint ? `, entry ${Math.round(atMint).toLocaleString("en-US")} from the price log at mint` : ", entry = first sample"}`);
  }
  if (changed) writeJson(DISCOVERED_FILE, discovered);
  return [...listed, ...discovered.filter((d) => !listed.some((m) => String(m.tokenId) === String(d.tokenId)))];
}

/** Record a discovered entry's first-seen price, or drop a closed one. */
function updateDiscovered(id, patch) {
  const rows = readJson(DISCOVERED_FILE, []);
  const i = rows.findIndex((r) => String(r.tokenId) === String(id));
  if (i < 0) return;
  if (patch === null) rows.splice(i, 1); else Object.assign(rows[i], patch);
  writeJson(DISCOVERED_FILE, rows);
}

/** One sample for a listed position: price (token per quote), pool liquidity, fee growth, uncollected fees in USD. */
async function sample(entry, wethUsd) {
  const owner = entry.walletAddress;
  const p = await v4.loadPosition({ provider, posm, stateView, cfg: { ...cfg, ownerAddress: owner } }, entry.tokenId);
  if (p.gone) return { gone: true };
  if (p.closed) return { closed: true };
  // The quote side is ETH when the pair has it, else the reference stable
  // (USDG/Bucket-style pools); prices are TOKEN PER QUOTE either way.
  const ethIs0 = isEth(p.token0.address), ethIs1 = isEth(p.token1.address);
  const quoteIs0 = ethIs0 ? true : ethIs1 ? false : isStable(p.token0.address) ? true : isStable(p.token1.address) ? false : true;
  const quote = quoteIs0 ? p.token0 : p.token1, token = quoteIs0 ? p.token1 : p.token0;
  const quoteUsd = isEth(quote.address) ? wethUsd : isStable(quote.address) ? 1 : null;
  const tokPerQuote = quoteIs0 ? p.prices.current : 1 / p.prices.current;
  const [L, growth] = await Promise.all([stateView.getLiquidity(p.poolAddress), stateView.getFeeGrowthGlobals(p.poolAddress)]);
  const f0 = Number(ethers.formatUnits(p.fees.amount0, p.token0.decimals));
  const f1 = Number(ethers.formatUnits(p.fees.amount1, p.token1.decimals));
  const a0 = Number(ethers.formatUnits(p.amounts.amount0, p.token0.decimals));
  const a1 = Number(ethers.formatUnits(p.amounts.amount1, p.token1.decimals));
  const tokUsd = quoteUsd != null && tokPerQuote > 0 ? quoteUsd / tokPerQuote : null;
  const usd0 = quoteIs0 ? quoteUsd : tokUsd, usd1 = quoteIs0 ? tokUsd : quoteUsd;
  const feeUsd = usd0 != null && usd1 != null ? f0 * usd0 + f1 * usd1 : null;
  const valueUsd = usd0 != null && usd1 != null ? a0 * usd0 + a1 * usd1 : null;
  return {
    t: Date.now(), price: tokPerQuote, liq: Number(L), g0: growth[0].toString(), g1: growth[1].toString(),
    feeUsd, valueUsd, inRange: p.inRange, symbol0: p.token0.symbol, symbol1: p.token1.symbol,
    quoteSymbol: quote.symbol, ethSymbol: quote.symbol, tokenSymbol: token.symbol, tokenAddress: token.address, quoteAddress: quote.address,
    amountEth: quoteIs0 ? a0 : a1, amountToken: quoteIs0 ? a1 : a0, tickLower: p.tickLower, tickUpper: p.tickUpper, currentTick: p.currentTick,
  };
}

function appendLog(entry) {
  const rows = readJson(LOG_FILE, []);
  rows.push(entry);
  writeJson(LOG_FILE, rows);
}

/** Close one listed position now (the operator must be armed). Returns the log entry. */
async function closeNow(entry, reason, who = "guardian") {
  const wallet = await closer.operatorWallet(provider);
  const base = { timestamp: new Date().toISOString(), tokenId: String(entry.tokenId), pair: entry.pair, wallet: entry.wallet, walletAddress: entry.walletAddress, reason, by: who };
  if (!wallet) {
    const row = { ...base, status: "locked", error: "collector is locked; arm it at /arm" };
    appendLog(row);
    await send(`⚠️ ${entry.pair}: auto-close needed (${reason}) but the collector is locked. Arm it at http://127.0.0.1:8787/arm — nothing was sent.`);
    return row;
  }
  try {
    const is3 = /^v3/i.test(String(entry.version || "")) || entry.version === 3;
    const res = is3
      ? await closer.closeV3({ provider, cfg, tokenId: entry.tokenId, owner: entry.walletAddress, wallet })
      : await closer.closeV4({ provider, cfg, tokenId: entry.tokenId, owner: entry.walletAddress, wallet });
    const p = res.position;
    const ethIs0 = p && (p.token0.address === ethers.ZeroAddress);
    const recovered = p
      ? `${ethers.formatUnits(ethIs0 ? res.expect.amount0 : res.expect.amount1, 18).slice(0, 8)} ETH + ${Number(ethers.formatUnits(ethIs0 ? res.expect.amount1 : res.expect.amount0, ethIs0 ? p.token1.decimals : p.token0.decimals)).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${ethIs0 ? p.token1.symbol : p.token0.symbol}`
      : "position value";
    const row = { ...base, status: "closed", tx: res.hash, block: res.block, gasEth: ethers.formatEther(res.gasWei), recovered };
    appendLog(row);
    await send(`🚨 Auto-closed ${entry.pair} — recovered ${recovered} to ${entry.wallet} (${reason}). tx ${res.hash.slice(0, 12)}…`);
    return row;
  } catch (err) {
    const row = { ...base, status: "failed", error: err.shortMessage || err.message };
    appendLog(row);
    await send(`❌ ${entry.pair}: auto-close failed: ${row.error}`);
    return row;
  }
}

async function cycle() {
  const live = readJson(CONFIG_FILE, cfg);
  const list = await watchList(live);
  const wethUsd = await ethUsd();
  const statuses = [];
  const now = Date.now();
  for (const entry of list) {
    const id = String(entry.tokenId);
    const st = (state.positions[id] = state.positions[id] || { samples: [], closed: false });
    if (st.closed) continue;
    let s;
    try {
      s = await sample(entry, wethUsd);
    } catch (err) {
      log(`#${id} ${entry.pair}: read failed: ${err.shortMessage || err.message}`);
      continue;
    }
    if (s.gone || s.closed) {
      st.closed = true;
      log(`#${id} ${entry.pair}: position is ${s.gone ? "no longer owned" : "closed"}; watching stops`);
      if (entry.discovered) updateDiscovered(id, null);
      statuses.push({ tokenId: id, pair: entry.pair, wallet: entry.wallet, closed: true, at: now });
      continue;
    }
    if (entry.discovered && !(Number(entry.entryPrice) > 0) && s.price > 0) {
      entry.entryPrice = s.price;
      entry.entryAt = s.t;
      updateDiscovered(id, { entryPrice: s.price, entryAt: s.t, entrySource: "first seen" });
    }
    st.samples.push(s);
    st.samples = st.samples.filter((x) => now - x.t <= KEEP_MS);
    const d = logic.derive(entry, st.samples, now);
    Object.assign(d, { symbolToken: s.tokenSymbol, quoteSymbol: s.quoteSymbol, amountEth: s.amountEth, amountToken: s.amountToken, wethUsd, tickLower: s.tickLower, tickUpper: s.tickUpper, currentTick: s.currentTick, samples: st.samples.length,
      entrySource: entry.entrySource || "config", entryAt: entry.entryAt || null, discovered: !!entry.discovered });
    for (const text of logic.alertsFor(d, state.sent, now)) await send(text);
    // Auto-close needs the trigger to hold for CONFIRM_CYCLES consecutive
    // 60-second cycles with the pool price stable within 10% between cycles,
    // so one bad RPC read or a single-block wick cannot close a position.
    const reason = logic.shouldClose(d);
    st.confirm = st.confirm || { n: 0, lastPrice: null };
    if (reason) {
      const agrees = st.confirm.lastPrice == null || !(d.price > 0) || Math.abs(d.price - st.confirm.lastPrice) / st.confirm.lastPrice <= 0.10;
      st.confirm.n = agrees ? st.confirm.n + 1 : 1;
      st.confirm.lastPrice = d.price > 0 ? d.price : st.confirm.lastPrice;
      d.closeConfirm = `${st.confirm.n}/${CONFIRM_CYCLES}`;
      const last = state.sent[`close:${id}`] || 0;
      if (st.confirm.n >= CONFIRM_CYCLES && now - last > 30 * 60000) {
        state.sent[`close:${id}`] = now;
        const row = await closeNow(entry, reason, "auto");
        d.lastClose = row;
        if (row.status === "closed") st.closed = true;
        else st.confirm.n = 0; // a failed attempt starts the confirmation over; retried after the 30-min cool-down
      }
    } else st.confirm.n = 0;
    statuses.push(d);
    log(`#${id} ${entry.pair}: ${d.status} price ${d.price.toLocaleString("en-US", { maximumFractionDigits: 0 })} (${d.priceVsEntryPct == null ? "no entry" : (d.priceVsEntryPct >= 0 ? "+" : "") + d.priceVsEntryPct.toFixed(1) + "% vs entry"}) ${d.inRange ? "in range" : "OUT " + Math.round(d.outMinutes) + "m"} fees $${(d.feeUsd || 0).toFixed(2)}${d.feesPerHour != null ? " (" + d.feesPerHour.toFixed(2) + "/h)" : ""} liq ${d.liqChange1hPct == null ? "" : (d.liqChange1hPct >= 0 ? "+" : "") + d.liqChange1hPct.toFixed(0) + "%/1h"}`);
  }
  writeJson(STATE_FILE, state);
  writeJson(STATUS_FILE, { ok: true, at: now, wethUsd, positions: statuses, recent: readJson(LOG_FILE, []).slice(-10).reverse() });
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--close") {
    const id = String(args[1] || "");
    const entry = [...(readJson(CONFIG_FILE, cfg).memecoins || []), ...readJson(DISCOVERED_FILE, [])].find((m) => String(m.tokenId) === id);
    if (!entry) throw new Error(`#${id} is not listed under memecoins in config.json or memecoin-discovered.json`);
    const row = await closeNow(entry, args[2] || "manual close from the dashboard", "manual");
    console.log(JSON.stringify(row));
    process.exit(row.status === "closed" ? 0 : 2);
  }
  log(`guardian started; ${(cfg.memecoins || []).length} configured position(s) plus discovery${cfg.memecoinDiscovery === false ? " off" : " of every v4 position in collected wallets"}, every ${INTERVAL_MS / 1000}s`);
  for (;;) {
    try {
      await cycle();
    } catch (err) {
      log(`cycle failed: ${err.shortMessage || err.message}`);
    }
    if (args.includes("--once")) return;
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
