/**
 * Token health: a risk read on every token the wallets hold.
 *
 * Two sources, combined:
 *  - the chain itself (always available): the contract bytecode is scanned for
 *    the 4-byte selectors of mint / pause / blacklist / tax / owner-style
 *    functions (a Solidity dispatcher embeds each public selector as PUSH4),
 *    and cheap views are read live (paused(), taxEnabled(), owner(),
 *    guardian(), totalSupply());
 *  - Blockscout (best effort, cached, paced): holder count, verified source,
 *    creation transaction (→ contract age), and the verified ABI, which is
 *    more precise than selector scanning when present.
 *
 * Scoring:
 *  🔴 Risk     unverified with mint/pause/blacklist power, tax switched on,
 *              pausable + paused, or younger than 3 days with few holders
 *  🟡 Caution  any of mint / pause / blacklist / tax present, owner-controlled,
 *              younger than 30 days, or under 50 holders
 *  🟢 Safe     verified, none of the above, older than 30 days, ≥ 50 holders
 * Well-known infrastructure tokens (WETH, the USD stable) are pinned safe.
 *
 * State lives in token-health.json; a token is refreshed every 6 hours.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { bsFetch } = require("./blockscout");

const FILE = path.join(__dirname, "token-health.json");
const REFRESH_MS = 6 * 3600 * 1000;
const RETRY_MS = 30 * 60 * 1000; // after a failed Blockscout read
const DAY = 86400000;

// Function selectors that signal control over holders' balances or transfers.
const SELECTORS = {
  mint: ["mint(address,uint256)", "mint(uint256)", "mint(address)", "mintTo(address,uint256)", "_mint(address,uint256)"],
  pause: ["pause()", "unpause()", "paused()", "setPaused(bool)"],
  blacklist: ["blacklist(address)", "blacklist(address,bool)", "isBlacklisted(address)", "setBlacklist(address,bool)", "addToBlacklist(address)", "blockAccount(address)"],
  tax: ["taxEnabled()", "setTaxEnabled(bool)", "isTaxExempt(address)", "taxCollector()", "setTax(uint256)", "setFees(uint256,uint256)", "buyTax()", "sellTax()", "transferTax()", "setTransferFee(uint256)"],
  admin: ["owner()", "guardian()", "admin()", "getOwner()", "transferOwnership(address)", "renounceOwnership()", "setGuardian(address)"],
  maxTx: ["maxTransactionAmount()", "maxWallet()", "setMaxTx(uint256)", "setMaxWallet(uint256)", "limitsInEffect()"],
};
const SEL_HEX = {};
for (const [k, sigs] of Object.entries(SELECTORS)) SEL_HEX[k] = sigs.map((s) => ({ sig: s, hex: ethers.id(s).slice(2, 10) }));

const VIEW_ABI = [
  "function paused() view returns (bool)",
  "function taxEnabled() view returns (bool)",
  "function owner() view returns (address)",
  "function guardian() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
];

/** Selector groups present in `bytecode` (hex string). */
function scanBytecode(bytecode) {
  const code = String(bytecode || "").toLowerCase();
  const found = {};
  for (const [k, list] of Object.entries(SEL_HEX)) {
    const hits = list.filter((s) => code.includes(s.hex)).map((s) => s.sig);
    if (hits.length) found[k] = hits;
  }
  return found;
}

