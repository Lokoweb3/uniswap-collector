/**
 * Staking rewards ledger for rebasing receipt tokens (OHM-style: balance =
 * gons / gonsPerFragment, and a public index() that grows with every rebase).
 * sNET from the NET Staking contract is the first one; settings.json `staking`
 * lists them.
 *
 * Every hour the owner's balance, the index and the receipt's USD price are
 * appended to snet-staking.json. Between two samples, a balance change that
 * matches the index change is a rebase reward; anything else (a stake or an
 * unstake) is not income and is skipped. History before the first sample is
 * rebuilt once from the token's LogRebase events: balance_then = balance_now
 * * index_then / index_now, valid back to the owner's last stake/unstake.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// Ledgers belong to the instance, not the checkout: with --data-dir a second
// chain keeps its own, and without it this is exactly path.join(__dirname, ...).
const { dataPath } = require("./data-dir");
const FILE = dataPath("snet-staking.json");
const SAMPLE_MS = 3600 * 1000;
const ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function index() view returns (uint256)",
  "event LogRebase(uint256 indexed epoch, uint256 rebaseAmount, uint256 index)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];
const LOG_FLOOR = 45000000; // the RPC serves logs back to roughly here
const DEFAULT_MAX_LOG_RANGE = 500000; // blocks per getLogs call when settings.json sets no maxLogRange (Robinhood's RPC copes with this)
const MIN_MAX_LOG_RANGE = 1000; // a tiny configured range would turn one scan into millions of getLogs calls
const MAX_SAMPLES = 20000;
const BACKOFF_MIN_MS = 3600 * 1000, BACKOFF_MAX_MS = 24 * 3600 * 1000;

function create({ provider, cfg, maxLogRange, getPrice, getWallets = () => [], getOwnerLabel = () => null, log = console }) {
  const list = ((cfg.staking && cfg.staking.tokens) || []).filter((t) => t && ethers.isAddress(t.token));
  const maxRange = Math.floor(Number(maxLogRange || cfg.maxLogRange)) > 0 ? Math.max(MIN_MAX_LOG_RANGE, Math.floor(Number(maxLogRange || cfg.maxLogRange))) : DEFAULT_MAX_LOG_RANGE;
  let state = { tokens: {} };
  let noSave = false; // set when an unreadable ledger could not be set aside: saving would overwrite it
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      // Unreadable or unparseable: keep it for inspection instead of silently overwriting the ledger on the next save.
      const bad = `${FILE}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(FILE, bad);
        log.error(`staking: ${path.basename(FILE)} could not be read (${err && err.message}); moved to ${path.basename(bad)}, starting empty`);
      } catch (e2) {
        noSave = true;
        log.error(`staking: ${path.basename(FILE)} could not be read (${err && err.message}) and could not be set aside (${e2.message}); not saving, so the original is kept`);
      }
    }
  }
  // Written to a temporary file and renamed into place: a crash mid-write leaves the previous ledger intact.
  const save = () => {
    if (noSave) { log.error("staking: save skipped, the unreadable ledger could not be set aside"); return; }
    const tmp = `${FILE}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, FILE);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      log.error("staking: save", err.message);
    }
  };
  // Per-sample-run caches, shared by every wallet: the head, the LogRebase scan per token, block timestamps.
  let run = null;
  const newRun = () => ({ head: null, rebase: new Map(), ts: new Map() });
  const headOf = async () => {
    const r = run || newRun();
    if (r.head == null) r.head = await provider.getBlockNumber();
    return r.head;
  };
  /** getLogs over [from, to] in ranges of at most maxRange blocks. */
  async function getLogsChunked(filter, from, to) {
    const out = [];
    for (let a = from; a <= to; a += maxRange) {
      const b = Math.min(a + maxRange - 1, to);
      for (const l of await provider.getLogs({ ...filter, fromBlock: a, toBlock: b })) out.push(l);
    }
    return out;
  }
  const blockTs = (n) => {
    const r = run || newRun();
    if (!r.ts.has(n)) {
      const p = provider.getBlock(n).then((b) => b.timestamp);
      p.catch(() => r.ts.delete(n));
      r.ts.set(n, p);
    }
    return r.ts.get(n);
  };
  // In-memory, per wallet: a watched wallet whose transfer scan keeps failing is retried after 1h, 2h, 4h ... capped at 24h.
  const backoff = new Map();
  const backedOff = (wkey) => { const b = backoff.get(wkey); return !!b && Date.now() < b.until; };
  const noteFail = (wkey) => {
    const n = ((backoff.get(wkey) || {}).fails || 0) + 1;
    backoff.set(wkey, { fails: n, until: Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (n - 1)) });
  };
  const meta = new Map();

  async function info(addr) {
    if (meta.has(addr)) return meta.get(addr);
    const c = new ethers.Contract(addr, ABI, provider);
    const [symbol, decimals] = await Promise.all([c.symbol().catch(() => "?"), c.decimals().catch(() => 18)]);
    const m = { c, symbol, decimals: Number(decimals) };
    meta.set(addr, m);
    return m;
  }

  /** Net principal: sNET received minus sent (stakes are 1:1, verified in the Staking source). Cached per sample run. */
  async function principalOf(m, owner) {
    const t = m.c.interface.getEvent("Transfer").topicHash;
    const head = await headOf();
    let inSum = 0n, outSum = 0n;
    try {
      for (const l of await getLogsChunked({ address: m.c.target, topics: [t, null, ethers.zeroPadValue(owner, 32)] }, LOG_FLOOR, head)) inSum += BigInt(l.data);
      for (const l of await getLogsChunked({ address: m.c.target, topics: [t, ethers.zeroPadValue(owner, 32)] }, LOG_FLOOR, head)) outSum += BigInt(l.data);
    } catch {
      return null;
    }
    return Number(ethers.formatUnits(inSum - outSum, m.decimals));
  }

  /** Owner's last stake/unstake block: the newest Transfer to or from the owner. */
  async function lastMoveBlock(m, owner, strict) {
    const to = ethers.zeroPadValue(owner, 32);
    const t = m.c.interface.getEvent("Transfer").topicHash;
    const head = await headOf();
    let newest = 0;
    for (const topics of [[t, null, to], [t, to]]) {
      try {
        const logs = await getLogsChunked({ address: m.c.target, topics }, LOG_FLOOR, head);
        for (const l of logs) if (l.blockNumber > newest) newest = l.blockNumber;
      } catch (err) {
        // A watched wallet is not backfilled from a scan that failed: with no last-move block the rebuilt history would reach back past its last stake. It is retried next sample. (The main wallet keeps its old best-effort behaviour.)
        if (strict) throw err;
        log.error("staking: transfer scan", err.shortMessage || err.message);
      }
    }
    return newest;
  }

  /** Every LogRebase of the token since the floor: scanned once per sample run and shared by all wallets. */
  function rebaseLogs(m) {
    const r = run || newRun();
    const k = String(m.c.target).toLowerCase();
    if (!r.rebase.has(k)) {
      const p = headOf().then((head) => getLogsChunked({ address: m.c.target, topics: [m.c.interface.getEvent("LogRebase").topicHash] }, LOG_FLOOR, head));
      p.catch(() => r.rebase.delete(k));
      r.rebase.set(k, p);
    }
    return r.rebase.get(k);
  }

  /** Rebuild samples from LogRebase events since the last stake/unstake. Once. */
  async function backfill(entry, m, owner, balNow, indexNow, price, strict) {
    const since = await lastMoveBlock(m, owner, strict);
    const from = Math.max(since, LOG_FLOOR);
    const logs = (await rebaseLogs(m)).filter((l) => l.blockNumber >= from);
    const samples = [];
    // The moment of the stake itself, at the index of the first rebase before it is unknown; start at the first rebase after it.
    for (const l of logs) {
      const e = m.c.interface.parseLog(l);
      const idx = e.args.index;
      const ts = await blockTs(l.blockNumber);
      const bal = Number(ethers.formatUnits((balNow * idx) / indexNow, m.decimals));
      samples.push({ t: ts * 1000, block: l.blockNumber, bal, index: idx.toString(), price: null, approx: true });
    }
    // The pre-first-rebase balance: what the owner held right after staking.
    if (samples.length && since > 0) {
      const sts = await blockTs(since);
      const firstIdx = BigInt(samples[0].index);
      // index before the first rebase is unknown; take the stake-time balance as balance at the first rebase minus that rebase's growth using the following ratio
      if (samples.length >= 2) {
        const r = Number(BigInt(samples[1].index) * 1000000n / firstIdx) / 1e6;
        samples.unshift({ t: sts * 1000, block: since, bal: samples[0].bal / r, index: null, price: null, approx: true, stake: true });
      }
    }
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
    entry.samples = samples;
    entry.backfilledAt = Date.now();
    entry.sinceBlock = since;
    log.log(`staking: ${m.symbol} history rebuilt from ${samples.length} rebase(s) since block ${since}`);
  }

  /**
   * The configured wallets besides the main one: [{ address (checksummed), label }].
   * `getWallets` is the watch.js reader, so this is exactly the watched set.
   */
  function others() {
    const out = [];
    const seen = new Set([String(cfg.ownerAddress).toLowerCase()]);
    let list = [];
    try { list = getWallets() || []; } catch (err) { log.error("staking: wallet list", err.shortMessage || err.message); }
    for (const w of list) {
      if (!w || !ethers.isAddress(w.address)) continue;
      const lower = w.address.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push({ address: ethers.getAddress(w.address), label: w.label || null });
    }
    return out;
  }
  const mainLabel = () => getOwnerLabel() || "Main";

  /** One token for one wallet. The main wallet's entry lives at tokens[token], the others at wallets[addr][token]. */
  async function sampleOne(t, owner, isMain) {
    const addr = t.token.toLowerCase();
    const wkey = owner.toLowerCase();
    const attach = (e) => { ((state.wallets = state.wallets || {})[wkey] = state.wallets[wkey] || {})[addr] = e; };
    let fresh = false;
    const existing = isMain ? state.tokens[addr] : state.wallets && state.wallets[wkey] && state.wallets[wkey][addr];
    // Main always gets its entry (as before); another wallet only once it holds sNET or already has one.
    let entry = isMain ? (state.tokens[addr] = state.tokens[addr] || { samples: [] }) : existing;
    try {
      const m = await info(t.token);
      const [raw, idx] = await Promise.all([m.c.balanceOf(owner), m.c.index()]);
      if (!entry) {
        if (raw === 0n) return;
        // Not attached to the state until its backfill has succeeded: a failed one must leave no empty entry behind.
        entry = { samples: [] };
        fresh = true;
      }
      const bal = Number(ethers.formatUnits(raw, m.decimals));
      const price = getPrice ? getPrice(addr) : null;
      if (!entry.backfilledAt && raw > 0n) {
        if (!isMain && backedOff(wkey)) return;
        try {
          await backfill(entry, m, owner, raw, idx, price, !isMain);
        } catch (err) {
          if (!isMain) noteFail(wkey);
          throw err;
        }
        backoff.delete(wkey);
        if (fresh) { attach(entry); fresh = false; }
        save();
      }
      const last = entry.samples[entry.samples.length - 1];
      if (!last || Date.now() - last.t >= SAMPLE_MS || (last.index && last.index !== idx.toString())) {
        entry.samples.push({ t: Date.now(), block: await provider.getBlockNumber(), bal, index: idx.toString(), price: price == null ? null : +price.toPrecision(6) });
        if (entry.samples.length > MAX_SAMPLES) entry.samples.splice(0, entry.samples.length - MAX_SAMPLES);
      }
      entry.symbol = m.symbol;
      if ((!entry.principalAt || Date.now() - entry.principalAt > 6 * 3600 * 1000) && (isMain || !backedOff(wkey))) {
        const pr = await principalOf(m, owner);
        if (pr != null) { entry.principal = pr; entry.principalAt = Date.now(); if (!isMain) backoff.delete(wkey); }
        else if (!isMain) noteFail(wkey);
      }
      entry.label = t.label || `${m.symbol} staking`;
      entry.underlying = t.underlying || null;
      if (fresh) attach(entry);
    } catch (err) {
      if (!isMain && entry && !entry.samples.length && state.wallets && state.wallets[wkey]) {
        delete state.wallets[wkey][addr];
        if (!Object.keys(state.wallets[wkey]).length) delete state.wallets[wkey];
        if (!Object.keys(state.wallets).length) delete state.wallets;
      }
      log.error(`staking: ${t.token.slice(0, 8)}…`, err.shortMessage || err.message);
    }
  }

  let inFlight = null;
  /** Single-flight: a call while a run is in progress gets that run's promise instead of starting a second one. */
  function sample() {
    if (!inFlight) inFlight = runSample().finally(() => { inFlight = null; });
    return inFlight;
  }
  async function runSample() {
    run = newRun();
    try {
      for (const t of list) await sampleOne(t, cfg.ownerAddress, true);
      // Each wallet is isolated: one wallet's RPC failure is logged inside sampleOne and the next goes on.
      for (const w of others()) for (const t of list) await sampleOne(t, w.address, false);
    } finally {
      run = null;
      save();
    }
  }

  /** Rewards between consecutive samples, in token units, valued at the later sample's price (or `nowPrice`). */
  function rewards(entry, nowPrice) {
    const out = [];
    const s = entry.samples;
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1], b = s[i];
      const d = b.bal - a.bal;
      if (d <= 0) continue;
      // A rebase moves the balance by the index ratio; a deposit does not.
      if (a.index && b.index) {
        const ratio = Number((BigInt(b.index) * 1000000n) / BigInt(a.index)) / 1e6;
        const expected = a.bal * (ratio - 1);
        if (Math.abs(d - expected) > Math.max(expected * 0.02, 1e-9)) continue; // stake, not reward
      }
      const price = b.price != null ? b.price : nowPrice;
      out.push({ t: b.t, amount: d, price, usd: price == null ? null : d * price, approx: b.price == null });
    }
    return out;
  }

  const { dayKey } = require("./daykey"); // one calendar for every "day" (LP_TZ, else the process zone)

  function tokensOf(entries, now) {
    const tokens = [];
    for (const [addr, e] of Object.entries(entries || {})) {
      const last = e.samples[e.samples.length - 1];
      if (!last) continue;
      const price = getPrice ? getPrice(addr) : last.price;
      const rw = rewards(e, price);
      const sum = (ms) => rw.filter((r) => now - r.t <= ms).reduce((s, r) => s + r.amount, 0);
      const sumUsd = (ms) => rw.filter((r) => now - r.t <= ms).reduce((s, r) => s + (r.usd || 0), 0);
      const daily = {};
      for (const r of rw) {
        const k = dayKey(r.t);
        daily[k] = daily[k] || { day: k, amount: 0, usd: 0, approx: false };
        daily[k].amount += r.amount;
        daily[k].usd += r.usd || 0;
        daily[k].approx = daily[k].approx || r.approx;
      }
      const d7 = sum(7 * 86400000);
      const first = e.samples.find((s) => !s.stake) || e.samples[0];
      const days = Math.max(1 / 24, (now - e.samples[0].t) / 86400000);
      const tracked = rw.reduce((s, r) => s + r.amount, 0); // rewards seen by the sampler
      // Principal from the 1:1 stake transfers when known; everything above it is reward, including rebases before sampling began.
      const base = e.principal != null ? e.principal : last.bal - tracked;
      const total = e.principal != null ? Math.max(0, last.bal - e.principal) : tracked;
      tokens.push({
        token: addr,
        symbol: e.symbol,
        label: e.label,
        underlying: e.underlying,
        balance: last.bal,
        principal: base,
        price,
        usd: price == null ? null : last.bal * price,
        since: e.samples[0].t,
        rewards: {
          today: rw.filter((r) => dayKey(r.t) === dayKey(now)).reduce((s, r) => s + r.amount, 0),
          d7,
          d30: sum(30 * 86400000),
          total,
          totalUsd: rw.reduce((s, r) => s + (r.usd || 0), 0),
          d7Usd: sumUsd(7 * 86400000),
          d30Usd: sumUsd(30 * 86400000),
        },
        // Annualised from what actually accrued over the tracked window, on the principal.
        aprPct: base > 0 && days > 0 ? (total / base / days) * 365 * 100 : null,
        daily: Object.values(daily).sort((a, b) => (a.day < b.day ? -1 : 1)),
        events: rw.slice(-200),
        series: e.samples.filter((_, i, arr) => i % Math.max(1, Math.ceil(arr.length / 240)) === 0 || i === arr.length - 1).map((s) => ({ t: s.t, bal: s.bal, price: s.price })),
      });
    }
    return tokens;
  }

  /** Main wallet exactly as before: { ok, at, tokens }. With { wallet } (address or label of a configured wallet): that wallet's tokens, plus the wallet. null when not configured. */
  function view(opts) {
    const now = Date.now();
    if (opts && opts.wallet != null) {
      const w = resolve(opts.wallet);
      if (!w) return null;
      const entries = w.main ? state.tokens : state.wallets && state.wallets[w.address.toLowerCase()];
      return { ok: true, at: now, wallet: { address: w.address, label: w.label }, tokens: tokensOf(entries, now) };
    }
    return { ok: true, at: now, tokens: tokensOf(state.tokens, now) };
  }

  /** The configured watched wallets (main excluded) with their tokens. */
  function viewAll() {
    const now = Date.now();
    return others().map((w) => ({ address: w.address, label: w.label || w.address, tokens: tokensOf(state.wallets && state.wallets[w.address.toLowerCase()], now) }));
  }

  /** A configured wallet by address or label (main included); never anything else. */
  function resolve(q) {
    const s = String(q == null ? "" : q).trim();
    if (!s) return null;
    const all = [{ address: cfg.ownerAddress, label: mainLabel(), main: true }, ...others().map((w) => ({ address: w.address, label: w.label || w.address }))];
    const lower = s.toLowerCase();
    const byAddr = all.find((w) => w.address.toLowerCase() === lower);
    if (byAddr) return byAddr;
    // A label shared by two configured wallets names neither of them.
    const byLabel = all.filter((w) => String(w.label).toLowerCase() === lower);
    return byLabel.length === 1 ? byLabel[0] : null;
  }

  return { sample, view, viewAll, resolve, enabled: list.length > 0 };
}

module.exports = { create };
