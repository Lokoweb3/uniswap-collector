#!/usr/bin/env node
require("dotenv").config();
/**
 * Local dashboard server. Reads never load a key and never send a transaction;
 * your RPC endpoint stays on this machine and is never exposed to the browser,
 * which also sidesteps CORS entirely.
 *
 * The one write path is POST /api/collect, which runs `run-collector.sh
 * collect` on this machine — the same flow as the CLI: operator keystore plus
 * the /dev/shm unlock window. No key material ever reaches the browser, and
 * with no live unlock the run logs "locked" and does nothing. The endpoint is
 * disabled unless the server is bound to 127.0.0.1 (override with
 * LP_ALLOW_REMOTE_COLLECT=1 if you know what you're doing).
 *
 *   node server.js          -> http://127.0.0.1:8787
 *   node server.js --port=9000
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ethers } = require("ethers");
// Tolerate a flattened layout (some downloads drop lib/), but resolve the path
// explicitly rather than try/catch around require -- that would report a syntax
// error inside univ3.js as a missing module.
const univ3Path = fs.existsSync(path.join(__dirname, "lib", "univ3.js"))
  ? "./lib/univ3"
  : "./univ3";
const u = require(univ3Path);

const history = require("./history");

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const portArg = process.argv.find((a) => a.startsWith("--port="));
const PORT = portArg ? Number(portArg.split("=")[1]) : (cfg.dashboard && cfg.dashboard.port) || 8787;

// WSL forwards Windows localhost to a service bound on 127.0.0.1 inside the
// distro. If that forwarding is disabled or mirrored networking gets in the
// way, LP_BIND=0.0.0.0 makes it reachable -- at the cost of exposing it to
// anything else on your network.
const HOST = process.env.LP_BIND || "127.0.0.1";
// LP_READONLY=1: this copy has no collector or keystore (a VM). The collect
// and arm endpoints refuse, and the page hides those controls. The ops strip
// still shows the last run, from files the collector machine pushes here.
const READONLY = process.env.LP_READONLY === "1";
// Background loops (risk guardian, fee auto-collect, nightly backup) and the
// companion services (gate, remote MCP, tailscale) run only in the main
// dashboard process: the configured port, not read-only, not --no-loops. A
// second server (the smoke test on 8799, a VM copy) is a plain viewer.
const MAIN_PORT = (cfg.dashboard && cfg.dashboard.port) || 8787;
const LOOPS = PORT === MAIN_PORT && !READONLY && !process.argv.includes("--no-loops");
const SERVICES = LOOPS && !process.argv.includes("--no-services");
const STARTED_AT = Date.now();
const timers = { guardian: { lastAt: 0 }, autoCollect: { lastAt: 0 }, backup: { lastAt: 0, lastResult: null } };
let guardian = null, autoCollect = null;

const CACHE_MS = 60_000;
let cache = { at: 0, payload: null };
let buildInFlight = null;

const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
const npm = new ethers.Contract(cfg.contracts.positionManager, u.NPM_ABI, provider);
const factory = new ethers.Contract(cfg.contracts.factory, u.FACTORY_ABI, provider);

// Uniswap v4, read-only. Absent from config = v3 only.
const v4 = require("./univ4");
const V4 = cfg.contracts.v4 && cfg.contracts.v4.positionManager
  ? {
      posm: new ethers.Contract(cfg.contracts.v4.positionManager, v4.POSM_ABI, provider),
      stateView: new ethers.Contract(cfg.contracts.v4.stateView, v4.STATE_VIEW_ABI, provider),
      discovery: v4.createDiscovery({
        provider,
        posmAddress: cfg.contracts.v4.positionManager,
        owner: cfg.ownerAddress,
        explorerApi: "https://robinhoodchain.blockscout.com/api",
      }),
    }
  : null;
// v4 ids share a number space with v3 ids, so they carry a prefix everywhere
// a position is keyed: payloads, snapshots, the daily ledger.
const v4Key = (id) => `v4-${id}`;
const isV4Key = (k) => String(k).startsWith("v4-");

const WETH = cfg.contracts.weth.toLowerCase();

// Operator address, read from the keystore's public address field — no
// passphrase involved. Used only to flag open positions the operator cannot
// collect from yet (new mints won't be approved until you approve them).
let OPERATOR = null;
try {
  const ksPath =
    process.env.LP_KEYSTORE_PATH ||
    path.join(process.env.HOME || "", ".lp-collector", "operator-keystore.json");
  const ks = JSON.parse(fs.readFileSync(ksPath, "utf8"));
  OPERATOR = ethers.getAddress("0x" + ks.address.replace(/^0x/, ""));
} catch {
  // No keystore on this machine: skip approval checks rather than fail reads.
}

/** WETH price in USD, read straight from a reference stable pool's slot0. */
async function getWethUsd(blockTag) {
  const ref = cfg.usdReference;
  if (!ref || !ref.stable) return null;
  try {
    const poolAddr = await factory.getPool(cfg.contracts.weth, ref.stable, ref.feeTier);
    if (poolAddr === ethers.ZeroAddress) return null;

    const pool = new ethers.Contract(poolAddr, u.POOL_ABI, provider);
    const slot0 = await pool.slot0(blockTag != null ? { blockTag } : {});
    const [t0, t1] = await Promise.all([
      u.getToken(cfg.contracts.weth, provider),
      u.getToken(ref.stable, provider),
    ]);

    // Pool orders tokens by address; work out which side WETH landed on.
    const wethIsToken0 = cfg.contracts.weth.toLowerCase() < ref.stable.toLowerCase();
    const d0 = wethIsToken0 ? t0.decimals : t1.decimals;
    const d1 = wethIsToken0 ? t1.decimals : t0.decimals;
    const p = u.priceFromSqrt(slot0.sqrtPriceX96, d0, d1);
    return wethIsToken0 ? p : 1 / p;
  } catch {
    return null;
  }
}

function toFloat(amountStr, decimals) {
  return Number(ethers.formatUnits(amountStr, decimals));
}

/**
 * Price each side in USD. A token gets a price when its pool pairs it with
 * WETH; anything else is left null rather than guessed at.
 */
const STABLE = ((cfg.usdReference && cfg.usdReference.stable) || "").toLowerCase();
function priceSides(p, wethUsd) {
  const a0 = p.token0.address.toLowerCase(), a1 = p.token1.address.toLowerCase();
  // Native ETH (v4 pools) is priced as WETH.
  const t0IsWeth = a0 === WETH || a0 === ethers.ZeroAddress;
  const t1IsWeth = a1 === WETH || a1 === ethers.ZeroAddress;
  if (wethUsd == null) return { usd0: null, usd1: null };

  if (t1IsWeth) return { usd0: p.prices.current * wethUsd, usd1: wethUsd };
  if (t0IsWeth) return { usd0: wethUsd, usd1: (1 / p.prices.current) * wethUsd };
  // Pairs against the reference stable: take it at a dollar.
  if (STABLE && a1 === STABLE) return { usd0: p.prices.current, usd1: 1 };
  if (STABLE && a0 === STABLE) return { usd0: 1, usd1: 1 / p.prices.current };
  return { usd0: null, usd1: null };
}

const hist = history.create({ provider, npmAddress: cfg.contracts.positionManager });
const basis = require("./basis");
const bf = basis.create({ npmAddress: cfg.contracts.positionManager });
// Pool stats (TVL, fees, APR, siblings) from the scanner on :3847; see pools.js.
const pools = require("./pools").create({ cfg, provider });

// Extra wallets to show read-only (config.watchWallets); see watch.js.
const watch = require("./watch").create({
  provider, npm, factory, cfg, u, v4, V4, priceSides, toFloat, getWethUsd, pools,
  getPortfolio: () => portfolio, // created below; only used at refresh time
  getPrices: () => lastPrices,
  getOperator: () => require("./arm").operatorAddress(), // keystore's public address, re-read each time
  // === performance-attribution === PnL vs HODL for watched positions: liquidity ledger basis + collect events
  getBasis: (tokenId) => {
    const id = String(tokenId);
    if (id.startsWith("v4-")) return typeof ledgerV4 !== "undefined" && ledgerV4 ? ledgerV4.basis(id.slice(3)) : null;
    return typeof ledger !== "undefined" ? ledger.basis(id) : null;
  },
  getCollectEvents: (tokenId) => (typeof hist !== "undefined" ? hist.events.filter((e) => e.tokenId === String(tokenId)) : []),
  getCollectSummary: (tokenKey, dec0, dec1, usd0, usd1) => collectSummary(tokenKey, dec0, dec1, usd0, usd1),
});
// Liquidity history from the RPC itself; the PnL basis prefers it over
// Blockscout's, which has dropped transactions on this chain.
const ledger = require("./ledger").create({
  provider,
  npmAddress: cfg.contracts.positionManager,
  forwardStart: hist.startBlock,
});
// v4 liquidity ledger (ledger-v4.js): ModifyLiquidity events on the PoolManager
// keyed by the salt (tokenId), in the v3 ledger's shape so the PnL views and
// strategy.js treat v4 positions the same way. Only when v4 is configured.
const ledgerV4 = V4 && cfg.contracts.v4.poolManager && cfg.contracts.v4.stateView
  ? require("./ledger-v4").create({
      provider,
      poolManager: cfg.contracts.v4.poolManager,
      posm: V4.posm,
      posmAddress: cfg.contracts.v4.positionManager,
      stateView: cfg.contracts.v4.stateView,
      forwardStart: hist.startBlock,
    })
  : null;
// Portfolio: every token held, in the wallet or inside positions, valued.
const portfolio = require("./portfolio").create({
  provider,
  factory,
  cfg,
  explorerApi: "https://robinhoodchain.blockscout.com/api",
});
// addr -> { amount, fees } in token units, summed over open positions by
// the last build, for the portfolio's per-token view.
let lastPoolHoldings = new Map();

// -- Daily revenue ledger ------------------------------------------------------
// Hourly buckets of fee accrual per position, in USD at the prices of the
// moment, derived from consecutive snapshots. Persistent and never pruned, so
// the daily view outlives the 7-day snapshot window. Keyed by the UTC hour
// (epoch ms); the browser folds hours into its own local days.
const DAILY_FILE = path.join(__dirname, "fee-daily.json");
let daily = { hours: {} };
try {
  daily = JSON.parse(fs.readFileSync(DAILY_FILE, "utf8"));
  if (!daily.hours) daily.hours = {};
} catch {}

function addAccrual(t, tokenId, usd) {
  if (!(usd > 0)) return;
  const h = String(Math.floor(t / 3600000) * 3600000);
  const b = daily.hours[h] || (daily.hours[h] = {});
  b[tokenId] = +((b[tokenId] || 0) + usd).toFixed(4);
}

function saveDaily() {
  try {
    fs.writeFileSync(DAILY_FILE, JSON.stringify(daily));
  } catch {}
}

/**
 * Fees earned by one position since the previous snapshot, in USD at today's
 * prices. Fee token amounts only grow between collects, so token deltas are
 * free of price noise; a drop means a collect happened and what remains is the
 * accrual since it (the few minutes between the previous snapshot and the
 * collect are lost). Snapshots older than this ledger carry only USD, so they
 * fall back to a USD delta with the same collect heuristic the rate uses.
 */
function accrualSince(prev, pos) {
  const id = pos.tokenId;
  if (prev.f && prev.f[id] && pos.usd0 != null && pos.usd1 != null) {
    const [p0, p1] = prev.f[id];
    const collected = pos.fee0 < p0 || pos.fee1 < p1;
    const d0 = collected ? pos.fee0 : pos.fee0 - p0;
    const d1 = collected ? pos.fee1 : pos.fee1 - p1;
    return d0 * pos.usd0 + d1 * pos.usd1;
  }
  if (prev.p && prev.p[id] != null && pos.feesUsd != null) {
    const pv = prev.p[id];
    return pos.feesUsd < pv * 0.8 ? pos.feesUsd : Math.max(0, pos.feesUsd - pv);
  }
  return 0;
}

// -- Range log: when each position is earning ---------------------------------
// One segment per stretch of "in range" or "out of range", per position,
// persisted and never pruned. Observations come from every build; a gap of
// more than 30 minutes between observations (server down) ends the segment
// so downtime is not counted as either state. Time in range is the share of
// observed time spent earning, which is the honest measure of whether a range
// was chosen well, and it weights the projection.
const RANGE_FILE = path.join(__dirname, "range-log.json");
const RANGE_GAP_MS = 30 * 60 * 1000;
let rangeLog = { positions: {} };
try {
  rangeLog = JSON.parse(fs.readFileSync(RANGE_FILE, "utf8"));
  if (!rangeLog.positions) rangeLog.positions = {};
} catch {}

function observeRange(tokenId, inRange, t) {
  const e = rangeLog.positions[tokenId] || (rangeLog.positions[tokenId] = { segments: [] });
  const last = e.segments[e.segments.length - 1];
  if (last && last.to == null) {
    if (t - last.last > RANGE_GAP_MS) last.to = last.last; // unobserved gap
    else if (last.inRange === inRange) { last.last = t; return; }
    else last.to = t;
  }
  e.segments.push({ from: t, to: null, last: t, inRange });
}

function closeRanges(openIds, t) {
  const open = new Set(openIds);
  for (const [id, e] of Object.entries(rangeLog.positions)) {
    const last = e.segments[e.segments.length - 1];
    if (last && last.to == null && !open.has(id)) last.to = Math.min(t, last.last + RANGE_GAP_MS);
  }
}

function saveRangeLog() {
  try {
    fs.writeFileSync(RANGE_FILE, JSON.stringify(rangeLog));
  } catch {}
}

