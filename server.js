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
const longterm = require("./longterm");
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
const verdict = require("./verdict");

const settings = require("./settings");
const logs = require("./logs");
const vaultMeta = require("./vault-metadata");
const cl = require("./collector-logic");   // native-currency naming, shared with the collector
const cfg = settings.load();
// The chain's name for anything a wallet will show a person. It was hardcoded to
// "Robinhood Chain", which on the Arc instance told the user to switch to the wrong
// network and would have added chain 5042 to their wallet under that name.
const KNOWN_CHAIN_NAMES = { 4663: "Robinhood Chain", 5042: "Arc" };
function chainDisplayName() {
  return cfg.chainName || KNOWN_CHAIN_NAMES[Number(cfg.chainId)] || `Chain ${Number(cfg.chainId)}`;
}
// Ledgers, state files and logs belong to the instance, not to the checkout, so
// one copy of the code can serve a second chain from its own directory. Code,
// pages, assets and shell scripts stay on __dirname; only data moves.
const { DATA_DIR } = require("./data-dir");
const dataFile = (...parts) => path.join(DATA_DIR, ...parts);
// Two different things, and a chain can have one without the other: EXPLORER_URL
// is where a human clicks through to (Arc: arcexplorer.org), BLOCKSCOUT_API is a
// Blockscout-shaped API to query (Arc: none). Empty means "this chain has none",
// which callers must report rather than paper over.
const EXPLORER_URL = cfg.explorer || "";
const BLOCKSCOUT_API = cfg.blockscout ? `${cfg.blockscout.replace(/\/$/, "")}/api` : "";
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
const timers = { guardian: { lastAt: 0 }, autoCollect: { lastAt: 0 }, backup: { lastAt: 0, lastResult: null }, launch: { lastAt: 0 } };
let guardian = null, autoCollect = null, telegramAgent = null, launchScanner = null;

const CACHE_MS = 60_000;
let cache = { at: 0, payload: null };
let buildInFlight = null;

const provider = require("./rpc").createProvider(cfg); // retries throttled (429/403) answers before failing a read
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
        explorerApi: BLOCKSCOUT_API,
      }),
    }
  : null;
// v4 ids share a number space with v3 ids, so they carry a prefix everywhere
// a position is keyed: payloads, snapshots, the daily ledger.
const v4Key = (id) => `v4-${id}`;
const isV4Key = (k) => String(k).startsWith("v4-");

// The unit of account the read path prices in. On this chain it is the wrapped
// native token; on one whose unit is already a dollar (Arc's USDC) it is that,
// and cfg.numeraire.usdRate short-circuits the second hop below. The name WETH
// is kept because ~50 call sites read it and the meaning is the same: "the
// token every other price is quoted against".
const UNIT = cfg.numeraire || { address: cfg.contracts.weth, symbol: "WETH", decimals: 18, usdRate: null };
const WETH = String(UNIT.address || cfg.contracts.weth || "").toLowerCase();

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

/**
 * The unit of account's price in USD, read from a reference stable pool's slot0.
 * When the unit is itself a dollar (cfg.numeraire.usdRate, e.g. Arc's USDC)
 * there is nothing to look up and no pool to depend on.
 */
async function getWethUsd(blockTag) {
  if (UNIT.usdRate != null) return Number(UNIT.usdRate);
  const ref = cfg.usdReference;
  if (!ref || !ref.stable || !cfg.contracts.weth) return null;
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
/**
 * How this instance turns token amounts into dollars, for the page to state
 * instead of a fixed "WETH or USDG" sentence. Position tokens are priced from
 * the position's own pool (priceSides); wallet tokens from the deepest pool
 * against the unit or the stable (portfolio.js poolFor). Symbols are filled in
 * once read from chain.
 */
const PRICING = { unit: UNIT.symbol || null, unitUsd: UNIT.usdRate != null ? Number(UNIT.usdRate) : null, stable: null, text: null };
function pricingText() {
  const unit = PRICING.unit || "the unit token";
  const sameAsStable = STABLE && STABLE === WETH;
  const quotes = sameAsStable || !STABLE ? unit : `${unit} or ${PRICING.stable || "the reference stablecoin"}`;
  const unitUsd = PRICING.unitUsd != null
    ? `${unit} is counted at $${PRICING.unitUsd} by configuration`
    : `${unit} is valued through its pool against ${PRICING.stable || "the reference stablecoin"}${STABLE && !sameAsStable ? `, and ${PRICING.stable || "the stablecoin"} at $1` : ""}`;
  return `Prices are read on-chain against ${quotes}, at current pool state: position tokens from the position's own pool; wallet tokens from a position's pool when one holds the same token, otherwise from the deepest ${quotes} pool. ${unitUsd}. A token with no such pool is left unpriced.`;
}
PRICING.text = pricingText();
if (STABLE && STABLE !== WETH) {
  u.getToken(STABLE, provider, Number(cfg.chainId)).then((t) => { if (t && t.symbol) { PRICING.stable = t.symbol; PRICING.text = pricingText(); } }).catch(() => {});
}
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

const hist = history.create({ provider, npmAddress: cfg.contracts.positionManager, cfg });
const basis = require("./basis");
const bf = basis.create({ npmAddress: cfg.contracts.positionManager });
// Pool stats (TVL, fees, APR, siblings) from the scanner on :3847; see pools.js.
const pools = require("./pools").create({ cfg, provider });

// Extra wallets to show read-only (config.watchWallets); see watch.js.
const watch = require("./watch").create({
  provider, npm, factory, cfg, u, v4, V4, priceSides, toFloat, getWethUsd, pools,
  getPortfolio: () => portfolio, // created below; only used at refresh time
  getPrices: () => lastPrices,
  priceAtOpen: (addr, t) => longterm.priceAt(priceLogData().hours, addr, t), // price-log price at the deposit hour (TASK-82)
  getOperator: () => require("./arm").operatorAddress(), // keystore's public address, re-read each time
  // === performance-attribution === PnL vs HODL for watched positions: liquidity ledger basis + collect events
  getBasis: (tokenId) => {
    const id = String(tokenId);
    if (id.startsWith("v4-")) return typeof ledgerV4 !== "undefined" && ledgerV4 ? ledgerV4.basis(id.slice(3)) : null;
    return typeof ledger !== "undefined" ? ledger.basis(id) : null;
  },
  getCollectEvents: (tokenId) => (typeof hist !== "undefined" ? hist.events.filter((e) => e.tokenId === String(tokenId)) : []),
  getCollectSummary: (tokenKey, dec0, dec1, usd0, usd1) => collectSummary(tokenKey, dec0, dec1, usd0, usd1),
  // Watched positions get the same claimed summary as the owner's, so the two
  // kinds of card can never show a different answer for the same question.
  getClaimedSummary: (tokenKey, dec0, dec1, usd0, usd1, sym0, sym1, ctx) =>
    claimedSummary(tokenKey, dec0, dec1, usd0, usd1, sym0, sym1, null, ctx),
});
// Liquidity history from the RPC itself; the PnL basis prefers it over
// Blockscout's, which has dropped transactions on this chain.
const ledger = require("./ledger").create({
  provider,
  npmAddress: cfg.contracts.positionManager,
  forwardStart: hist.startBlock,
});
/**
 * What this collector itself recorded collecting, per position.
 *
 * Nineteen of the thirty-three positions here can never be reconstructed from the
 * chain: their pools pay a native-asset leg by plain value transfer, which emits no
 * log, so the claims page shows "none" for them and says why. But the collector was
 * the thing doing the collecting, and it wrote down what it took. Eight of those
 * positions are in its ledger with real amounts.
 *
 * This is a different provenance from the chain reconstruction and is never added to
 * the verified totals: it covers only this collector's own runs and knows nothing
 * about fees the wallet settled itself. It is shown beside them, labelled, because
 * "none" for a position that demonstrably paid out is worse than a figure whose
 * origin is stated.
 */
const OWNER_COLLECTS_FILE = dataFile("v4-owner-collects.json");
let ownerCollectsCache = { mtime: 0, byId: new Map() };
function collectorRunsByPosition() {
  let mtime = 0;
  try { mtime = fs.statSync(OWNER_COLLECTS_FILE).mtimeMs; } catch { return new Map(); }
  if (mtime === ownerCollectsCache.mtime) return ownerCollectsCache.byId;
  const byId = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(OWNER_COLLECTS_FILE, "utf8"));
    const rows = Array.isArray(raw) ? raw : raw.rows || [];
    for (const r of rows) {
      if (r.principal === true) continue;                 // liquidity out, not a fee
      const id = String(r.tokenId || "").replace(/^v4-/, "");
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, { records: 0, unknownLegs: 0, firstT: null, lastT: null, tok: new Map() });
      const e = byId.get(id);
      e.records++;
      if (r.t) { if (!e.firstT || r.t < e.firstT) e.firstT = r.t; if (!e.lastT || r.t > e.lastT) e.lastT = r.t; }
      for (const [amt, meta] of [[r.fee0, r.t0], [r.fee1, r.t1]]) {
        // A leg the ledger could not measure is unknown, never zero: adding it as
        // zero is exactly the repair tools/repair-v4-zero-fees.js had to undo.
        if (amt == null || !meta || !meta.address) { e.unknownLegs++; continue; }
        const k = String(meta.address).toLowerCase();
        const prev = e.tok.get(k) || { address: meta.address, symbol: meta.symbol || "?", decimals: Number(meta.decimals ?? 18), raw: 0n };
        prev.raw += BigInt(amt);
        e.tok.set(k, prev);
      }
    }
  } catch { return ownerCollectsCache.byId; }
  ownerCollectsCache = { mtime, byId };
  return byId;
}
const collectorRunsFor = (tokenId) => {
  const e = collectorRunsByPosition().get(String(tokenId));
  if (!e || !e.records) return null;
  return {
    records: e.records, unknownLegs: e.unknownLegs, firstT: e.firstT, lastT: e.lastT,
    tokens: [...e.tok.values()].map((t) => ({ address: t.address, symbol: t.symbol, raw: t.raw.toString(),
      amount: Number(ethers.formatUnits(t.raw, t.decimals)) })),
    note: "this collector's own runs only; fees the wallet settled itself are not counted here",
  };
};

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
      // The v4 ledger starts where the v4 position manager was deployed, not where
      // the v3 collect history starts: they are different contracts with different
      // ages, and a start taken from the wrong one either misses positions or walks
      // blocks that could not contain them. Falls back to the v3 history's start.
      forwardStart: Number(cfg.contracts.v4.deployBlock || hist.startBlock),
      // Chain identity for token naming: without it a native currency is named by
      // guess, and the ledger read an undeclared `cfg` instead.
      cfg,
    })
  : null;
// Portfolio: every token held, in the wallet or inside positions, valued.
const portfolio = require("./portfolio").create({
  provider,
  factory,
  cfg,
  explorerApi: BLOCKSCOUT_API,
});
// addr -> { amount, fees } in token units, summed over open positions by
// the last build, for the portfolio's per-token view.
let lastPoolHoldings = new Map();

// -- Daily revenue ledger ------------------------------------------------------
// Hourly buckets of fee accrual per position, in USD at the prices of the
// moment, derived from consecutive snapshots. Persistent and never pruned, so
// the daily view outlives the 7-day snapshot window. Keyed by the UTC hour
// (epoch ms); the browser folds hours into its own local days.
const DAILY_FILE = dataFile("fee-daily.json");
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
const RANGE_FILE = dataFile("range-log.json");
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
const SNAP_FILE = dataFile("fee-snapshots.json");
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
const PRICE_FILE = dataFile("fee-prices.json");
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
  let usd = 0, usd7d = 0, count = 0, last = null, locked = 0;
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const events = typeof hist !== "undefined" ? [...(typeof bf !== "undefined" ? bf.events : []), ...hist.events] : [];
  for (const e of events) {
    if (e.tokenId !== String(tokenKey)) continue;
    const f0 = Number(ethers.formatUnits(e.fee0 || "0", dec0)), f1 = Number(ethers.formatUnits(e.fee1 || "0", dec1));
    const px = feePrices[priceKey(e)];
    let v = 0;
    if (px) { v = f0 * px.p0 + f1 * px.p1; locked++; }
    else if (usd0 != null && usd1 != null) v = f0 * usd0 + f1 * usd1;
    usd += v;
    if (e.t && e.t > weekAgo) usd7d += v;
    count++;
    if (e.t && (!last || e.t > last)) last = e.t;
  }
  return count ? { usd: +usd.toFixed(2), usd7d: +usd7d.toFixed(2), count, last, atCollectPrices: locked, approx: locked < count } : null;
}
/**
 * The chain-derived claim store for this instance's v4 position manager. Its file
 * lives in DATA_DIR, so two instances on two chains keep separate progress and
 * separate records. v3 has no equivalent here yet: its claims still sit in the
 * tokenId-only ledgers, which is exactly why they are reported as unverified.
 */
const claimStore = (() => {
  try {
    if (!cfg.contracts.v4 || !cfg.contracts.v4.positionManager || !cfg.contracts.v4.poolManager) return null;
    return require("./claims-store").create({
      provider, chainId: Number(cfg.chainId),
      positionManager: cfg.contracts.v4.positionManager,
      poolManager: cfg.contracts.v4.poolManager,
      stateView: cfg.contracts.v4.stateView || null,
      file: dataFile("claims.json"),
      log: console,
      // Arc refuses a getLogs span over about 1,000 blocks; the backward search for
      // the swap that set a pool's price has to respect that too.
      maxLogRange: cfg.maxLogRange ? Number(cfg.maxLogRange) : null,
    });
  } catch (err) { console.error(`claims store unavailable: ${err.message}`); return null; }
})();
/** Pair and owner for a token id, so the scanner knows which positions to fold. */
function claimMeta(tokenId) {
  const hit = claimMetaIndex.get(String(tokenId));
  // Persisted with the scan progress, so a restarted process can keep scanning
  // before the first build has described any position.
  return hit || (claimStore && claimStore.metaOf(tokenId)) || null;
}
/** Every position the scanner should track: this process's cards plus the persisted ones. */
function trackedClaimIds() {
  return [...new Set([...claimMetaIndex.keys(), ...(claimStore ? claimStore.knownIds() : [])])];
}
const claimMetaIndex = new Map();
function rememberClaimMeta(tokenId, token0, token1, owner) {
  if (!tokenId || !token0 || !token1 || !owner) return;
  claimMetaIndex.set(String(tokenId), { token0, token1, owner });
  if (claimStore) {
    try { claimStore.remember(tokenId, { token0, token1, owner }); }
    catch (err) { console.error(`claims: could not persist position ${tokenId}: ${err.message}`); }
  }
}

/**
 * Claimed fees for one position, in the shape the card renders: token amounts,
 * a USD total when both legs price, the count and the latest collection, and an
 * explicit coverage state.
 *
 * Scope. Rows are keyed by token id alone in the ledgers, so the scope is carried
 * here and stated on the card rather than pretended away: this instance serves one
 * chain (cfg.chainId) and one pair of position managers, and `scope` records which.
 * claimed-fees.js is the chain-derived replacement that keys rows by
 * chainId:positionManager:tokenId; until its scanner is wired in, this reads the
 * existing ledgers and is honest about what they cover.
 *
 * Coverage. The v3 scan starts at START_BLOCK, so a position opened before that
 * has claims this cannot see: that is `partial`, with the date it starts from.
 * No history file at all is `unavailable` — never a zero.
 */
