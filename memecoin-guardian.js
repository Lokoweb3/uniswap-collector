#!/usr/bin/env node
/**
 * Risk guardian: the one watcher for every open LP position, main wallet and
 * watched wallets, v3 and v4. Positions listed under `memecoins` in
 * config.json carry their own rule block; every other open position is
 * discovered from the dashboard and watched with the `memecoinDefaults` rules
 * (entry price from the hourly price log at mint, else the first sample).
 *
 * Each cycle reads a position and its pool straight from the chain (v4 every
 * 60 s, v3 every 5 min), keeps a rolling 24 h history, derives a status
 * (guardian-logic.js), sends ONE Telegram message per event, writes
 * memecoin-status.json for the dashboard's Risk section and, only for entries
 * with `autoClose: true` and `alertOnly: false`, closes a position through
 * close-position.js while the collector is armed (the operator key signs;
 * everything is paid to the position's owner wallet).
 *
 * Used in-process by server.js (create()), or standalone:
 *   node memecoin-guardian.js                 # run forever
 *   node memecoin-guardian.js --once          # one cycle, then exit
 *   node memecoin-guardian.js --close <id>    # close one watched position now (needs the armed cache)
 *
 * Closes and refusals go to memecoin-guardian-log.json, samples to
 * memecoin-guardian-state.json, discovered entries to memecoin-discovered.json.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const v4 = require("./univ4");
const u = require("./univ3");
const logic = require("./guardian-logic");
const closer = require("./close-position");

const CONFIRM_CYCLES = 3; // consecutive cycles an auto-close trigger must hold
const KEEP_MS = 24 * 3600 * 1000;
const INTERVALS = { 3: 5 * 60 * 1000, 4: 60 * 1000 }; // sampling interval per position version
const RULE_KEYS = ["alertPct", "closePct", "outOfRangeMinutes", "tvlDropPct", "feeFloorPerHour", "collectedTargetUsd"];

const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return d;
  }
};
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
const addrOf = (t) => (typeof t === "string" ? t : t && t.address) || null;
const bareId = (p) => String(p.nftId || String(p.tokenId).replace(/^v4-/, ""));

/**
 * create({ dir, provider, alerts, log, positions, watched, now })
 *   dir        directory holding config.json and the state files
 *   positions  () => the dashboard's main-wallet payload ({ positions, owner, ownerLabel }) or null
 *   watched    () => the watched-wallet list ([{ ok, label, address, positions }]) or null
 *   alerts     alerts.js instance (sendGroup / send) or null
 */