function rangeStats(tokenId, now = Date.now()) {
  const e = rangeLog.positions[tokenId];
  if (!e || !e.segments.length) return null;
  let tracked = 0, earning = 0, flips = 0, prev = null;
  for (const seg of e.segments) {
    const end = seg.to == null ? Math.min(now, seg.last + RANGE_GAP_MS) : seg.to;
    const ms = Math.max(0, end - seg.from);
    tracked += ms;
    if (seg.inRange) earning += ms;
    if (prev != null && prev !== seg.inRange) flips++;
    prev = seg.inRange;
  }
  // Current streak: walk back over same-state segments (gap splits included).
  let i = e.segments.length - 1;
  const state = e.segments[i].inRange;
  while (i > 0 && e.segments[i - 1].inRange === state) i--;
  return {
    pctInRange: tracked ? (earning / tracked) * 100 : null,
    trackedHours: tracked / 3600000,
    since: e.segments[0].from,
    flips,
    streakInRange: state,
    streakSince: e.segments[i].from,
  };
}

// -- Fee snapshots: the raw material for accrual rates ------------------------
const SNAP_FILE = path.join(__dirname, "fee-snapshots.json");
let snaps = [];
try {
  snaps = JSON.parse(fs.readFileSync(SNAP_FILE, "utf8"));
} catch {}

// First run with the range log: replay the price snapshots against each
// position's bounds (a v3 range never moves), so time in range starts with
// the days already observed. Needs the bounds, so it runs after the first
// build; see seedRangeLog().
let rangeSeeded = Object.keys(rangeLog.positions).length > 0;
function seedRangeLog(positions) {
  if (rangeSeeded) return;
  rangeSeeded = true;
  const byId = new Map(positions.map((p) => [p.tokenId, p]));
  for (const s of snaps) {
    if (!s.px) continue;
    for (const [id, px] of Object.entries(s.px)) {
      const p = byId.get(id);
      if (!p || p.priceLower == null || p.priceUpper == null) continue;
      observeRange(id, px >= p.priceLower && px < p.priceUpper, s.t);
    }
  }
}

// First run with the ledger: replay whatever snapshot history exists so the
// daily view starts with the days already observed rather than from now.
if (!Object.keys(daily.hours).length && snaps.length > 1) {
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1], cur = snaps[i];
    for (const id of Object.keys(cur.p || {})) {
      addAccrual(cur.t, id, accrualSince(prev, { tokenId: id, feesUsd: cur.p[id] }));
    }
  }
  saveDaily();
}

function appendSnapshot(positions, wethUsd) {
  const now = Date.now();
  if (snaps.length && now - snaps[snaps.length - 1].t < 5 * 60 * 1000) return;
  const prev = snaps.length ? snaps[snaps.length - 1] : null;
  const p = {};
  const px = {};
  const f = {};
  let tv = 0;
  for (const pos of positions) {
    if (pos.feesUsd != null) p[pos.tokenId] = +pos.feesUsd.toFixed(4);
    if (pos.priceCurrent != null) px[pos.tokenId] = pos.priceCurrent;
    if (pos.fee0 != null && pos.fee1 != null) f[pos.tokenId] = [pos.fee0, pos.fee1];
    tv += pos.valueUsd || 0;
    if (prev) addAccrual(now, pos.tokenId, accrualSince(prev, pos));
  }
  saveDaily();
  // Per-token USD prices and the WETH price ride along, so a collect found
  // later can be valued at the prices of its moment.
  const uMap = {};
  for (const [a, v] of Object.entries(lastPrices)) if (v != null) uMap[a] = +v.toPrecision(6);
  snaps.push({ t: now, p, px, f, u: uMap, w: wethUsd != null ? +wethUsd.toFixed(2) : null, tv: +tv.toFixed(2) });
  const cutoff = now - 7 * 86400 * 1000;
  while (snaps.length && snaps[0].t < cutoff) snaps.shift();
  try {
    fs.writeFileSync(SNAP_FILE, JSON.stringify(snaps));
  } catch {}
}

/**
 * Accrual rate from the last 48h of snapshots. A collect resets uncollected
 * fees to ~zero, so only the segment after the most recent big drop counts.
 */
function rateFor(tokenId) {
  const now = Date.now();
  const pts = snaps
    .filter((s) => s.t >= now - 48 * 3600 * 1000 && s.p[tokenId] != null)
    .map((s) => ({ t: s.t, v: s.p[tokenId] }));
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].v < pts[i - 1].v * 0.8) start = i;
  }
  const seg = pts.slice(start);
  if (seg.length < 2) return { spark: pts, dailyUsd: null, windowH: null };
  const dtMs = seg[seg.length - 1].t - seg[0].t;
  if (dtMs < 45 * 60 * 1000) return { spark: pts, dailyUsd: null, windowH: null };
  const dv = seg[seg.length - 1].v - seg[0].v;
  return { spark: pts, dailyUsd: (Math.max(0, dv) / dtMs) * 86400 * 1000, windowH: dtMs / 3600000 };
}

/** 7-day total-portfolio-value series, decimated for the wire. */
function tvSeries() {
  const cutoff = Date.now() - 7 * 86400 * 1000;
  const pts = snaps.filter((s) => s.t >= cutoff && s.tv != null).map((s) => ({ t: s.t, v: s.tv }));
  const step = Math.max(1, Math.ceil(pts.length / 120));
  return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
}

/** 7-day pool-price series for one position, decimated for the wire. */
function pxSeriesFor(tokenId) {
  const cutoff = Date.now() - 7 * 86400 * 1000;
  const pts = snaps
    .filter((s) => s.t >= cutoff && s.px && s.px[tokenId] != null)
    .map((s) => ({ t: s.t, v: s.px[tokenId] }));
  const step = Math.max(1, Math.ceil(pts.length / 120));
  return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
}

// -- Prices at collect time ----------------------------------------------------
// A collect's value is locked at the prices of its moment: pool state at its
// block while this RPC still serves it (about an hour), else the nearest fee
// snapshot within three hours. Keyed by tx and tokenId so it survives the
// backfill being rebuilt. Collects older than both fall back to today's
// prices at display time, and are marked as such.
const PRICE_FILE = path.join(__dirname, "fee-prices.json");
let feePrices = {};
try {
  feePrices = JSON.parse(fs.readFileSync(PRICE_FILE, "utf8"));
} catch {}
const priceKey = (e) => `${e.tx}:${e.tokenId}`;
/**
 * What a position has paid out so far: every collect event for it (v3 scanned,
 * v4 from the collector's and the owner's ledgers), valued at the collect-time
 * price record when there is one, else at the prices given. For the cards.
 */
function collectSummary(tokenKey, dec0, dec1, usd0, usd1) {
  let usd = 0, count = 0, last = null, locked = 0;
  const events = typeof hist !== "undefined" ? [...(typeof bf !== "undefined" ? bf.events : []), ...hist.events] : [];
  for (const e of events) {
    if (e.tokenId !== String(tokenKey)) continue;
    const f0 = Number(ethers.formatUnits(e.fee0 || "0", dec0)), f1 = Number(ethers.formatUnits(e.fee1 || "0", dec1));
    const px = feePrices[priceKey(e)];
    if (px) { usd += f0 * px.p0 + f1 * px.p1; locked++; }
    else if (usd0 != null && usd1 != null) usd += f0 * usd0 + f1 * usd1;
    count++;
    if (e.t && (!last || e.t > last)) last = e.t;
  }
  return count ? { usd: +usd.toFixed(2), count, last, atCollectPrices: locked, approx: locked < count } : null;
}
const STATE_DEPTH = 4500; // probed: slot0 answers at -5000 blocks, not at -50000

async function pricesAtBlock(m, block) {
  const poolAddr = await factory.getPool(m.t0.address, m.t1.address, m.fee);
  if (poolAddr === ethers.ZeroAddress) return null;
  const pool = new ethers.Contract(poolAddr, u.POOL_ABI, provider);
  const [slot0, w] = await Promise.all([pool.slot0({ blockTag: block }), getWethUsd(block)]);
  if (w == null) return null;
  const price = u.priceFromSqrt(slot0.sqrtPriceX96, m.t0.decimals, m.t1.decimals);
  const { usd0, usd1 } = priceSides({ token0: m.t0, token1: m.t1, prices: { current: price } }, w);
  if (usd0 == null || usd1 == null) return null;
  return { p0: usd0, p1: usd1, w, src: "block" };
}

function pricesFromSnapshot(m, t) {
  let best = null;
  for (const s of snaps) {
    if (!s.u || s.w == null) continue;
    const d = Math.abs(s.t - t);
    if (d <= 3 * 3600 * 1000 && (!best || d < best.d)) best = { s, d };
  }
  if (!best) return null;
  const p0 = best.s.u[m.t0.address.toLowerCase()], p1 = best.s.u[m.t1.address.toLowerCase()];
  if (p0 == null || p1 == null) return null;
  return { p0, p1, w: best.s.w, src: "snapshot" };
}

// -- Hourly price log ---------------------------------------------------------
// USD price of every token worth holding (in a position, or ≥ $1 in any wallet
// incl. watched ones) once an hour, kept for 400 days, so a collect or reward
// can always be valued at the price of its own hour instead of today's.
const PRICE_LOG_FILE = path.join(__dirname, "price-log.json");
let priceLog = { hours: {} };
try {
  priceLog = JSON.parse(fs.readFileSync(PRICE_LOG_FILE, "utf8"));
} catch {}
function recordPriceLog() {
  const hour = String(Math.floor(Date.now() / 3600000) * 3600000);
  if (priceLog.hours[hour]) return;
  const row = {};
  const put = (addr, price) => {
    if (addr && price != null && isFinite(price) && price > 0) row[String(addr).toLowerCase()] = +Number(price).toPrecision(6);
  };
  for (const [a, p] of Object.entries(lastPrices)) put(a, p); // position tokens
  const pf = portfolio.latest;
  if (pf) {
    if (pf.wethUsd) row.eth = +Number(pf.wethUsd).toPrecision(6);
    for (const r of pf.rows) if (r.address && r.price != null && (r.usd || 0) >= 1) put(r.address, r.price);
  }
  for (const w of (watch.latest && watch.latest.wallets) || []) {
    for (const t of (w.holdings && w.holdings.tokens) || []) if (t.address && t.price != null && (t.usd || 0) >= 1) put(t.address, t.price);
    for (const p of w.positions || []) {
      if (p.token0 && p.token0 !== ethers.ZeroAddress) put(p.token0, p.usd0);
      if (p.token1 && p.token1 !== ethers.ZeroAddress) put(p.token1, p.usd1);
    }
  }
  if (!Object.keys(row).length) return;
  priceLog.hours[hour] = row;
  const cutoff = Date.now() - 400 * 86400000;
  for (const h of Object.keys(priceLog.hours)) if (Number(h) < cutoff) delete priceLog.hours[h];
  try {
    fs.writeFileSync(PRICE_LOG_FILE, JSON.stringify(priceLog));
  } catch {}
}
/** Prices for a position's pair from the hourly log, nearest hour within 3h of `t`. */
function pricesFromLog(m, t) {
  let best = null;
  for (const h of Object.keys(priceLog.hours)) {
    const d = Math.abs(Number(h) - t);
    if (d <= 3 * 3600 * 1000 && (!best || d < best.d)) best = { h, d };
  }
  if (!best) return null;
  const row = priceLog.hours[best.h];
  const logKey = (t) => (t.address === ethers.ZeroAddress ? "eth" : t.address.toLowerCase()); // v4 native leg
  const p0 = row[logKey(m.t0)], p1 = row[logKey(m.t1)];
  if (p0 == null || p1 == null || row.eth == null) return null;
  return { p0, p1, w: row.eth, src: "pricelog" };
}

// -- Combined portfolio history --------------------------------------------------
// Hourly total value of the main wallet and each watched wallet, kept forever,
// for the all-wallets and per-wallet value charts.
const ALL_FILE = path.join(__dirname, "portfolio-all.json");
let allSeries = { points: [] };
try {
  allSeries = JSON.parse(fs.readFileSync(ALL_FILE, "utf8"));
} catch {}
function recordAllWallets() {
  const pf = portfolio.latest, wl = watch.latest;
  if (!pf) return;
  const last = allSeries.points[allSeries.points.length - 1];
  if (last && Date.now() - last.t < 3600000) return;
  const wallets = {};
  for (const w of (wl && wl.wallets) || []) if (w.ok && w.totals) wallets[w.address.toLowerCase()] = +w.totals.totalUsd.toFixed(2);
  const owner = +pf.totals.totalUsd.toFixed(2);
  const total = +(owner + Object.values(wallets).reduce((a, b) => a + b, 0)).toFixed(2);
  allSeries.points.push({ t: Date.now(), owner, wallets, total });
  try {
    fs.writeFileSync(ALL_FILE, JSON.stringify(allSeries));
  } catch {}
}
function allWalletsView() {
  const pts = allSeries.points;
  const step = Math.max(1, Math.ceil(pts.length / 400));
  return { ok: true, points: pts.filter((_, i) => i % step === 0 || i === pts.length - 1) };
}

async function priceEvents() {
  const head = await provider.getBlockNumber().catch(() => null);
  let changed = 0;
  for (const e of [...hist.events, ...bf.events]) {
    const k = priceKey(e);
    if (feePrices[k]) continue;
    let px = null;
    try {
      const m = await eventMeta(e);
      // v4 rows (from v4-collects.json) have no v3 pool to read at the block; the hourly price log is their record.
      if (!isV4Key(e.tokenId) && head != null && head - e.block <= STATE_DEPTH) px = await pricesAtBlock(m, e.block).catch(() => null);
      if (!px && e.t && !isV4Key(e.tokenId)) px = pricesFromSnapshot(m, e.t);
      if (!px && e.t) px = pricesFromLog(m, e.t);
    } catch {}
    if (px) {
      feePrices[k] = { p0: +px.p0.toPrecision(8), p1: +px.p1.toPrecision(8), w: +px.w.toFixed(2), src: px.src, t: e.t };
      changed++;
    }
  }
  if (changed) {
    try {
      fs.writeFileSync(PRICE_FILE, JSON.stringify(feePrices));
    } catch {}
  }
  return changed;
}