// The arguments each card's claim summary was built with, so the summary can be
// recomputed from the store whenever a cached payload is served. The scanner
// moves on between rebuilds (a rescan, a new claim); a summary frozen into the
// positions or watch cache would keep saying "not scanned" after the panel,
// which reads the store directly, already shows a complete history.
const claimArgs = new WeakMap();
function claimedSummary(...args) {
  const out = claimedSummaryNow(...args);
  if (out && typeof out === "object") claimArgs.set(out, args);
  return out;
}
/** Replace every `claimed` in a payload with one computed from the store now. */
function freshClaims(payload) {
  if (!payload || !claimStore) return payload;
  const fix = (list) => {
    if (!Array.isArray(list)) return;              // e.g. a wallet's `closed` is a count
    for (const p of list) {
      const args = p && p.claimed && claimArgs.get(p.claimed);
      if (args) {
        try {
          p.claimed = claimedSummary(...args);
          const [key, dec0, dec1, , , sym0, sym1, , ctx] = args;
          if (ctx && ctx.owner) {
            p.income = positionIncome(String(key).replace(/^v4-/, ""), ctx.owner,
              { address: ctx.token0, symbol: sym0, decimals: dec0 }, { address: ctx.token1, symbol: sym1, decimals: dec1 },
              { claimed: p.claimed, uncollectedUsd: p.feesUsd ?? null, valueUsd: p.valueUsd ?? null });
          }
        } catch (err) { console.error(`claims: refreshing a card summary failed: ${err.message}`); }
      }
    }
  };
  fix(payload.positions);
  fix(payload.closed);
  for (const w of payload.wallets || []) { fix(w.positions); fix(w.closed); }
  return payload;
}
function claimedSummaryNow(tokenKey, dec0, dec1, usd0, usd1, sym0, sym1, openedBlock, ctx) {
  const key = String(tokenKey);
  // Remember what the scanner needs to recognise this position later: its pair and
  // the wallet the payout lands in. Without this the scan cannot tell one manager's
  // positions apart from every other position on the chain.
  if (ctx && ctx.token0 && ctx.token1 && ctx.owner) rememberClaimMeta(key.replace(/^v4-/, ""), ctx.token0, ctx.token1, ctx.owner);
  const isV4 = key.startsWith("v4-");
  const id = key.replace(/^v4-/, "");
  // v3 (and anything else) still comes from the tokenId-only ledgers. Those rows
  // record no chain and no position manager, so the scope this instance would
  // attach is an assumption about where they came from, not evidence. An
  // assumption must not become a displayed figure.
  if (!isV4 || !claimStore) {
    return { status: "unavailable", state: "unsupported", verifiedZero: false,
      reason: isV4
        ? "the chain-derived claim scanner is not configured for this instance"
        : "this position's claims are only in the older token-id-keyed ledger, which records no chain or position manager, so they cannot be attributed to this position with certainty",
      scope: { chainId: Number(cfg.chainId), tokenId: id, positionManager: null },
      legacyRowsExist: hasLegacyRows(key) };
  }
  // A native-asset leg is paid by a value transfer that emits no log, so its
  // history is not reconstructed: excluded and said so, never a zero.
  if (ctx && [ctx.token0, ctx.token1].some((t) => String(t).toLowerCase() === ethers.ZeroAddress)) {
    return { status: "unavailable", state: "unsupported", verifiedZero: false,
      reason: "this pool pays a native-asset leg by plain value transfer, which emits no log; that history is not reconstructed on this instance",
      scope: { chainId: Number(cfg.chainId), tokenId: id, positionManager: String(cfg.contracts.v4.positionManager).toLowerCase(), wallet: ctx.owner ? String(ctx.owner).toLowerCase() : null } };
  }
  // Coverage comes only from the mint (or the wallet's transfer in) the scanner
  // observed; `openedBlock` is not used. Only the wallet's own settlements count.
  return claimStore.summary(id, { dec0, dec1, sym0, sym1, usd0, usd1, wallet: ctx && ctx.owner ? ctx.owner : null });
}
/** Does the old ledger hold rows for this key? Reported, never counted. */
function hasLegacyRows(tokenKey) {
  try { return (hist.events || []).some((e) => e.tokenId === String(tokenKey)); } catch { return false; }
}

/** Has the pre-collector backfill finished, so history reaches a position's open? */
function bfDone() { try { return typeof bf !== "undefined" && bf.ready === true; } catch { return false; } }

/** Approximate wall-clock time of the history scan floor, for the partial label. */
function START_BLOCK_TIME() { try { return hist.startBlockTime || null; } catch { return null; } }
// Scanning is bounded so opening a card cannot stall the request; coverage grows
// a little each time the panel is opened, and the cursor is persisted either way.
const CLAIM_CHUNK = Number(process.env.LP_CLAIM_CHUNK || 9000);
const CLAIM_BUDGET = Number(process.env.LP_CLAIM_BUDGET || 6);
// How far back a scan reaches for a position whose mint it has not found. The
// store converts this to a block floor with the chain's measured block time
// (Arc is ~0.5 s a block, Robinhood ~0.1 s), so no block time is assumed here.
const CLAIM_LOOKBACK_MS = Number(process.env.LP_CLAIM_LOOKBACK_DAYS || 30) * 86400 * 1000;
/** Scan every position the cards have described, under the request budget. */
function scanClaims() {
  return claimStore.scan(claimMeta, { ids: trackedClaimIds(), chunk: CLAIM_CHUNK, budget: CLAIM_BUDGET, lookbackMs: CLAIM_LOOKBACK_MS });
}
// The background scan (claims-scanner.js): runs from server start, one chunk at a
// time behind the dashboard's own requests, until every tracked position reaches
// its mint or the lookback floor, then follows the head. On in the main process;
// a read-only or preview instance opts in with LP_CLAIM_SCAN=1 or --claim-scan
// (only one process per data directory should run it). LP_CLAIM_SCAN=0 turns it off.
let activeRequests = 0;
const CLAIM_SCAN = !!claimStore && process.env.LP_CLAIM_SCAN !== "0" &&
  (process.env.LP_CLAIM_SCAN === "1" || process.argv.includes("--claim-scan") || LOOPS);
// Only one process may own claims.json; if another live one does, this one reads.
const CLAIM_WRITER = CLAIM_SCAN && claimStore.acquireWriter();
if (CLAIM_SCAN && !CLAIM_WRITER) console.error(`claims scan: not started, another process holds ${dataFile("claims.json")}.lock; this one only reads its progress`);
const claimScanner = CLAIM_WRITER ? require("./claims-scanner").create({
  store: claimStore, meta: claimMeta, ids: trackedClaimIds,
  busy: () => activeRequests > 0,
  chunk: CLAIM_CHUNK, lookbackMs: CLAIM_LOOKBACK_MS,
  pauseMs: Number(process.env.LP_CLAIM_PAUSE_MS || 500),
  // New records are priced at their own block right away, so the cards' dollar
  // figure does not wait for someone to open the panel.
  onFolded: async () => { await priceAllClaims(); },
}) : null;
async function priceAllClaims() {
  for (const id of trackedClaimIds()) await priceClaims(id).catch((err) => console.error(`claims: pricing ${id}: ${err.message}`));
}

// Every v4 position the wallets on this instance have held (position-registry.js).
// Refreshed in the background by the process that owns the claim store; requests
// read the saved view.
const lcAddr = (a) => (a == null ? null : String(a).toLowerCase());
function instanceWallets() {
  const out = [{ address: cfg.ownerAddress, label: watch.ownerLabel() || "Main" }];
  for (const w of watch.readWallets()) out.push({ address: w.address, label: w.label || w.address });
  const seen = new Set();
  return out.filter((w) => w.address && !seen.has(lcAddr(w.address)) && seen.add(lcAddr(w.address)));
}
const registry = V4 && claimStore ? require("./position-registry").create({
  provider, cfg, posm: V4.posm, v4,
  getToken: (a) => u.getToken(a, provider, Number(cfg.chainId)),
  wallets: instanceWallets,
  discoveryFor: (a) => (lcAddr(a) === lcAddr(cfg.ownerAddress) ? V4.discovery : watch.discoveryFor(a)),
  // A position already described by an open card keeps that description.
  remember: (id, m) => { if (!claimMetaIndex.has(String(id))) { try { claimStore.remember(id, m); } catch {} } },
  file: dataFile("position-registry.json"),
}) : null;
/** `?wallet=all|<address>` → the instance's wallets in scope (this chain only). */
function claimScope(url) {
  const all = instanceWallets();
  const want = String(url.searchParams.get("wallet") || "all").toLowerCase();
  if (want === "all") return { all: true, wallets: all, set: new Set(all.map((w) => lcAddr(w.address))) };
  const hit = all.find((w) => lcAddr(w.address) === want);
  if (!hit) return { error: "wallet is not one of this instance's wallets" };
  return { all: false, wallets: [hit], set: new Set([want]) };
}
/**
 * What a position has actually earned, from the chain-derived history alone:
 * capital in and out at the price of each transaction, fees claimed at the price
 * of each settlement, and the fees still in the pool at today's price.
 *
 * The fee rate is fees over TIME-WEIGHTED capital: the running net capital (at
 * the prices it went in and out) integrated over the position's life and divided
 * by that life. A position that has been emptied still has an honest denominator
 * this way, and no figure is produced when an input is missing — every gap is
 * named in `missing` instead.
 */
function positionIncome(tokenId, wallet, token0, token1, { claimed, uncollectedUsd = null, valueUsd = null, closedT = null } = {}) {
  const missing = [];
  if (!claimStore) return { available: false, missing: ["this instance has no chain-derived claim scanner"] };
  if (!token0 || !token1 || token0.decimals == null || token1.decimals == null) {
    return { available: false, missing: ["a token's decimals were not read from chain"] };
  }
  const cap = claimStore.capital(tokenId, wallet);
  const cov = claimStore.coverage(tokenId, wallet);
  const usdOf = (r, a0, a1) => (r.px ? Number(ethers.formatUnits(a0, token0.decimals)) * r.px.p0 + Number(ethers.formatUnits(a1, token1.decimals)) * r.px.p1 : null);
  let deposited = 0, withdrawn = 0, unpriced = 0;
  const events = [];
  for (const r of cap) {
    const usd = r.unpriced ? null : usdOf(r, r.principal0, r.principal1);
    if (usd == null) { unpriced++; continue; }
    if (r.direction === "in") deposited += usd; else withdrawn += usd;
    events.push({ t: r.t, usd, direction: r.direction });
  }
  if (!cov || !cov.coversOpening) missing.push("the scan has not covered this position's whole life for this wallet");
  if (unpriced) missing.push(`${unpriced} capital movement(s) have no verified price of their moment`);
  if (!cap.length) missing.push("no capital movement has been read for this position yet");
  const openedT = cov ? cov.openedT ?? cov.fromT : null;
  if (openedT == null) missing.push("the time this position was opened is not known");
  const endT = closedT || Date.now();
  const days = openedT != null ? (endT - openedT) / 86400000 : null;
  // Time-weighted capital over the life, from the events themselves.
  let twa = null;
  if (openedT != null && days > 0 && events.length && !unpriced) {
    const sorted = events.filter((e) => e.t != null).sort((a, b) => a.t - b.t);
    let running = 0, area = 0, prev = openedT;
    for (const e of sorted) {
      area += running * Math.max(0, e.t - prev);
      running += e.direction === "in" ? e.usd : -e.usd;
      prev = e.t;
    }
    area += running * Math.max(0, endT - prev);
    twa = area / Math.max(1, endT - openedT);
  }
  const claimedUsd = claimed && claimed.usd != null ? claimed.usd : null;
  if (claimedUsd == null) missing.push("the claimed fees have no historical USD total");
  const uncollected = uncollectedUsd == null ? 0 : uncollectedUsd;
  const feesUsd = claimedUsd == null ? null : claimedUsd + uncollected;
  // Fees against the capital that was actually working, and the annualised rate —
  // but only from a day's history: annualising six hours reads as a five-figure
  // percentage and means nothing.
  const onCapitalPct = feesUsd != null && twa != null && twa > 0 ? (feesUsd / twa) * 100 : null;
  const feeRatePct = onCapitalPct != null && days >= 1 ? onCapitalPct * (365 / days) : null;
  const annualNote = onCapitalPct != null && feeRatePct == null
    ? `open for ${days != null ? (days * 24).toFixed(1) : "?"} h — too short to annualise`
    : null;
  return {
    available: !missing.length,
    openedT, days: days == null ? null : +days.toFixed(3), closedT: closedT || null,
    depositedUsd: unpriced ? null : +deposited.toPrecision(12),
    withdrawnUsd: unpriced ? null : +withdrawn.toPrecision(12),
    netCapitalUsd: unpriced ? null : +(deposited - withdrawn).toPrecision(12),
    twaCapitalUsd: twa == null ? null : +twa.toPrecision(12),
    claimedUsd, uncollectedUsd: uncollectedUsd == null ? null : +uncollected.toPrecision(12),
    feesUsd: feesUsd == null ? null : +feesUsd.toPrecision(12),
    onCapitalPct: onCapitalPct == null ? null : +onCapitalPct.toPrecision(6),
    feeRatePct: feeRatePct == null ? null : +feeRatePct.toPrecision(6),
    annualNote,
    valueUsd, capitalEvents: cap.length, claimEvents: claimed ? claimed.count ?? null : null,
    basis: "capital at the price of each deposit and withdrawal; claimed fees at the price of each settlement; fees still in the pool at today's price",
    missing,
  };
}

/** A registry entry's claim summary, scoped to the wallet that held it. */
function registryClaim(e) {
  const scope = { chainId: Number(cfg.chainId), positionManager: lcAddr(cfg.contracts.v4.positionManager), tokenId: e.tokenId, wallet: e.wallet };
  if (!e.token0 || !e.token1) {
    return { status: "unavailable", state: "unsupported", verifiedZero: false, scope,
      reason: "this position's pair could not be read, so its settlements cannot be decoded" };
  }
  if (e.token0.decimals == null || e.token1.decimals == null) {
    return { status: "unavailable", state: "unsupported", verifiedZero: false, scope,
      reason: "a token's decimals were not read from chain, so no amount can be stated" };
  }
  const price = (t) => (t.address === ethers.ZeroAddress ? lastPrices[WETH] ?? null : currentPrice(t.address) ?? null);
  return claimedSummary(`v4-${e.tokenId}`, e.token0.decimals, e.token1.decimals, price(e.token0), price(e.token1),
    e.token0.symbol, e.token1.symbol, null, { token0: e.token0.address, token1: e.token1.address, owner: e.wallet });
}
/** A registry entry plus what the claim store knows: dates, closure, fees owed. */
async function historyEntry(e) {
  const own = claimStore.ownership(e.tokenId);
  const lh = claimStore.liquidityHistory(e.tokenId);
  const w = e.wallet;
  const at = async (x) => (x ? { block: x.block, t: await registry.blockTime(x.block), tx: x.tx } : null);
  const received = own.transfers.find((x) => x.to === w) || null;
  const sentAway = [...own.transfers].reverse().find((x) => x.from === w && x.to !== ethers.ZeroAddress) || null;
  let status = e.status, statusReason = e.statusReason;
  // A burned NFT that this wallet had already transferred away left this wallet
  // by transfer; the burn was someone else's.
  if (status === "burned" && sentAway) {
    status = "transferred";
    statusReason = `sent to ${sentAway.to} and later burned by its new owner`;
  }
  const noLiquidity = status === "closed" || status === "burned";
  const claimed = registryClaim(e);
  const closedAt = noLiquidity && lh.closedAt ? { ...(await at(lh.closedAt)), verified: !!lh.closedAt.verified } : null;
  const { checkedAt, poolId, tickSpacing, mintBlock, ...rest } = e;
  return {
    ...rest, status, statusReason,
    openedAt: await at(received),
    closedAt,
    transferredAt: status === "transferred" && sentAway ? { ...(await at(sentAway)), to: sentAway.to } : null,
    burnedAt: status === "burned" ? await at(own.burn) : null,
    unsettledFees: noLiquidity
      ? { state: "none", reason: "v4 pays out every accrued fee when liquidity is removed, and this position holds no liquidity" }
      : { state: "unknown", reason: status === "open" ? "shown as uncollected fees on the open card"
        : status === "transferred" ? "the position belongs to another owner now" : "the position could not be read" },
    claimed,
    income: positionIncome(e.tokenId, e.wallet, e.token0, e.token1, {
      claimed,
      uncollectedFees: null,
      uncollectedUsd: noLiquidity ? 0 : null,
      closedT: closedAt ? closedAt.t : null,
    }),
    checkedAt,
  };
}
/**
 * The selected wallets' verified fee settlements, aggregated. Tokens are summed by
 * ADDRESS. USD is only ever historical here (a claim's own verified price); claims
 * without one are listed as excluded from a "priced subtotal". Today's valuation is
 * a separate, labelled figure. Positions whose history cannot be read in full are
 * left out of the totals and listed with the reason.
 */
