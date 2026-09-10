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

const FILE = path.join(__dirname, "snet-staking.json");
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

function create({ provider, cfg, getPrice, log = console }) {
  const list = ((cfg.staking && cfg.staking.tokens) || []).filter((t) => t && ethers.isAddress(t.token));
  let state = { tokens: {} };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {}
  const save = () => {
    try {
      fs.writeFileSync(FILE, JSON.stringify(state));
    } catch {}
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
    const head = await provider.getBlockNumber();
    let inSum = 0n, outSum = 0n;
    try {
      for (const l of await provider.getLogs({ address: m.c.target, fromBlock: LOG_FLOOR, toBlock: head, topics: [t, null, ethers.zeroPadValue(owner, 32)] })) inSum += BigInt(l.data);
      for (const l of await provider.getLogs({ address: m.c.target, fromBlock: LOG_FLOOR, toBlock: head, topics: [t, ethers.zeroPadValue(owner, 32)] })) outSum += BigInt(l.data);
    } catch {
      return null;
    }
    return Number(ethers.formatUnits(inSum - outSum, m.decimals));
  }

  /** Owner's last stake/unstake block: the newest Transfer to or from the owner. */
  async function lastMoveBlock(m, owner) {
    const to = ethers.zeroPadValue(owner, 32);
    const t = m.c.interface.getEvent("Transfer").topicHash;
    const head = await provider.getBlockNumber();
    let newest = 0;
    for (const topics of [[t, null, to], [t, to]]) {
      try {
        const logs = await provider.getLogs({ address: m.c.target, fromBlock: LOG_FLOOR, toBlock: head, topics });
        for (const l of logs) if (l.blockNumber > newest) newest = l.blockNumber;
      } catch (err) {
        log.error("staking: transfer scan", err.shortMessage || err.message);
      }
    }
    return newest;
  }

  /** Rebuild samples from LogRebase events since the last stake/unstake. Once. */
  async function backfill(entry, m, owner, balNow, indexNow, price) {
    const since = await lastMoveBlock(m, owner);
    const head = await provider.getBlockNumber();
    const logs = await provider.getLogs({ address: m.c.target, fromBlock: Math.max(since, LOG_FLOOR), toBlock: head, topics: [m.c.interface.getEvent("LogRebase").topicHash] });
    const samples = [];
    // The moment of the stake itself, at the index of the first rebase before it is unknown; start at the first rebase after it.
    for (const l of logs) {
      const e = m.c.interface.parseLog(l);
      const idx = e.args.index;
      const b = await provider.getBlock(l.blockNumber);
      const bal = Number(ethers.formatUnits((balNow * idx) / indexNow, m.decimals));
      samples.push({ t: b.timestamp * 1000, block: l.blockNumber, bal, index: idx.toString(), price: null, approx: true });
    }
    // The pre-first-rebase balance: what the owner held right after staking.
    if (samples.length && since > 0) {
      const b = await provider.getBlock(since);
      const firstIdx = BigInt(samples[0].index);
      // index before the first rebase is unknown; take the stake-time balance as balance at the first rebase minus that rebase's growth using the following ratio
      if (samples.length >= 2) {
        const r = Number(BigInt(samples[1].index) * 1000000n / firstIdx) / 1e6;
        samples.unshift({ t: b.timestamp * 1000, block: since, bal: samples[0].bal / r, index: null, price: null, approx: true, stake: true });
      }
    }
    entry.samples = samples;
    entry.backfilledAt = Date.now();
    entry.sinceBlock = since;
    log.log(`staking: ${m.symbol} history rebuilt from ${samples.length} rebase(s) since block ${since}`);
  }

  async function sample() {
    const owner = cfg.ownerAddress;
    for (const t of list) {
      const addr = t.token.toLowerCase();
      const entry = (state.tokens[addr] = state.tokens[addr] || { samples: [] });
      try {
        const m = await info(t.token);
        const [raw, idx] = await Promise.all([m.c.balanceOf(owner), m.c.index()]);
        const bal = Number(ethers.formatUnits(raw, m.decimals));
        const price = getPrice ? getPrice(addr) : null;
        if (!entry.backfilledAt && raw > 0n) await backfill(entry, m, owner, raw, idx, price);
        const last = entry.samples[entry.samples.length - 1];
        if (!last || Date.now() - last.t >= SAMPLE_MS || (last.index && last.index !== idx.toString())) {
          entry.samples.push({ t: Date.now(), block: await provider.getBlockNumber(), bal, index: idx.toString(), price: price == null ? null : +price.toPrecision(6) });
          if (entry.samples.length > 20000) entry.samples.splice(0, entry.samples.length - 20000);
        }
        entry.symbol = m.symbol;
        if (!entry.principalAt || Date.now() - entry.principalAt > 6 * 3600 * 1000) {
          const pr = await principalOf(m, owner);
          if (pr != null) { entry.principal = pr; entry.principalAt = Date.now(); }
        }
        entry.label = t.label || `${m.symbol} staking`;
        entry.underlying = t.underlying || null;
        save();
      } catch (err) {
        log.error(`staking: ${t.token.slice(0, 8)}…`, err.shortMessage || err.message);
      }
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

  const dayKey = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  function view() {
    const now = Date.now();
    const tokens = [];
    for (const [addr, e] of Object.entries(state.tokens)) {
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
    return { ok: true, at: now, tokens };
  }

  return { sample, view, enabled: list.length > 0 };
}

module.exports = { create };