// Latest per-token USD prices and discovered ids, refreshed by build() and
// used to value history events and drive the background scanner.
let lastPrices = {};
let lastWethUsdSeen = null;
let latestIds = [];
let latestOpenIds = [];
// Every token seen across positions, for the owner-balances panel.
const tokenSet = new Map(); // addrLower -> { address, symbol, decimals }

/** Every operator the owner has ever granted setApprovalForAll on `mgr`, with its current state (from events, re-checked on chain). */
async function approvedOperators(provider, mgr, owner) {
  const iface = new ethers.Interface(["event ApprovalForAll(address indexed owner,address indexed operator,bool approved)"]);
  const c = new ethers.Contract(mgr, ["function isApprovedForAll(address,address) view returns (bool)"], provider);
  let logs = [];
  try {
    logs = await provider.getLogs({ address: mgr, fromBlock: 0, toBlock: "latest", topics: [iface.getEvent("ApprovalForAll").topicHash, ethers.zeroPadValue(owner, 32)] });
  } catch {
    return [];
  }
  const seen = new Map();
  for (const l of logs) seen.set(iface.parseLog(l).args.operator, true);
  const out = [];
  for (const op of seen.keys()) out.push({ address: op, approved: await c.isApprovedForAll(owner, op).catch(() => null) });
  return out;
}

// -- Last run + gas budget, for the ops strip --------------------------------
function opsInfo() {
  let gas24h = 0;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));
    const cut = Date.now() - 86400 * 1000;
    for (const g of st.gasSpends || []) {
      if (g.t >= cut) gas24h += Number(g.wei) / 1e18;
    }
  } catch {}

  // Last run, with failures attributed per wallet pass (see ops.js).
  let lastRun = null;
  try {
    const lines = fs.readFileSync(path.join(__dirname, "collector.log"), "utf8").split("\n").slice(-600);
    lastRun = require("./ops").parseLastRun(lines);
  } catch {}

  return { lastRun, gas24h: { eth: gas24h, capEth: Number(cfg.thresholds && cfg.thresholds.dailyGasCapEth) || 0 } };
}

// Every wallet whose collects are recorded: the main wallet (ids from the
// last build) and each wallets.json wallet (v3 ids enumerated on the NPM,
// closed positions included so past collects are found). Cached briefly.
let historyWalletsCache = { at: 0, list: [] };
async function historyWallets() {
  if (Date.now() - historyWalletsCache.at < 9 * 60 * 1000 && historyWalletsCache.list.length) return historyWalletsCache.list;
  const list = [{ address: cfg.ownerAddress, label: watch.ownerLabel() || "Main", ids: latestIds.filter((id) => !isV4Key(id)), main: true }];
  for (const w of watch.readWallets()) {
    try {
      const ids = (await u.listTokenIds(npm, w.address, [])).map((id) => id.toString());
      list.push({ address: w.address, label: w.label || w.address, ids, main: false });
    } catch (err) {
      console.error("history wallets:", w.address.slice(0, 8), err.shortMessage || err.message);
    }
  }
  historyWalletsCache = { at: Date.now(), list };
  return list;
}
/** Today's USD price for a token from whatever the server already knows: position pools, the portfolio, watched holdings. */
function currentPrice(addr) {
  const a = String(addr).toLowerCase();
  if (lastPrices[a] != null) return lastPrices[a];
  const pf = portfolio.latest;
  if (pf) {
    const r = pf.rows.find((x) => x.address && x.address.toLowerCase() === a && x.price != null);
    if (r) return r.price;
  }
  for (const w of (watch.latest && watch.latest.wallets) || []) {
    const t = ((w.holdings && w.holdings.tokens) || []).find((x) => x.address && x.address.toLowerCase() === a && x.price != null);
    if (t) return t.price;
  }
  return null;
}
/** Label for a history event's wallet (missing = the main wallet, from before wallets were tagged). */
function walletLabelFor(e) {
  const addr = (e.wallet || cfg.ownerAddress).toLowerCase();
  if (addr === cfg.ownerAddress.toLowerCase()) return { address: cfg.ownerAddress, label: watch.ownerLabel() || "Main", main: true };
  const w = watch.readWallets().find((x) => x.address.toLowerCase() === addr);
  return { address: e.wallet, label: (w && w.label) || e.walletLabel || e.wallet, main: false };
}

// Token metadata per tokenId (works for closed positions too — the NFTs
// still exist), cached for the life of the server.
const tierLabel = (fee) => (fee / 10000).toFixed(fee % 10000 === 0 ? 0 : 2) + "%";

const metaCache = new Map();
async function positionMeta(tokenId) {
  if (!metaCache.has(tokenId)) {
    if (isV4Key(tokenId)) {
      if (!V4) throw new Error("v4 not configured");
      const { key } = await V4.posm.getPoolAndPositionInfo(BigInt(String(tokenId).slice(3)));
      const [t0, t1] = await Promise.all([
        v4.getCurrency(key.currency0, provider),
        v4.getCurrency(key.currency1, provider),
      ]);
      metaCache.set(tokenId, { t0, t1, fee: Number(key.fee) });
    } else {
      const pos = await npm.positions(tokenId);
      const [t0, t1] = await Promise.all([
        u.getToken(pos.token0, provider),
        u.getToken(pos.token1, provider),
      ]);
      metaCache.set(tokenId, { t0, t1, fee: Number(pos.fee) });
    }
  }
  return metaCache.get(tokenId);
}

/** Token metadata for a history event: v4 ledger rows carry it inline, everything else asks the chain. */
async function eventMeta(e) {
  if (e.t0 && e.t1 && e.t0.address && e.t1.address) return { t0: e.t0, t1: e.t1, fee: null };
  return positionMeta(e.tokenId);
}
/** Address used for today's price lookups; the v4 native leg is priced as WETH. */
const priceAddr = (t) => (t.address === ethers.ZeroAddress ? WETH : t.address.toLowerCase());