async function claimTotal(sel, status, from, to) {
  const bucketOf = (st) => (st === "open" ? "open" : st === "closed" ? "closed" : "other");
  const newSub = () => ({ tokens: new Map(), usdHistorical: 0, pricedSubtotal: 0, unpriced: 0, records: 0, positions: 0 });
  const addTok = (map, t, raw) => {
    const k = t.address;
    const cur = map.get(k) || { address: t.address, symbol: t.symbol, decimals: t.decimals, raw: 0n };
    cur.raw += raw;
    map.set(k, cur);
  };
  const tokList = (map) => [...map.values()].map((x) => ({ address: x.address, symbol: x.symbol, decimals: x.decimals,
    raw: x.raw.toString(), amount: Number(ethers.formatUnits(x.raw, x.decimals)) }));
  const tokens = new Map();
  const subs = { open: newSub(), closed: newSub(), other: newSub() };
  const positions = [], rows = [], excluded = [], partial = [], unsupported = [];
  let complete = true, hist = 0, priced = 0, unpriced = 0, inScope = 0;
  for (const e0 of registry.entries(sel.set)) {
    const h = await historyEntry(e0);
    const bucket = bucketOf(h.status);
    if (status !== "all" && bucket !== status) continue;
    inScope++;
    const c = h.claimed;
    const base = { key: h.key, tokenId: h.tokenId, wallet: h.wallet, walletLabel: h.walletLabel, status: h.status, pair: h.pair || null, bucket };
    if (h.status === "unavailable" || ["unsupported", "undecodable", "not-scanned"].includes(c.state)) {
      complete = false;
      const reason = h.status === "unavailable" ? h.statusReason : c.reason;
      (c.state === "not-scanned" ? partial : unsupported).push({ key: h.key, tokenId: h.tokenId, state: h.status === "unavailable" ? "unavailable" : c.state, reason });
      // The excluded path is where the native-asset positions land -- the ones the
      // chain cannot reconstruct at all. It is precisely there that the collector's
      // own record is worth having, so it is attached here too. Without this the
      // figure appeared only on positions that already had a verified history.
      positions.push({ ...base, tokens: [], usdHistorical: null, pricedSubtotal: 0, records: 0, lastT: null, state: h.status === "unavailable" ? "unavailable" : c.state, reason, included: false,
        collector: collectorRunsFor(base.tokenId) });
      continue;
    }
    if (c.state !== "complete") { complete = false; partial.push({ key: h.key, tokenId: h.tokenId, state: c.state, reason: c.reason }); }
    const recs = claimStore.rows(h.tokenId, h.wallet).filter((r) => !r.unavailable)
      .filter((r) => (from == null || (r.t != null && r.t >= from)) && (to == null || (r.t != null && r.t <= to)));
    const ptoks = new Map();
    let pHist = 0, pUnpriced = 0, lastT = null;
    const sub = subs[bucket];
    sub.positions++;
    for (const r of recs) {
      const r0 = BigInt(r.fee0 || "0"), r1 = BigInt(r.fee1 || "0");
      addTok(tokens, h.token0, r0); addTok(tokens, h.token1, r1);
      addTok(ptoks, h.token0, r0); addTok(ptoks, h.token1, r1);
      addTok(sub.tokens, h.token0, r0); addTok(sub.tokens, h.token1, r1);
      const x0 = Number(ethers.formatUnits(r0, h.token0.decimals)), x1 = Number(ethers.formatUnits(r1, h.token1.decimals));
      const usdRow = r.px ? x0 * r.px.p0 + x1 * r.px.p1 : null;
      if (usdRow == null) { unpriced++; pUnpriced++; sub.unpriced++; excluded.push({ key: r.key, tokenId: h.tokenId, reason: "no verified price of this claim's moment" }); }
      else { priced++; hist += usdRow; pHist += usdRow; sub.pricedSubtotal += usdRow; }
      sub.records++;
      if (r.t && (!lastT || r.t > lastT)) lastT = r.t;
      rows.push({ key: r.key, positionKey: h.key, logIndex: Number(String(r.key).split(":")[1]), tokenId: h.tokenId, wallet: h.wallet, walletLabel: h.walletLabel,
        status: h.status, t: r.t ?? null, block: r.block, tx: r.tx, kind: r.kind, recipient: r.owner || null,
        tokens: [{ address: h.token0.address, symbol: h.token0.symbol, raw: r0.toString(), amount: x0 },
                 { address: h.token1.address, symbol: h.token1.symbol, raw: r1.toString(), amount: x1 }],
        usd: usdRow == null ? null : +usdRow.toPrecision(12), priceSrc: r.px ? r.px.src : null,
        priceT: r.px ? (r.px.t ?? (r.px.src === "block" ? r.t ?? null : null)) : null });
    }
    positions.push({ ...base, tokens: tokList(ptoks), usdHistorical: pUnpriced ? null : +pHist.toPrecision(12), pricedSubtotal: +pHist.toPrecision(12),
      records: recs.length, lastT, state: c.state, reason: c.reason || null, included: true,
      // Carried, never merged: the verified figures above stay exactly as the chain
      // supports them, and this says what the collector separately wrote down.
      collector: collectorRunsFor(base.tokenId) });
  }
  const discovery = sel.wallets.map((w) => {
    const d = registry.discoveryStatus(w.address);
    return { wallet: lcAddr(w.address), label: w.label, complete: !!(d && d.complete), scannedFrom: d ? d.scannedFrom : null,
      deployBlock: d ? d.deployBlock : null, error: d ? d.error : "no discovery for this wallet" };
  });
  if (discovery.some((d) => !d.complete)) complete = false;
  rows.sort((a, b) => (b.t || 0) - (a.t || 0) || b.block - a.block);
  const tokenTotals = tokList(tokens);
  // Today's prices, separately: only when every token has one.
  let current = null;
  if (tokenTotals.length) {
    const prices = tokenTotals.map((t) => (t.address === ethers.ZeroAddress ? lastPrices[WETH] ?? null : currentPrice(t.address) ?? null));
    current = prices.every((p) => p != null)
      ? { usd: +tokenTotals.reduce((s, t, i) => s + t.amount * prices[i], 0).toPrecision(12), note: "the same token amounts at today's prices; not what they were worth when claimed" }
      : { usd: null, note: "a claimed token has no current price, so there is no current-price figure" };
  }
  const walletName = sel.all ? "All wallets" : sel.wallets[0].label;
  const statusName = { all: "Open + closed", open: "Open", closed: "Closed", other: "Burned, transferred and unavailable" }[status];
  const state = !rows.length ? "empty" : complete ? "complete" : "partial";
  const stateLabel = !rows.length
    ? (complete ? "Verified: no fees claimed" : "No verified settlements found so far — partial history")
    : complete ? "Verified claimed — complete history" : "Verified claimed so far — partial history";
  const note = [
    "Only this instance's chain and v4 position manager are covered; v3 positions are not reconstructed here. Token ids are shared across managers, so they are never merged by id alone.",
    "Historical USD uses each settlement's own pool price at its transaction — the price that produced the payout, not an independent valuation; another venue's price for the same token can differ materially.",
    "Native-asset payouts emit no log and are not reconstructed; such positions are listed as unsupported and excluded.",
    discovery.some((d) => !d.complete) ? "Position discovery has not swept back to the position manager's deployment block for every wallet, so an older position cannot be ruled out from saved state alone." : "",
    from != null || to != null ? "A date range is applied to the settlements; coverage still describes the whole history." : "",
  ].filter(Boolean).join(" ");
  const subOut = (x) => ({ tokens: tokList(x.tokens), usdHistorical: x.unpriced ? null : +x.pricedSubtotal.toPrecision(12),
    pricedSubtotal: +x.pricedSubtotal.toPrecision(12), records: x.records, positions: x.positions });
  return {
    ok: true, at: registry.at,
    scope: { chainId: Number(cfg.chainId), positionManager: lcAddr(cfg.contracts.v4.positionManager),
      wallets: sel.wallets.map((w) => ({ address: lcAddr(w.address), label: w.label })), status, from, to },
    label: `Total claimed fees · ${walletName} · ${statusName}`,
    state, stateLabel,
    verifiedZero: complete && !rows.length,
    tokens: tokenTotals,
    usd: { historical: unpriced ? null : +hist.toPrecision(12), pricedSubtotal: +hist.toPrecision(12), pricedRecords: priced, unpricedRecords: unpriced, excluded },
    current,
    subtotals: { open: subOut(subs.open), closed: subOut(subs.closed), other: subOut(subs.other) },
    positions, rows,
    coverage: { positionsTotal: inScope, positionsComplete: positions.filter((p) => p.state === "complete").length, partial, unsupported, discovery, note },
    pricing: PRICING,
  };
}
const REGISTRY_EVERY_MS = 10 * 60 * 1000;
function refreshRegistry() {
  if (!registry || !CLAIM_WRITER) return null;
  return registry.refresh();
}

/**
 * Fix each of a position's claims at the USD prices of its own moment: the pool
 * price the scanner read at the claim's block with the numeraire at that block,
 * else the hourly price log within three hours. A claim with neither keeps no
 * price, and the summary values it at today's prices and says so. A price once
 * fixed is kept with the record, so this only does work for new claims.
 */
/**
 * The hourly price log has held mis-scaled rows (a token off by 1e12 after a
 * decimals slip), which would value a claim at about nothing. A log row is used
 * for a claim only when it agrees with the pool price the scanner read at that
 * claim (within 1.5x on the pair's ratio). Otherwise it is refused: the claim
 * keeps its exact token amounts and has no historical USD value.
 */
function priceLogImplausible(lp, r, a, b) {
  if (!(lp.p0 > 0) || !(lp.p1 > 0)) return "a non-positive price";
  // Being near today's price says nothing about a past price, so without the pool
  // price the scanner read at the claim there is nothing to verify the row against.
  if (!r.sqrtP) return "no pool price at the claim to verify the price-log row against";
  const pool = u.priceFromSqrt(BigInt(r.sqrtP), a.decimals, b.decimals);   // token1 per token0
  const ratio = (lp.p0 / lp.p1) / pool;
  return pool > 0 && ratio < 1.5 && ratio > 1 / 1.5 ? null : `its ratio is ${ratio.toPrecision(3)}x the pool price at the claim`;
}
async function priceClaims(id) {
  let changed = 0;
  // Capital events are priced too: a deposit's own price is what makes an income
  // figure possible at all.
  for (const r of claimStore.rows(id, null, { capital: true })) {
    if (r.px || r.unavailable) continue;
    let px = null;
    try {
      const [a, b] = await Promise.all([u.getToken(r.token0, provider, Number(cfg.chainId)), u.getToken(r.token1, provider, Number(cfg.chainId))]);
      if (a.decimalsOk !== true || b.decimalsOk !== true) continue;   // no decimals, no price
      const m = { t0: { address: r.token0, decimals: a.decimals, symbol: a.symbol }, t1: { address: r.token1, decimals: b.decimals, symbol: b.symbol } };
      if (r.sqrtP) {
        const w = await getWethUsd(r.block);
        if (w != null) {
          const current = u.priceFromSqrt(BigInt(r.sqrtP), a.decimals, b.decimals);
          const { usd0, usd1 } = priceSides({ token0: m.t0, token1: m.t1, prices: { current } }, w);
          if (usd0 != null && usd1 != null && isFinite(usd0) && isFinite(usd1)) px = { p0: usd0, p1: usd1, src: "block", t: r.t ?? null };
        }
      }
      if (!px && r.t) {
        const lp = pricesFromLog(m, r.t);
        const why = lp ? priceLogImplausible(lp, r, a, b) : null;
        if (lp && !why) px = { ...lp, t: lp.at };
        else if (why) console.error(`claims: price-log row for ${r.key} rejected: ${why}`);
      }
    } catch (err) {
      console.error(`claims: pricing ${r.key} failed: ${err.shortMessage || err.message}`);
    }
    if (px) { claimStore.setPrice(r.key, px); changed++; }
  }
  if (changed) claimStore.save();
  return changed;
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
const PRICE_LOG_FILE = dataFile("price-log.json");
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
  return { p0, p1, w: row.eth, src: "pricelog", at: Number(best.h) };
}

// -- Combined portfolio history --------------------------------------------------
// Hourly total value of the main wallet and each watched wallet, kept forever,
// for the all-wallets and per-wallet value charts.
const ALL_FILE = dataFile("portfolio-all.json");
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
  // A partially priced owner view understates `owner` and `total`; the point is kept for the
  // chart but flagged so attribution never reads the gap as a value drop.

  // A misread price is not a measurement. One sample on 2026-09-17 recorded the
  // owner at 6.7e37 and one watched wallet at 1.4e38 while the main-wallet series,
  // priced the same minute, sat at $12,400 -- a single token priced wrongly by
  // thirty-odd orders of magnitude. It is kept forever and it set the chart's upper
  // bound, flattening eleven days of real history into the axis. So a sample wildly
  // out of step with the ones around it is refused rather than stored: judged
  // against the recent median, which needs no absolute ceiling and moves with the
  // portfolio, and only once there is enough history to judge against.
  const recent = allSeries.points.slice(-24).map((p) => p.total).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const median = recent.length ? recent[Math.floor(recent.length / 2)] : null;
  if (!Number.isFinite(total)) {
    console.error(`portfolio-all: sample refused, total is not a number (${total})`);
    return;
  }
  if (median != null && recent.length >= 6 && total > median * 100) {
    console.error(`portfolio-all: sample refused, $${total.toExponential(3)} is more than 100x the recent median of $${median.toFixed(2)} — a price misread, not a value`);
    return;
  }
  allSeries.points.push({ t: Date.now(), owner, wallets, total, ...(pf.partial ? { partial: true } : {}) });
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

/**
 * Every operator this owner has granted setApprovalForAll on `mgr`.
 *
 * The collector's own operator is asked about directly, so its row is right even
 * where the event history cannot be read: a chain that caps getLogs (Arc refuses
 * anything over ~1,000 blocks) made this return nothing at all, and the page then
 * said "No operator approvals" about a wallet that had just approved. Other
 * operators are discovered from events over whatever range the chain allows, and
 * the coverage is reported rather than implied.
 */
