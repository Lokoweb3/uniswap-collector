/**
 * Exit rules: risk triggers evaluated every five minutes over every open
 * position (main wallet + watched wallets), with two possible actions:
 *
 *   alert  -> Telegram message
 *   close  -> decrease 100% liquidity and take everything to the OWNER wallet,
 *             signed by the operator (close-position.js), logged to exit-log.json
 *
 * Rule types (config.json `exitRules`):
 *   priceDropPct1h { threshold, pairs, action }   price down >= threshold % vs 1h ago
 *   outOfRange     { durationMinutes, pairs, action }  out of range for that long
 *   tvlDrop        { threshold, pairs, action }   pool active liquidity down >= threshold % vs its 24h max
 * `pairs` match either token order, case- and space-insensitive; "*" = all.
 *
 * Per-position overrides (config.json `exitRuleOverrides[tokenId]`):
 *   { enabled, priceDropPct1h, outOfRangeMinutes, tvlDropPct }
 * A "close" only executes when the position's override says enabled: true
 * AND close-position.js is present AND the collector is armed. Otherwise the
 * rule degrades to an alert that says why. Every trigger fires once per
 * episode (state in exit-state.json) and a close is attempted once per
 * position.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const STATE_FILE = path.join(__dirname, "exit-state.json");
const LOG_FILE = path.join(__dirname, "exit-log.json");
const HISTORY_MS = 24 * 3600 * 1000; // price / TVL samples kept
const CACHE_FILE = `/dev/shm/.lp-collector-${typeof process.getuid === "function" ? process.getuid() : 0}`;

/** "ETH / LAPTOP", "LAPTOP/ETH", "laptop / eth" -> "eth|laptop" */
function pairKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean)
    .sort()
    .join("|");
}
function pairsMatch(rulePairs, pair) {
  if (!Array.isArray(rulePairs) || !rulePairs.length) return false;
  if (rulePairs.includes("*")) return true;
  const k = pairKey(pair);
  return rulePairs.some((p) => pairKey(p) === k);
}

function loadCloseModule() {
  try {
    return require("./close-position");
  } catch {
    return null;
  }
}

/** Operator signer from the RAM cache the collector uses; null when locked. */
function operatorSigner(provider) {
  try {
    const ttl = Number(fs.readFileSync(`${CACHE_FILE}.ttl`, "utf8"));
    if (!(ttl > Date.now() / 1000)) return null;
    const pass = fs.readFileSync(CACHE_FILE, "utf8");
    const ksPath = process.env.LP_KEYSTORE_PATH || path.join(process.env.HOME || "", ".lp-collector", "operator-keystore.json");
    const json = fs.readFileSync(ksPath, "utf8");
    return ethers.Wallet.fromEncryptedJson(json, pass).then((w) => w.connect(provider));
  } catch {
    return null;
  }
}

