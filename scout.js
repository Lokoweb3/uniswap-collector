/**
 * Pool scout: once an hour, compare every open position's pool with the other
 * pools of the same pair on the scanner (GeckoTerminal-backed, :3847), and
 * when another pool's 24h fee APR beats the position's pool by 50% or more on
 * two consecutive daily checks, say so once on Telegram. State (streaks and
 * what was already reported) lives in pool-scout-state.json, every
 * observation in pool-scout-log.json.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const SCANNER = process.env.LP_SCANNER_URL || "http://127.0.0.1:3847";
const STATE_FILE = path.join(__dirname, "pool-scout-state.json");
const LOG_FILE = path.join(__dirname, "pool-scout-log.json");
const BETTER_BY = 1.5; // candidate APR must be ≥ 1.5 × ours
const DAYS_REQUIRED = 2; // on two consecutive daily checks
const MIN_TVL = 5000; // ignore dust pools
const DAY = 86400 * 1000;

function create({ cfg, send, log = console, now = () => Date.now() }) {
  const WETH = (cfg.contracts.weth || "").toLowerCase();
  const norm = (a) => {
    const x = String(a || "").toLowerCase();
    return x === ethers.ZeroAddress || x === WETH ? "eth" : x;
  };
  const pairKey = (a, b) => [norm(a), norm(b)].sort().join("|");
  let state = { streaks: {}, reported: {} };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
  } catch {}
  const save = () => {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch {}
  };
  const appendLog = (row) => {
    let rows = [];
    try {
      rows = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
    } catch {}
    rows.push(row);
    if (rows.length > 2000) rows = rows.slice(-2000);
    try {
      fs.writeFileSync(LOG_FILE, JSON.stringify(rows, null, 1));
    } catch {}
  };

  async function fetchPools() {
    const r = await fetch(`${SCANNER}/api/pools`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const byPair = new Map();
    for (const p of j.pools || []) {
      if (!p.base || !p.quote || !(p.tvl > MIN_TVL)) continue;
      const apr = p.apr24h ?? (p.fees24h != null && p.tvl > 0 ? (p.fees24h / p.tvl) * 365 * 100 : null);
      if (apr == null) continue;
      const k = pairKey(p.base.address, p.quote.address);
      if (!byPair.has(k)) byPair.set(k, []);
      byPair.get(k).push({ key: String(p.key).toLowerCase(), name: p.name, version: p.version, feePct: p.feePct, tvl: p.tvl, apr });
    }
    return byPair;
  }

  /**
   * `positions`: [{ wallet, tokenId, pair, version, poolAddress, token0, token1, pool: {aprPct} }].
   * Returns the alerts sent this run.
   */
  async function check(positions) {
    let byPair;
    try {
      byPair = await fetchPools();
    } catch (err) {
      log.error("scout: scanner unavailable:", err.shortMessage || err.message);
      return [];
    }
    const sent = [];
    const t = now();
    const dayKey = Math.floor(t / DAY);
    for (const p of positions) {
      if (!p.token0 || !p.token1) continue;
      const own = p.pool && p.pool.aprPct != null ? p.pool.aprPct : null;
      const myKey = `v${p.version === 4 ? 4 : 3}:${String(p.poolAddress).toLowerCase()}`;
      const cands = (byPair.get(pairKey(p.token0, p.token1)) || []).filter((c) => c.key !== myKey);
      if (!cands.length || own == null || own <= 0) continue;
      const best = cands.sort((a, b) => b.apr - a.apr)[0];
      const id = `${p.wallet}:${p.tokenId}:${best.key}`;
      const streak = state.streaks[id] || { days: 0, lastDay: null };
      const beats = best.apr >= own * BETTER_BY;
      if (beats) {
        if (streak.lastDay !== dayKey) {
          streak.days = streak.lastDay === dayKey - 1 ? streak.days + 1 : 1;
          streak.lastDay = dayKey;
        }
      } else {
        streak.days = 0;
        streak.lastDay = null;
      }
      state.streaks[id] = streak;
      appendLog({ t, wallet: p.wallet, tokenId: p.tokenId, pair: p.pair, ownApr: own, best: best.name, bestApr: best.apr, bestTvl: best.tvl, beats, streakDays: streak.days });
      if (beats && streak.days >= DAYS_REQUIRED && (!state.reported[id] || t - state.reported[id] > 7 * DAY)) {
        const msg = `💡 ${best.name.replace(/ \/ /g, "/")} ${best.version} (${best.apr.toFixed(0)}% APR, TVL $${Math.round(best.tvl).toLocaleString("en-US")}) beats your ${p.pair.replace(/ \/ /g, "/")} (${own.toFixed(0)}%) for ${streak.days} days · ${p.wallet} #${p.tokenId}`;
        try {
          if (await send(msg)) {
            state.reported[id] = t;
            sent.push(msg);
          }
        } catch (err) {
          log.error("scout: send failed:", err.message);
        }
      }
    }
    save();
    return sent;
  }

  return { check, get state() { return state; } };
}

module.exports = { create };