async function approvedOperators(provider, mgr, owner, knownOperator = null) {
  const iface = new ethers.Interface(["event ApprovalForAll(address indexed owner,address indexed operator,bool approved)"]);
  const c = new ethers.Contract(mgr, ["function isApprovedForAll(address,address) view returns (bool)"], provider);
  const state = async (op) => c.isApprovedForAll(owner, op).catch(() => null);

  const seen = new Map();
  if (knownOperator) seen.set(ethers.getAddress(knownOperator), "configured");

  let coverage = { scannedFrom: null, complete: false, error: "not scanned" };
  try {
    const scan = await logs.getLogsRange(provider, { address: mgr, topics: [iface.getEvent("ApprovalForAll").topicHash, ethers.zeroPadValue(owner, 32)] },
      { from: 0, span: logs.spanFor(cfg), maxRequests: 8 });
    for (const l of scan.logs) { const op = iface.parseLog(l).args.operator; if (!seen.has(op)) seen.set(op, "event"); }
    coverage = { scannedFrom: scan.scannedFrom, complete: scan.complete, error: scan.error || null, requests: scan.requests };
  } catch (err) {
    coverage = { scannedFrom: null, complete: false, error: err.shortMessage || err.message };
  }

  const out = [];
  for (const [op, source] of seen) out.push({ address: op, approved: await state(op), source });
  // An operator the chain confirms is approved is never dropped for lack of history.
  out.sort((a, b) => (b.approved === true) - (a.approved === true));
  out.coverage = coverage;
  return out;
}

// -- Last run + gas budget, for the ops strip --------------------------------
function opsInfo() {
  let gas24h = 0;
  try {
    const st = JSON.parse(fs.readFileSync(dataFile("state.json"), "utf8"));
    const cut = Date.now() - 86400 * 1000;
    for (const g of st.gasSpends || []) {
      if (g.t >= cut) gas24h += Number(g.wei) / 1e18;
    }
  } catch {}

  // Last run, with failures attributed per wallet pass (see ops.js).
  let lastRun = null;
  try {
    const lines = fs.readFileSync(dataFile("collector.log"), "utf8").split("\n").slice(-600);
    lastRun = require("./ops").parseLastRun(lines);
  } catch {}

  return { lastRun, gas24h: { eth: gas24h, capEth: Number(cfg.thresholds && cfg.thresholds.dailyGasCapEth) || 0 } };
}

// Every wallet whose collects are recorded: the main wallet (ids from the
// last build) and each settings.json wallet (v3 ids enumerated on the NPM,
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
let priceLogCache = { at: 0, hours: {}, sorted: [] };
function priceLogData() {
  if (Date.now() - priceLogCache.at > 60 * 1000) {
    try { const pl = JSON.parse(fs.readFileSync(dataFile("price-log.json"), "utf8")); const hours = pl.hours || {}; priceLogCache = { at: Date.now(), hours, sorted: Object.keys(hours).map(Number).sort((a, b) => a - b) }; } catch { priceLogCache.at = Date.now(); }
  }
  return priceLogCache;
}
const priceHoursSorted = () => priceLogData().sorted;
const priceLogRow = (h) => priceLogData().hours[String(h)] || {};
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
        v4.getCurrency(key.currency0, provider, cfg),
        v4.getCurrency(key.currency1, provider, cfg),
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