/** Same groups from a verified ABI (function names), more precise than bytecode. */
function scanAbi(abi) {
  const found = {};
  const names = (Array.isArray(abi) ? abi : []).filter((x) => x.type === "function").map((x) => `${x.name}(${(x.inputs || []).map((i) => i.type).join(",")})`);
  for (const [k, list] of Object.entries(SELECTORS)) {
    const hits = names.filter((n) => list.includes(n) || (k === "tax" && /^(set)?(buy|sell|transfer)?(tax|fee)s?\(/i.test(n) && !/^feeGrowth|^fee\(\)$/.test(n)) || (k === "mint" && /^mint[A-Z]?\w*\(/.test(n)));
    if (hits.length) found[k] = [...new Set(hits)];
  }
  return found;
}

/**
 * Score one token from its gathered facts. Pure, so it is unit-testable.
 * facts: { verified, holders, ageDays, powers: {mint,pause,blacklist,tax,admin,maxTx}, live: {paused, taxEnabled, owner, guardian}, pinnedSafe, metaOk }
 */
function score(facts) {
  const notes = [];
  const p = facts.powers || {};
  const live = facts.live || {};
  if (facts.pinnedSafe) return { level: "safe", badge: "🟢", label: "Safe", notes: ["core token"] };
  let level = "safe";
  const bump = (to) => {
    const rank = { safe: 0, caution: 1, risk: 2 };
    if (rank[to] > rank[level]) level = to;
  };
  if (live.taxEnabled === true) { notes.push("transfer tax on"); bump("risk"); }
  else if (p.tax) { notes.push("transfer tax functions"); bump("caution"); }
  if (live.paused === true) { notes.push("transfers paused"); bump("risk"); }
  else if (p.pause) { notes.push("pausable"); bump("caution"); }
  if (p.mint) { notes.push("mint function"); bump("caution"); }
  if (p.blacklist) { notes.push("blacklist function"); bump("caution"); }
  if (p.maxTx) { notes.push("transfer limits"); bump("caution"); }
  if (live.guardian && live.guardian !== ethers.ZeroAddress) { notes.push("guardian role"); bump("caution"); }
  else if (live.owner && live.owner !== ethers.ZeroAddress) { notes.push("owner-controlled"); bump("caution"); }
  else if (p.admin && !live.owner) { notes.push("admin functions"); }
  if (facts.verified === false) {
    notes.push("source not verified");
    bump(p.mint || p.pause || p.blacklist ? "risk" : "caution");
  } else if (facts.verified == null && facts.metaOk === false) notes.push("verification unknown");
  if (facts.ageDays != null) {
    if (facts.ageDays < 3) { notes.push(`${facts.ageDays.toFixed(1)} days old`); bump(facts.holders != null && facts.holders < 100 ? "risk" : "caution"); }
    else if (facts.ageDays < 30) { notes.push(`${Math.round(facts.ageDays)} days old`); bump("caution"); }
  }
  if (facts.holders != null && facts.holders < 50) { notes.push(`${facts.holders} holders`); bump("caution"); }
  // Unverified AND mint/pause AND tax on: nothing more to say, it is a risk already.
  const badge = level === "risk" ? "🔴" : level === "caution" ? "🟡" : "🟢";
  const label = level === "risk" ? "Risk" : level === "caution" ? "Caution" : "Safe";
  if (!notes.length) notes.push("verified, no admin powers found");
  return { level, badge, label, notes };
}

function create({ provider, cfg, log = console }) {
  let state = { tokens: {} };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {}
  const save = () => {
    try {
      fs.writeFileSync(FILE, JSON.stringify(state));
    } catch {}
  };
  const pinned = new Set([cfg.contracts && cfg.contracts.weth, cfg.usdReference && cfg.usdReference.stable].filter(Boolean).map((a) => a.toLowerCase()));
  let inFlight = null;

  /** Blockscout facts, best effort. Returns { ok, holders, verified, creationTx, abi } */
  async function metadata(addr) {
    const out = { ok: true, holders: null, verified: null, creationTx: null, abi: null };
    const get = async (p) => {
      for (let i = 0; i < 2; i++) {
        try {
          const r = await bsFetch(p, { timeoutMs: 15000 });
          if (r.status === 404) return null;
          const j = await r.json();
          if (r.ok && !j.error) return j;
        } catch {}
        await new Promise((res) => setTimeout(res, 1500));
      }
      out.ok = false;
      return null;
    };
    const [t, a, c] = await Promise.all([get(`/v2/tokens/${addr}`), get(`/v2/addresses/${addr}`), get(`/v2/smart-contracts/${addr}`)]);
    if (t) out.holders = t.holders_count != null ? Number(t.holders_count) : t.holders != null ? Number(t.holders) : null;
    if (a) {
      out.creationTx = a.creation_transaction_hash || a.creation_tx_hash || null;
      if (a.is_verified != null) out.verified = !!a.is_verified;
    }
    if (c) {
      if (c.is_verified != null) out.verified = !!c.is_verified;
      if (Array.isArray(c.abi)) out.abi = c.abi;
      if (c.is_verified === false && !c.abi) out.verified = false;
    } else if (out.verified == null && a && a.is_contract) out.verified = null;
    return out;
  }

  /** Contract age in days from the creation transaction's block. */
  async function ageDays(creationTx) {
    if (!creationTx) return null;
    try {
      const tx = await provider.getTransaction(creationTx);
      if (!tx || tx.blockNumber == null) return null;
      const b = await provider.getBlock(tx.blockNumber);
      return (Date.now() / 1000 - b.timestamp) / 86400;
    } catch {
      return null;
    }
  }

  /** Live reads that are cheap and never revert the whole check. */
  async function liveViews(addr) {
    const c = new ethers.Contract(addr, VIEW_ABI, provider);
    const live = {};
    const tryCall = async (k) => {
      try {
        live[k] = await c[k]();
      } catch {}
    };
    await Promise.all(["paused", "taxEnabled", "owner", "guardian"].map(tryCall));
    if (typeof live.paused === "boolean") live.paused = live.paused;
    return live;
  }

  /** Gather facts for one token address (lowercase) and score it. */
  async function check(addr, symbol) {
    const a = addr.toLowerCase();
    const facts = { address: a, symbol: symbol || null, at: Date.now(), pinnedSafe: pinned.has(a) };
    const code = await provider.getCode(a).catch(() => "0x");
    if (!facts.symbol && code && code !== "0x") {
      try {
        facts.symbol = await new ethers.Contract(a, ["function symbol() view returns (string)"], provider).symbol();
      } catch {}
    }
    facts.isContract = code && code !== "0x";
    facts.powers = facts.isContract ? scanBytecode(code) : {};
    const [live, meta] = await Promise.all([facts.isContract ? liveViews(a) : {}, metadata(a)]);
    facts.live = live;
    facts.metaOk = meta.ok;
    facts.holders = meta.holders;
    facts.verified = meta.verified;
    if (meta.abi) {
      const fromAbi = scanAbi(meta.abi);
      facts.powers = { ...facts.powers, ...fromAbi }; // ABI names win where present
      facts.abiScanned = true;
    }
    facts.ageDays = await ageDays(meta.creationTx);
    facts.creationTx = meta.creationTx;
    const s = score(facts);
    facts.level = s.level;
    facts.badge = s.badge;
    facts.label = s.label;
    facts.notes = s.notes;
    facts.retryAt = meta.ok ? 0 : Date.now() + RETRY_MS;
    return facts;
  }

  /**
   * Refresh every token in `list` ([{address, symbol}]) that is stale. Runs
   * sequentially (Blockscout pacing), at most `budget` fresh checks per call.
   */
  async function refresh(list, budget = 40) {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let n = 0;
      const seen = new Set();
      for (const t of list) {
        if (!t || !t.address || !ethers.isAddress(t.address)) continue;
        const a = t.address.toLowerCase();
        if (seen.has(a)) continue;
        seen.add(a);
        const cur = state.tokens[a];
        const stale = !cur || Date.now() - cur.at > REFRESH_MS || (cur.metaOk === false && Date.now() > (cur.retryAt || 0) && Date.now() - cur.at > RETRY_MS);
        if (!stale) continue;
        if (n >= budget) break;
        try {
          state.tokens[a] = await check(a, t.symbol);
          n++;
          save();
        } catch (err) {
          log.error("token-health:", a.slice(0, 10), err.shortMessage || err.message);
        }
      }
      return n;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function view() {
    const tokens = Object.values(state.tokens).map((t) => ({
      address: t.address, symbol: t.symbol, level: t.level, badge: t.badge, label: t.label, notes: t.notes,
      verified: t.verified, holders: t.holders, ageDays: t.ageDays == null ? null : +t.ageDays.toFixed(1),
      powers: Object.keys(t.powers || {}), live: { paused: t.live && t.live.paused, taxEnabled: t.live && t.live.taxEnabled, owner: t.live && t.live.owner, guardian: t.live && t.live.guardian },
      at: t.at, metaOk: t.metaOk,
    }));
    tokens.sort((x, y) => ({ risk: 0, caution: 1, safe: 2 }[x.level] ?? 3) - ({ risk: 0, caution: 1, safe: 2 }[y.level] ?? 3));
    return { ok: true, at: Date.now(), count: tokens.length, tokens, byAddress: Object.fromEntries(tokens.map((t) => [t.address, t])) };
  }

  return { refresh, view, check, get size() { return Object.keys(state.tokens).length; } };
}

module.exports = { create, score, scanBytecode, scanAbi, SELECTORS };