// -- Merkl incentive rewards -------------------------------------------------
// None of the owner's pools are in a live campaign today; this polls so the
// site notices if that changes. Cached 10 minutes; failures degrade to null.
let merkl = { at: 0, data: null };
let balCache = { at: 0, data: null };
async function merklRewards() {
  if (Date.now() - merkl.at < 10 * 60 * 1000) return merkl.data;
  try {
    const r = await fetch(
      `https://api.merkl.xyz/v4/users/${cfg.ownerAddress}/rewards?chainId=${cfg.chainId}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const arr = await r.json();
    const rewards = [];
    for (const ch of Array.isArray(arr) ? arr : []) {
      for (const rw of ch.rewards || []) {
        const dec = rw.token.decimals;
        const amount = Number(rw.amount) / 10 ** dec;
        const claimed = Number(rw.claimed) / 10 ** dec;
        rewards.push({
          symbol: rw.token.symbol,
          token: rw.token.address,
          amount,
          claimed,
          pending: Number(rw.pending) / 10 ** dec,
          claimable: Math.max(0, amount - claimed),
        });
      }
    }
    merkl = { at: Date.now(), data: rewards };
  } catch {
    merkl = { at: Date.now(), data: merkl.data }; // keep last known on failure
  }
  return merkl.data;
}

/** Unlock window state, read from the same /dev/shm cache run-collector.sh uses. */
function unlockState() {
  const armer = require("./arm");
  let ttl = null;
  try {
    ttl = Number(fs.readFileSync(`/dev/shm/.lp-collector-${process.getuid()}.ttl`, "utf8"));
  } catch {}
  const now = Date.now() / 1000;
  if (ttl && ttl > now) {
    // Armed (by any path, including unlock.sh): keep the on-disk record in step.
    const w = armer.expectedWindow();
    if (!w || Math.abs(w.until - ttl) > 5) armer.rememberWindow(ttl);
    return { armed: true, minutesLeft: Math.floor((ttl - now) / 60), until: ttl * 1000 };
  }
  // Not armed. If a window was still supposed to be running, the RAM cache was
  // cleared underneath it (a WSL restart), not merely expired.
  const w = armer.expectedWindow();
  if (w && w.until > now) return { armed: false, lost: true, until: w.until * 1000 };
  return { armed: false };
}

async function build() {
  await pools.refresh().catch(() => {});
  const [blockNumber, wethUsd, operatorWei] = await Promise.all([
    provider.getBlockNumber(),
    getWethUsd(),
    OPERATOR ? provider.getBalance(OPERATOR).catch(() => null) : null,
  ]);

  const minGas = Number(cfg.thresholds.minOperatorGasBalanceEth || 0);
  const operatorGas =
    operatorWei == null
      ? null
      : {
          eth: Number(ethers.formatEther(operatorWei)),
          low: Number(ethers.formatEther(operatorWei)) < minGas,
        };

  const deny = new Set((cfg.denylist || []).map(String));
  const ids = (await u.listTokenIds(npm, cfg.ownerAddress, cfg.tokenIds)).filter(
    (id) => !deny.has(id.toString())
  );
  latestIds = ids.map((id) => id.toString());

  // Blanket approval short-circuits the per-token checks entirely.
  let blanket = false, blanketV4 = false;
  if (OPERATOR) {
    blanket = await npm.isApprovedForAll(cfg.ownerAddress, OPERATOR).catch(() => false);
    if (V4) blanketV4 = await V4.posm.isApprovedForAll(cfg.ownerAddress, OPERATOR).catch(() => false);
  }

  // v4 ids ride along with a version tag; discovery is budgeted so a build
  // never waits on a long log scan (the background tick does the catching up).
  const v4Ids = V4 ? (await V4.discovery.discover(20)).filter((id) => !deny.has(v4Key(id))) : [];
  const work = [...ids.map((id) => ({ id, version: 3 })), ...v4Ids.map((id) => ({ id: BigInt(id), version: 4 }))];

  const positions = [];
  const errors = [];
  const closedIds = [];
  const poolHoldings = new Map();

  // Positions load with limited concurrency: sequential took 1-2 minutes on
  // this RPC; four at a time keeps it well under 30s without hammering it.
  const CONCURRENCY = 4;
  let cursor = 0;
  async function processOne({ id, version }) {
    try {
      const p =
        version === 4
          ? await v4.loadPosition({ provider, posm: V4.posm, stateView: V4.stateView, cfg }, id)
          : await u.loadPosition({ provider, npm, factory, cfg }, id);
      if (p.gone) {
        V4.discovery.forget(id); // transferred away; stop asking about it
        return;
      }
      if (version === 4) p.tokenId = v4Key(p.tokenId);
      if (p.closed) {
        closedIds.push(p.tokenId);
        return;
      }

      // Approval: v3 via the NPM (blanket or per token), v4 via the v4
      // PositionManager's blanket approval (collect-v4.js needs that one).
      let approved = null; // null = unknown (no operator keystore here)
      if (OPERATOR && version !== 4) {
        approved =
          blanket ||
          (await npm.getApproved(id).catch(() => ethers.ZeroAddress)).toLowerCase() ===
            OPERATOR.toLowerCase();
      } else if (OPERATOR && version === 4) {
        approved = blanketV4;
      }

      const { usd0, usd1 } = priceSides(p, wethUsd);
      if (usd0 != null) lastPrices[p.token0.address.toLowerCase()] = usd0;
      if (usd1 != null) lastPrices[p.token1.address.toLowerCase()] = usd1;
      for (const t of [p.token0, p.token1]) {
        if (t.address === ethers.ZeroAddress) continue; // native ETH: not an ERC-20 balance
        tokenSet.set(t.address.toLowerCase(), { address: t.address, symbol: t.symbol, decimals: t.decimals });
      }
      const a0 = toFloat(p.amounts.amount0, p.token0.decimals);
      const a1 = toFloat(p.amounts.amount1, p.token1.decimals);
      const f0 = toFloat(p.fees.amount0, p.token0.decimals);
      const f1 = toFloat(p.fees.amount1, p.token1.decimals);
      for (const [t, amt, fee] of [[p.token0, a0, f0], [p.token1, a1, f1]]) {
        // Native ETH in a v4 pool counts as WETH for the portfolio.
        const k = t.address === ethers.ZeroAddress ? WETH : t.address.toLowerCase();
        const h = poolHoldings.get(k) || { amount: 0, fees: 0 };
        h.amount += amt;
        h.fees += fee;
        poolHoldings.set(k, h);
      }

      const v0 = usd0 == null ? null : a0 * usd0;
      const v1 = usd1 == null ? null : a1 * usd1;
      const valueUsd = v0 == null || v1 == null ? null : v0 + v1;
      const feesUsd = usd0 == null || usd1 == null ? null : f0 * usd0 + f1 * usd1;

      // Pool-price approximation of the collector's quoter check: fees worth at
      // least minWethPerPosition will be taken by the next collect run.
      const minWeth = Number(cfg.thresholds && cfg.thresholds.minWethPerPosition) || 0;
      const eligible =
        version === 4 && !(cfg.v4Collect && cfg.v4Collect.enabled) ? null : feesUsd != null && wethUsd != null ? feesUsd / wethUsd >= minWeth : null;

      // PnL vs HODL: everything received or held, minus holding the deposits.
      // All legs valued at current prices.
      let pnlUsd = null, pnlPct = null, pnlSince = null, pnlApprox = false, pnlLegs = null, pnlSource = null;
      // Chain-read history once it reaches the mint; Blockscout's until then.
      const b = (version !== 4 ? ledger.basis(p.tokenId) : ledgerV4 && ledgerV4.basis(id)) || bf.basis[p.tokenId];
      if (b) pnlSource = b.source || "blockscout";
      if (b && usd0 != null && usd1 != null) {
        const dec0 = p.token0.decimals, dec1 = p.token1.decimals;
        const depositedUsd =
          toFloat(b.dep0, dec0) * usd0 + toFloat(b.dep1, dec1) * usd1;
        const withdrawnUsd =
          toFloat(b.wd0, dec0) * usd0 + toFloat(b.wd1, dec1) * usd1;
        let collectedUsd = 0, collects = 0;
        for (const e of [...bf.events, ...hist.events]) {
          if (e.tokenId !== p.tokenId) continue;
          collectedUsd += toFloat(e.fee0, dec0) * usd0 + toFloat(e.fee1, dec1) * usd1;
          collects++;
        }
        if (depositedUsd > 0) {
          pnlUsd = (valueUsd || 0) + (feesUsd || 0) + collectedUsd + withdrawnUsd - depositedUsd;
          pnlPct = (pnlUsd / depositedUsd) * 100;
          pnlSince = b.firstT;
          // The legs, so the card can show its working.
          pnlLegs = {
            deposited: depositedUsd, adds: b.increases || null,
            withdrawn: withdrawnUsd,
            collected: collectedUsd, collects,
            held: valueUsd || 0, uncollected: feesUsd || 0,
          };
          // If the ledger's liquidity disagrees with the live position, the
          // basis is missing an add or remove: the chain scanner has not
          // reached it yet (minutes), or Blockscout never indexed it.
          pnlApprox = b.liq !== p.liquidity;
        }
      }

      // Ticks are already a log scale, so a linear interpolation between them
      // is exactly a log interpolation on price. The midpoint is where the
      // position sits 50/50 by value.
      const span = p.tickUpper - p.tickLower;
      const raw = (p.currentTick - p.tickLower) / span;
      const railPos = Math.max(0, Math.min(1, raw));

      const toUpper = (p.prices.upper / p.prices.current - 1) * 100;
      const toLower = (1 - p.prices.lower / p.prices.current) * 100;

      positions.push({
        tokenId: p.tokenId,
        version: version === 4 ? 4 : 3,
        nftId: id.toString(),
        hooks: p.hooks && p.hooks !== ethers.ZeroAddress ? p.hooks : null,
        approved,
        eligible,
        pnlUsd,
        pnlPct,
        pnlSince,
        pnlApprox,
        pnlLegs,
        pnlSource,
        collected: collectSummary(p.tokenId, p.token0.decimals, p.token1.decimals, usd0, usd1),
        liquidity: p.liquidity,
        pair: `${p.token0.symbol} / ${p.token1.symbol}`,
        symbol0: p.token0.symbol,
        symbol1: p.token1.symbol,
        feeTier: p.feeTier,
        feeTierLabel: tierLabel(p.feeTier),
        inRange: p.inRange,
        poolAddress: p.poolAddress,
        token0: p.token0.address,
        token1: p.token1.address,
        pool: await pools.forPosition({ version, poolAddress: p.poolAddress, token0: p.token0.address, token1: p.token1.address, usd0, usd1, decimals0: p.token0.decimals, decimals1: p.token1.decimals, feePct: p.feeTier != null ? Number(p.feeTier) / 10000 : null, symbol0: p.token0.symbol, symbol1: p.token1.symbol }),
        amount0: a0,
        amount1: a1,
        fee0: f0,
        fee1: f1,
        usd0,
        usd1,
        feesOk: p.fees.ok,
        feesError: p.fees.error,
        valueUsd,
        feesUsd,
        share0: valueUsd ? (v0 / valueUsd) * 100 : a0 + a1 === 0 ? 0 : null,
        share1: valueUsd ? (v1 / valueUsd) * 100 : null,
        priceCurrent: p.prices.current,
        priceLower: p.prices.lower,
        priceUpper: p.prices.upper,
        railPos,
        rawPos: raw,
        toUpperPct: toUpper,
        toLowerPct: toLower,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        currentTick: p.currentTick,
      });
    } catch (err) {
      errors.push({ tokenId: version === 4 ? v4Key(id) : id.toString(), error: err.shortMessage || err.message });
    }
  }
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < work.length) {
        await processOne(work[cursor++]);
      }
    })
  );

  positions.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
  lastPoolHoldings = poolHoldings;

  if (wethUsd != null) lastWethUsdSeen = wethUsd;
  latestOpenIds = positions.filter((p) => p.version !== 4).map((p) => p.tokenId);
  appendSnapshot(positions, wethUsd);
  seedRangeLog(positions);
  const nowT = Date.now();
  for (const p of positions) observeRange(p.tokenId, p.inRange, nowT);
  closeRanges(positions.map((p) => p.tokenId), nowT);
  saveRangeLog();
  for (const p of positions) {
    p.range = rangeStats(p.tokenId, nowT);
    const r = rateFor(p.tokenId);
    p.dailyUsd = r.dailyUsd;
    p.rateWindowH = r.windowH;
    p.aprPct = r.dailyUsd != null && p.valueUsd ? (r.dailyUsd * 365 * 100) / p.valueUsd : null;
    p.spark = r.spark;
    p.px = pxSeriesFor(p.tokenId);
  }

  const liquidityUsd = positions.reduce((s, p) => s + (p.valueUsd || 0), 0);
  const feesUsd = positions.reduce((s, p) => s + (p.feesUsd || 0), 0);

  const unapproved = OPERATOR
    ? positions.filter((p) => p.approved === false).map((p) => p.tokenId)
    : [];

  const eligiblePositions = positions.filter((p) => p.eligible === true);

  // Closed positions, named via the cached NFT metadata (the NFTs persist
  // after withdrawal, so pair symbols still resolve).
  const closed = await Promise.all(
    closedIds.map(async (id) => ({
      tokenId: id,
      version: isV4Key(id) ? 4 : 3,
      nftId: isV4Key(id) ? id.slice(3) : id,
      pair: await positionMeta(id)
        .then((m) => `${m.t0.symbol}/${m.t1.symbol}`)
        .catch(() => null),
    }))
  );

  return {
    ok: true,
    at: Date.now(),
    blockNumber,
    chainId: Number(cfg.chainId),
    owner: cfg.ownerAddress,
    ownerLabel: watch.ownerLabel(),
    loops: loopHealth(),
    alerts: { telegram: !!(alerts && alerts.enabled) },
    operator: OPERATOR,
    operatorGas,
    unlock: unlockState(),
    positionManager: cfg.contracts.positionManager,
    positionManagerV4: V4 ? cfg.contracts.v4.positionManager : null,
    readOnly: READONLY,
    unapproved,
    explorer: "https://robinhoodchain.blockscout.com",
    minWethPerPosition: Number(cfg.thresholds && cfg.thresholds.minWethPerPosition) || 0,
    ops: opsInfo(),
    wethUsd,
    totals: {
      liquidityUsd,
      feesUsd,
      count: positions.length,
      idle: positions.filter((p) => !p.inRange).length,
      collectableUsd: eligiblePositions.reduce((s, p) => s + (p.feesUsd || 0), 0),
      eligibleCount: eligiblePositions.length,
      // Verified PnL only: a position whose deposit basis disagrees with its
      // live liquidity (pnlApprox) would poison the headline number.
      pnlUsd: positions.reduce((s, p) => s + (p.pnlUsd != null && !p.pnlApprox ? p.pnlUsd : 0), 0),
      pnlCount: positions.filter((p) => p.pnlUsd != null && !p.pnlApprox).length,
      pnlApproxCount: positions.filter((p) => p.pnlUsd != null && p.pnlApprox).length,
      // The two halves of that PnL, same verified set: fees earned over the
      // positions' lives, and what the price moves cost versus holding.
      feesEarnedUsd: positions.reduce(
        (s, p) => s + (p.pnlLegs && !p.pnlApprox ? p.pnlLegs.collected + p.pnlLegs.uncollected : 0), 0),
      holdCostUsd: positions.reduce(
        (s, p) => s + (p.pnlLegs && !p.pnlApprox ? p.pnlUsd - p.pnlLegs.collected - p.pnlLegs.uncollected : 0), 0),
    },
    positions,
    closed,
    errors,
  };
}

// -- Collect runs -----------------------------------------------------------
// One at a time. Only runs started here are tracked; a timer or CLI run in
// parallel is invisible to this (and to the button).
const MAX_RUN_OUTPUT = 64 * 1024;
let collectRun = null; // { startedAt, output, done, code }

function startCollectRun() {
  const run = { startedAt: Date.now(), output: "", done: false, code: null };
  collectRun = run;

  const collectMode = (cfg.dashboard && cfg.dashboard.collectMode) === "full" ? "full" : "collect";
  const child = spawn("bash", [path.join(__dirname, "run-collector.sh"), collectMode], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (d) => {
    run.output = (run.output + d.toString()).slice(-MAX_RUN_OUTPUT);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (err) => {
    append(`failed to start: ${err.message}\n`);
    run.done = true;
    run.code = -1;
  });
  child.on("close", (code) => {
    run.done = true;
    run.code = code;
    cache = { at: 0, payload: null }; // fees changed; drop the cached view
  });
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (d) => {
      s += d;
      if (s.length > limit) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

const CACHE_FILE = `/dev/shm/.lp-collector-${process.getuid()}`;
const armer = require("./arm");
const treasuryLedger = require("./treasury");
const chatbot = require("./chat").create({ port: PORT });
// Public hostname for phone links and QR codes: LP_PUBLIC_HOST from the
// environment, else the node's tailnet name asked from the user-space
// tailscaled. Resolved at runtime so no tracked file carries the real name.
let publicHostCache = { at: 0, host: null };
function publicHost() {
  if (process.env.LP_PUBLIC_HOST) return process.env.LP_PUBLIC_HOST;
  if (Date.now() - publicHostCache.at < 10 * 60 * 1000) return publicHostCache.host;
  publicHostCache.at = Date.now();
  try {
    const home = process.env.HOME || "";
    const bin = path.join(home, ".local", "tailscale", "tailscale");
    const sock = path.join(home, ".local", "state", "tailscale", "tailscaled.sock");
    const out = require("child_process").execFileSync(bin, [`--socket=${sock}`, "status", "--json"], { timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const dns = JSON.parse(String(out)).Self.DNSName || "";
    publicHostCache.host = dns.replace(/\.$/, "") || null;
  } catch {
    publicHostCache.host = null;
  }
  return publicHostCache.host;
}
const strategy = require("./strategy").create({ cfg, dir: __dirname, port: PORT, metaFor: (id) => positionMeta(id) });
let lastDisposalScan = 0;
// === strategy track record (strategy-track.js): score agent proposals against what happened ===
const strategyTrack = require("./strategy-track").create({ cfg, dir: __dirname, port: PORT });

// One portfolio refresh at a time, fed from the latest position build.
let portfolioInFlight = null;
function refreshPortfolio() {
  if (!cache.payload) return Promise.resolve(null);
  if (!portfolioInFlight) {
    const pl = cache.payload;
    portfolioInFlight = portfolio
      .refresh({
        positionTokens: tokenSet,
        poolHoldings: lastPoolHoldings,
        lpUsd: pl.totals.liquidityUsd,
        feesUsd: pl.totals.feesUsd,
        wethUsd: pl.wethUsd,
        prices: lastPrices,
      })
      .finally(() => {
        portfolioInFlight = null;
      });
  }
  return portfolioInFlight;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // Arm the unlock window from the page: verify the passphrase against the
  // keystore (same check as unlock.sh), then cache it in RAM with a TTL.
  // The passphrase travels over plain HTTP, so this is loopback-only
  // unconditionally — LP_ALLOW_REMOTE_COLLECT does not open it.
  if (READONLY && (url.pathname === "/api/unlock" || url.pathname === "/api/lock" || url.pathname.startsWith("/api/arm") || (url.pathname === "/api/collect" && req.method === "POST"))) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "This dashboard is read-only; the collector runs on another machine." }));
  }

  // Wallet-signature arming (arm.js / arm.html). Loopback only, like unlock.
  if (url.pathname === "/arm" || url.pathname === "/arm.html") {
    try {
      const html = fs.readFileSync(path.join(__dirname, "arm.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("arm.html not found");
    }
  }
  if (url.pathname.startsWith("/api/arm")) {
    res.setHeader("Content-Type", "application/json");
    if (HOST !== "127.0.0.1") {
      res.writeHead(403);
      return res.end(JSON.stringify({ ok: false, error: "arming is localhost-only" }));
    }
    try {
      if (url.pathname === "/api/arm/status") {
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, owner: cfg.ownerAddress, operator: armer.operatorAddress(), chainId: Number(cfg.chainId), message: armer.message(cfg), unlock: unlockState(), ...armer.configured() }));
      }
      if (req.method !== "POST") throw new Error("POST required");
      const body = JSON.parse(await readBody(req));
      if (url.pathname === "/api/arm/setup") {
        await armer.setup(cfg, body);
        const mins = await armer.arm(cfg, body, CACHE_FILE);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, unlock: { armed: true, minutesLeft: mins }, ...armer.configured() }));
      }
      if (url.pathname === "/api/arm") {
        const mins = await armer.arm(cfg, body, CACHE_FILE);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, unlock: { armed: true, minutesLeft: mins } }));
      }
      if (url.pathname === "/api/arm/forget") {
        armer.verify(cfg, body.signature);
        armer.forget();
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, ...armer.configured() }));
      }
      throw new Error("unknown arm endpoint");
    } catch (err) {
      const msg = err.shortMessage || err.message || String(err);
      res.writeHead(/signature|not set up|does not unlock|changed since|malformed|passphrase|password/i.test(msg) ? 403 : 500);
      return res.end(JSON.stringify({ ok: false, error: /invalid password|incorrect password/i.test(msg) ? "wrong passphrase" : msg }));
    }
  }

  if (url.pathname === "/api/unlock" && req.method === "POST") {
    res.setHeader("Content-Type", "application/json");
    if (HOST !== "127.0.0.1") {
      res.writeHead(403);
      return res.end(JSON.stringify({ ok: false, error: "unlock is localhost-only" }));
    }
    try {
      const body = JSON.parse(await readBody(req));
      const minutes = Math.max(1, Math.min(10080, Number(body.minutes) || 120)); // up to 7 days
      const ksPath =
        process.env.LP_KEYSTORE_PATH ||
        path.join(process.env.HOME || "", ".lp-collector", "operator-keystore.json");
      const json = fs.readFileSync(ksPath, "utf8");
      await ethers.Wallet.fromEncryptedJson(json, body.passphrase || ""); // throws if wrong
      fs.writeFileSync(CACHE_FILE, body.passphrase, { mode: 0o600 });
      fs.writeFileSync(`${CACHE_FILE}.ttl`, String(Math.floor(Date.now() / 1000) + minutes * 60), { mode: 0o600 });
      fs.chmodSync(CACHE_FILE, 0o600);
      fs.chmodSync(`${CACHE_FILE}.ttl`, 0o600);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, unlock: { armed: true, minutesLeft: minutes } }));
    } catch (err) {
      const wrong = /invalid password|incorrect password/i.test(err.message || "");
      res.writeHead(wrong ? 403 : 500);
      return res.end(JSON.stringify({ ok: false, error: wrong ? "wrong passphrase" : err.message }));
    }
  }

  if (url.pathname === "/api/lock" && req.method === "POST") {
    res.setHeader("Content-Type", "application/json");
    if (HOST !== "127.0.0.1") {
      res.writeHead(403);
      return res.end(JSON.stringify({ ok: false, error: "lock is localhost-only" }));
    }
    fs.rmSync(CACHE_FILE, { force: true });
    fs.rmSync(`${CACHE_FILE}.ttl`, { force: true });
    armer.clearWindow();
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, unlock: { armed: false } }));
  }

  if (url.pathname === "/api/collect") {
    res.setHeader("Content-Type", "application/json");
    if (HOST !== "127.0.0.1" && process.env.LP_ALLOW_REMOTE_COLLECT !== "1") {
      res.writeHead(403);
      return res.end(JSON.stringify({ ok: false, error: "collect is disabled when bound beyond localhost" }));
    }
    if (req.method === "POST") {
      if (collectRun && !collectRun.done) {
        res.writeHead(409);
        return res.end(JSON.stringify({ ok: false, error: "a collect run is already in progress", run: collectRun }));
      }
      startCollectRun();
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, run: collectRun }));
    }
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, run: collectRun }));
  }

  if (url.pathname === "/api/portfolio") {
    res.setHeader("Content-Type", "application/json");
    try {
      const fresh = url.searchParams.get("fresh") === "1";
      let d = portfolio.latest;
      if (fresh && d) d = await refreshPortfolio();
      if (!d) {
        // First pass (up to a minute for a wallet full of airdrops): kick it
        // off and let the page come back rather than hold the request.
        refreshPortfolio().catch(() => {});
        res.writeHead(503);
        return res.end(JSON.stringify({ ok: false, error: "portfolio still loading" }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify(d));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }

  // Browser-based v4 operator approval (approve-v4.html): the page reads every
  // address from here (config.json + the operator keystore's public address)
  // and the current approval state from this server's RPC.
  if (url.pathname === "/api/approval" || url.pathname === "/api/v4-approval") {
    res.setHeader("Content-Type", "application/json");
    try {
      const v = url.pathname === "/api/v4-approval" ? 4 : Number(url.searchParams.get("v")) === 3 ? 3 : 4;
      const mgr = v === 3 ? cfg.contracts.positionManager : cfg.contracts.v4 && cfg.contracts.v4.positionManager;
      if (!mgr) throw new Error(`no v${v} position manager in config.json`);
      // Which owner wallet: the main one by default, or any wallets.json wallet the collector may collect for.
      const allowed = [{ address: cfg.ownerAddress, label: watch.ownerLabel() || "Main wallet", main: true }];
      for (const w of watch.readWallets()) allowed.push({ address: w.address, label: w.label || w.address, main: false, collect: !!w.collect });
      const want = url.searchParams.get("owner");
      const ownerEntry = want ? allowed.find((a) => a.address.toLowerCase() === want.toLowerCase()) : allowed[0];
      if (!ownerEntry) throw new Error("that wallet is not the main wallet or a wallet listed in wallets.json");
      const ownerAddr = ownerEntry.address;
      // Re-read the keystore's public address each time: the file can be replaced while the server runs.
      let operator = OPERATOR;
      try {
        const ksPath = process.env.LP_KEYSTORE_PATH || path.join(process.env.HOME || "", ".lp-collector", "operator-keystore.json");
        operator = ethers.getAddress("0x" + JSON.parse(fs.readFileSync(ksPath, "utf8")).address.replace(/^0x/, ""));
      } catch {}
      const c = new ethers.Contract(mgr, ["function isApprovedForAll(address,address) view returns (bool)"], provider);
      const approved = operator ? await c.isApprovedForAll(ownerAddr, operator) : null;
      // Other operators still approved (e.g. a replaced keystore's address), so the page can offer to revoke them.
      const others = (await approvedOperators(provider, mgr, ownerAddr)).filter((o) => o.approved && (!operator || o.address.toLowerCase() !== operator.toLowerCase()));
      // Overview of every wallet's approval on this manager, for the page's wallet table.
      const wallets = [];
      for (const a of allowed) wallets.push({ ...a, approved: operator ? await c.isApprovedForAll(a.address, operator).catch(() => null) : null });
      res.writeHead(200);
      return res.end(JSON.stringify({
        ok: true, version: v,
        owner: ownerAddr, ownerLabel: ownerEntry.label, operator, posm: ethers.getAddress(mgr),
        chainId: Number(cfg.chainId), chainName: "Robinhood Chain", rpc: cfg.rpcUrl,
        explorer: "https://robinhoodchain.blockscout.com", approved, others, wallets,
      }));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }
  if (/^\/approve-v[34](\.html)?$/.test(url.pathname)) {
    const file = url.pathname.includes("v3") ? "approve-v3.html" : "approve-v4.html";
    try {
      const html = fs.readFileSync(path.join(__dirname, file));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end(`${file} not found`);
    }
  }

  if (url.pathname === "/api/portfolio-all") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    return res.end(JSON.stringify(allWalletsView()));
  }

  // LOKOVault: the treasury page, the split ledger, and a summary for the analytics tile.
  if (url.pathname === "/treasury" || url.pathname === "/treasury.html") {
    try {
      const html = fs.readFileSync(path.join(__dirname, "treasury.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("treasury.html is not installed yet: copy it into the project folder next to server.js");
    }
  }
  if (url.pathname === "/config.json") {
    // Only the public treasury / contract addresses; nothing operational.
    const pick = ["chainId", "treasuryNFT", "treasuryTBA", "treasuryTokenId", "treasuryImplementation", "feeSplitPct", "feeSplitMax", "ownerAddress"];
    const out = {};
    for (const k of pick) if (cfg[k] !== undefined) out[k] = cfg[k];
    out.usdg = cfg.usdReference && cfg.usdReference.stable;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(out));
  }
  if (url.pathname === "/fee-split-ledger.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(treasuryLedger.readLedger()));
  }
  if (url.pathname === "/api/treasury") {
    res.setHeader("Content-Type", "application/json");
    try {
      res.writeHead(200);
      return res.end(JSON.stringify(await treasuryView()));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }

  // === memecoin-guardian ===
  // Memecoin Watch: status written by memecoin-guardian.js (a separate process),
  // and a loopback-only close that runs the guardian's --close (operator must be armed).
  // Nightly backup on demand (loopback-only; the scheduled run is a timer in this process).
  if (url.pathname === "/api/backup" && req.method === "POST") {
    res.setHeader("Content-Type", "application/json");
    if (HOST !== "127.0.0.1" || READONLY || !server.runBackup) {
      res.writeHead(403);
      return res.end(JSON.stringify({ ok: false, error: "backups run from the main dashboard process on this machine" }));
    }
    const code = await server.runBackup("manual");
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: code === 0, code, last: timers.backup.lastResult }));
  }
  // Risk: every watched position's status and rule block (GET), a rule change (POST, loopback-only).
  if (url.pathname === "/api/risk" && req.method === "POST") {
    res.setHeader("Content-Type", "application/json");
    if (HOST !== "127.0.0.1" || READONLY) {
      res.writeHead(403);
      return res.end(JSON.stringify({ ok: false, error: "rule changes are localhost-only" }));
    }
    try {
      const body = JSON.parse(await readBody(req));
      if (!body || !/^\d+$/.test(String(body.tokenId))) throw new Error("tokenId required");
      const rules = guardianRules(String(body.tokenId), body);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, tokenId: String(body.tokenId), rules }));
    } catch (err) {
      res.writeHead(400);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }
  if (url.pathname === "/api/risk" || url.pathname === "/api/memecoins") {
    res.setHeader("Content-Type", "application/json");
    try {
      const st = guardian && guardian.status && guardian.status.at ? JSON.parse(JSON.stringify(guardian.status)) : JSON.parse(fs.readFileSync(path.join(__dirname, "memecoin-status.json"), "utf8"));
      st.stale = Date.now() - (st.at || 0) > 5 * 60 * 1000; // guardian not running?
      st.watching = (st.positions || []).filter((p) => !p.closed).length;
      for (const p of st.positions || []) {
        if (p.closed) continue;
        try {
          const key = Number(p.version) === 3 ? String(p.tokenId) : `v4-${p.tokenId}`;
          const m = await positionMeta(key);
          const price = (t) => (t.address === ethers.ZeroAddress ? lastPrices[WETH] : lastPrices[t.address.toLowerCase()]) ?? currentPrice(priceAddr(t));
          p.collected = collectSummary(key, m.t0.decimals, m.t1.decimals, price(m.t0), price(m.t1));
        } catch { p.collected = null; }
      }
      st.configured = (cfg.memecoins || []).length;
      st.discovery = cfg.memecoinDiscovery !== false;
      // Fee auto-collect (memecoin-collect.js, a timer in this process): settings and last activity.
      if (autoCollect) { st.autoCollect = autoCollect.summary(); st.autoCollect.stale = Date.now() - (st.autoCollect.lastCheckAt || 0) > 40 * 60 * 1000; }
      else { const mc = cfg.memecoinCollect || {}; st.autoCollect = { enabled: mc.enabled !== false, minUsd: Number(mc.minUsd ?? 20), minIntervalMinutes: Number(mc.minIntervalMinutes ?? 30), lastRunAt: null, lastCheckAt: null, stale: true, note: "loops run in the main dashboard process only" }; }
      st.loops = loopHealth();
      res.writeHead(200);
      return res.end(JSON.stringify(st));
    } catch {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, at: 0, positions: [], recent: [], stale: true, watching: 0, configured: (cfg.memecoins || []).length }));
    }
  }
  if (url.pathname === "/api/memecoins/close" && req.method === "POST") {
    res.setHeader("Content-Type", "application/json");
    if (HOST !== "127.0.0.1" || READONLY || !guardian) {
      res.writeHead(403);
      return res.end(JSON.stringify({ ok: false, error: "closing is localhost-only, from the main dashboard process" }));
    }
    try {
      const body = JSON.parse(await readBody(req));
      const id = String(body.tokenId || "");
      if (!/^\d+$/.test(id)) throw new Error("tokenId required");
      const result = await guardian.closeById(id, "manual close from the dashboard", "manual");
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: result.status === "closed", result }));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }
  // === end memecoin-guardian ===

  // === performance-attribution === daily P&L decomposition and benchmarks
  if (url.pathname === "/api/attribution") {
    res.setHeader("Content-Type", "application/json");
    try {
      const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days")) || 30));
      res.writeHead(200);
      return res.end(JSON.stringify(attribution.load({ days })));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }

  // === weekly-digest-and-vault ===
  // Weekly Telegram digest (digest.js): preview text; /vault is an alias of the
  // treasury page for phones; /qr.js is the QR encoder the treasury page uses.
  if (url.pathname === "/api/digest") {
    res.setHeader("Content-Type", "application/json");
    try {
      const digest = require("./digest");
      const text = digest.build(await digest.gather(`http://127.0.0.1:${PORT}`));
      let state = {};
      try { state = JSON.parse(fs.readFileSync(path.join(__dirname, "digest-state.json"), "utf8")); } catch {}
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, text, week: digest.isoWeek(new Date()), lastSentWeek: state.lastSentWeek || null, lastSentAt: state.lastSentAt || null, due: digest.due(new Date(), state) }));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }
  if (url.pathname === "/api/daily") {
    res.setHeader("Content-Type", "application/json");
    try {
      const daily = require("./daily");
      const text = daily.build(await daily.gather(`http://127.0.0.1:${PORT}`));
      let state = {};
      try { state = JSON.parse(fs.readFileSync(path.join(__dirname, "digest-state.json"), "utf8")); } catch {}
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, text, settings: daily.settings(cfg), lastDailyDate: state.lastDailyDate || null, lastDailyAt: state.lastDailyAt || null, due: daily.due(cfg, new Date(), state) }));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }
  if (url.pathname === "/api/vault-info") {
    // Read-only facts for the vault page (owner, admin, split, balances) so a browser
    // without a wallet, or one whose RPC calls are CORS-blocked, still sees them.
    res.setHeader("Content-Type", "application/json");
    try {
      const ts = treasuryLedger.settings(cfg);
      const out = { ok: true, nft: cfg.treasuryNFT || null, tba: ts.tba, pct: ts.pct, max: ts.max, owner: null, admin: null, paused: null, balances: [], publicHost: publicHost() };
      if (cfg.treasuryNFT) {
        const nft = new ethers.Contract(cfg.treasuryNFT, ["function ownerOf(uint256) view returns (address)", "function owner() view returns (address)", "function feeSplitPct() view returns (uint256)", "function paused() view returns (bool)"], provider);
        const [o, a, p, pz] = await Promise.all([nft.ownerOf(1).catch(() => null), nft.owner().catch(() => null), nft.feeSplitPct().catch(() => null), nft.paused().catch(() => null)]);
        out.owner = o; out.admin = a; out.paused = pz;
        if (p != null) out.pct = Number(p);
      }
      if (ts.tba) {
        const eth = await provider.getBalance(ts.tba);
        out.balances.push({ symbol: "ETH", address: null, amount: ethers.formatEther(eth), decimals: 18 });
        const seenTok = new Set();
        const tokens = [cfg.usdReference && cfg.usdReference.stable, cfg.contracts.weth, ...Object.keys(lastPrices)].filter((a) => a && !seenTok.has(a.toLowerCase()) && seenTok.add(a.toLowerCase()));
        for (const addr of tokens.slice(0, 40)) {
          try {
            const meta = await u.getToken(addr, provider);
            const raw = await new ethers.Contract(addr, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(ts.tba);
            if (raw > 0n || addr.toLowerCase() === String(cfg.usdReference && cfg.usdReference.stable).toLowerCase()) out.balances.push({ symbol: meta.symbol, address: meta.address, amount: ethers.formatUnits(raw, meta.decimals), decimals: meta.decimals });
          } catch {}
        }
      }
      res.writeHead(200);
      return res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }
  if (url.pathname === "/vault" || url.pathname === "/vault.html") {
    try {
      const html = fs.readFileSync(path.join(__dirname, "treasury.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("treasury.html is not installed yet");
    }
  }
  if (url.pathname === "/qr.js") {
    try {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(fs.readFileSync(path.join(__dirname, "qr.js")));
    } catch {
      res.writeHead(404);
      return res.end("qr.js not found");
    }
  }
  // === end weekly-digest-and-vault ===
  // === pool-scout-and-IL: range advisor + IL forecast results ===
  if (url.pathname === "/api/advisor") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    return res.end(JSON.stringify({ ...advisor.view(), scout: scout.state }));
  }
  // === end pool-scout-and-IL ===

  // === token-health-and-approvals ===
  if (url.pathname === "/api/token-health") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    return res.end(JSON.stringify(tokenHealth.view()));
  }
  if (url.pathname === "/approvals" || url.pathname === "/approvals.html") {
    try {
      const html = fs.readFileSync(path.join(__dirname, "approvals.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("approvals.html not found");
    }
  }
  if (url.pathname === "/api/approvals") {
    // Read-only audit of one wallet's allowances, operator approvals and vault
    // status. `owner` must be the main wallet or a wallets.json wallet.
    res.setHeader("Content-Type", "application/json");
    try {
      const allowed = [{ address: cfg.ownerAddress, label: watch.ownerLabel() || "Main wallet", main: true }];
      for (const w of watch.readWallets()) allowed.push({ address: w.address, label: w.label || w.address, main: false, collect: !!w.collect });
      const want = url.searchParams.get("owner");
      const entry = want ? allowed.find((a) => a.address.toLowerCase() === want.toLowerCase()) : allowed[0];
      if (!entry) throw new Error("that wallet is not the main wallet or a wallet listed in wallets.json");
      const data = await approvalsAudit.audit(entry.address, require("./arm").operatorAddress());
      res.writeHead(200);
      return res.end(JSON.stringify({ ...data, ownerLabel: entry.label, wallets: allowed, chainId: Number(cfg.chainId), rpc: cfg.rpcUrl, explorer: "https://robinhoodchain.blockscout.com", health: tokenHealth.view().byAddress }));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }
  // === end token-health-and-approvals ===

  // === in-site chat ===
  // Chat panel (chat.js): answers from the same read-only tools as lp-mcp.mjs.
  // POST /api/chat {sessionId, message}; POST /api/chat/reset; GET /api/chat = status.
  if (url.pathname === "/chat-widget.js") {
    try {
      const body = fs.readFileSync(path.join(__dirname, "chat-widget.js"));
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(body);
    } catch {
      res.writeHead(404);
      return res.end("chat-widget.js missing");
    }
  }
  if (url.pathname === "/api/chat" || url.pathname === "/api/chat/reset") {
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "POST") {
      res.writeHead(200);
      return res.end(JSON.stringify(chatbot.status()));
    }
    try {
      const body = JSON.parse((await readBody(req, 16384)) || "{}");
      if (url.pathname === "/api/chat/reset") {
        res.writeHead(200);
        return res.end(JSON.stringify(chatbot.reset(String(body.sessionId || ""))));
      }
      const out = await chatbot.chat({ sessionId: String(body.sessionId || ""), message: body.message });
      res.writeHead(200);
      return res.end(JSON.stringify(out));
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      const msg = err.status ? (err.message || "chat failed") : `chat failed: ${(err.message || String(err)).slice(0, 200)}`;
      res.writeHead(status);
      return res.end(JSON.stringify({ ok: false, error: msg }));
    }
  }
  // === end in-site chat ===

  // === confirm-before-sell (sell-v4.js) ===
  // GET /api/sales/pending lists sales awaiting a decision; POST /api/sales/approve {id, decision}
  // records one (loopback-only; the gate refuses the path). The collector polls the file.
  if (url.pathname === "/api/sales/pending" || url.pathname === "/api/sales/approve") {
    res.setHeader("Content-Type", "application/json");
    try {
      const sv4 = require("./sell-v4");
      if (url.pathname === "/api/sales/approve") {
        if (req.method !== "POST") { res.writeHead(405); return res.end(JSON.stringify({ ok: false, error: "method not allowed" })); }
        if (HOST !== "127.0.0.1" || READONLY) { res.writeHead(403); return res.end(JSON.stringify({ ok: false, error: "sale approvals are localhost-only" })); }
        const body = JSON.parse(await readBody(req));
        const decision = body.decision === "reject" ? "reject" : "approve";
        const row = sv4.decideSale(String(body.id || ""), decision, String(body.by || "api").slice(0, 40));
        if (!row) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "no such sale" })); }
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, sale: row }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, confirm: !!(cfg.memecoinSell && cfg.memecoinSell.confirm), sales: sv4.pendingSales() }));
    } catch (err) {
      res.writeHead(400);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }
  // === end confirm-before-sell ===

  // === strategy track record (strategy-track.js) ===
  // POST /api/strategy/proposals records a proposal (loopback-only, like /api/risk;
  // the gate refuses the path); GET /api/strategy/track returns the view. Scoring runs in backgroundTick.
  if (url.pathname === "/api/strategy/proposals" || url.pathname === "/api/strategy/track") {
    res.setHeader("Content-Type", "application/json");
    try {
      if (url.pathname === "/api/strategy/proposals") {
        if (req.method !== "POST") { res.writeHead(405); return res.end(JSON.stringify({ ok: false, error: "method not allowed" })); }
        if (HOST !== "127.0.0.1" || READONLY) {
          res.writeHead(403);
          return res.end(JSON.stringify({ ok: false, error: "strategy proposals are localhost-only" }));
        }
        const body = JSON.parse(await readBody(req, 65536));
        res.writeHead(200);
        return res.end(JSON.stringify(strategyTrack.record(body)));
      }
      res.writeHead(200);
      return res.end(JSON.stringify(strategyTrack.view()));
    } catch (err) {
      res.writeHead(400);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }
  // === end strategy track record ===

  // === strategy dataset (strategy.js) ===
  if (url.pathname.startsWith("/api/strategy/")) {
    res.setHeader("Content-Type", "application/json");
    try {
      const q = url.searchParams;
      const num = (k, d) => (q.get(k) != null && q.get(k) !== "" ? Number(q.get(k)) : d);
      let out;
      if (url.pathname === "/api/strategy/positions") {
        out = await strategy.positionHistory({ wallet: q.get("wallet"), includeClosed: q.get("closed") !== "0", days: num("days", null) });
      }
      else if (url.pathname === "/api/strategy/prices") out = await strategy.priceHistory({ token: q.get("token"), days: num("days", 7), stepHours: num("step", 1) });
      else if (url.pathname === "/api/strategy/scout") out = strategy.scoutHistory({ days: num("days", 30) });
      else if (url.pathname === "/api/strategy/lots") out = await strategy.tokenLots({ token: q.get("token"), wallet: q.get("wallet"), days: num("days", null) });
      else { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "unknown strategy view" })); }
      res.writeHead(200);
      return res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(400);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }
  // === end strategy dataset ===


  if (url.pathname === "/api/staking") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    return res.end(JSON.stringify(staking.enabled ? staking.view() : { ok: true, at: Date.now(), tokens: [] }));
  }

  if (url.pathname === "/api/watch") {
    // Serves the cached view only. A rebuild reads every watched wallet's
    // positions and holdings (minutes for a wallet with many tokens), so it
    // runs in the background: on the 10-minute tick, or kicked off here by
    // fresh=1, which returns the current cache at once with `refreshing: true`.
    res.setHeader("Content-Type", "application/json");
    const fresh = url.searchParams.get("fresh") === "1";
    const d = watch.latest;
    const stale = !d || Date.now() - d.at > 15 * 60 * 1000;
    if (fresh || stale) watch.refresh().catch((err) => console.error("watch:", err.shortMessage || err.message));
    res.writeHead(d ? 200 : 202);
    return res.end(JSON.stringify(d ? { ...d, refreshing: watch.inFlight } : { ok: false, refreshing: true, error: "watched wallets still loading", wallets: [] }));
  }

  if (url.pathname === "/api/balances") {
    res.setHeader("Content-Type", "application/json");
    try {
      if (Date.now() - balCache.at > 5 * 60 * 1000) {
        const rows = [];
        const native = await provider.getBalance(cfg.ownerAddress);
        rows.push({ symbol: "ETH", balance: Number(ethers.formatEther(native)), native: true });
        for (const t of tokenSet.values()) {
          const erc = new ethers.Contract(t.address, ["function balanceOf(address) view returns (uint256)"], provider);
          const raw = await erc.balanceOf(cfg.ownerAddress).catch(() => null);
          if (raw == null) continue;
          rows.push({ symbol: t.symbol, address: t.address, balance: Number(ethers.formatUnits(raw, t.decimals)) });
        }
        // Before the first position build there are no tokens (and no prices);
        // don't let that empty view stick in the cache for 5 minutes.
        balCache = { at: tokenSet.size ? Date.now() : 0, data: rows };
      }
      // Price at read time, not cache time — prices arrive with the first build.
      const priced = balCache.data.map((r) => {
        const price = r.native ? lastPrices[WETH] : lastPrices[r.address.toLowerCase()];
        return { ...r, usd: price != null ? r.balance * price : null };
      });
      priced.sort((a, b) => (b.usd || 0) - (a.usd || 0));
      res.writeHead(200);
      return res.end(JSON.stringify({
        ok: true,
        owner: cfg.ownerAddress,
        rows: priced,
        totalUsd: priced.reduce((s, r) => s + (r.usd || 0), 0),
        explorer: "https://robinhoodchain.blockscout.com",
      }));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }

  if (url.pathname === "/api/rewards") {
    res.setHeader("Content-Type", "application/json");
    const rewards = await merklRewards();
    res.writeHead(200);
    return res.end(JSON.stringify({
      ok: true,
      rewards, // null = Merkl unreachable and nothing cached
      claimUrl: `https://app.merkl.xyz/users/${cfg.ownerAddress}`,
    }));
  }

  if (url.pathname === "/api/history") {
    res.setHeader("Content-Type", "application/json");
    try {
      const rows = [];
      const merged = [...bf.events, ...hist.events].sort((a, b) => a.block - b.block);
      for (const e of merged) {
        const m = await eventMeta(e).catch(() => null);
        const wl = walletLabelFor(e);
        let f0 = null, f1 = null, usd = null, weth = null, locked = false;
        const px = feePrices[priceKey(e)];
        if (m) {
          f0 = Number(ethers.formatUnits(e.fee0, m.t0.decimals));
          f1 = Number(ethers.formatUnits(e.fee1, m.t1.decimals));
          if (px) {
            usd = f0 * px.p0 + f1 * px.p1;
            weth = px.w ? usd / px.w : null;
            locked = true;
          } else {
            // Main-wallet rows keep the original rule (only tokens in its own positions have a
            // current price); watched wallets' rows may also use their holdings' prices.
            const p0 = wl.main ? lastPrices[priceAddr(m.t0)] : currentPrice(priceAddr(m.t0));
            const p1 = wl.main ? lastPrices[priceAddr(m.t1)] : currentPrice(priceAddr(m.t1));
            if (p0 != null && p1 != null) {
              usd = f0 * p0 + f1 * p1;
              weth = lastWethUsdSeen ? usd / lastWethUsdSeen : null;
            }
          }
        }
        rows.push({
          t: e.t, block: e.block, tx: e.tx, tokenId: e.tokenId,
          version: isV4Key(e.tokenId) ? 4 : 3, nftId: isV4Key(e.tokenId) ? String(e.tokenId).slice(3) : String(e.tokenId),
          src: e.src || null, note: e.note || null,
          wallet: wl.label, walletAddress: wl.address, mainWallet: wl.main,
          pair: m ? `${m.t0.symbol}/${m.t1.symbol}` : null,
          sym0: m ? m.t0.symbol : null, sym1: m ? m.t1.symbol : null,
          f0, f1, usd, weth, locked, principal: !!e.principal,
          p0: px ? px.p0 : null, p1: px ? px.p1 : null, wethAt: px ? px.w : null,
        });
      }
      const totalUsd = rows.reduce((s, r) => s + (r.usd || 0), 0);
      const lockedSince = rows.filter((r) => r.locked && r.t).reduce((a, r) => (a == null || r.t < a ? r.t : a), null);
      // Per-wallet breakdown, main wallet first, then in wallets.json order.
      const byWallet = [];
      for (const w of [{ address: cfg.ownerAddress, label: watch.ownerLabel() || "Main", main: true }, ...watch.readWallets()]) {
        const mine = rows.filter((r) => r.walletAddress && r.walletAddress.toLowerCase() === w.address.toLowerCase());
        byWallet.push({ address: w.address, label: w.label || w.address, main: !!w.main, count: mine.length, usd: mine.reduce((s, r) => s + (r.usd || 0), 0), unpriced: mine.filter((r) => r.usd == null).length });
      }
      res.writeHead(200);
      return res.end(JSON.stringify({
        ok: true, rows, totalUsd, byWallet, catchup: hist.catchupStatus(),
        lockedCount: rows.filter((r) => r.locked).length,
        lockedSince,
        wethUsd: lastWethUsdSeen,
        lastScanned: hist.lastScanned,
        scanning: hist.scanning,
        backfilled: bf.ready,
        backfilling: bf.building,
        tvSeries: tvSeries(),
        explorer: "https://robinhoodchain.blockscout.com",
      }));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }

  if (url.pathname === "/api/daily") {
    res.setHeader("Content-Type", "application/json");
    try {
      const ids = new Set();
      for (const b of Object.values(daily.hours)) for (const id of Object.keys(b)) ids.add(id);
      const pools = {};
      for (const id of ids) {
        const m = await positionMeta(id).catch(() => null);
        pools[id] = m
          ? { pair: `${m.t0.symbol}/${m.t1.symbol}`, tier: tierLabel(m.fee) }
          : { pair: `#${id}`, tier: "" };
      }
      const hours = Object.entries(daily.hours)
        .map(([h, p]) => ({ h: Number(h), p }))
        .sort((a, b) => a.h - b.h);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, hours, pools }));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }

  if (url.pathname === "/api/positions") {
    const fresh = url.searchParams.get("fresh") === "1";
    const age = Date.now() - cache.at;

    // Fresh enough: serve it.
    if (!fresh && cache.payload && age < CACHE_MS) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ...cache.payload, cached: true, loops: loopHealth() }));
    }

    // Stale (or fresh=1): kick off one rebuild, shared by all callers.
    if (!buildInFlight) {
      buildInFlight = build()
        .then((payload) => {
          cache = { at: Date.now(), payload };
          return payload;
        })
        .finally(() => {
          buildInFlight = null;
        });
      buildInFlight.catch(() => {}); // logged via the response path that awaits it
    }

    // Stale-while-revalidate: anything cached goes out immediately rather than
    // holding the page hostage for a full chain read. Only the explicit
    // Refresh button (fresh=1) and the very first request ever wait.
    if (cache.payload && !fresh) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ...cache.payload, cached: true, refreshing: true, loops: loopHealth() }));
    }
    try {
      const payload = await buildInFlight;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }

  // The dashboard's stylesheet and script, split out of dashboard.html by
  // tools/split-dashboard.js. Only these two files are served as assets.
  if (url.pathname === "/dashboard.css" || url.pathname === "/dashboard.js") {
    const isCss = url.pathname === "/dashboard.css";
    try {
      const body = fs.readFileSync(path.join(__dirname, isCss ? "dashboard.css" : "dashboard.js"));
      res.writeHead(200, { "Content-Type": isCss ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end(`${isCss ? "dashboard.css" : "dashboard.js"} not found; run node tools/split-dashboard.js`);
    }
  }

  // One HTML file serves both pages; the browser picks the view from the path.
  if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/analytics") {
    const candidates = [
      path.join(__dirname, "public", "dashboard.html"),
      path.join(__dirname, "dashboard.html"),
    ];
    const found = candidates.find((c) => fs.existsSync(c));
    if (!found) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("dashboard.html not found next to server.js or in public/");
    }
    const html = fs.readFileSync(found);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// Staking rewards ledger (staking.js): hourly samples of rebasing receipts,
// priced like the Portfolio prices them (sNET as NET).
const staking = require("./staking").create({
  provider,
  cfg,
  getPrice: (addr) => {
    const row = portfolio.latest && portfolio.latest.rows.find((r) => r.address && r.address.toLowerCase() === addr);
    return row && row.price != null ? row.price : lastPrices[addr] ?? null;
  },
});

/**
 * Background loop health for the watchdog: age of each loop's last write.
 * The guardian rewrites memecoin-status.json every 60 s, the auto-collect
 * loop touches its heartbeat every 15 min. Only loops that are expected
 * (config present and enabled) are reported.
 */
function loopHealth() {
  // The loops are timers in this process; a timer that has not completed a
  // cycle within its window (a hung RPC read, a stuck collector) reads as stale.
  if (!LOOPS) return {};
  const ageOf = (t) => (t ? (Date.now() - t) / 60000 : null);
  const loops = {};
  loops.guardian = { ageMin: ageOf(timers.guardian.lastAt), staleAfterMin: 10, label: "risk guardian" };
  if (cfg.memecoinCollect && cfg.memecoinCollect.enabled !== false) loops.autoCollect = { ageMin: ageOf(timers.autoCollect.lastAt), staleAfterMin: 45, label: "fee auto-collect" };
  loops.backup = { ageMin: ageOf(timers.backup.lastAt), staleAfterMin: 26 * 60, label: "nightly backup", lastResult: timers.backup.lastResult || null };
  for (const l of Object.values(loops)) l.stale = l.ageMin == null ? l.label !== "nightly backup" || (Date.now() - STARTED_AT) / 60000 > 26 * 60 : l.ageMin > l.staleAfterMin;
  return loops;
}

/** The treasury view (/api/treasury): settings in force, TBA balance, ledger totals. */
async function treasuryView() {
  // The percentage in force is the NFT's feeSplitPct() (the vault page's slider), not config.json.
  const ts = await treasuryLedger.effectiveSettings(cfg, provider);
  let balanceUsdg = null;
  if (ts.tba && cfg.usdReference && cfg.usdReference.stable) {
    const usdg = new ethers.Contract(cfg.usdReference.stable, ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"], provider);
    const [raw, dec] = await Promise.all([usdg.balanceOf(ts.tba), usdg.decimals()]);
    balanceUsdg = Number(ethers.formatUnits(raw, dec));
  }
  return { ok: true, ...ts, balanceUsdg, ...treasuryLedger.summary(), explorer: "https://robinhoodchain.blockscout.com" };
}

/**
 * Treasury state for the alerts: effective split % (the TBA contract's own
 * value when it exposes one, else config.json), TBA USDG balance, and the
 * run of consecutive failed splits from the ledger.
 */
async function treasuryState() {
  const ts = treasuryLedger.settings(cfg);
  if (!ts.tba) return null;
  const eff = await treasuryLedger.effectiveSettings(cfg, provider);
  const pct = eff.pct, pctSource = eff.pctSource;
  let balanceUsdg = null;
  try {
    const usdg = new ethers.Contract(cfg.usdReference.stable, ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"], provider);
    const [raw, dec] = await Promise.all([usdg.balanceOf(ts.tba), usdg.decimals()]);
    balanceUsdg = Number(ethers.formatUnits(raw, dec));
  } catch {}
  return { enabled: ts.enabled, pct, pctSource, balanceUsdg, consecutiveFailures: treasuryLedger.consecutiveFailures(), withdrawAlertUsdg: Number(cfg.treasuryWithdrawAlertUsdg) || null };
}

// === performance-attribution === (attribution.js): reads the ledgers plus the live views on request
const attribution = require("./attribution").create({
  cfg,
  getPortfolio: () => portfolio.latest,
  getWatch: () => watch.latest,
  getPositions: () => cache.payload,
  getStaking: () => (staking.enabled ? staking.view() : null),
});
// === token-health-and-approvals ===
// Risk read on every held token (token-health.json, refreshed in the tick) and
// the approval audit behind /approvals.
const tokenHealth = require("./token-health").create({ provider, cfg });
const approvalsAudit = require("./approvals").create({
  provider,
  cfg,
  approvedOperators,
  tokenMeta: (addr) => u.getToken(addr, provider),
});
/** Every token held in any wallet, for the health refresh. */
function heldTokens() {
  const out = [];
  const pf = portfolio.latest;
  if (pf) for (const r of pf.rows) if (r.address) out.push({ address: r.address, symbol: r.symbol });
  for (const w of (watch.latest && watch.latest.wallets) || []) for (const t of (w.holdings && w.holdings.tokens) || []) if (t.address) out.push({ address: t.address, symbol: t.symbol });
  for (const [a, m] of tokenSet) out.push({ address: m.address || a, symbol: m.symbol });
  return out;
}
// === end token-health-and-approvals ===

// Telegram alerts (alerts.js): token and chat id come from the environment
// (./.env via start-all.sh); without them the module stays silent.
const alerts = require("./alerts").create();
console.log(`alerts: ${alerts.enabled ? "enabled" : "disabled (set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID)"}`);

// === pool-scout-and-IL: range advisor / IL forecast (advisor.js) and pool scout (scout.js) ===
const advisor = require("./advisor").create({ provider, cfg });
const scout = require("./scout").create({ cfg, send: (text) => alerts.send(text) });
let advisorAt = 0, scoutAt = 0, advisorBusy = false;
/** Open positions of every wallet in the shape advisor.js and scout.js want. */
async function advisorPositions() {
  const out = [];
  const decimals = new Map();
  const dec = async (addr) => {
    if (!addr || addr === ethers.ZeroAddress) return 18;
    const k = addr.toLowerCase();
    if (!decimals.has(k)) decimals.set(k, (await u.getToken(addr, provider)).decimals);
    return decimals.get(k);
  };
  const push = async (p, wallet) => {
    if (!p.poolAddress || p.tickLower == null) return;
    let liquidity = p.liquidity;
    if (liquidity == null) {
      try {
        liquidity = p.version === 4 && V4 ? (await V4.posm.getPositionLiquidity(BigInt(p.nftId || p.tokenId))).toString() : (await npm.positions(BigInt(p.nftId || p.tokenId))).liquidity.toString();
      } catch {
        return;
      }
    }
    out.push({
      key: `v${p.version === 4 ? 4 : 3}:${String(p.poolAddress).toLowerCase()}`, wallet, tokenId: String(p.nftId || p.tokenId), nftId: String(p.nftId || p.tokenId), pair: p.pair, version: p.version,
      poolAddress: p.poolAddress, token0: p.token0, token1: p.token1, liquidity: String(liquidity), tickLower: p.tickLower, tickUpper: p.tickUpper, currentTick: p.currentTick,
      tickSpacing: p.tickSpacing || (p.version === 4 ? 200 : Math.max(1, Math.round(Number(p.feeTier || 3000) / 50))), feeTier: p.feeTier, usd0: p.usd0, usd1: p.usd1,
      decimals0: await dec(p.token0), decimals1: await dec(p.token1), valueUsd: p.valueUsd, inRange: p.inRange, pool: p.pool,
    });
  };
  for (const p of (cache.payload && cache.payload.positions) || []) await push(p, watch.ownerLabel() || "Main");
  for (const w of (watch.latest && watch.latest.wallets) || []) for (const p of w.positions || []) await push(p, w.label || w.address);
  return out;
}
async function advisorTick() {
  if (advisorBusy) return;
  advisorBusy = true;
  try {
    const positions = await advisorPositions();
    if (Date.now() - advisorAt >= 55 * 60 * 1000) {
      await advisor.refresh(positions, { maxChunksPerPool: 120 });
      advisorAt = Date.now();
    }
    if (Date.now() - scoutAt >= 55 * 60 * 1000) {
      const sent = await scout.check(positions);
      for (const m of sent) console.log("scout:", m.slice(0, 90));
      scoutAt = Date.now();
    }
  } catch (err) {
    console.error("advisor/scout:", err.shortMessage || err.message);
  } finally {
    advisorBusy = false;
  }
}
// === end pool-scout-and-IL ===

// Background work: refresh the view (which also snapshots fees) and advance
// the event scan every 10 minutes, so rates and history accrue even when no
// browser tab is open.
async function backgroundTick() {
  try {
    if (!buildInFlight) {
      buildInFlight = build()
        .then((payload) => {
          cache = { at: Date.now(), payload };
          return payload;
        })
        .finally(() => {
          buildInFlight = null;
        });
    }
    await buildInFlight;
  } catch {}
  try {
    const sent = await alerts.check({
      payload: cache.payload,
      watched: watch.latest && watch.latest.wallets,
      ops: opsInfo(),
      unlock: unlockState(),
      treasury: await treasuryState().catch(() => null),
      loops: loopHealth(),
    });
    for (const m of sent) console.log("alert sent:", m.split("\n")[0].slice(0, 80));
  } catch (err) {
    console.error("alerts:", err.shortMessage || err.message);
  }
  try {
    await refreshPortfolio();
  } catch (err) {
    console.error("portfolio:", err.shortMessage || err.message);
  }
  if (staking.enabled) {
    try {
      await staking.sample();
    } catch (err) {
      console.error("staking:", err.shortMessage || err.message);
    }
  }
  try {
    await watch.refresh();
  } catch (err) {
    console.error("watch:", err.shortMessage || err.message);
  }
  try {
    recordPriceLog(); // after the watched wallets, so their tokens are in the hour's row
  } catch (err) {
    console.error("price log:", err.shortMessage || err.message);
  }
  try {
    recordAllWallets();
  } catch (err) {
    console.error("portfolio-all:", err.shortMessage || err.message);
  }
  advisorTick(); // === pool-scout-and-IL === (hourly work, runs in the background)
  try {
    await hist.scan(await historyWallets(), { mainAddress: cfg.ownerAddress });
  } catch (err) {
    console.error("history scan:", err.shortMessage || err.message);
  }
  if (V4) {
    try {
      await V4.discovery.discover(150);
    } catch (err) {
      console.error("v4 discovery:", err.shortMessage || err.message);
    }
  }
  // Liquidity ledger: catch the forward cursor up to the block the position
  // list was read at, then (once that has happened at least once) keep the
  // backward scan walking toward each open position's mint. The backward
  // scan is not awaited: it can run for most of a tick and must not hold up
  // the collect pricing below.
  if (cache.payload) {
    // === performance-attribution === the watched wallets' v3 positions share the ledger (ids are chain-unique)
    let allIds = latestIds, allOpenIds = latestOpenIds;
    try {
      const watchedIds = (await historyWallets()).filter((w) => !w.main).flatMap((w) => w.ids);
      const watchedOpen = ((watch.latest && watch.latest.wallets) || []).flatMap((w) => (w.positions || []).filter((p) => p.version !== 4).map((p) => String(p.tokenId)));
      allIds = [...new Set([...latestIds, ...watchedIds])];
      allOpenIds = [...new Set([...latestOpenIds, ...watchedOpen])];
    } catch {}
    try {
      await ledger.scanForward(allIds, cache.payload.blockNumber);
    } catch (err) {
      console.error("ledger forward:", err.shortMessage || err.message);
    }
    if (ledger.forwardCaughtUp && ledger.pendingBack(allOpenIds).length) {
      ledger.scanBack(allOpenIds, 600).catch((err) => console.error("ledger back:", err.shortMessage || err.message));
    }
    // v4 ledger: the main wallet's discovered ids plus every watched wallet's
    // (v4-positions-<address>.json, written by watch.js). Bare ids, no prefix.
    // Neither scan is awaited: the first forward walk covers months of blocks.
    if (ledgerV4) {
      const v4Ids = new Set([...V4.discovery.ids].map(String));
      for (const w of (watch.latest && watch.latest.wallets) || []) {
        try { for (const id of JSON.parse(fs.readFileSync(path.join(__dirname, `v4-positions-${w.address.toLowerCase()}.json`), "utf8")).ids || []) v4Ids.add(String(id)); } catch {}
      }
      const v4Open = new Set([
        ...((cache.payload.positions || []).filter((p) => p.version === 4).map((p) => String(p.nftId))),
        ...(((watch.latest && watch.latest.wallets) || []).flatMap((w) => (w.positions || []).filter((p) => p.version === 4).map((p) => String(p.nftId || String(p.tokenId).slice(3))))),
      ]);
      const ids = [...v4Ids];
      ledgerV4.scanForward(ids, cache.payload.blockNumber).then(() => {
        if (ledgerV4.forwardCaughtUp && ledgerV4.pendingBack([...v4Open]).length) {
          return ledgerV4.scanBack([...v4Open], 600);
        }
      }).catch((err) => console.error("ledger-v4:", err.shortMessage || err.message));
    }
  }
  // A position still on a Blockscout basis whose live liquidity disagrees
  // with it had an add or remove since that basis was built. Refetch it now
  // rather than at the daily refresh -- but only if the chain has changed
  // since the last fetch (a change Blockscout never indexed would otherwise
  // be refetched forever) and not more often than every 20 minutes, since
  // the anonymous API allows ten requests an hour.
  if (cache.payload) {
    const REBASIS_MS = 20 * 60 * 1000;
    const live = {};
    for (const p of cache.payload.positions) if (p.version === 3) live[p.tokenId] = p.liquidity;
    const stale = cache.payload.positions
      .filter((p) => p.version === 3 && p.pnlApprox && p.pnlSource !== "rpc")
      .map((p) => p.tokenId)
      .filter((id) => {
        const t = bf.builtAt(id);
        return (t == null || Date.now() - t > REBASIS_MS) && bf.liveAtBuild(id) !== live[id];
      });
    const n = bf.invalidate(stale, live);
    if (n) console.log(`basis: refetching ${n} position(s) whose liquidity changed`);
  }
  // === weekly-digest-and-vault ===
  try {
    await require("./digest").maybeSend({ alerts, base: `http://127.0.0.1:${PORT}` });
  } catch (err) {
    console.error("digest:", err.shortMessage || err.message);
  }
  // Daily line-up (daily.js): once a day at config dailySummary.hour (local), from live data.
  try {
    await require("./daily").maybeSend({ cfg, alerts, base: `http://127.0.0.1:${PORT}` });
  } catch (err) {
    console.error("daily:", err.shortMessage || err.message);
  }
  // === end weekly-digest-and-vault ===
  if (bf.stale && latestIds.length) {
    try {
      await bf.build(latestIds, latestOpenIds, hist.startBlock);
      console.log(`backfill: ${bf.events.length} historical fee event(s), basis for ${Object.keys(bf.basis).length} position(s)`);
    } catch (err) {
      console.error("backfill:", err.shortMessage || err.message);
    }
  }
  try {
    const n = await priceEvents();
    if (n) console.log(`priced ${n} collect(s) at their own time`);
  } catch (err) {
    console.error("collect pricing:", err.shortMessage || err.message);
  }
  // === token-health-and-approvals ===
  // Not awaited: Blockscout reads are paced, a batch may take minutes.
  tokenHealth.refresh(heldTokens(), 15).then((n) => { if (n) console.log(`token health: refreshed ${n} token(s)`); }).catch((err) => console.error("token health:", err.shortMessage || err.message));
  // === end token-health-and-approvals ===
  // === fee-token disposals === where handed-back tokens went (strategy.scanDisposals), every 6 h, paced Blockscout reads; not awaited
  if (Date.now() - lastDisposalScan > 6 * 3600 * 1000) {
    lastDisposalScan = Date.now();
    strategy.scanDisposals({ ownAddresses: [OPERATOR].filter(Boolean) }).then((r) => { if (r.added) console.log(`disposals: ${r.added} outbound transfer(s) of handed-back tokens recorded`); }).catch((err) => console.error("disposals:", err.shortMessage || err.message));
  }
  // === strategy track record === score any due, unscored proposals (one local read when something is due)
  try {
    const r = await strategyTrack.score();
    if (r.scored) console.log("strategy track: scored due proposal(s)");
  } catch (err) {
    console.error("strategy track:", err.shortMessage || err.message);
  }
}
backgroundTick();
setInterval(backgroundTick, 10 * 60 * 1000);

// Rule edits from the Risk section go through the guardian module (config.json or memecoin-discovered.json).
function guardianRules(tokenId, patch) {
  return (guardian || require("./memecoin-guardian").create({ dir: __dirname, provider, positions: () => cache.payload, watched: () => watch.latest && watch.latest.wallets, log: () => {} })).setRule(tokenId, patch);
}

// === background loops === one process, one log: the risk guardian (60 s), fee
// auto-collect (15 min) and the nightly ledger backup (02:00 local) are timers here.
if (LOOPS) {
  const stamp = (tag) => (m) => console.log(`${tag}: ${m}`);
  guardian = require("./memecoin-guardian").create({ dir: __dirname, provider, alerts, log: stamp("guardian"), positions: () => cache.payload, watched: () => watch.latest && watch.latest.wallets });
  let guardianBusy = false;
  async function guardianTick() {
    if (guardianBusy) return;
    guardianBusy = true;
    try { await guardian.cycle(); timers.guardian.lastAt = Date.now(); }
    catch (err) { console.error("guardian: cycle failed:", err.shortMessage || err.message); }
    finally { guardianBusy = false; }
  }
  setTimeout(guardianTick, 90 * 1000); // after the first build
  setInterval(guardianTick, 60 * 1000);

  autoCollect = require("./memecoin-collect").create({ dir: __dirname, alerts, log: stamp("auto-collect"), positions: () => cache.payload, watched: () => watch.latest && watch.latest.wallets,
    treasury: () => treasuryView().catch(() => null), armUrl: `http://127.0.0.1:${PORT}/arm` });
  async function autoCollectTick() {
    try { await autoCollect.cycle(); timers.autoCollect.lastAt = Date.now(); }
    catch (err) { console.error("auto-collect: cycle failed:", err.shortMessage || err.message); }
  }
  setTimeout(autoCollectTick, 2 * 60 * 1000);
  setInterval(autoCollectTick, 15 * 60 * 1000);

  // Nightly backup: backup-ledgers.sh once a day at 02:00 local time (checked every minute; the
  // day is remembered in digest-state.json so a restart after 02:00 does not run it twice).
  const BACKUP_HOUR = Number(process.env.LP_BACKUP_HOUR || 2);
  const backupDay = (d = new Date()) => d.toLocaleDateString("en-CA");
  function backupState() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "digest-state.json"), "utf8")); } catch { return {}; } }
  function runBackup(reason = "scheduled") {
    return new Promise((resolve) => {
      const child = spawn("bash", [path.join(__dirname, "backup-ledgers.sh")], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"], env: process.env });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("close", (code) => {
        const last = out.trim().split("\n").pop() || "";
        console.log(`backup (${reason}): exit ${code}${last ? " — " + last : ""}`);
        timers.backup.lastAt = Date.now();
        timers.backup.lastResult = { at: Date.now(), code, line: last };
        try { fs.writeFileSync(path.join(__dirname, "digest-state.json"), JSON.stringify({ ...backupState(), lastBackupDate: backupDay(), lastBackupAt: new Date().toISOString(), lastBackupCode: code })); } catch {}
        if (code !== 0) alerts.send(`⚠️ Nightly ledger backup exited ${code}: ${last.slice(0, 200)}`).catch(() => {});
        resolve(code);
      });
      child.on("error", (err) => { console.error("backup: could not start:", err.message); resolve(-1); });
    });
  }
  let backupBusy = false;
  setInterval(async () => {
    if (backupBusy) return;
    const now = new Date();
    if (now.getHours() !== BACKUP_HOUR || backupState().lastBackupDate === backupDay(now)) return;
    backupBusy = true;
    try { await runBackup(); } finally { backupBusy = false; }
  }, 60 * 1000);
  // Recorded runs from before the fold count for the watchdog.
  { const st = backupState(); if (st.lastBackupAt) { timers.backup.lastAt = Date.parse(st.lastBackupAt) || 0; timers.backup.lastResult = { at: timers.backup.lastAt, code: st.lastBackupCode ?? null }; } }
  server.runBackup = runBackup;
  console.log(`loops: risk guardian every 60 s, fee auto-collect every 15 min, ledger backup daily at ${String(BACKUP_HOUR).padStart(2, "0")}:00`);
}

