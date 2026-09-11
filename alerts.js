/**
 * Telegram alerts, driven from the dashboard's background tick.
 *
 * Conditions (each deduplicated in alerts-state.json so a standing problem is
 * reported once, then again only after ALERT_REPEAT_MS):
 *   - a position left its range (and when it comes back)
 *   - the scheduled collect failed, or was skipped because the collector was locked
 *   - the collector is still locked shortly before the 09:00 run
 *   - the 09:00 run did not happen at all
 *   - the Windows keepalive session is gone (WSL will stop with the last terminal)
 *   - the dashboard was down (reported on the first tick after it comes back)
 *
 * Pool cool-down (shared across sources): the guardian, the range check here and
 * the auto-collect summary all talk about the same pools. sendPool(poolKey, text)
 * lets one message per pool through per POOL_COOLDOWN_MS whoever sends it; the
 * rest are held (logged, counted in state.held). Messages marked urgent (a dump,
 * a close-now, a close result) always go through. settings.json
 * alerts.poolCooldownMinutes changes the window (default 30).
 *
 * Secrets: the bot token comes from process.env.TELEGRAM_TOKEN and is used only
 * to build the request URL; it is never logged or written anywhere. Messages
 * carry short addresses (0x1234…5678) only.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const STATE_FILE = path.join(__dirname, "alerts-state.json");
const ALERT_REPEAT_MS = 6 * 3600 * 1000; // re-remind about a standing problem
const POOL_COOLDOWN_MS = 30 * 60 * 1000; // one message per pool per window, across every source
const DOWN_GAP_MS = 25 * 60 * 1000; // ticks are 10 min apart; a larger gap = outage
const COLLECT_HOUR = 9; // local time of the scheduled run (windows-task.ps1)
const WARN_HOUR = 8; // remind about a locked collector from this hour

const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "?");

// Chat ids: the environment wins, else settings.json `alerts` (telegramChat = group, fallbackChat = personal, treasuryChat).
let CHATS = {};
try { CHATS = require("./settings").load().alerts || {}; } catch {}
const TREASURY_CHAT = process.env.TELEGRAM_TREASURY_CHAT_ID || CHATS.treasuryChat || "";
const TREASURY_BALANCE_ALERT_USDG = 1000; // default; settings.json vault.withdrawAlertUsdg overrides (passed as treasury.withdrawAlertUsdg)

function create({ token, chatId, treasuryChatId = TREASURY_CHAT, transport, stateFile = STATE_FILE, now = () => Date.now(), log = console, onSent = null, poolCooldownMs = null } = {}) {
  if (token === undefined && !Object.keys(arguments[0] || {}).includes('token')) token = process.env.TELEGRAM_TOKEN;
  chatId = chatId !== undefined ? chatId : (process.env.TELEGRAM_CHAT_ID || CHATS.fallbackChat || "");
  const poolWindow = poolCooldownMs != null ? Number(poolCooldownMs) : Number(CHATS.poolCooldownMinutes) > 0 ? Number(CHATS.poolCooldownMinutes) * 60000 : POOL_COOLDOWN_MS;
  let state = { sent: {}, outSince: {}, lastTick: 0, lastRunSeen: null, pool: {}, held: {} };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) };
  } catch {}
  const save = () => {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(state));
    } catch {}
  };

  const enabled = !!(token && chatId && token !== 'undefined' && chatId !== 'undefined') || !!transport;

  /** Deliver one message to `to` (default chat). Returns true when it was sent. */
  async function send(text, to = chatId) {
    const ok = await deliver(text, to);
    if (ok && onSent) { try { onSent(text, to); } catch {} } // the agent remembers what was said on that chat
    return ok;
  }
  async function deliver(text, to) {
    if (transport) return transport(text, to);
    if (!token || !to) return false;
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: to, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      log.error(`telegram: sendMessage HTTP ${r.status}`);
      return false;
    }
    return true;
  }

  /** Group messages (per-position guardian rules) go to TELEGRAM_GROUP_CHAT_ID, else the treasury chat, falling back to the main chat. */
  const groupChatId = process.env.TELEGRAM_GROUP_CHAT_ID || CHATS.telegramChat || treasuryChatId;
  async function sendGroup(text) {
    if (groupChatId && groupChatId !== chatId && (await send(text, groupChatId))) return true;
    return send(text, chatId);
  }

  /** Treasury messages go to the treasury chat; if that chat is unreachable they fall back to the main chat. */
  async function sendTreasury(text) {
    if (treasuryChatId && treasuryChatId !== chatId && (await send(text, treasuryChatId))) return true;
    return send(text, chatId);
  }

  /**
   * Send `text` about one pool unless any source already sent about that pool
   * within the window. `urgent` bypasses the window. Returns true when sent;
   * false when held (the caller decides whether to retry later).
   */
  async function sendPool(poolKey, text, { source = "?", urgent = false, every = poolWindow, deliver = send } = {}) {
    const k = String(poolKey || "?");
    const last = state.pool[k];
    if (!urgent && last && now() - last.at < every) {
      state.held[k] = (state.held[k] || 0) + 1;
      save();
      log.log && log.log(`alerts: held (${source}, pool cool-down ${Math.round((every - (now() - last.at)) / 60000)} min left after ${last.source}) ${text.replace(/\n/g, " / ").slice(0, 120)}`);
      return false;
    }
    const ok = await deliver(text);
    if (ok) {
      state.pool[k] = { at: now(), source };
      delete state.held[k];
      save();
    }
    return ok;
  }

  /** Send `text` for `key` unless the same key was sent within `every` ms (0 = once, ever). */
  async function once(key, text, every = ALERT_REPEAT_MS, deliver = send) {
    const last = state.sent[key] || 0;
    if (last && (every === 0 || now() - last < every)) return false;
    const ok = await deliver(text);
    if (ok) {
      state.sent[key] = now();
      save();
    }
    return ok;
  }

  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

  /** Is the Windows keepalive still holding the distro open? (it runs `sleep infinity`) */
  function keepaliveAlive() {
    try {
      const out = execFileSync("pgrep", ["-f", "^sleep infinity$"], { encoding: "utf8" });
      return out.trim().length > 0;
    } catch {
      return false; // pgrep exits 1 when nothing matches
    }
  }

  /**
   * Evaluate every condition. `payload` is the dashboard's position payload,
   * `ops` is opsInfo() (last run + gas), `unlock` is unlockState().
   * `keepalive` overrides the pgrep check (tests). Returns the messages sent.
   */
  async function check({ payload, watched, ops, unlock, keepalive, treasury, loops } = {}) {
    const sent = [];
    const say = async (key, text, every, deliver) => {
      if (await once(key, text, every, deliver)) sent.push(text);
    };
    const t = now();
    const d = new Date(t);

    // Outage: first tick after a long gap.
    if (state.lastTick && t - state.lastTick > DOWN_GAP_MS) {
      const mins = Math.round((t - state.lastTick) / 60000);
      await say(`down:${state.lastTick}`, `⚠️ Dashboard was down for about ${mins} min (last tick ${new Date(state.lastTick).toLocaleString()}). WSL restart or keepalive task?`, 0);
    }
    state.lastTick = t;
    save();

    // Keepalive session.
    const alive = keepalive != null ? keepalive : keepaliveAlive();
    if (!alive) await say("keepalive", "⚠️ The Windows keepalive session is not running. WSL will stop (and the dashboard with it) when the last terminal closes. Re-register 'LP Dashboard Keepalive' from PowerShell.");
    else delete state.sent.keepalive;

    // Positions leaving / re-entering range: the main wallet (state keys are
    // the bare tokenId, as before) and every watched wallet (keys prefixed by
    // the wallet address so two wallets' ids never collide).
    const walletSets = [];
    if (payload && Array.isArray(payload.positions)) walletSets.push({ prefix: "", label: payload.ownerLabel || null, positions: payload.positions });
    for (const w of Array.isArray(watched) ? watched : []) {
      if (!w || !w.ok || !Array.isArray(w.positions) || !w.address) continue;
      walletSets.push({ prefix: `${w.address.toLowerCase()}:`, label: w.label || short(w.address), positions: w.positions });
    }
    if (walletSets.length) {
      const seen = new Set();
      for (const ws of walletSets) {
        for (const p of ws.positions) {
          const id = `${ws.prefix}${p.tokenId}`;
          seen.add(id);
          const name = `${ws.label ? ws.label + " · " : ""}${p.pair || "?"} #${p.nftId || p.tokenId}`;
          const viaPool = (text) => sendPool(poolKeyOf(p, ws.prefix), text, { source: "range" });
          const viaPoolUrgent = (text) => sendPool(poolKeyOf(p, ws.prefix), text, { source: "range", urgent: true });
          if (!p.inRange) {
            if (!state.outSince[id]) { state.outSince[id] = t; save(); }
            // Held by the pool cool-down? The key carries the episode start, so the next tick tries again.
            const dir = p.rawPos > 1 ? "above" : "below";
            await say(`out:${id}:${state.outSince[id]}`, `🔴 ${name} is out of range (price ${dir} the range) — not earning. Value ${usd(p.valueUsd)}, uncollected ${usd(p.feesUsd)}.`, 0, viaPool);
          } else if (state.outSince[id]) {
            const since = state.outSince[id];
            const hrs = ((t - since) / 3600000).toFixed(1);
            if (await once(`in:${id}:${since}`, `🟢 ${name} is back in range after ${hrs} h.`, 0, viaPoolUrgent)) { sent.push(`🟢 ${name} is back in range after ${hrs} h.`); delete state.outSince[id]; save(); }
          }
        }
      }
      // Forget positions that closed while out. A watched wallet that failed to
      // load this tick keeps its entries so a transient error does not reset them.
      const loadedPrefixes = new Set(walletSets.map((ws) => ws.prefix));
      for (const id of Object.keys(state.outSince)) {
        const prefix = id.includes(":") ? id.slice(0, id.indexOf(":") + 1) : "";
        if (loadedPrefixes.has(prefix) && !seen.has(id)) delete state.outSince[id];
      }
    }

    // Scheduled collect: failed, skipped as locked, or missing.
    const run = ops && ops.lastRun;
    if (run && run.t && run.t !== state.lastRunSeen) {
      state.lastRunSeen = run.t;
      save();
      if (/failed|aborted/i.test(run.result || "")) {
        const per = Array.isArray(run.failures) && run.failures.length
          ? ` Wallets with failures: ${run.failures.map((f) => `${f.wallet} (${f.count})`).join(", ")}.`
          : "";
        await say(`runfail:${run.t}`, `❌ Collect run at ${run.t} (${run.mode}): ${run.result}.${per} See collector.log.`, 0);
      }
      else if (/locked/i.test(run.result || "")) await say(`runlocked:${run.t}`, `🔒 Collect run at ${run.t} was skipped: the collector was locked. Arm it (Arm collector on the dashboard, or ./unlock.sh) before tomorrow's ${COLLECT_HOUR}:00 run.`, 0);
    }
    const hour = d.getHours();
    if (hour >= COLLECT_HOUR && hour < COLLECT_HOUR + 1 && d.getMinutes() >= 30) {
      const ranToday = run && run.t && sameDay(parseRunTime(run.t), d) && parseRunTime(run.t).getHours() >= COLLECT_HOUR - 1;
      if (!ranToday) await say(`missed:${dayKey(d)}`, `⚠️ No collect run seen today after ${COLLECT_HOUR}:00. Is the Windows scheduled task 'LP fee collector' still registered?`, 0);
    }

    // Arm window lost to a restart (the RAM cache is gone but the window had not expired).
    if (unlock && unlock.lost) {
      await say(`lost:${unlock.until}`, `⚠️ The collector's arm window (until ${new Date(unlock.until).toLocaleString()}) was lost: the RAM cache was cleared, most likely by a WSL restart. Re-arm at http://127.0.0.1:8787/arm.`, 0);
    }

    // Background loops (guardian, auto-collect): alert when a loop stops writing, and once when it is back.
    if (loops) {
      for (const [name, l] of Object.entries(loops)) {
        const k = `loop:${name}`;
        if (l.stale) {
          if (!state.sent[k]) await say(k, `⚠️ The ${l.label} has not reported for ${l.ageMin == null ? "ever (never started?)" : Math.round(l.ageMin) + " min"}. It should write every ${l.staleAfterMin >= 45 ? "15" : "1"} min. Check server.log.`, 0);
        } else if (state.sent[k]) {
          delete state.sent[k];
          delete state.sent[`${k}:back:${t}`];
          save();
          await say(`${k}:back:${t}`, `✅ The ${l.label} is reporting again.`, 0);
        }
      }
    }

    // LOKOVault treasury: repeated failed splits, a balance worth withdrawing, a changed split percentage.
    if (treasury) {
      if (treasury.consecutiveFailures >= 3) {
        await say(`vaultfail:${treasury.consecutiveFailures}`, `❌ LOKOVault: the treasury transfer failed ${treasury.consecutiveFailures} times in a row (the wallets received the full amounts). Check treasuryTBA in settings.json and the TBA contract.`, 0, sendTreasury);
      }
      const level = Number(treasury.withdrawAlertUsdg) > 0 ? Number(treasury.withdrawAlertUsdg) : TREASURY_BALANCE_ALERT_USDG;
      if (treasury.balanceUsdg != null && treasury.balanceUsdg >= level) {
        await say(`vaultbalance:${level}`, `💰 LOKOVault holds ${treasury.balanceUsdg.toFixed(2)} USDG (≥ ${level}). Time to withdraw from the vault.`, ALERT_REPEAT_MS, sendTreasury);
      }
      if (treasury.pct != null) {
        if (state.lastSplitPct != null && state.lastSplitPct !== treasury.pct) {
          await say(`vaultpct:${treasury.pct}:${t}`, `⚙️ LOKOVault fee split changed: ${state.lastSplitPct}% → ${treasury.pct}% (${treasury.pctSource || "config"}).`, 0, sendTreasury);
        }
        state.lastSplitPct = treasury.pct;
        save();
      }
    }

    // Locked collector ahead of the run.
    if (unlock && !unlock.armed && hour >= WARN_HOUR && hour < COLLECT_HOUR) {
      await say(`locked:${dayKey(d)}`, `🔒 The collector is locked; the ${COLLECT_HOUR}:00 collect will skip. Arm it from the dashboard or run ./unlock.sh.`, 0);
    }

    return sent;
  }

  return { enabled, send, sendGroup, sendTreasury, sendPool, poolKeyOf, check, poolWindow, get state() { return state; } };
}

/**
 * The pool a position row belongs to ("v4:0x…" / "v3:0x…" from the dashboard
 * payload), else the position itself scoped by its wallet (v3 and v4 ids can
 * collide across wallets; `scope` is the wallet prefix when the row lacks one).
 */
function poolKeyOf(p, scope = null) {
  if (!p) return "?";
  if (p.pool && p.pool.key) return String(p.pool.key);
  if (p.poolKey) return String(p.poolKey);
  if (p.poolAddress) return `v${Number(p.version) === 4 ? 4 : 3}:${String(p.poolAddress).toLowerCase()}`; // the payload's pool id / address
  const s = scope != null ? scope : p.walletAddress ? `${String(p.walletAddress).toLowerCase()}:` : "";
  return `pos:${s}${String(p.nftId || p.tokenId || "?").replace(/^v4-/, "")}`;
}

function usd(n) {
  return n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/** collector.log stamps look like "2026-09-06T09:00:04" or "Sep 6, 09:00 AM"; be lenient. */
function parseRunTime(s) {
  const d = new Date(String(s).replace(/^\[|\]$/g, ""));
  return isNaN(d) ? new Date(0) : d;
}
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

module.exports = { create, short, poolKeyOf, POOL_COOLDOWN_MS };