function create({ provider, cfg, alerts, getPositions, getWatched, log = console, now = () => Date.now(), closeModule, signerFactory, stateFile = STATE_FILE, logFile = LOG_FILE, readConfig } = {}) {
  let state = { prices: {}, tvls: {}, outSince: {}, fired: {}, closed: {}, lastRun: null, lastEval: {} };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) };
  } catch {}
  const save = () => {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(state));
    } catch {}
  };
  const closer = closeModule !== undefined ? closeModule : loadCloseModule();
  const getSigner = signerFactory || (() => operatorSigner(provider));
  const currentConfig = () => (readConfig ? readConfig() : cfg);

  const rules = () => (currentConfig().exitRules || []).filter((r) => r && r.type);
  const overrides = () => currentConfig().exitRuleOverrides || {};

  /** Effective thresholds for one position: rule values, overridden per token id. */
  function ruleSet(tokenId) {
    const o = overrides()[String(tokenId)] || {};
    return { enabled: o.enabled === true, priceDropPct1h: o.priceDropPct1h, outOfRangeMinutes: o.outOfRangeMinutes, tvlDropPct: o.tvlDropPct };
  }

  /** Every open position, main and watched, in one shape. */
  function allPositions() {
    const out = [];
    const main = getPositions ? getPositions() : null;
    if (main && Array.isArray(main.positions)) {
      for (const p of main.positions) out.push({ ...p, wallet: main.ownerLabel || "Main", walletAddress: main.owner, main: true });
    }
    for (const w of (getWatched ? getWatched() : null) || []) {
      if (!w || !w.ok) continue;
      for (const p of w.positions || []) out.push({ ...p, wallet: w.label || w.address, walletAddress: w.address, main: false });
    }
    return out;
  }

  // Watched v4 positions carry tokenId "v4-<id>"; config overrides and logs use the bare NFT id.
  const idOf = (p) => String(p.nftId || p.tokenId).replace(/^v4-/, "");
  const key = (p) => `${String(p.walletAddress || "").toLowerCase()}:${idOf(p)}`;

  /** Push a sample and return the value nearest to `ago` ms back (null when history is too short). */
  function sample(map, k, value, t) {
    if (value == null || !isFinite(value)) return;
    const arr = (map[k] = map[k] || []);
    arr.push({ t, v: value });
    const cut = t - HISTORY_MS;
    while (arr.length && arr[0].t < cut) arr.shift();
  }
  function valueAgo(map, k, t, agoMs) {
    const arr = map[k] || [];
    const target = t - agoMs;
    let best = null;
    for (const s of arr) {
      if (s.t > target + 5 * 60 * 1000) break; // samples are chronological
      if (!best || Math.abs(s.t - target) < Math.abs(best.t - target)) best = s;
    }
    return best && Math.abs(best.t - target) <= 20 * 60 * 1000 ? best.v : null;
  }
  function maxRecent(map, k) {
    const arr = map[k] || [];
    return arr.length ? Math.max(...arr.map((s) => s.v)) : null;
  }

  async function fire(p, rule, trigger, detail, msg) {
    const fk = `${key(p)}:${rule.type}:${rule.action}:${trigger}`;
    if (state.fired[fk]) return null; // once per episode
    state.fired[fk] = now();
    save();
    const wantClose = rule.action === "close";
    const rs = ruleSet(idOf(p));
    let text, closed = null;
    if (wantClose && rs.enabled && closer && !state.closed[key(p)]) {
      const signer = await getSigner();
      if (!signer) {
        text = `🚨 ${p.pair} ${detail} — exit rule wants to CLOSE but the collector is locked; arm it at /arm or close by hand.`;
      } else {
        state.closed[key(p)] = now();
        save();
        try {
          const fn = Number(p.version) === 4 ? closer.closeV4 : closer.closeV3;
          if (typeof fn !== "function") throw new Error("close module has no close function for v" + p.version);
          const r = await fn({ provider, cfg: currentConfig(), tokenId: idOf(p), owner: p.walletAddress, wallet: signer });
          closed = { txHash: r && (r.hash || r.txHash) || null, recovered: r && r.recovered || null };
          appendLog({ timestamp: new Date(now()).toISOString(), wallet: p.wallet, tokenId: idOf(p), pair: p.pair, rule: rule.type, trigger, txHash: closed.txHash, recovered: closed.recovered });
          text = `🚨 Auto-closed ${p.pair} — ${detail}${closed.recovered ? ` — recovered ${closed.recovered}` : ""}${closed.txHash ? ` (${String(closed.txHash).slice(0, 12)}…)` : ""}`;
        } catch (err) {
          text = `❌ ${p.pair} ${detail} — auto-close FAILED: ${err.shortMessage || err.message}. Close by hand.`;
          appendLog({ timestamp: new Date(now()).toISOString(), wallet: p.wallet, tokenId: idOf(p), pair: p.pair, rule: rule.type, trigger, error: err.shortMessage || err.message });
        }
      }
    } else if (wantClose) {
      const why = !closer ? "close module unavailable" : !rs.enabled ? "auto-close is off for this position (enable it on the card)" : "already closed by a rule";
      text = `🚨 ${p.pair} ${detail} — exit rule (close, not executed: ${why})`;
    } else {
      text = msg || `🚨 ${p.pair} ${detail} — exit rule (alert)`;
    }
    if (alerts && typeof alerts.send === "function") {
      try {
        await alerts.send(text);
      } catch (err) {
        log.error && log.error("exit-rules: telegram", err.message);
      }
    }
    log.log && log.log("exit-rules:", text);
    return text;
  }

  function appendLog(entry) {
    let rows = [];
    try {
      rows = JSON.parse(fs.readFileSync(logFile, "utf8"));
      if (!Array.isArray(rows)) rows = [];
    } catch {}
    rows.push(entry);
    try {
      fs.writeFileSync(logFile, JSON.stringify(rows, null, 1));
    } catch {}
  }

  /** One evaluation pass. Returns the messages sent. */
  async function evaluate() {
    const t = now();
    const sent = [];
    const positions = allPositions();
    const seen = new Set();
    for (const p of positions) {
      const k = key(p);
      seen.add(k);
      const rs = ruleSet(idOf(p));
      // Samples: price (token1 per token0 as the payload gives it) and pool active liquidity.
      sample(state.prices, k, Number(p.priceCurrent), t);
      const tvl = p.pool && p.pool.tvl != null ? Number(p.pool.tvl) : null;
      if (tvl != null) sample(state.tvls, k, tvl, t);
      // Out-of-range clock: the range log for the main wallet, our own timestamps otherwise.
      let outSince = null;
      if (!p.inRange) {
        if (p.main && p.range && p.range.streakInRange === false && p.range.streakSince) outSince = p.range.streakSince;
        else {
          if (!state.outSince[k]) state.outSince[k] = t;
          outSince = state.outSince[k];
        }
      } else {
        delete state.outSince[k];
        for (const fk of Object.keys(state.fired)) if (fk.startsWith(k + ":outOfRange:")) delete state.fired[fk]; // episode over
      }
      const evalRec = { t, pair: p.pair, wallet: p.wallet, inRange: !!p.inRange, outMinutes: outSince ? Math.round((t - outSince) / 60000) : 0, drop1hPct: null, tvlDropPct: null, fired: [] };
      const price1h = valueAgo(state.prices, k, t, 3600 * 1000);
      if (price1h != null && price1h > 0 && p.priceCurrent != null) {
        // Prices are token1 per token0; for a "memecoin per ETH" pool a rising number means the coin fell.
        // Use the position's own value direction instead: drop = fall of the token that is not ETH/WETH/USDG.
        evalRec.drop1hPct = dropPct(p, price1h, Number(p.priceCurrent));
      }
      const tvlMax = maxRecent(state.tvls, k);
      if (tvl != null && tvlMax > 0) evalRec.tvlDropPct = ((tvlMax - tvl) / tvlMax) * 100;

      for (const rule of rules()) {
        if (!pairsMatch(rule.pairs, p.pair)) continue;
        if (rule.type === "priceDropPct1h") {
          const th = Number(rs.priceDropPct1h != null && rule.action === "alert" ? rs.priceDropPct1h : rule.threshold);
          if (evalRec.drop1hPct != null && evalRec.drop1hPct >= th) {
            const r = await fire(p, rule, `drop1h`, `dropped ${evalRec.drop1hPct.toFixed(0)}% in 1h`, `🚨 ${p.pair} dropped ${evalRec.drop1hPct.toFixed(0)}% in 1h — exit rule (alert)`);
            if (r) { sent.push(r); evalRec.fired.push(rule.type); }
          } else if (evalRec.drop1hPct != null && evalRec.drop1hPct < th * 0.5) {
            delete state.fired[`${k}:${rule.type}:${rule.action}:drop1h`]; // recovered: a new episode may fire again
          }
        } else if (rule.type === "outOfRange") {
          const mins = Number(rs.outOfRangeMinutes != null ? rs.outOfRangeMinutes : rule.durationMinutes);
          if (outSince && t - outSince >= mins * 60000) {
            const r = await fire(p, rule, `out`, `out of range for ${Math.round((t - outSince) / 60000)} min`, `🔴 ${p.pair} out of range for ${Math.round((t - outSince) / 60000)} min — exit rule (alert)`);
            if (r) { sent.push(r); evalRec.fired.push(rule.type); }
          }
        } else if (rule.type === "tvlDrop") {
          const th = Number(rs.tvlDropPct != null ? rs.tvlDropPct : rule.threshold);
          if (evalRec.tvlDropPct != null && evalRec.tvlDropPct >= th) {
            const r = await fire(p, rule, `tvl`, `pool liquidity down ${evalRec.tvlDropPct.toFixed(0)}% from its 24h high`, `⚠️ ${p.pair} pool liquidity down ${evalRec.tvlDropPct.toFixed(0)}% from its 24h high — LPs leaving (exit rule alert)`);
            if (r) { sent.push(r); evalRec.fired.push(rule.type); }
          } else if (evalRec.tvlDropPct != null && evalRec.tvlDropPct < th * 0.5) {
            delete state.fired[`${k}:${rule.type}:${rule.action}:tvl`];
          }
        }
      }
      state.lastEval[k] = evalRec;
    }
    // Positions that disappeared (closed) drop their state.
    for (const m of ["outSince", "lastEval"]) for (const k of Object.keys(state[m])) if (!seen.has(k)) delete state[m][k];
    state.lastRun = t;
    save();
    return sent;
  }

  /**
   * Percentage fall of the non-quote token between two token1-per-token0 prices.
   * ETH/WETH/USDG count as the quote; if token0 is the quote, the price is
   * "coin per quote" and a rise means the coin fell.
   */
  function dropPct(p, before, after) {
    const quote = /^(eth|weth|usdg)$/i;
    const token0IsQuote = quote.test(p.symbol0 || "");
    const token1IsQuote = quote.test(p.symbol1 || "");
    let ratio;
    if (token1IsQuote && !token0IsQuote) ratio = after / before; // quote per coin: falling number = coin fell
    else if (token0IsQuote && !token1IsQuote) ratio = before / after; // coin per quote: rising number = coin fell
    else ratio = after / before;
    return (1 - ratio) * 100;
  }

  /** Config + state for the dashboard. */
  function view() {
    const cfgNow = currentConfig();
    return { ok: true, rules: cfgNow.exitRules || [], overrides: cfgNow.exitRuleOverrides || {}, closeAvailable: !!closer, lastRun: state.lastRun, lastEval: state.lastEval, closed: state.closed };
  }

  /** Persist a per-position override into config.json. */
  function setOverride(configPath, tokenId, patch) {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    raw.exitRuleOverrides = raw.exitRuleOverrides || {};
    const cur = raw.exitRuleOverrides[String(tokenId)] || {};
    const next = { ...cur };
    if (patch.enabled != null) next.enabled = !!patch.enabled;
    for (const kname of ["priceDropPct1h", "outOfRangeMinutes", "tvlDropPct"]) {
      if (patch[kname] === null) delete next[kname];
      else if (patch[kname] != null && isFinite(Number(patch[kname]))) next[kname] = Number(patch[kname]);
    }
    raw.exitRuleOverrides[String(tokenId)] = next;
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
    if (cfg) cfg.exitRuleOverrides = raw.exitRuleOverrides;
    return next;
  }

  return { evaluate, view, setOverride, pairsMatch, dropPct, get state() { return state; } };
}

module.exports = { create, pairsMatch, pairKey };
