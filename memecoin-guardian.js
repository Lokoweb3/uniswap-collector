#!/usr/bin/env node
/**
 * Memecoin guardian: a standalone watcher for the risky LP positions listed
 * under `memecoins` in config.json. Every 60 seconds it reads each position
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

/** One sample for a listed position: price (token per ETH), pool liquidity, fee growth, uncollected fees in USD. */
async function sample(entry, wethUsd) {
  const owner = entry.walletAddress;
  const p = await v4.loadPosition({ provider, posm, stateView, cfg: { ...cfg, ownerAddress: owner } }, entry.tokenId);
  if (p.gone) return { gone: true };
  if (p.closed) return { closed: true };
  const ethIs0 = p.token0.address === ethers.ZeroAddress || p.token0.address.toLowerCase() === (cfg.contracts.weth || "").toLowerCase();
  // token per ETH regardless of which side ETH sits on
  const tokPerEth = ethIs0 ? p.prices.current : 1 / p.prices.current;
  const [L, growth] = await Promise.all([stateView.getLiquidity(p.poolAddress), stateView.getFeeGrowthGlobals(p.poolAddress)]);
  const f0 = Number(ethers.formatUnits(p.fees.amount0, p.token0.decimals));
  const f1 = Number(ethers.formatUnits(p.fees.amount1, p.token1.decimals));
  const a0 = Number(ethers.formatUnits(p.amounts.amount0, p.token0.decimals));
  const a1 = Number(ethers.formatUnits(p.amounts.amount1, p.token1.decimals));
  const tokUsd = wethUsd != null && tokPerEth > 0 ? wethUsd / tokPerEth : null;
  const usd0 = ethIs0 ? wethUsd : tokUsd, usd1 = ethIs0 ? tokUsd : wethUsd;
  const feeUsd = usd0 != null && usd1 != null ? f0 * usd0 + f1 * usd1 : null;
  const valueUsd = usd0 != null && usd1 != null ? a0 * usd0 + a1 * usd1 : null;
  return {
    t: Date.now(), price: tokPerEth, liq: Number(L), g0: growth[0].toString(), g1: growth[1].toString(),
    feeUsd, valueUsd, inRange: p.inRange, symbol0: p.token0.symbol, symbol1: p.token1.symbol,
    ethSymbol: ethIs0 ? p.token0.symbol : p.token1.symbol, tokenSymbol: ethIs0 ? p.token1.symbol : p.token0.symbol,
    amountEth: ethIs0 ? a0 : a1, amountToken: ethIs0 ? a1 : a0, tickLower: p.tickLower, tickUpper: p.tickUpper, currentTick: p.currentTick,
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
  const list = Array.isArray(live.memecoins) ? live.memecoins : [];
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
      statuses.push({ tokenId: id, pair: entry.pair, wallet: entry.wallet, closed: true, at: now });
      continue;
    }
    st.samples.push(s);
    st.samples = st.samples.filter((x) => now - x.t <= KEEP_MS);
    const d = logic.derive(entry, st.samples, now);
    Object.assign(d, { symbolToken: s.tokenSymbol, amountEth: s.amountEth, amountToken: s.amountToken, wethUsd, tickLower: s.tickLower, tickUpper: s.tickUpper, currentTick: s.currentTick, samples: st.samples.length });
    for (const text of logic.alertsFor(d, state.sent, now)) await send(text);
    const reason = logic.shouldClose(d);
    if (reason) {
      const last = state.sent[`close:${id}`] || 0;
      if (now - last > 30 * 60000) {
        state.sent[`close:${id}`] = now;
        const row = await closeNow(entry, reason, "auto");
        d.lastClose = row;
        if (row.status === "closed") st.closed = true;
      }
    }
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
    const entry = (readJson(CONFIG_FILE, cfg).memecoins || []).find((m) => String(m.tokenId) === id);
    if (!entry) throw new Error(`#${id} is not listed under memecoins in config.json`);
    const row = await closeNow(entry, args[2] || "manual close from the dashboard", "manual");
    console.log(JSON.stringify(row));
    process.exit(row.status === "closed" ? 0 : 2);
  }
  log(`guardian started; watching ${(cfg.memecoins || []).length} position(s) every ${INTERVAL_MS / 1000}s`);
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