function create({ dir = __dirname, provider = null, alerts = null, log = (m) => console.log(`[${new Date().toISOString()}] ${m}`), positions = () => null, watched = () => null, now = () => Date.now() } = {}) {
  const CONFIG_FILE = path.join(dir, "config.json");
  const STATE_FILE = path.join(dir, "memecoin-guardian-state.json");
  const STATUS_FILE = path.join(dir, "memecoin-status.json");
  const LOG_FILE = path.join(dir, "memecoin-guardian-log.json");
  const DISCOVERED_FILE = path.join(dir, "memecoin-discovered.json");

  const cfg = readJson(CONFIG_FILE, null);
  if (!cfg) throw new Error("config.json missing");
  provider = provider || new ethers.JsonRpcProvider(cfg.rpcUrl, Number(cfg.chainId), { staticNetwork: true });
  const hasV4 = !!(cfg.contracts.v4 && cfg.contracts.v4.positionManager);
  const posm = hasV4 ? new ethers.Contract(cfg.contracts.v4.positionManager, v4.POSM_ABI, provider) : null;
  const stateView = hasV4 ? new ethers.Contract(cfg.contracts.v4.stateView, [...v4.STATE_VIEW_ABI, "function getLiquidity(bytes32) view returns (uint128)"], provider) : null;
  const npm = new ethers.Contract(cfg.contracts.positionManager, u.NPM_ABI, provider);
  const factory = new ethers.Contract(cfg.contracts.factory, u.FACTORY_ABI, provider);

  const WETH_ADDR = (cfg.contracts.weth || "").toLowerCase();
  const STABLE_ADDR = ((cfg.usdReference && cfg.usdReference.stable) || "").toLowerCase();
  const isEth = (a) => a === ethers.ZeroAddress || String(a).toLowerCase() === WETH_ADDR;
  const isStable = (a) => !!STABLE_ADDR && String(a).toLowerCase() === STABLE_ADDR;

  let state = readJson(STATE_FILE, { positions: {}, sent: {} });
  let status = readJson(STATUS_FILE, { ok: true, at: 0, positions: [], recent: [] });
  const liveConfig = () => readJson(CONFIG_FILE, cfg);

  async function send(text) {
    log(`ALERT ${text.replace(/\n/g, " / ")}`);
    if (alerts && alerts.enabled) {
      try {
        if (alerts.sendGroup) await alerts.sendGroup(text); else await alerts.send(text);
      } catch (err) {
        log(`telegram failed: ${err.message}`);
      }
    }
  }

  /** ETH price in USD: the dashboard's payload, else the price log's newest hour. */
  function ethUsd() {
    const pl = positions();
    if (pl && pl.wethUsd) return pl.wethUsd;
    const log_ = readJson(path.join(dir, "price-log.json"), { hours: {} });
    const hours = Object.keys(log_.hours || {}).sort();
    for (let i = hours.length - 1; i >= 0; i--) if (log_.hours[hours[i]].eth) return log_.hours[hours[i]].eth;
    return null;
  }

  /** Every open position the dashboard knows, main wallet and every watched wallet, both versions. */
  function livePositions() {
    const out = [];
    const push = (p, wallet, walletAddress) => {
      out.push({ tokenId: bareId(p), version: Number(p.version) === 4 ? 4 : 3, pair: p.pair, wallet, walletAddress,
        token0: addrOf(p.token0), token1: addrOf(p.token1), since: p.pnlSince || null,
        outSince: p.range && p.range.streakInRange === false && p.range.streakSince ? p.range.streakSince : null });
    };
    const main = positions();
    if (main && Array.isArray(main.positions)) for (const p of main.positions) push(p, main.ownerLabel || "Main", main.owner || cfg.ownerAddress);
    for (const w of watched() || []) {
      if (!w || !w.ok) continue;
      for (const p of w.positions || []) push(p, w.label || w.address, w.address);
    }
    return out;
  }

  /** Token-per-quote price from the hourly price log nearest `t` (within 3h), or null. */
  function priceLogAt(tokenAddr, quoteAddr, t) {
    if (!tokenAddr || !t) return null;
    const pl = readJson(path.join(dir, "price-log.json"), { hours: {} });
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
   * The watch list for this cycle: config entries first (their rule block
   * wins), then discovered positions with the default rules. New discoveries
   * get their entry price from the price log at the mint time when it has the
   * token, else from their first sample (filled in by cycle()); closed ones
   * are dropped from the discovered file and never re-discovered.
   */
  function watchList(live, closedIds = new Set()) {
    const listed = (Array.isArray(live.memecoins) ? live.memecoins : []).map((m) => ({ ...m, tokenId: String(m.tokenId) }));
    const lp = livePositions();
    for (const m of listed) { // fill what a hand-written entry may lack from the live position
      const p = lp.find((x) => x.tokenId === m.tokenId);
      if (p) { m.version = m.version || p.version; m.walletAddress = m.walletAddress || p.walletAddress; m.wallet = m.wallet || p.wallet; m.pair = m.pair || p.pair; m.outSince = p.outSince; }
    }
    if (live.memecoinDiscovery === false) return listed;
    const discovered = readJson(DISCOVERED_FILE, []);
    const have = new Set([...listed, ...discovered].map((m) => String(m.tokenId)).concat([...closedIds]));
    let changed = false;
    for (const p of lp) {
      if (have.has(p.tokenId)) continue;
      const quote = isEth(p.token0) || (!isEth(p.token1) && isStable(p.token0)) ? p.token0 : p.token1;
      const token = quote === p.token0 ? p.token1 : p.token0;
      const atMint = priceLogAt(token, quote, p.since);
      const entry = { tokenId: p.tokenId, version: p.version, pair: p.pair, wallet: p.wallet, walletAddress: p.walletAddress,
        entryPrice: atMint || null, entrySource: atMint ? "price log at mint" : "first seen", entryAt: atMint ? p.since : null, discovered: true };
      discovered.push(entry);
      have.add(p.tokenId);
      changed = true;
      log(`discovered ${p.pair} #${p.tokenId} v${p.version} (${p.wallet})${atMint ? `, entry ${Math.round(atMint).toLocaleString("en-US")} from the price log at mint` : ", entry = first sample"}`);
    }
    if (changed) writeJson(DISCOVERED_FILE, discovered);
    const out = [...listed];
    for (const d of discovered) {
      if (listed.some((m) => m.tokenId === String(d.tokenId))) continue;
      const p = lp.find((x) => x.tokenId === String(d.tokenId));
      out.push({ ...d, tokenId: String(d.tokenId), outSince: p ? p.outSince : null });
    }
    return out;
  }

  /** Record a discovered entry's first-seen price, patch its rules, or drop a closed one. */
  function updateDiscovered(id, patch) {
    const rows = readJson(DISCOVERED_FILE, []);
    const i = rows.findIndex((r) => String(r.tokenId) === String(id));
    if (i < 0) return false;
    if (patch === null) rows.splice(i, 1); else Object.assign(rows[i], patch);
    writeJson(DISCOVERED_FILE, rows);
    return true;
  }

  /** Cumulative USDG the collector swept for a position (fee-split-ledger.json), for the collected-target rule. */
  function collectedFromLedger(id) {
    const rows = readJson(path.join(dir, "fee-split-ledger.json"), []);
    let sum = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
      const ids = Array.isArray(r.positionIds) ? r.positionIds.map(String) : [String(r.positionId)];
      if (ids.includes(String(id))) sum += (Number(r.totalCollectedUsdg) || 0) / Math.max(1, ids.length); // a multi-position pass shares its total equally
    }
    return sum;
  }

  /** One sample for a watched position: price (token per quote), pool liquidity, uncollected fees and value in USD. */
  async function sample(entry, wethUsd) {
    const owner = entry.walletAddress;
    const is4 = Number(entry.version) === 4;
    if (is4 && !hasV4) throw new Error("v4 contracts not configured");
    const p = is4
      ? await v4.loadPosition({ provider, posm, stateView, cfg: { ...cfg, ownerAddress: owner } }, entry.tokenId)
      : await u.loadPosition({ provider, npm, factory, cfg }, entry.tokenId);
    if (p.gone) return { gone: true };
    if (p.closed) return { closed: true };
    // The quote side is ETH when the pair has it, else the reference stable; prices are TOKEN PER QUOTE either way.
    const ethIs0 = isEth(p.token0.address), ethIs1 = isEth(p.token1.address);
    const quoteIs0 = ethIs0 ? true : ethIs1 ? false : isStable(p.token0.address) ? true : isStable(p.token1.address) ? false : true;
    const quote = quoteIs0 ? p.token0 : p.token1, token = quoteIs0 ? p.token1 : p.token0;
    const quoteUsd = isEth(quote.address) ? wethUsd : isStable(quote.address) ? 1 : null;
    const tokPerQuote = quoteIs0 ? p.prices.current : 1 / p.prices.current;
    const L = is4 ? await stateView.getLiquidity(p.poolAddress) : await new ethers.Contract(p.poolAddress, u.POOL_ABI, provider).liquidity();
    const f0 = Number(ethers.formatUnits(p.fees.amount0, p.token0.decimals));
    const f1 = Number(ethers.formatUnits(p.fees.amount1, p.token1.decimals));
    const a0 = Number(ethers.formatUnits(p.amounts.amount0, p.token0.decimals));
    const a1 = Number(ethers.formatUnits(p.amounts.amount1, p.token1.decimals));
    const tokUsd = quoteUsd != null && tokPerQuote > 0 ? quoteUsd / tokPerQuote : null;
    const usd0 = quoteIs0 ? quoteUsd : tokUsd, usd1 = quoteIs0 ? tokUsd : quoteUsd;
    const feeUsd = usd0 != null && usd1 != null ? f0 * usd0 + f1 * usd1 : null;
    const valueUsd = usd0 != null && usd1 != null ? a0 * usd0 + a1 * usd1 : null;
    return {
      t: now(), price: tokPerQuote, liq: Number(L), feeUsd, valueUsd, inRange: p.inRange,
      symbol0: p.token0.symbol, symbol1: p.token1.symbol, quoteSymbol: quote.symbol, tokenSymbol: token.symbol, tokenAddress: token.address, quoteAddress: quote.address,
      amountEth: quoteIs0 ? a0 : a1, amountToken: quoteIs0 ? a1 : a0, tickLower: p.tickLower, tickUpper: p.tickUpper, currentTick: p.currentTick,
    };
  }

  function appendLog(entry) {
    const rows = readJson(LOG_FILE, []);
    rows.push(entry);
    writeJson(LOG_FILE, rows);
  }

  /** Close one watched position now (the operator must be armed). Returns the log entry. */
  async function closeNow(entry, reason, who = "guardian") {
    const wallet = await closer.operatorWallet(provider);
    const base = { timestamp: new Date(now()).toISOString(), tokenId: String(entry.tokenId), pair: entry.pair, wallet: entry.wallet, walletAddress: entry.walletAddress, reason, by: who };
    if (!wallet) {
      const row = { ...base, status: "locked", error: "collector is locked; arm it first" };
      appendLog(row);
      await send(`⚠️ ${entry.pair}: close needed (${reason}) but the collector is locked. Arm it from the dashboard — nothing was sent.`);
      return row;
    }
    try {
      const is3 = Number(entry.version) === 3;
      const res = is3
        ? await closer.closeV3({ provider, cfg, tokenId: entry.tokenId, owner: entry.walletAddress, wallet })
        : await closer.closeV4({ provider, cfg, tokenId: entry.tokenId, owner: entry.walletAddress, wallet });
      const p = res.position;
      const ethIs0 = p && isEth(p.token0.address);
      const recovered = p && res.expect
        ? `${Number(ethers.formatUnits(ethIs0 ? res.expect.amount0 : res.expect.amount1, ethIs0 ? p.token0.decimals : p.token1.decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${ethIs0 ? p.token0.symbol : p.token1.symbol} + ${Number(ethers.formatUnits(ethIs0 ? res.expect.amount1 : res.expect.amount0, ethIs0 ? p.token1.decimals : p.token0.decimals)).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${ethIs0 ? p.token1.symbol : p.token0.symbol}`
        : "position value";
      const row = { ...base, status: "closed", tx: res.hash, block: res.block, gasEth: res.gasWei != null ? ethers.formatEther(res.gasWei) : null, recovered };
      appendLog(row);
      const st = state.positions[String(entry.tokenId)];
      if (st) st.closed = true;
      await send(`🚨 ${who === "manual" ? "Closed" : "Auto-closed"} ${entry.pair} — recovered ${recovered} to ${entry.wallet} (${reason}). tx ${String(res.hash).slice(0, 12)}…`);
      return row;
    } catch (err) {
      const row = { ...base, status: "failed", error: err.shortMessage || err.message };
      appendLog(row);
      await send(`❌ ${entry.pair}: close failed: ${row.error}`);
      return row;
    }
  }

  /** Find a watched entry (config or discovered) by id. */
  function entryFor(id) {
    const live = liveConfig();
    return [...(live.memecoins || []), ...readJson(DISCOVERED_FILE, [])].map((m) => ({ ...m, tokenId: String(m.tokenId) })).find((m) => m.tokenId === String(id)) || null;
  }

  /** Close by id, from the dashboard or the CLI. */
  async function closeById(id, reason = "manual close from the dashboard", who = "manual") {
    const entry = entryFor(id);
    if (!entry) throw new Error(`#${id} is not a watched position`);
    if (!entry.version || !entry.walletAddress) {
      const p = livePositions().find((x) => x.tokenId === String(id));
      if (p) { entry.version = p.version; entry.walletAddress = p.walletAddress; entry.wallet = entry.wallet || p.wallet; }
    }
    return closeNow(entry, reason, who);
  }

  /**
   * Change a position's rule block. A listed position is updated in
   * config.json; a discovered one in memecoin-discovered.json. Returns the
   * effective rules.
   */
  function setRule(id, patch = {}) {
    const next = {};
    for (const k of RULE_KEYS) {
      if (patch[k] === undefined) continue;
      if (patch[k] === null || patch[k] === "") next[k] = null;
      else if (isFinite(Number(patch[k])) && Number(patch[k]) >= 0) next[k] = Number(patch[k]);
      else throw new Error(`${k} must be a number`);
    }
    if (patch.autoClose !== undefined) { next.autoClose = patch.autoClose === true; if (next.autoClose) next.alertOnly = false; }
    if (patch.alertOnly !== undefined) next.alertOnly = patch.alertOnly !== false;
    if (patch.entryPrice !== undefined && Number(patch.entryPrice) > 0) { next.entryPrice = Number(patch.entryPrice); next.entrySource = "set by hand"; }
    const raw = readJson(CONFIG_FILE, null);
    if (!raw) throw new Error("config.json unreadable");
    const i = (raw.memecoins || []).findIndex((m) => String(m.tokenId) === String(id));
    if (i >= 0) {
      Object.assign(raw.memecoins[i], next);
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + "\n");
      return logic.rulesOf(raw.memecoins[i], raw.memecoinDefaults);
    }
    if (!updateDiscovered(id, next)) throw new Error(`#${id} is not a watched position`);
    return logic.rulesOf(entryFor(id), raw.memecoinDefaults);
  }

  async function cycle() {
    const live = liveConfig();
    const defaults = live.memecoinDefaults || {};
    const list = watchList(live, new Set(Object.entries(state.positions).filter(([, st]) => st.closed).map(([id]) => id)));
    const wethUsd = ethUsd();
    const statuses = [];
    const t = now();
    const alertsSent = [];
    for (const entry of list) {
      const id = String(entry.tokenId);
      const st = (state.positions[id] = state.positions[id] || { samples: [], closed: false });
      if (st.closed) continue;
      const lastSample = st.samples.length ? st.samples[st.samples.length - 1] : null;
      const interval = Number(entry.intervalSec) > 0 ? Number(entry.intervalSec) * 1000 : INTERVALS[Number(entry.version) === 3 ? 3 : 4];
      if (lastSample && t - lastSample.t < interval - 5000) { // not due: keep the previous status
        const prev = status.positions.find((p) => p.tokenId === id);
        if (prev) statuses.push(prev);
        continue;
      }
      let s;
      try {
        s = await sample(entry, wethUsd);
      } catch (err) {
        log(`#${id} ${entry.pair}: read failed: ${err.shortMessage || err.message}`);
        const prev = status.positions.find((p) => p.tokenId === id);
        if (prev) statuses.push(prev);
        continue;
      }
      if (s.gone || s.closed) {
        st.closed = true;
        log(`#${id} ${entry.pair}: position is ${s.gone ? "no longer owned" : "closed"}; watching stops`);
        if (entry.discovered) updateDiscovered(id, null);
        statuses.push({ tokenId: id, pair: entry.pair, wallet: entry.wallet, version: entry.version, closed: true, at: t });
        continue;
      }
      if (!(Number(entry.entryPrice) > 0) && s.price > 0) {
        entry.entryPrice = s.price;
        entry.entryAt = s.t;
        entry.entrySource = "first seen";
        if (entry.discovered) updateDiscovered(id, { entryPrice: s.price, entryAt: s.t, entrySource: "first seen" });
      }
      st.samples.push(s);
      st.samples = st.samples.filter((x) => t - x.t <= KEEP_MS);
      const rules = logic.rulesOf(entry, defaults);
      if (rules.collectedTargetUsd != null) entry.collectedUsd = collectedFromLedger(id);
      const d = logic.derive(entry, st.samples, t, defaults);
      Object.assign(d, { symbolToken: s.tokenSymbol, quoteSymbol: s.quoteSymbol, amountEth: s.amountEth, amountToken: s.amountToken, wethUsd, tickLower: s.tickLower, tickUpper: s.tickUpper, currentTick: s.currentTick, samples: st.samples.length,
        entrySource: entry.entrySource || "config", entryAt: entry.entryAt || null, discovered: !!entry.discovered, intervalSec: interval / 1000 });
      // Auto-close needs the trigger to hold for CONFIRM_CYCLES consecutive
      // cycles with the pool price stable within 10% between cycles, so one
      // bad RPC read or a single-block wick cannot close a position.
      const reason = logic.shouldClose(d);
      st.confirm = st.confirm || { n: 0, lastPrice: null };
      for (const text of logic.alertsFor(d, state.sent, t, 60 * 60000, { closing: !!reason })) { await send(text); alertsSent.push(text); }
      if (reason) {
        const agrees = st.confirm.lastPrice == null || !(d.price > 0) || Math.abs(d.price - st.confirm.lastPrice) / st.confirm.lastPrice <= 0.10;
        st.confirm.n = agrees ? st.confirm.n + 1 : 1;
        st.confirm.lastPrice = d.price > 0 ? d.price : st.confirm.lastPrice;
        d.closeConfirm = `${st.confirm.n}/${CONFIRM_CYCLES}`;
        const last = state.sent[`close:${id}`] || 0;
        if (st.confirm.n >= CONFIRM_CYCLES && t - last > 30 * 60000) {
          state.sent[`close:${id}`] = t;
          const row = await closeNow(entry, reason, "auto");
          d.lastClose = row;
          if (row.status === "closed") st.closed = true;
          else st.confirm.n = 0; // a failed or locked attempt starts the confirmation over; retried after the 30-min cool-down
        }
      } else st.confirm.n = 0;
      statuses.push(d);
      log(`#${id} ${entry.pair}: ${d.status} price ${d.price.toLocaleString("en-US", { maximumFractionDigits: 0 })} (${d.priceVsEntryPct == null ? "no entry" : (d.priceVsEntryPct >= 0 ? "+" : "") + d.priceVsEntryPct.toFixed(1) + "% vs entry"}) ${d.inRange ? "in range" : "OUT " + Math.round(d.outMinutes) + "m"} fees $${(d.feeUsd || 0).toFixed(2)}${d.feesPerHour != null ? " (" + d.feesPerHour.toFixed(2) + "/h)" : ""} liq ${d.liqDropFromMaxPct == null ? "" : "-" + d.liqDropFromMaxPct.toFixed(0) + "% vs 24h max"}`);
    }
    writeJson(STATE_FILE, state);
    status = { ok: true, at: t, wethUsd, positions: statuses, recent: readJson(LOG_FILE, []).slice(-10).reverse(), defaults: logic.rulesOf({}, defaults), discovery: live.memecoinDiscovery !== false };
    writeJson(STATUS_FILE, status);
    return { statuses, alerts: alertsSent };
  }

  return { cycle, closeNow, closeById, setRule, entryFor, watchList, get status() { return status; }, get state() { return state; } };
}