// === companion services === the passphrase gate (lp-gate.mjs), the remote MCP
// server (run-mcp-remote.sh) and the Tailscale funnel are children of this
// process, restarted when they exit, their output in this log. --no-services skips them.
if (SERVICES) {
  const listening = (port) => new Promise((resolve) => { const s = require("net").createConnection({ host: "127.0.0.1", port }); s.once("connect", () => { s.destroy(); resolve(true); }); s.once("error", () => resolve(false)); });
  const services = [
    { name: "gate", cmd: "node", args: [path.join(__dirname, "lp-gate.mjs")], port: 8790 },
    { name: "mcp-remote", cmd: "bash", args: [path.join(__dirname, "run-mcp-remote.sh")], port: Number(process.env.LP_MCP_PORT || 8788), needs: path.join(__dirname, ".env.mcp") },
  ];
  // The Robinhood LP pool scanner (a separate project) when SCANNER_DIR points at it; its chat
  // settings come from <scanner>/.env or ~/.config/robinhood-lp.env, never printed.
  const scannerDir = process.env.SCANNER_DIR || "";
  if (scannerDir && fs.existsSync(path.join(scannerDir, "server.js"))) {
    services.push({ name: "scanner", cmd: "bash", cwd: scannerDir, port: 3847, needs: path.join(scannerDir, "server.js"),
      args: ["-c", 'set -a; [ -f "$HOME/.config/robinhood-lp.env" ] && . "$HOME/.config/robinhood-lp.env"; [ -f .env ] && . .env; set +a; mkdir -p .cache; exec node server.js'] });
  }
  async function startService(svc) {
    if (svc.needs && !fs.existsSync(svc.needs)) return console.log(`${svc.name}: skipped (${path.basename(svc.needs)} missing)`);
    if (svc.port && (await listening(svc.port))) return console.log(`${svc.name}: already running on :${svc.port}`);
    const child = spawn(svc.cmd, svc.args, { cwd: svc.cwd || __dirname, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    svc.child = child; svc.startedAt = Date.now();
    const relay = (d) => { for (const line of d.toString().split("\n")) if (line.trim()) console.log(`${svc.name}: ${line}`); };
    child.stdout.on("data", relay); child.stderr.on("data", relay);
    child.on("exit", (code) => {
      svc.child = null;
      const upMs = Date.now() - svc.startedAt;
      const delay = upMs < 30000 ? 60000 : 5000; // a service that dies at once is retried a minute later
      console.log(`${svc.name}: exited ${code}; restarting in ${delay / 1000} s`);
      setTimeout(() => startService(svc).catch(() => {}), delay);
    });
    child.on("error", (err) => console.error(`${svc.name}: ${err.message}`));
    console.log(`${svc.name}: started (pid ${child.pid})`);
  }
  for (const svc of services) startService(svc).catch((err) => console.error(`${svc.name}: ${err.message}`));
  // Tailscale: a one-shot script that brings the daemon up and (re)publishes the funnels.
  if (fs.existsSync(path.join(__dirname, "run-tailscale.sh"))) {
    const ts = spawn("bash", [path.join(__dirname, "run-tailscale.sh")], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "";
    ts.stdout.on("data", (d) => { out += d; }); ts.stderr.on("data", (d) => { out += d; });
    ts.on("close", (code) => console.log(`tailscale: ${code === 0 ? "funnel on" : "exited " + code + " — " + out.trim().split("\n").pop()}`));
  }
  process.on("exit", () => { for (const svc of services) if (svc.child) try { svc.child.kill(); } catch {} });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { for (const svc of services) if (svc.child) try { svc.child.kill(); } catch {} process.exit(0); });
}

server.listen(PORT, HOST, () => {
  console.log(`Dashboard running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (HOST === "0.0.0.0") console.log("Bound to all interfaces -- reachable from your network.");
  console.log(`Watching ${cfg.ownerAddress} on chain ${cfg.chainId}`);
  console.log("Reads are key-free. The Collect button runs run-collector.sh on this machine;");
  console.log("it needs a live unlock window (./unlock.sh) and no key ever reaches the browser.");
});