// === long-term returns (longterm.js, TASK-51) ===============================
// The collect history rows, built the same way /api/history serves them, kept in memory so
// the positions build and attribution.load() can hand them to longterm.compute() without a
// round trip; refreshed at most every 5 min (the route always refreshes).
const { dayKey: ltDayKey } = require("./daykey");
let lastHistoryRows = [];
let lastHistoryAt = 0;
let historyInFlight = null;
async function historyRows(fresh = false) {
  if (!fresh && Date.now() - lastHistoryAt < 5 * 60 * 1000) return lastHistoryRows;
  if (historyInFlight) return historyInFlight;
  historyInFlight = (async () => {
    const rows = [];
    const merged = [...bf.events, ...hist.events].sort((a, b) => a.block - b.block);
    for (const e of merged) {
      const m = await eventMeta(e).catch(() => null);
      const wl = walletLabelFor(e);
      let f0 = null, f1 = null, usd = null, weth = null, locked = false;
      const px = feePrices[priceKey(e)];
      if (m) {
        // A leg recorded as null (a batched v4 collect whose split is unknown, TASK-87) is 0 for
        // the amount and makes the row unpriced: the USD would be a guess.
        const legUnknown = e.fee0 == null || e.fee1 == null;
        f0 = Number(ethers.formatUnits(e.fee0 ?? "0", m.t0.decimals));
        f1 = Number(ethers.formatUnits(e.fee1 ?? "0", m.t1.decimals));
        if (px && !legUnknown) {
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
    lastHistoryRows = rows;
    lastHistoryAt = Date.now();
    return rows;
  })().finally(() => { historyInFlight = null; });
  return historyInFlight;
}

// Daily per-position value ledger (position-values.json): one point per position per day,
// { "<wallet>:<id>": [{ t, usd, fees }] }, the time-weighted basis for the 30 d window and
// the value at a window start for the 30 d net return. The fee snapshots keep 7 days only.
const POSVAL_FILE = dataFile("position-values.json");
let posValues = {};
try { posValues = JSON.parse(fs.readFileSync(POSVAL_FILE, "utf8")) || {}; } catch {}
function recordPositionValues(now, entries) {
  let changed = false;
  const today = ltDayKey(now);
  for (const { walletAddress, p } of entries) {
    if (!p || p.valueUsd == null) continue;
    const key = `${String(walletAddress).toLowerCase()}:${longterm.idKey(p.tokenId, p.version)}`;
    const arr = posValues[key] || (posValues[key] = []);
    const point = { t: now, usd: +Number(p.valueUsd).toFixed(2), fees: p.feesUsd != null ? +Number(p.feesUsd).toFixed(2) : null };
    const last = arr[arr.length - 1];
    if (last && ltDayKey(last.t) === today) arr[arr.length - 1] = point; else arr.push(point);
    while (arr.length > 400) arr.shift();
    changed = true;
  }
  if (!changed) return;
  try {
    fs.writeFileSync(POSVAL_FILE + ".tmp", JSON.stringify(posValues));
    fs.renameSync(POSVAL_FILE + ".tmp", POSVAL_FILE);
  } catch (err) { console.warn(`position-values: ${err.message}`); }
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
          // `eth` is the field name the page has always read; what it holds is this
          // chain's native currency, which is USDC on Arc at 18 decimals. formatEther
          // is right for the scale and wrong for the name, so the symbol travels with
          // it rather than being assumed by every consumer.
          eth: Number(ethers.formatUnits(operatorWei, cl.nativeDecimals(cfg))),
          symbol: cl.nativeLabel(cfg),
          low: Number(ethers.formatUnits(operatorWei, cl.nativeDecimals(cfg))) < minGas,
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
        V4.discovery.forget(id, p.goneReason || "transferred away"); // stop asking, but keep the record
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
        let collectedUsd = 0, collects = 0, legUnknown = false;
        for (const e of [...bf.events, ...hist.events]) {
          if (e.tokenId !== p.tokenId) continue;
          collectedUsd += toFloat(e.fee0 ?? "0", dec0) * usd0 + toFloat(e.fee1 ?? "0", dec1) * usd1;
          if (e.fee0 == null || e.fee1 == null) legUnknown = true; // batched v4 collect, split unknown (TASK-87)
          collects++;
        }
        // Collected fees at the prices of the collect itself when every collect has a price
        // record (the same figure the card's "claimed" line and /api/history show); only when
        // one is missing do the legs fall back to today's prices, and then they say so.
        let collectedBasis = "today";
        {
          const cs = collectSummary(p.tokenId, dec0, dec1, usd0, usd1);
          if (cs && !cs.approx && cs.count === collects && collects > 0) { collectedUsd = cs.usd; collectedBasis = "collect-time"; }
        }
        if (depositedUsd > 0) {
          pnlUsd = (valueUsd || 0) + (feesUsd || 0) + collectedUsd + withdrawnUsd - depositedUsd;
          pnlPct = (pnlUsd / depositedUsd) * 100;
          pnlSince = b.firstT;
          // The legs, so the card can show its working.
          // Deposit priced at the hour it was made (price-log), for the long-term "value at
          // open" basis; null when no price exists for that hour — never today's price.
          const px0o = longterm.priceAt(priceLogData().hours, p.token0.address, b.firstT), px1o = longterm.priceAt(priceLogData().hours, p.token1.address, b.firstT);
          const depositedAtOpen = b.firstT != null && px0o != null && px1o != null ? toFloat(b.dep0, dec0) * px0o + toFloat(b.dep1, dec1) * px1o : null;
          pnlLegs = {
            deposited: depositedUsd, depositedAtOpen, adds: b.increases || null,
            withdrawn: withdrawnUsd,
            collected: collectedUsd, collects, collectedBasis,
            held: valueUsd || 0, uncollected: feesUsd || 0,
          };
          // If the ledger's liquidity disagrees with the live position, the
          // basis is missing an add or remove: the chain scanner has not
          // reached it yet (minutes), or Blockscout never indexed it.
          pnlApprox = b.liq !== p.liquidity || legUnknown;
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
        claimed: claimedSummary(p.version === 4 && !String(p.tokenId).startsWith("v4-") ? `v4-${p.tokenId}` : String(p.tokenId), p.token0.decimals, p.token1.decimals, usd0, usd1, p.token0.symbol, p.token1.symbol, p.openedBlock ?? null, { token0: p.token0.address, token1: p.token1.address, owner: cfg.ownerAddress }),
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
    // No annualising of a segment shorter than 6 h: the digest and the MCP print aprPct unguarded.
    p.aprPct = r.dailyUsd != null && r.windowH >= 6 && p.valueUsd ? (r.dailyUsd * 365 * 100) / p.valueUsd : null;
    p.spark = r.spark;
    p.px = pxSeriesFor(p.tokenId);
  }
  // Long-term returns (longterm.js): since-open and 30 d fee APR and net return on the open or
  // time-weighted basis, chained across re-mints of the same wallet + pair. Main wallet here;
  // attribution.load() does the same for every wallet.
  {
    const ltRows = await historyRows().catch((err) => { console.warn(`history rows: ${err.message}`); return lastHistoryRows; });
    const entries = positions.map((p) => ({ walletAddress: cfg.ownerAddress, p }));
    for (const w of (watch.latest && watch.latest.wallets) || []) for (const p of w.positions || []) entries.push({ walletAddress: w.address, p });
    recordPositionValues(nowT, entries);
    const lt = longterm.compute({ open: entries, collects: ltRows, rangeLog: rangeLog.positions, values: posValues, now: nowT });
    for (const { walletAddress, p } of entries) p.longTerm = lt.get(`${String(walletAddress).toLowerCase()}:${longterm.idKey(p.tokenId, p.version)}`) || null;
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
    explorer: EXPLORER_URL,
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
const csrf = require("./csrf");
const treasuryLedger = require("./treasury");
// The agent (agent.js): one brain for the web panel, Telegram and loopback scripts.
const agent = require("./agent").create({
  port: PORT, dir: DATA_DIR,
  // Which chain this assistant is looking at, from this instance's own settings.
  // Name and id only: what a figure is denominated in is already stated per figure
  // by the tools, and naming a unit here is how "reported in ETH" got onto a USDG
  // balance once already.
  chain: { id: Number(cfg.chainId) || null, name: chainDisplayName() },
});
/** Channel and role of a chat request: through the gate = web/read; a browser on this machine = web/read; a script on loopback = loopback/full (read when the dashboard is read-only). */
function chatChannel(req, body) {
  const viaGate = req.headers["x-lp-gate"] === "1";
  const browser = !!(req.headers.origin || req.headers["sec-fetch-mode"] || req.headers["sec-fetch-site"]);
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
  if (viaGate || browser || !loopback || READONLY) return { channel: "web", role: "read" };
  const channel = typeof body.channel === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(body.channel) ? body.channel : "loopback";
  return { channel, role: "full" };
}
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
const strategy = require("./strategy").create({ cfg, dir: DATA_DIR, port: PORT, metaFor: (id) => positionMeta(id) });
let lastDisposalScan = 0;
// === strategy track record (strategy-track.js): score agent proposals against what happened ===
const strategyTrack = require("./strategy-track").create({ cfg, dir: DATA_DIR, port: PORT });

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

// A route that throws ends only its own request: a 500 when no headers went out yet,
// a closed connection otherwise. Without this, one such throw (2026-09-12: the treasury
// route sent a 200 header, then its view failed on a 403 from the RPC) took the whole
// dashboard down with ERR_HTTP_HEADERS_SENT.
const server = http.createServer((req, res) => {
  // Counted so the background claim scan can step aside while requests run.
  activeRequests++;
  let counted = true;
  const done = () => { if (counted) { counted = false; activeRequests--; } };
  res.on("finish", done); res.on("close", done);
  handleRequest(req, res).catch((err) => {
    console.error(`request ${req.method} ${String(req.url).slice(0, 80)} failed: ${err && (err.shortMessage || err.message || err)}`);
    try {
      if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "internal error" })); }
      else res.end();
    } catch {}
  });
});
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // Cross-site guard for every state-changing /api route (csrf.js): a browser
  // page from another site cannot lock, collect, close, approve or change rules
  // through loopback trust. Scripts carry no Origin and pass; the owner's own
  // page and the gate / tailnet name are same-origin.
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && url.pathname.startsWith("/api/")) {
    const h = req.headers;
    if (csrf.isCrossSite({ origin: h.origin, host: h.host, secFetchSite: h["sec-fetch-site"], viaGate: h["x-lp-gate"] === "1", publicHost })) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "cross-site request" }));
    }
    if (csrf.needsJson({ origin: h.origin, contentType: h["content-type"], contentLength: h["content-length"], transferEncoding: h["transfer-encoding"] })) {
      res.writeHead(415, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "send application/json" }));
    }
  }

  // Arm the unlock window from the page: verify the passphrase against the
  // keystore (same check as unlock.sh), then cache it in RAM with a TTL.
  // The passphrase travels over plain HTTP, so this is loopback-only
  // unconditionally — LP_ALLOW_REMOTE_COLLECT does not open it.
  if (READONLY && (url.pathname === "/api/unlock" || url.pathname === "/api/lock" || url.pathname.startsWith("/api/arm") || (url.pathname === "/api/collect" && req.method === "POST"))) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "This dashboard is read-only; the collector runs on another machine." }));
  }

  // The Wallet page: arming, approvals (audit + operator approvals), the vault and the operator, as tabs.
  // The former pages redirect to their tab so old links and bookmarks keep working.
  if (url.pathname === "/wallet" || url.pathname === "/wallet.html") {
    try {
      const html = fs.readFileSync(path.join(__dirname, "wallet.html"));
      // Same reason the dashboard shell is no-cache: this page carries its own
      // markup and script inline, so a browser holding an older copy keeps showing
      // old labels and missing controls long after the server was fixed. That is
      // what made a corrected vault page still read "493.293396 ETH".
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(html);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("wallet.html not found");
    }
  }
  {
    const tab = { "/arm": "arm", "/approvals": "approvals", "/approve-v3": "approvals", "/approve-v4": "approvals", "/treasury": "vault", "/vault": "vault" }[url.pathname.replace(/\.html$/, "")];
    if (tab) {
      res.writeHead(302, { Location: `/wallet#${tab}` });
      return res.end();
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
        return res.end(JSON.stringify({ ok: true, owner: cfg.ownerAddress, operator: armer.operatorAddress(), chainId: Number(cfg.chainId), message: armer.message(cfg), unlock: unlockState(), maxMinutes: cfg.armMaxMinutes, ...armer.configured() }));
      }
      if (req.method !== "POST") throw new Error("POST required");
      const body = JSON.parse(await readBody(req));
      // The window is clamped to settings arm.maxMinutes (24 h by default); the response says so.
      const clampInfo = (mins) => { const asked = Number(body.minutes) || 120; return { minutes: mins, maxMinutes: cfg.armMaxMinutes, ...(asked > mins ? { clampedFrom: asked } : {}) }; };
      if (url.pathname === "/api/arm/setup") {
        await armer.setup(cfg, body);
        const mins = await armer.arm(cfg, body, CACHE_FILE);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, unlock: { armed: true, minutesLeft: mins }, ...clampInfo(mins), ...armer.configured() }));
      }
      if (url.pathname === "/api/arm") {
        const mins = await armer.arm(cfg, body, CACHE_FILE);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, unlock: { armed: true, minutesLeft: mins }, ...clampInfo(mins) }));
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
      const minutes = Math.max(1, Math.min(Number(cfg.armMaxMinutes) || 1440, Number(body.minutes) || 120)); // settings arm.maxMinutes, 24 h by default
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
      return res.end(JSON.stringify({ ...d, pricing: PRICING }));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }

  // Browser-based operator approval (the Wallet page, Approvals tab): the page reads every
  // address from here (settings.json + the operator keystore's public address)
  // and the current approval state from this server's RPC.
  // Who this instance is on. The wallet page used to hardcode Robinhood's chain id,
  // name and explorer, which made every network prompt wrong on Arc.
  if (url.pathname === "/api/chain") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    return res.end(JSON.stringify({
      ok: true, chainId: Number(cfg.chainId), chainName: chainDisplayName(),
      rpc: cfg.rpcUrl, explorer: EXPLORER_URL,
      // Null unless settings verify it: a wallet told the wrong native asset keeps
      // showing gas under the wrong ticker.
      nativeCurrency: cfg.nativeCurrency ? { name: cfg.nativeCurrency.symbol, symbol: cfg.nativeCurrency.symbol, decimals: cfg.nativeCurrency.decimals } : null,
    }));
  }
  if (url.pathname === "/api/approval" || url.pathname === "/api/v4-approval") {
    res.setHeader("Content-Type", "application/json");
    try {
      const v = url.pathname === "/api/v4-approval" ? 4 : Number(url.searchParams.get("v")) === 3 ? 3 : 4;
      const mgr = v === 3 ? cfg.contracts.positionManager : cfg.contracts.v4 && cfg.contracts.v4.positionManager;
      if (!mgr) throw new Error(`no v${v} position manager in settings.json`);
      // Which owner wallet: the main one by default, or any settings.json wallet the collector may collect for.
      const allowed = [{ address: cfg.ownerAddress, label: watch.ownerLabel() || "Main wallet", main: true }];
      for (const w of watch.readWallets()) allowed.push({ address: w.address, label: w.label || w.address, main: false, collect: !!w.collect });
      const want = url.searchParams.get("owner");
      const ownerEntry = want ? allowed.find((a) => a.address.toLowerCase() === want.toLowerCase()) : allowed[0];
      if (!ownerEntry) throw new Error("that wallet is not the main wallet or a wallet listed under wallets in settings.json");
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
      const allOps = await approvedOperators(provider, mgr, ownerAddr, operator);
      const others = allOps.filter((o) => o.approved && (!operator || o.address.toLowerCase() !== operator.toLowerCase()));
      // Overview of every wallet's approval on this manager, for the page's wallet table.
      const wallets = [];
      for (const a of allowed) wallets.push({ ...a, approved: operator ? await c.isApprovedForAll(a.address, operator).catch(() => null) : null });
      res.writeHead(200);
      return res.end(JSON.stringify({
        ok: true, version: v,
        owner: ownerAddr, ownerLabel: ownerEntry.label, operator, posm: ethers.getAddress(mgr),
        operators: allOps.map((o) => ({ address: o.address, approved: o.approved, source: o.source })),
        operatorsCoverage: allOps.coverage,
        chainId: Number(cfg.chainId), chainName: chainDisplayName(), rpc: cfg.rpcUrl,
        // For the page's "add this network" call. Omitted unless the chain's native
        // asset is verified in settings: declaring the wrong one would register the
        // network in someone's wallet with gas labelled as a currency it is not.
        nativeCurrency: cfg.nativeCurrency ? { name: cfg.nativeCurrency.symbol, symbol: cfg.nativeCurrency.symbol, decimals: cfg.nativeCurrency.decimals } : null,
        explorer: EXPLORER_URL, approved, others, wallets,
      }));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }

  if (url.pathname === "/api/portfolio-all") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    return res.end(JSON.stringify(allWalletsView()));
  }

  // LOKOVault: the split ledger and a summary for the analytics tile (the vault page is a Wallet tab).
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
      const view = await treasuryView(); // build first: a failure after writeHead(200) cannot send a 500
      res.writeHead(200);
      return res.end(JSON.stringify(view));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }

  // === memecoin-guardian ===
  // Memecoin Watch: status written by memecoin-guardian.js (a separate process),
  // and a loopback-only close that runs the guardian's --close (operator must be armed).
  // Launch Watch: the launch scanner's last scan, candidates and recent alerts.
  if (url.pathname === "/api/launches") {
    res.setHeader("Content-Type", "application/json");
    let st = null;
    try { st = launchScanner ? launchScanner.status : JSON.parse(fs.readFileSync(dataFile("launch-scanner-status.json"), "utf8")); } catch {}
    const enabled = !!(cfg.launchScanner && cfg.launchScanner.enabled !== false);
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, enabled, running: enabled && !!launchScanner, at: st ? st.at : 0, stale: !st || Date.now() - (st.at || 0) > 20 * 60 * 1000, ...(st || {}), settings: (launchScanner && launchScanner.settings) || cfg.launchScanner || {} }));
  }
  // Nightly backup on demand (loopback-only; the scheduled run is a timer in this process).
  
  // === tasks: manual trigger for run-all.sh or one task script ===
  // Only the four known names, spawned from an argument array (never a shell: the route is reachable
  // through the gate, so the task value is untrusted); output goes to run-all.log like the scheduler.
  if (url.pathname === "/api/tasks/run" && req.method === "POST") {
    res.setHeader("Content-Type", "application/json");
    const plan = require("./tasks-route").planTaskRun(url.searchParams.get("task"));
    if (plan.error) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: plan.error })); }
    if (HOST !== "127.0.0.1" || READONLY || !server.runTasks) {
      res.writeHead(403);
      return res.end(JSON.stringify({ ok: false, error: "tasks run from the main dashboard process on this machine" }));
    }
    if (plan.all && server.tasksBusy && server.tasksBusy()) {
      res.writeHead(409);
      return res.end(JSON.stringify({ ok: false, error: "run-all is already in progress" }));
    }
    const { spawn } = require("child_process");
    let logFd = null;
    try { fs.mkdirSync(path.join(__dirname, "tasks", "output"), { recursive: true }); logFd = fs.openSync(path.join(__dirname, "tasks", "output", "run-all.log"), "a"); } catch (err) { console.error(`tasks: cannot open run-all.log: ${err.message}`); }
    const child = spawn(plan.cmd, plan.args, { cwd: __dirname, detached: true, stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"], env: process.env });
    child.on("close", () => { if (logFd != null) { try { fs.closeSync(logFd); } catch {} } });
    child.on("error", (err) => { if (logFd != null) { try { fs.closeSync(logFd); } catch {} } console.error(`tasks: ${plan.args[0]} failed to start: ${err.message}`); });
    const started = new Date().toISOString();
    child.unref();
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, started, script: [plan.cmd === process.execPath ? "node" : plan.cmd, ...plan.args].join(" "), pid: child.pid }));
  }
  // === end tasks ===

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
      const st = guardian && guardian.status && guardian.status.at ? JSON.parse(JSON.stringify(guardian.status)) : JSON.parse(fs.readFileSync(dataFile("memecoin-status.json"), "utf8"));
      st.stale = Date.now() - (st.at || 0) > 5 * 60 * 1000; // guardian not running?
      st.watching = (st.positions || []).filter((p) => !p.closed).length;
      for (const p of st.positions || []) {
        if (p.closed) continue;
        const key = Number(p.version) === 3 ? String(p.tokenId) : `v4-${p.tokenId}`;
        try {
          const m = await positionMeta(key);
          const price = (t) => (t.address === ethers.ZeroAddress ? lastPrices[WETH] : lastPrices[t.address.toLowerCase()]) ?? currentPrice(priceAddr(t));
          p.collected = collectSummary(key, m.t0.decimals, m.t1.decimals, price(m.t0), price(m.t1));
          p.claimed = claimedSummary(key, m.t0.decimals, m.t1.decimals, price(m.t0), price(m.t1), m.t0.symbol, m.t1.symbol, p.openedBlock ?? null, { token0: m.t0.address, token1: m.t1.address, owner: cfg.ownerAddress });
        } catch { p.collected = null; p.claimed = { status: "unavailable", reason: "this position's token metadata could not be read, so its claims cannot be valued" }; }
        // keep / watch / close / hold, from this row plus the collect history and
        // the hourly fee accrual (main wallet only; watched wallets accrue per wallet).
        const feeHours = {};
        for (const [h, per] of Object.entries(daily.hours || {})) if (per && per[key] > 0) feeHours[h] = per[key];
        // One fee rate per position: the dashboard's 48 h accrual segment (when it spans ≥ 6 h),
        // else the verdict's 7-day realised rate. The guardian's 30-min rate stays as
        // liveFeesPerHour for alerts; it is no longer what the cards, Telegram and MCP call "$/h".
        const seg = rateFor(key);
        const serverRate = seg.dailyUsd != null && seg.windowH >= 6 ? seg.dailyUsd / 24 : null;
        p.verdict = verdict.verdictFor(p, { feeHours, rate: serverRate });
        p.liveFeesPerHour = p.feesPerHour;
        p.feesPerHour = p.verdict.feesPerHour;
        p.feeRateSource = serverRate != null ? "48h-accrual" : p.verdict.feesPerHour != null ? "7d-realised" : null;
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
      try { state = JSON.parse(fs.readFileSync(dataFile("digest-state.json"), "utf8")); } catch {}
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, text, week: digest.isoWeek(new Date()), lastSentWeek: state.lastSentWeek || null, lastSentAt: state.lastSentAt || null, due: digest.due(new Date(), state) }));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }
  // The daily check text (daily.js). /api/daily itself is the fee-by-hour ledger below, which the
  // analytics page, the MCP daily_revenue tool and the weekly digest read; the two shared one
  // path for a week and this one shadowed the ledger.
  if (url.pathname === "/api/insights" && req.method === "GET") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    try {
      const read = name => { try { return JSON.parse(fs.readFileSync(dataFile(name), "utf8")); } catch { return null; } };
      const pf = read("portfolio.json"), fee = read("fee-daily.json"), state = read("state.json");
      const px = read("price-log.json"), flows = read("token-disposals.json");
      const result = require("./insights").build({
        positions: cache.payload ? { ...cache.payload, unlock: unlockState(), ops: opsInfo(), loops: loopHealth() } : null,
        watch: watch.latest, portfolio: portfolio.latest, history: lastHistoryAt ? lastHistoryRows : null,
        ranges: rangeLog.positions, series: pf && pf.series, fees: fee && fee.hours,
        gas: state && state.gasSpends, prices: px && px.hours, flows: flows && flows.rows,
      }, { since: url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined });
      res.writeHead(200);
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: "Could not build dashboard insights" }));
    }
  }
  if (url.pathname === "/api/daily-check") {
    res.setHeader("Content-Type", "application/json");
    try {
      const daily = require("./daily");
      const text = daily.build(await daily.gather(`http://127.0.0.1:${PORT}`));
      let state = {};
      try { state = JSON.parse(fs.readFileSync(dataFile("digest-state.json"), "utf8")); } catch {}
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
        // The native row is this chain's native asset, not ether: on Arc it is USDC
        // at 18 decimals. Labelling it "ETH" named a currency the chain does not have.
        const nativeDec = cl.nativeDecimals(cfg), nativeSym = cl.nativeLabel(cfg);
        const eth = await provider.getBalance(ts.tba);
        out.balances.push({ symbol: nativeSym, address: null, amount: ethers.formatUnits(eth, nativeDec), decimals: nativeDec, native: true });
        // Where the native asset IS the token (Arc: numeraire.nativeSameAsErc20, one
        // balance behind a native interface and an ERC-20 one), listing both makes a
        // reader add a balance to itself. Skip the token row and say so on the native.
        const num = cfg.numeraire || {};
        const dualAddr = num.nativeSameAsErc20 && num.address ? String(num.address).toLowerCase() : null;
        if (dualAddr) out.balances[0].alsoErc20 = ethers.getAddress(dualAddr);
        const seenTok = new Set();
        const tokens = [cfg.usdReference && cfg.usdReference.stable, cfg.contracts.weth, ...Object.keys(lastPrices)].filter((a) => a && !seenTok.has(a.toLowerCase()) && seenTok.add(a.toLowerCase()));
        for (const addr of tokens.slice(0, 40)) {
          try {
            const meta = await u.getToken(addr, provider);
            const raw = await new ethers.Contract(addr, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(ts.tba);
            if (dualAddr && addr.toLowerCase() === dualAddr) continue;   // already the native row
            if (raw > 0n || addr.toLowerCase() === String(cfg.usdReference && cfg.usdReference.stable).toLowerCase()) out.balances.push({ symbol: meta.symbol, address: meta.address, amount: ethers.formatUnits(raw, meta.decimals), decimals: meta.decimals });
          } catch {}
        }
      }
        // The NFT's own art and metadata, so the page can show the token rather than a
        // drawing of one. What the token says about its chain is checked against the
        // chain it is actually on, in two separate ways, because two different things
        // can be wrong. A token from the old contract carries a hardcoded id: the Arc
        // deployment says "Robinhood Chain / 4663" in metadata it cannot change. A
        // token from the current contract takes its id from block.chainid and cannot
        // be wrong about that, but its name is chosen at deployment and can be.
        try {
          const uri = await new ethers.Contract(cfg.treasuryNFT, ["function tokenURI(uint256) view returns (string)"], provider).tokenURI(1);
          if (uri.startsWith("data:application/json;base64,")) {
            const meta = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
            out.art = {
              name: meta.name || null,
              image: meta.image || null,
              chainName: chainDisplayName(),
              ...vaultMeta.chainClaim(meta, cfg.chainId, chainDisplayName()),
            };
          }
        } catch (err) { out.artError = err.shortMessage || err.message; }
        out.chain = { id: Number(cfg.chainId), name: chainDisplayName() };
      res.writeHead(200);
      return res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
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
  if (url.pathname === "/api/approvals") {
    // Read-only audit of one wallet's allowances, operator approvals and vault
    // status. `owner` must be the main wallet or a settings.json wallet.
    res.setHeader("Content-Type", "application/json");
    try {
      const allowed = [{ address: cfg.ownerAddress, label: watch.ownerLabel() || "Main wallet", main: true }];
      for (const w of watch.readWallets()) allowed.push({ address: w.address, label: w.label || w.address, main: false, collect: !!w.collect });
      const want = url.searchParams.get("owner");
      const entry = want ? allowed.find((a) => a.address.toLowerCase() === want.toLowerCase()) : allowed[0];
      if (!entry) throw new Error("that wallet is not the main wallet or a wallet listed under wallets in settings.json");
      const data = await approvalsAudit.audit(entry.address, require("./arm").operatorAddress());
      res.writeHead(200);
      return res.end(JSON.stringify({ ...data, ownerLabel: entry.label, wallets: allowed, chainId: Number(cfg.chainId), rpc: cfg.rpcUrl, explorer: EXPLORER_URL, health: tokenHealth.view().byAddress }));
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
      return res.end(JSON.stringify({ ...agent.status(), channels: agent.channels(), telegram: telegramAgent ? telegramAgent.health() : null }));
    }
    try {
      const body = JSON.parse((await readBody(req, 16384)) || "{}");
      const who = chatChannel(req, body);
      if (url.pathname === "/api/chat/reset") {
        res.writeHead(200);
        return res.end(JSON.stringify(agent.reset(who.channel)));
      }
      const out = await agent.chat({ channel: who.channel, role: who.role, message: body.message });
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
    return res.end(JSON.stringify(d ? { ...freshClaims(d), refreshing: watch.inFlight, pricing: PRICING } : { ok: false, refreshing: true, error: "watched wallets still loading", wallets: [] }));
  }

  // === sell tab (wallet.html) === tokens a wallet holds and a signable sell quote; nothing is sent by the server.
  if (url.pathname === "/api/sell/tokens") {
    res.setHeader("Content-Type", "application/json");
    try {
      const want = String(url.searchParams.get("wallet") || cfg.ownerAddress);
      const ours = [{ address: cfg.ownerAddress, label: watch.ownerLabel() || "Main" }, ...watch.readWallets().map((w) => ({ address: w.address, label: w.label || w.address }))];
      const wallet = ours.find((w) => w.address.toLowerCase() === want.toLowerCase());
      if (!wallet) throw new Error("not one of our wallets");
      const stable = (cfg.usdReference && cfg.usdReference.stable || "").toLowerCase();
      // Holdings as the portfolio already knows them: the main wallet from the portfolio rows, a watched wallet from its own token list.
      let held = [];
      if (wallet.address.toLowerCase() === cfg.ownerAddress.toLowerCase()) held = ((portfolio.latest && portfolio.latest.rows) || []).filter((r) => !r.native && r.wallet > 0).map((r) => ({ symbol: r.symbol, address: r.address, amount: r.wallet, price: r.price }));
      else { const w = ((watch.latest && watch.latest.wallets) || []).find((x) => x.address && x.address.toLowerCase() === wallet.address.toLowerCase()); held = (((w && w.holdings && w.holdings.tokens) || [])).filter((t) => !t.native && t.amount > 0).map((t) => ({ symbol: t.symbol, address: t.address, amount: t.amount, price: t.price })); }
      const rows = [];
      // Skip known dust before touching the chain (the main wallet's portfolio lists many tiny airdrops).
      held = held.filter((h) => h.address && !(h.price != null && h.amount * h.price < 1) && h.address.toLowerCase() !== stable && h.address.toLowerCase() !== WETH);
      // One Multicall3 round trip for every balanceOf + decimals instead of two RPC calls per token.
      const ercIface = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"]);
      const mc = new ethers.Contract("0xcA11bde05977b3631167028862bE2a173976CA11", ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)"], provider);
      const calls = [];
      for (const h of held) calls.push({ target: h.address, allowFailure: true, callData: ercIface.encodeFunctionData("balanceOf", [wallet.address]) }, { target: h.address, allowFailure: true, callData: ercIface.encodeFunctionData("decimals", []) });
      let res3 = [];
      try { res3 = await mc.aggregate3(calls); } catch (err) { throw new Error("balance read failed: " + (err.shortMessage || err.message)); }
      held.forEach((h, i) => {
        const b = res3[2 * i], d = res3[2 * i + 1];
        if (!b || !b.success || b.returnData.length < 66) return;
        const raw = BigInt(b.returnData);
        if (raw === 0n) return;
        let meta = tokenSet.get(h.address.toLowerCase());
        if (!meta) { if (!d || !d.success || d.returnData.length < 66) return; meta = { address: h.address, symbol: h.symbol, decimals: Number(BigInt(d.returnData)) }; tokenSet.set(h.address.toLowerCase(), meta); }
        const balance = Number(ethers.formatUnits(raw, meta.decimals));
        const price = h.price ?? lastPrices[h.address.toLowerCase()] ?? currentPrice(h.address);
        const usd = price != null ? balance * price : null;
        if (usd != null && usd < 1) return; // dust
        // Price 1 h and 24 h ago from the hourly price log, so a drop is visible before selling.
        const ch = (agoMs) => { const hs = priceHoursSorted(); const target = Date.now() - agoMs; let best = null; for (const hh of hs) if (Math.abs(hh - target) <= 3 * 3600 * 1000 && (best == null || Math.abs(hh - target) < Math.abs(best - target))) best = hh; const old = best != null ? priceLogRow(best)[h.address.toLowerCase()] : null; return price != null && old > 0 ? +(((price - old) / old) * 100).toFixed(1) : null; };
        rows.push({ symbol: meta.symbol || h.symbol, address: meta.address, decimals: meta.decimals, raw: raw.toString(), balance, usd, priceUsd: price ?? null, change1hPct: ch(3600 * 1000), change24hPct: ch(24 * 3600 * 1000) });
      });
      rows.sort((a, b) => (b.usd || 0) - (a.usd || 0));
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, wallet, wallets: ours, rows, usdg: cfg.usdReference && cfg.usdReference.stable, weth: cfg.contracts.weth }));
    } catch (err) {
      res.writeHead(400);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }
  // A sale signed from the Sell tab, recorded like the collector's own (token-sales.json -> lots table, daily summary).
  if (url.pathname === "/api/sell/record" && req.method === "POST") {
    res.setHeader("Content-Type", "application/json");
    if (HOST !== "127.0.0.1" || READONLY) { res.writeHead(403); return res.end(JSON.stringify({ ok: false, error: "recording is localhost-only" })); }
    try {
      const b = JSON.parse(await readBody(req));
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(b.tx || ""))) throw new Error("tx hash required");
      const r = await provider.getTransactionReceipt(b.tx);
      if (!r || r.status !== 1) throw new Error("transaction not found or failed");
      const row = { t: Date.now(), wallet: String(b.walletLabel || "").slice(0, 40), walletAddress: ethers.getAddress(String(b.wallet || r.from)), token: String(b.symbol || "").slice(0, 20), tokenAddress: ethers.getAddress(String(b.token)), amount: Number(b.amount) || 0, amountOut: Number(b.amountOut) || null, currencyOut: b.outSymbol || null, usd: Number(b.usd) || null, impactPct: b.impactPct != null ? Number(b.impactPct) : null, tx: b.tx, block: r.blockNumber, manual: true, via: "sell tab" };
      require("./sell-v4").appendSale(row);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, row }));
    } catch (err) {
      res.writeHead(400);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }
  if (url.pathname === "/api/sell/quote") {
    res.setHeader("Content-Type", "application/json");
    try {
      const token = ethers.getAddress(String(url.searchParams.get("token") || ""));
      const amount = BigInt(String(url.searchParams.get("amount") || "0"));
      if (amount <= 0n) throw new Error("amount (raw units) required");
      const maxImpactPct = Math.min(25, Math.max(0.1, Number(url.searchParams.get("maxImpactPct") || 3)));
      const slippageBps = BigInt(Math.min(1000, Math.max(10, Number(url.searchParams.get("slippageBps") || 100))));
      const recipient = url.searchParams.get("recipient") ? ethers.getAddress(url.searchParams.get("recipient")) : null;
      const sv4 = require("./sell-v4").create({ provider, cfg, log: () => {} });
      const stable = (cfg.usdReference && cfg.usdReference.stable || "").toLowerCase();
      const usdOf = async (cur, amt) => {
        const c = String(cur).toLowerCase();
        if (c === stable) return Number(ethers.formatUnits(amt, 6));
        if (cur === ethers.ZeroAddress || c === WETH) { const px = lastPrices[WETH]; return px != null ? Number(ethers.formatEther(amt)) * px : null; }
        return null;
      };
      const keys = [];
      for (const p of (cache.payload && cache.payload.positions) || []) if (p.version === 4 && p.poolKey && [p.token0, p.token1].some((t) => String(t).toLowerCase() === token.toLowerCase())) keys.push(p.poolKey);
      const q = await sv4.quote({ token, amount, usdOf, maxImpactPct, slippageBps, recipient, keys });
      const meta = tokenSet.get(token.toLowerCase());
      const outMeta = q.ok ? (q.currencyOut === ethers.ZeroAddress ? { symbol: "ETH", decimals: 18 } : tokenSet.get(q.currencyOut.toLowerCase()) || (q.currencyOut.toLowerCase() === stable ? { symbol: "USDG", decimals: 6 } : { symbol: "?", decimals: 18 })) : null;
      res.writeHead(200);
      return res.end(JSON.stringify({ ...q, tokenSymbol: meta ? meta.symbol : null, tokenDecimals: meta ? meta.decimals : null, outSymbol: outMeta && outMeta.symbol, outDecimals: outMeta && outMeta.decimals, chainId: Number(cfg.chainId), rpc: cfg.rpcUrl, explorer: EXPLORER_URL }));
    } catch (err) {
      res.writeHead(400);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }
  // === end sell tab ===
  // === ledger audit === GET the last report; ?run=1 (loopback) runs it now; POST /api/audit/accept { shapes } accepts route shapes.
  if (url.pathname === "/api/audit" || url.pathname === "/api/audit/accept") {
    res.setHeader("Content-Type", "application/json");
    try {
      if (url.pathname === "/api/audit/accept" || url.searchParams.get("run") === "1") {
        if (HOST !== "127.0.0.1" || READONLY) { res.writeHead(403); return res.end(JSON.stringify({ ok: false, error: "localhost-only" })); }
        if (url.pathname === "/api/audit/accept") {
          const b = JSON.parse(await readBody(req));
          const out = ledgerAudit.acceptShapes((Array.isArray(b.shapes) ? b.shapes : []).map(String).slice(0, 20));
          res.writeHead(200); return res.end(JSON.stringify({ ok: true, ...out }));
        }
        const { report } = await ledgerAudit.run();
        res.writeHead(200); return res.end(JSON.stringify({ ok: true, ...report }));
      }
      const rep = ledgerAudit.read();
      res.writeHead(200);
      return res.end(JSON.stringify(rep ? { ok: true, ...rep, line: ledgerAudit.summaryLine(rep) } : { ok: true, at: null, findings: [], summary: null, line: ledgerAudit.summaryLine(null) }));
    } catch (err) {
      res.writeHead(400);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }
  // === mint tab === open a v4 / v3 position or move one (mint.js): the server quotes and
  // builds the calldata, the wallet signs in Rabby. Reads only; nothing here sends.
  if (url.pathname.startsWith("/api/mint/")) {
    res.setHeader("Content-Type", "application/json");
    try {
      const q = url.searchParams;
      const ours = [{ address: cfg.ownerAddress, label: watch.ownerLabel() || "Main" }, ...watch.readWallets().map((w) => ({ address: w.address, label: w.label || w.address }))];
      const walletOf = (want) => { const w = ours.find((x) => x.address.toLowerCase() === String(want || cfg.ownerAddress).toLowerCase()); if (!w) throw new Error("not one of our wallets"); return w; };
      const mint = require("./mint").create({ provider, cfg });
      let out;
      if (url.pathname === "/api/mint/context") {
        // Wallets, the chosen wallet's open positions (to move) and the tokens it could pair.
        const wallet = walletOf(q.get("wallet"));
        const main = wallet.address.toLowerCase() === cfg.ownerAddress.toLowerCase();
        const src = main ? ((cache.payload && cache.payload.positions) || []) : (((watch.latest && watch.latest.wallets) || []).find((x) => x.address && x.address.toLowerCase() === wallet.address.toLowerCase()) || {}).positions || [];
        const positions = src.filter((p) => p.version === 4 ? !p.hooks || p.hooks === ethers.ZeroAddress : true).map((p) => ({ tokenId: String(p.nftId || String(p.tokenId).replace(/^v4-/, "")), version: p.version, pair: p.pair, token0: p.token0, token1: p.token1, symbol0: p.symbol0, symbol1: p.symbol1, feeTier: p.feeTier, tickLower: p.tickLower, tickUpper: p.tickUpper, inRange: p.inRange, valueUsd: p.valueUsd, feesUsd: p.feesUsd, priceCurrent: p.priceCurrent, priceLower: p.priceLower, priceUpper: p.priceUpper }));
        const stable = cfg.usdReference && cfg.usdReference.stable;
        const tokens = new Map();
        const add = (address, symbol, usd) => { if (!address) return; const k = address.toLowerCase(); if (!tokens.has(k)) tokens.set(k, { address, symbol, usd: usd ?? null }); };
        add(ethers.ZeroAddress, "ETH", null);
        if (stable) add(stable, "USDG", null);
        add(cfg.contracts.weth, "WETH", null);
        if (main) for (const r of (portfolio.latest && portfolio.latest.rows) || []) { if (!r.native && r.wallet > 0 && (r.price == null || r.wallet * r.price >= 1)) add(r.address, r.symbol, r.price != null ? r.wallet * r.price : null); }
        else { const w = ((watch.latest && watch.latest.wallets) || []).find((x) => x.address && x.address.toLowerCase() === wallet.address.toLowerCase()); for (const t of (w && w.holdings && w.holdings.tokens) || []) if (!t.native && t.amount > 0 && (t.price == null || t.amount * t.price >= 1)) add(t.address, t.symbol, t.price != null ? t.amount * t.price : null); }
        for (const p of positions) { add(p.token0, p.symbol0, null); add(p.token1, p.symbol1, null); }
        out = { ok: true, wallet, wallets: ours, positions, tokens: [...tokens.values()], usdg: stable, weth: cfg.contracts.weth, permit2: cfg.contracts.v4 && cfg.contracts.v4.permit2, chainId: Number(cfg.chainId), explorer: EXPLORER_URL };
      } else if (url.pathname === "/api/mint/pools") {
        out = { ok: true, ...(await mint.pools({ tokenA: q.get("tokenA"), tokenB: q.get("tokenB") })) };
      } else if (url.pathname === "/api/mint/quote") {
        const pool = JSON.parse(q.get("pool") || "null");
        if (!pool || !pool.version) throw new Error("pool required (from /api/mint/pools)");
        if (pool.version === 4 && pool.key && pool.key.hooks && pool.key.hooks !== ethers.ZeroAddress) throw new Error("hooked pools are not supported here yet");
        out = await mint.quote({ wallet: walletOf(q.get("wallet")).address, pool, tickLower: Number(q.get("tickLower")), tickUpper: Number(q.get("tickUpper")), amount0: BigInt(q.get("amount0") || "0"), amount1: BigInt(q.get("amount1") || "0"), slippageBps: Math.min(1000, Math.max(10, Number(q.get("slippageBps") || 100))), payEth: q.get("payEth") !== "0", fill: q.get("fill") === "0" ? 0 : q.get("fill") === "1" ? 1 : null });
        // USD of the deposit, from the collector's prices (null for tokens it does not price).
        const px = (m) => (m.native || m.isWeth ? lastPrices[WETH] : lastPrices[String(m.address).toLowerCase()] ?? currentPrice(m.address));
        const p0 = px(pool.token0), p1 = px(pool.token1);
        out.human.usd = p0 != null && p1 != null ? +(out.human.amount0 * p0 + out.human.amount1 * p1).toFixed(2) : null;
        out.human.usd0 = p0 ?? null; out.human.usd1 = p1 ?? null;
      } else if (url.pathname === "/api/mint/dryrun") {
        out = { ok: true, ...(await mint.dryRun({ wallet: walletOf(q.get("wallet")).address, to: ethers.getAddress(String(q.get("to") || "")), data: String(q.get("data") || "0x"), value: q.get("value") || "0" })) };
        if (out.ok && out.error) out.ok = false;
      } else if (url.pathname === "/api/mint/balances") {
        out = { ok: true, rows: await mint.balances({ wallet: walletOf(q.get("wallet")).address, tokens: String(q.get("tokens") || "").split(",").filter(Boolean) }) };
      } else if (url.pathname === "/api/mint/close") {
        out = await mint.closeQuote({ wallet: walletOf(q.get("wallet")).address, version: Number(q.get("version")), tokenId: String(q.get("tokenId") || ""), slippageBps: Math.min(1000, Math.max(10, Number(q.get("slippageBps") || 100))) });
      } else throw new Error("unknown mint endpoint");
      res.writeHead(200);
      return res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(400);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }
  // === end mint tab ===
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
        explorer: EXPLORER_URL,
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

  // Collection history for ONE position, scoped by chain, position manager and
  // token id, served independently of the analytics bundle so the card's control
  // can load it on its own. A scan budget is spent here, so opening the panel is
  // also what extends coverage backwards.
  if (url.pathname === "/api/claims") {
    res.setHeader("Content-Type", "application/json");
    const id = String(url.searchParams.get("tokenId") || "").replace(/^v4-/, "");
    const wantChain = url.searchParams.get("chainId");
    const wantManager = (url.searchParams.get("manager") || "").toLowerCase();
    const wantWallet = (url.searchParams.get("wallet") || "").toLowerCase() || null;
    if (!/^[0-9]+$/.test(id)) return res.end(JSON.stringify({ ok: false, error: "a numeric tokenId is required" }));
    if (wantWallet && !/^0x[0-9a-f]{40}$/.test(wantWallet)) return res.end(JSON.stringify({ ok: false, error: "wallet must be an address" }));
    if (!claimStore) {
      return res.end(JSON.stringify({ ok: true, status: "unavailable", rows: [],
        reason: "this instance has no chain-derived claim scanner configured" }));
    }
    // A request for another chain's or another manager's position is answered as
    // what it is — not this instance's position — rather than with these records.
    if ((wantChain && Number(wantChain) !== Number(cfg.chainId)) ||
        (wantManager && wantManager !== String(cfg.contracts.v4.positionManager).toLowerCase())) {
      return res.end(JSON.stringify({ ok: true, status: "unavailable", rows: [],
        reason: `this instance serves chain ${cfg.chainId} and manager ${cfg.contracts.v4.positionManager}; the position asked for belongs to a different scope` }));
    }
    try {
      // With the background scan running, the request never scans on its own and
      // never waits for it: it answers from the progress saved so far.
      // Saved progress is read as it is; the background scanner prices new records.
      if (claimMeta(id) && !claimScanner && !claimStore.readOnly) {
        await scanClaims();
        await priceClaims(id);
      }
      const m0 = claimMeta(id);
      const wallet = wantWallet || (m0 && m0.owner ? String(m0.owner).toLowerCase() : null);
      const rows = claimStore.rows(id, wallet);
      const coverage = claimStore.coverage(id, wallet);
      // The card's own summary decides the state, so the panel and the tile can
      // never disagree about completeness or a verified zero.
      const m = claimMeta(id);
      let sum = null;
      if (m) {
        try {
          const [a, b] = await Promise.all([u.getToken(m.token0, provider, Number(cfg.chainId)), u.getToken(m.token1, provider, Number(cfg.chainId))]);
          if (a.decimalsOk === true && b.decimalsOk === true) sum = claimedSummaryNow(`v4-${id}`, a.decimals, b.decimals, null, null, a.symbol, b.symbol, null, { token0: m.token0, token1: m.token1, owner: wallet });
        } catch {}
      }
      const state = sum ? sum.state : !coverage ? "not-scanned" : rows.some((r) => r.unavailable) ? "undecodable" : coverage.coversOpening ? "complete" : coverage.reachedLookbackFloor ? "lookback-reached" : "scanning";
      return res.end(JSON.stringify({ ok: true,
        status: !coverage ? "unavailable" : state === "undecodable" ? "unavailable" : coverage.coversOpening ? "ok" : "partial",
        state, verifiedZero: !!(sum && sum.verifiedZero),
        // Valued only at each claim's own moment here (no current prices on this
        // route), so an unpriced record leaves the total null rather than guessed.
        summary: sum,
        ...(!coverage ? { reason: m
          ? "no block range has been scanned for this position yet"
          : "this position has not been loaded by this instance, so the scanner does not know its pair or owner" }
          : sum && sum.reason ? { reason: sum.reason } : coverage.gap ? { reason: coverage.gap } : {}),
        scope: { chainId: Number(cfg.chainId), positionManager: String(cfg.contracts.v4.positionManager).toLowerCase(), tokenId: id, wallet },
        coverage,
        scanner: claimScanner ? claimScanner.status() : null,
        rows: await Promise.all(rows.map(async (r) => {
          // Format here, where the token metadata is available and cached; the card
          // must never be handed a raw integer and left to guess at decimals.
          const fmt = async (raw, addr) => {
            if (raw == null) return null;
            try { const t = await u.getToken(addr, provider, Number(cfg.chainId));
              if (t.decimalsOk !== true) return null;
              return `${Number(ethers.formatUnits(raw, t.decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${t.symbol}`;
            } catch { return null; }
          };
          // USD for this row only at the price of its own moment; a row without one
          // is not valued here (the card's total says how it values those).
          let usdRow = null;
          if (r.px && r.fee0 != null && r.fee1 != null) {
            try {
              const [a, b] = await Promise.all([u.getToken(r.token0, provider, Number(cfg.chainId)), u.getToken(r.token1, provider, Number(cfg.chainId))]);
              if (a.decimalsOk === true && b.decimalsOk === true) {
                usdRow = +(Number(ethers.formatUnits(r.fee0, a.decimals)) * r.px.p0 + Number(ethers.formatUnits(r.fee1, b.decimals)) * r.px.p1).toFixed(4);
              }
            } catch {}
          }
          return { t: r.t, block: r.block, tx: r.tx, logIndex: Number(String(r.key).split(":")[1]), kind: r.kind, unavailable: r.unavailable,
                   recipient: r.owner || null,
                   fee0: await fmt(r.fee0, r.token0), fee1: await fmt(r.fee1, r.token1),
                   priceSrc: r.px ? r.px.src : null,
                   priceT: r.px ? (r.px.t ?? (r.px.src === "block" ? r.t : null)) : null,
                   usd: usdRow };
        })),
      }));
    } catch (err) {
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }

  // Every position a wallet has held, open or not, with its status evidence,
  // closure/transfer/burn dates and its claimed-fee summary for that wallet.
  if (url.pathname === "/api/positions/history") {
    res.setHeader("Content-Type", "application/json");
    try {
      const sel = claimScope(url);
      if (sel.error) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: sel.error })); }
      if (!registry) return res.end(JSON.stringify({ ok: false, error: "this instance has no v4 position manager, so there is no position history" }));
      if (CLAIM_WRITER && Date.now() - registry.at > REGISTRY_EVERY_MS) refreshRegistry();
      if (!registry.at) {
        res.writeHead(202);
        return res.end(JSON.stringify({ ok: false, refreshing: true, error: "position history is still being read" }));
      }
      const positions = await Promise.all(registry.entries(sel.set).map(historyEntry));
      const counts = { open: 0, closed: 0, burned: 0, transferred: 0, unavailable: 0, all: positions.length };
      for (const p of positions) counts[p.status] = (counts[p.status] || 0) + 1;
      return res.end(JSON.stringify({ ok: true, at: registry.at, refreshing: registry.inFlight,
        chainId: Number(cfg.chainId), positionManager: lcAddr(cfg.contracts.v4.positionManager), pricing: PRICING,
        scanner: claimScanner ? claimScanner.status() : null,
        wallets: sel.wallets.map((w) => ({ address: lcAddr(w.address), label: w.label, discovery: registry.discoveryStatus(w.address) })),
        counts, positions }));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }

  // The read-only "Total claimed fees" history: every verified fee settlement of
  // the selected wallet(s) across their positions, grouped by token address.
  if (url.pathname === "/api/claims/total") {
    res.setHeader("Content-Type", "application/json");
    try {
      const sel = claimScope(url);
      if (sel.error) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: sel.error })); }
      if (!registry) return res.end(JSON.stringify({ ok: false, error: "this instance has no v4 position manager, so there is no claim history" }));
      if (!registry.at) {
        res.writeHead(202);
        return res.end(JSON.stringify({ ok: false, refreshing: true, error: "position history is still being read" }));
      }
      const status = String(url.searchParams.get("status") || "all").toLowerCase();
      if (!["all", "open", "closed", "other"].includes(status)) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "status must be all, open, closed or other" })); }
      const num = (k) => { const v = url.searchParams.get(k); return v == null || v === "" ? null : Number(v); };
      const from = num("from"), to = num("to");
      if ((from != null && !Number.isFinite(from)) || (to != null && !Number.isFinite(to))) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "from and to are millisecond timestamps" })); }
      return res.end(JSON.stringify(await claimTotal(sel, status, from, to)));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }

  if (url.pathname === "/api/history") {
    res.setHeader("Content-Type", "application/json");
    try {
      const rows = await historyRows(true);
      const totalUsd = rows.reduce((s, r) => s + (r.usd || 0), 0);
      const lockedSince = rows.filter((r) => r.locked && r.t).reduce((a, r) => (a == null || r.t < a ? r.t : a), null);
      // Per-wallet breakdown, main wallet first, then in settings.json order.
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
        explorer: EXPLORER_URL,
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
      return res.end(JSON.stringify({ ...freshClaims(cache.payload), cached: true, loops: loopHealth(), pricing: PRICING }));
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
      return res.end(JSON.stringify({ ...freshClaims(cache.payload), cached: true, refreshing: true, loops: loopHealth(), pricing: PRICING }));
    }
    try {
      const payload = await buildInFlight;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ...freshClaims(payload), pricing: PRICING }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
    }
  }

  // The dashboard's stylesheet and script, split out of dashboard.html by
  // tools/split-dashboard.js. Serve only explicitly listed assets.
  if (["/dashboard.css", "/dashboard.js", "/insights-view.js"].includes(url.pathname)) {
    const isCss = url.pathname === "/dashboard.css";
    try {
      const body = fs.readFileSync(path.join(__dirname, url.pathname.slice(1)));
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
    // The page shell carries the markup the script fills, so a browser holding an
    // older copy shows a page whose controls simply do not exist. The scripts are
    // already no-cache; the shell must be too.
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(html);
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

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
  // A timer that has not completed a cycle yet counts from process start, so a fresh restart is not "late".
  const ageOf = (t) => (Date.now() - (t || STARTED_AT)) / 60000;
  const loops = {};
  loops.guardian = { ageMin: ageOf(timers.guardian.lastAt), staleAfterMin: 10, label: "risk guardian" };
  if (cfg.memecoinCollect && cfg.memecoinCollect.enabled !== false) loops.autoCollect = { ageMin: ageOf(timers.autoCollect.lastAt), staleAfterMin: 45, label: "fee auto-collect" };
  loops.backup = { ageMin: ageOf(timers.backup.lastAt), staleAfterMin: 26 * 60, label: "nightly backup", lastResult: timers.backup.lastResult || null };
  // The position build itself: everything above reads its cache, so a build that keeps failing must show here.
  loops.build = { ageMin: ageOf(cache.at), staleAfterMin: 30, label: "position build", lastError: lastBuildError };
  if (cfg.launchScanner && cfg.launchScanner.enabled !== false) loops.launch = { ageMin: ageOf(timers.launch.lastAt), staleAfterMin: 20, label: "launch scanner" };
  for (const l of Object.values(loops)) l.stale = l.ageMin > l.staleAfterMin;
  return loops;
}

/** The treasury view (/api/treasury): settings in force, TBA balance, ledger totals. */
const treasuryUnitCache = new Map();   // stable token address -> its symbol, read once
async function treasuryView() {
  // The percentage in force is the NFT's feeSplitPct() (the vault page's slider), not settings.json.
  const ts = await treasuryLedger.effectiveSettings(cfg, provider);
  let balanceUsdg = null;
  let unitSymbol = null;
  if (ts.tba && cfg.usdReference && cfg.usdReference.stable) {
    const usdg = new ethers.Contract(cfg.usdReference.stable, ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"], provider);
    const [raw, dec, sym] = await Promise.all([usdg.balanceOf(ts.tba), usdg.decimals(), usdg.symbol().catch(() => null)]);
    balanceUsdg = Number(ethers.formatUnits(raw, dec));
    // A token's symbol does not change, so a read that fails once should not drop
    // the ticker off a balance that is still being reported. Remembered per token.
    if (sym) treasuryUnitCache.set(cfg.usdReference.stable, sym);
    // The unit is whatever THIS token calls itself, asked of the token the balance
    // was just read from. Taking it from cfg.numeraire named a USDG treasury "WETH"
    // on Robinhood, and only looked right on Arc because its numeraire and its
    // stable happen to be the same contract.
    unitSymbol = sym || treasuryUnitCache.get(cfg.usdReference.stable) || null;
  }
  // Null rather than a guess when the token could not be asked: a blank is honest,
  // a wrong ticker on someone's treasury is not.
  return { ok: true, ...ts, balanceUsdg, unit: unitSymbol, ...treasuryLedger.summary(), explorer: EXPLORER_URL };
}

/**
 * Treasury state for the alerts: effective split % (the TBA contract's own
 * value when it exposes one, else settings.json), TBA USDG balance, and the
 * run of consecutive failed splits from the ledger.
 */
async function treasuryState() {
  const ts = treasuryLedger.settings(cfg);
  if (!ts.tba) return null;
  const eff = await treasuryLedger.effectiveSettings(cfg, provider);
  const pct = eff.pct, pctSource = eff.pctSource;
  let balanceUsdg = null, unit = null;
  try {
    const usdg = new ethers.Contract(cfg.usdReference.stable, ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"], provider);
    const [raw, dec, sym] = await Promise.all([usdg.balanceOf(ts.tba), usdg.decimals(), usdg.symbol().catch(() => null)]);
    balanceUsdg = Number(ethers.formatUnits(raw, dec));
    // The alert text used to hardcode "USDG". Telegram is the channel read when
    // nobody is looking at the dashboard, so a wrong currency there is worse than a
    // wrong label on a page: this one says what the token calls itself.
    if (sym) treasuryUnitCache.set(cfg.usdReference.stable, sym);
    unit = sym || treasuryUnitCache.get(cfg.usdReference.stable) || null;
  } catch {}
  return { enabled: ts.enabled, pct, pctSource, balanceUsdg, unit, consecutiveFailures: treasuryLedger.consecutiveFailures(), withdrawAlertUsdg: Number(cfg.treasuryWithdrawAlertUsdg) || null };
}

// === performance-attribution === (attribution.js): reads the ledgers plus the live views on request
const attribution = require("./attribution").create({
  cfg,
  getPortfolio: () => portfolio.latest,
  getWatch: () => watch.latest,
  getPositions: () => cache.payload,
  getStaking: () => (staking.enabled ? staking.view() : null),
  getHistory: () => lastHistoryRows,
  dir: DATA_DIR, // the instance's ledgers, not the checkout's: a second chain must never read the first's history
});
// === ledger audit === (audit.js): nightly plausibility + inflow reconciliation of the valued rows
// dir: this instance's ledgers, not the checkout's — a second chain must never
// reconcile the first's history.
const ledgerAudit = require("./audit").create({ cfg, dir: DATA_DIR, port: PORT, log: (m) => console.log(m) });
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
const alerts = require("./alerts").create({
  // Every alert sent to a Telegram chat is also remembered on that chat's channel, so "approve it" resolves without an id.
  onSent: (text, to) => { try { if (to) agent.remember(`telegram:${to}`, "assistant", text); } catch {} },
});
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
const startedAt = Date.now();
let auditRunning = false;
let lastBuildError = null; // one log line per distinct failure, not one per tick
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
    if (lastBuildError) { console.log("build: recovered"); lastBuildError = null; }
  } catch (err) {
    // A failing build used to be silent unless a browser happened to be waiting on it;
    // meanwhile alerts, the guardian watch list and auto-collect kept reading the stale cache.
    const m = err && (err.shortMessage || err.message) || String(err);
    if (m !== lastBuildError) { console.error(`build: ${m} (serving the ${cache.at ? Math.round((Date.now() - cache.at) / 60000) + " min old" : "empty"} cache)`); lastBuildError = m; }
  }
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
        try { for (const id of JSON.parse(fs.readFileSync(dataFile(`v4-positions-${w.address.toLowerCase()}.json`), "utf8")).ids || []) v4Ids.add(String(id)); } catch {}
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
  // === ledger audit === once a day (first run ~10 min after start), after the disposal scan had its turn; one Telegram line when the findings change
  if (LOOPS) {
    const last = (ledgerAudit.read() || {}).at || 0;
    if (Date.now() - last > 24 * 3600 * 1000 && Date.now() - startedAt > 10 * 60 * 1000 && !auditRunning) {
      auditRunning = true;
      ledgerAudit.run().then(({ report, changed }) => {
        const s = report.summary;
        if (changed && s.bad + s.warn > 0) alerts.send(ledgerAudit.summaryLine(report)).catch(() => {});
      }).catch((err) => console.error("audit:", err.shortMessage || err.message)).finally(() => { auditRunning = false; });
    }
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

// Rule edits from the Risk section go through the guardian module (settings.json or memecoin-discovered.json).
function guardianRules(tokenId, patch) {
  return (guardian || require("./memecoin-guardian").create({ dir: DATA_DIR, provider, positions: () => cache.payload, watched: () => watch.latest && watch.latest.wallets, log: () => {} })).setRule(tokenId, patch);
}

// === background loops === one process, one log: the risk guardian (60 s), fee
// auto-collect (15 min) and the nightly ledger backup (02:00 local) are timers here.
if (LOOPS) {
  const stamp = (tag) => (m) => console.log(`${tag}: ${m}`);
  guardian = require("./memecoin-guardian").create({ dir: DATA_DIR, provider, alerts, log: stamp("guardian"), positions: () => cache.payload, watched: () => watch.latest && watch.latest.wallets });
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

  autoCollect = require("./memecoin-collect").create({ dir: DATA_DIR, alerts, log: stamp("auto-collect"), positions: () => cache.payload, watched: () => watch.latest && watch.latest.wallets,
    treasury: () => treasuryView().catch(() => null), armUrl: `http://127.0.0.1:${PORT}/arm` });
  async function autoCollectTick() {
    // A skipped cycle (previous collector child still running) leaves the heartbeat alone, so a
    // hung run trips the 45 min stale alert instead of reading as healthy forever.
    try { const r = await autoCollect.cycle(); if (require("./memecoin-collect").cycleCounts(r)) timers.autoCollect.lastAt = Date.now(); }
    catch (err) { console.error("auto-collect: cycle failed:", err.shortMessage || err.message); }
  }
  setTimeout(autoCollectTick, 2 * 60 * 1000);
  setInterval(autoCollectTick, 15 * 60 * 1000);

  // Nightly backup: backup-ledgers.sh once a day at 02:00 local time (checked every minute; the
  // day is remembered in digest-state.json so a restart after 02:00 does not run it twice).
  const BACKUP_HOUR = Number(process.env.LP_BACKUP_HOUR || 2);
  const backupDay = (d = new Date()) => d.toLocaleDateString("en-CA");
  function backupState() { try { return JSON.parse(fs.readFileSync(dataFile("digest-state.json"), "utf8")); } catch { return {}; } }
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
        try { fs.writeFileSync(dataFile("digest-state.json"), JSON.stringify({ ...backupState(), lastBackupDate: backupDay(), lastBackupAt: new Date().toISOString(), lastBackupCode: code })); } catch {}
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
  // Shared memory to the VPS every 10 minutes (sync-memory.sh: brain/notes.md, agent-memory, agent-work.log), so the VPS agent remembers the same things.
  let memSyncBusy = false;
  function syncMemory() {
    if (memSyncBusy || !fs.existsSync(path.join(__dirname, "sync-memory.sh"))) return;
    memSyncBusy = true;
    const child = spawn("bash", [path.join(__dirname, "sync-memory.sh")], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => { memSyncBusy = false; const last = out.trim().split("\n").pop(); if (code !== 0) console.error(`memory sync: exit ${code}${last ? " — " + last : ""}`); else if (last && !timers.memorySyncLogged) { console.log(last); timers.memorySyncLogged = true; } timers.memorySync = { lastAt: Date.now(), code }; });
    child.on("error", () => { memSyncBusy = false; });
  }
  setTimeout(syncMemory, 4 * 60 * 1000);
  setInterval(syncMemory, 10 * 60 * 1000);
  server.syncMemory = syncMemory;

  // Improvement loop + code review (tasks/run-all.sh) every 6 h from here: cron is not running in
  // this WSL instance, so this timer is the only scheduler. One run at a time; output appended to
  // tasks/output/run-all.log. Never on the smoke-test or read-only instances (LOOPS guards this block).
  let tasksBusy = false;
  function runTasks() {
    const script = path.join(__dirname, "tasks", "run-all.sh");
    if (tasksBusy || !fs.existsSync(script)) return;
    tasksBusy = true;
    let logFd = null;
    try { fs.mkdirSync(path.join(__dirname, "tasks", "output"), { recursive: true }); logFd = fs.openSync(path.join(__dirname, "tasks", "output", "run-all.log"), "a"); } catch (err) { console.error(`tasks: cannot open run-all.log: ${err.message}`); }
    const child = spawn("bash", [script], { cwd: __dirname, stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"], env: process.env });
    console.log(`tasks: run-all started (pid ${child.pid})`);
    child.on("close", (code) => { tasksBusy = false; if (logFd != null) { try { fs.closeSync(logFd); } catch {} } console.log(`tasks: run-all finished (code ${code})`); timers.tasks = { lastAt: Date.now(), code }; rememberTasksRun(code); });
    child.on("error", (err) => { tasksBusy = false; if (logFd != null) { try { fs.closeSync(logFd); } catch {} } console.error(`tasks: run-all failed to start: ${err.message}`); });
  }
  // The cadence survives restarts: the last run is remembered in digest-state.json (next to the
  // backup's), so a process that restarts 20 times a day does not run the paid model review 20
  // times. First run at max(10 min, lastTasksAt + 6 h − now); then every 6 h.
  const TASKS_EVERY_MS = 6 * 60 * 60 * 1000;
  function rememberTasksRun(code) { try { fs.writeFileSync(dataFile("digest-state.json"), JSON.stringify({ ...backupState(), lastTasksAt: new Date().toISOString(), lastTasksCode: code })); } catch {} }
  {
    const st = backupState();
    const lastTasksAt = st.lastTasksAt ? Date.parse(st.lastTasksAt) || 0 : 0;
    if (lastTasksAt) timers.tasks = { lastAt: lastTasksAt, code: st.lastTasksCode ?? null };
    const firstDelay = Math.max(10 * 60 * 1000, lastTasksAt + TASKS_EVERY_MS - Date.now());
    setTimeout(() => { runTasks(); setInterval(runTasks, TASKS_EVERY_MS); }, firstDelay);
    console.log(`tasks: first run-all at ${new Date(Date.now() + firstDelay).toISOString().slice(0, 16)}Z${lastTasksAt ? ` (last ran ${new Date(lastTasksAt).toISOString().slice(0, 16)}Z)` : ""}, then every 6 h`);
  }
  server.runTasks = runTasks;
  server.tasksBusy = () => tasksBusy;

  // Recorded runs from before the fold count for the watchdog.
  { const st = backupState(); if (st.lastBackupAt) { timers.backup.lastAt = Date.parse(st.lastBackupAt) || 0; timers.backup.lastResult = { at: timers.backup.lastAt, code: st.lastBackupCode ?? null }; } }
  server.runBackup = runBackup;
  console.log(`loops: risk guardian every 60 s, fee auto-collect every 15 min, ledger backup daily at ${String(BACKUP_HOUR).padStart(2, "0")}:00, tasks/run-all.sh every 6 h`);

  // Launch scanner (launch-scanner.js): new v4 pools scored every 5 minutes; alerts through the same Telegram path.
  if (cfg.launchScanner && cfg.launchScanner.enabled !== false) {
    launchScanner = require("./launch-scanner").create({ cfg, provider, alerts, log: stamp("launch"), dir: DATA_DIR, wethUsd: () => (cache.payload && cache.payload.wethUsd) || lastPrices[WETH] || null });
    let launchBusy = false;
    async function launchTick() {
      if (launchBusy) return;
      launchBusy = true;
      try { await launchScanner.scan(); timers.launch.lastAt = Date.now(); }
      catch (err) { console.error("launch: scan failed:", err.shortMessage || err.message); }
      finally { launchBusy = false; }
    }
    setTimeout(launchTick, 3 * 60 * 1000); // after the first build, off the guardian's beat
    setInterval(launchTick, 5 * 60 * 1000);
  }

  // Telegram: incoming messages are the VPS agent's (it polls the bot); this process only sends
  // alerts and remembers them on the chat's transcript. telegram.js keeps the outbound side and
  // a handle() for a future relay; nothing here calls getUpdates.
  {
    const allowed = {};
    const al = cfg.alerts || {};
    if (al.fallbackChat) allowed[String(al.fallbackChat)] = "approve";
    for (const c of (settings.read().alerts || {}).agentChats || []) if (c && c.chat) allowed[String(c.chat)] = ["read", "approve", "full"].includes(c.role) ? c.role : "read";
    telegramAgent = require("./telegram").create({ agent, allowed, log: { log: (m) => console.log(m), error: (m) => console.error(m) } });
  }
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
  // Supervision: a child that keeps dying at start (a bad patch, a missing module) is
  // retried every 60 s for the first three exits, then every 15 min, and one Telegram line
  // goes out on the third fast exit (at most hourly) so a crash loop never runs unnoticed.
  // Ten minutes of uptime clears the counter. A service found "already running" (an orphan
  // from a previous server) is re-checked every 60 s and started when its port goes quiet.
  const FAST_EXIT_MS = 30000, FAST_EXITS_BEFORE_BACKOFF = 3, BACKOFF_MS = 15 * 60000, STABLE_MS = 10 * 60000;
  async function startService(svc) {
    svc.pending = false;
    if (svc.needs && !fs.existsSync(svc.needs)) return console.log(`${svc.name}: skipped (${path.basename(svc.needs)} missing)`);
    if (svc.port && (await listening(svc.port))) {
      if (!svc.adopted) console.log(`${svc.name}: already running on :${svc.port} (not started by this process; re-checked every 60 s)`);
      svc.adopted = true;
      return;
    }
    svc.adopted = false;
    // A service gets its own PORT, never this process's. The scanner reads
    // `process.env.PORT || 3847`, inherited 8787 from the dashboard that spawned it,
    // bound the port already in use and died two seconds later -- forty-six times,
    // every fifteen minutes, while :3847 stayed empty and the public scanner URL had
    // nothing behind it. Inheriting the environment is right for the secrets in it;
    // inheriting the parent's own port never is.
    const env = { ...process.env };
    if (svc.port) env.PORT = String(svc.port); else delete env.PORT;
    const child = spawn(svc.cmd, svc.args, { cwd: svc.cwd || __dirname, stdio: ["ignore", "pipe", "pipe"], env });
    svc.child = child; svc.startedAt = Date.now();
    const relay = (isErr) => (d) => { for (const line of d.toString().split("\n")) if (line.trim()) { console.log(`${svc.name}: ${line}`); if (isErr) svc.lastErr = line.trim(); } };
    child.stdout.on("data", relay(false)); child.stderr.on("data", relay(true));
    const stableTimer = setTimeout(() => { if (svc.child === child && svc.fastExits) { svc.fastExits = 0; console.log(`${svc.name}: stable for 10 min, crash counter cleared`); } }, STABLE_MS);
    child.on("exit", (code) => {
      clearTimeout(stableTimer);
      svc.child = null;
      const upMs = Date.now() - svc.startedAt;
      svc.fastExits = upMs < FAST_EXIT_MS ? (svc.fastExits || 0) + 1 : 0;
      const backoff = svc.fastExits >= FAST_EXITS_BEFORE_BACKOFF;
      const delay = backoff ? BACKOFF_MS : upMs < FAST_EXIT_MS ? 60000 : 5000;
      console.log(`${svc.name}: exited ${code} after ${Math.round(upMs / 1000)} s (fast exits: ${svc.fastExits}); restarting in ${delay / 1000} s`);
      if (backoff && Date.now() - (svc.alertedAt || 0) >= 3600000) {
        svc.alertedAt = Date.now();
        alerts.send(`⚠️ ${svc.name} keeps exiting (code ${code}, ${svc.fastExits} fast exits): ${svc.lastErr || "no stderr"} — retrying every 15 min; see server.log`).catch(() => {});
      }
      svc.pending = true;
      setTimeout(() => startService(svc).catch(() => {}), delay);
    });
    child.on("error", (err) => console.error(`${svc.name}: ${err.message}`));
    console.log(`${svc.name}: started (pid ${child.pid})`);
  }
  for (const svc of services) startService(svc).catch((err) => console.error(`${svc.name}: ${err.message}`));
  // An adopted (orphan) service that later exits would otherwise stay dead: watch its port.
  setInterval(async () => {
    for (const svc of services) {
      if (svc.child || svc.pending || !svc.adopted || !svc.port) continue;
      if (await listening(svc.port)) continue;
      console.log(`${svc.name}: :${svc.port} stopped listening (orphan gone); starting`);
      svc.adopted = false;
      startService(svc).catch((err) => console.error(`${svc.name}: ${err.message}`));
    }
  }, 60000).unref();
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

// Brought back by watchdog.sh after the process exited: one Telegram line, so a crash never passes unnoticed.
if (process.env.LP_RESTARTED_BY === "watchdog" && LOOPS) {
  setTimeout(() => { alerts.send(`♻️ Dashboard restarted by the watchdog after it exited (${process.env.LP_RESTART_REASON || "process gone"}). Check server.log for the cause.`).catch(() => {}); }, 20000);
}
server.listen(PORT, HOST, () => {
  if (claimScanner) {
    // After the listener is up, so the first requests are never behind it.
    setTimeout(() => { claimScanner.start(); priceAllClaims().catch(() => {}); }, Number(process.env.LP_CLAIM_SCAN_DELAY_MS || 15000)).unref();
    if (registry) {
      setTimeout(() => refreshRegistry(), Number(process.env.LP_REGISTRY_DELAY_MS || 20000)).unref();
      setInterval(() => refreshRegistry(), REGISTRY_EVERY_MS).unref();
    }
    console.log(`claims scan: background scan on (chain ${cfg.chainId}, ${trackedClaimIds().length} position(s) persisted)`);
  }
  console.log(`Dashboard running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (HOST === "0.0.0.0") console.log("Bound to all interfaces -- reachable from your network.");
  console.log(`Watching ${cfg.ownerAddress} on chain ${cfg.chainId}`);
  console.log("Reads are key-free. The Collect button runs run-collector.sh on this machine;");
  console.log("it needs a live unlock window (./unlock.sh) and no key ever reaches the browser.");
});