module.exports = { create, INTERVALS };

if (require.main === module) {
  const DASHBOARD = `http://127.0.0.1:${process.env.LP_DASHBOARD_PORT || 8787}`;
  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
  let payload = null, wallets = null;
  async function refresh() {
    const getJson = async (p) => { const r = await fetch(`${DASHBOARD}${p}`, { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`); return r.json(); };
    try { const j = await getJson("/api/positions"); if (j && j.ok) payload = j; } catch (err) { log(`dashboard: /api/positions failed: ${err.message}`); }
    try { const j = await getJson("/api/watch"); if (j && j.ok) wallets = j.wallets || []; } catch (err) { log(`dashboard: /api/watch failed: ${err.message}`); }
  }
  let alerts = null;
  try { alerts = require("./alerts").create(); } catch {}
  const g = create({ alerts, log, positions: () => payload, watched: () => wallets });
  const args = process.argv.slice(2);
  (async () => {
    if (args[0] === "--close") {
      await refresh();
      const row = await g.closeById(String(args[1] || ""), args[2] || "manual close from the dashboard", "manual");
      console.log(JSON.stringify(row));
      process.exit(row.status === "closed" ? 0 : 2);
    }
    log("guardian started: every open position of every wallet, v4 every 60 s, v3 every 5 min");
    for (;;) {
      await refresh();
      try { await g.cycle(); } catch (err) { log(`cycle failed: ${err.shortMessage || err.message}`); }
      if (args.includes("--once")) return;
      await new Promise((r) => setTimeout(r, 60 * 1000));
    }
  })().catch((err) => { console.error(err.message); process.exit(1); });
}
