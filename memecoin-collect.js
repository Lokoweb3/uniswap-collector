#!/usr/bin/env node
/**
 * memecoin-collect.js — collect memecoin fees as soon as they are worth it.
 *
 * Every 15 minutes (a timer inside server.js): from the dashboard's own
 * position data, find memecoin positions (every v4 position in the main
 * wallet and the collected watched wallets, plus settings.json `risk.memecoins` ids)
 * whose uncollected fees exceed `memecoinCollect.minUsd` (default $20), and
 * run `./run-collector.sh full --quiet` — the normal collector, which handles
 * every wallet and the LOKOVault split — instead of waiting for the 09:00 run.
 * At most one auto run per `minIntervalMinutes`.
 *
 * The collector only signs while armed; when it is locked this sends one
 * Telegram nudge per lock episode (then at most every 6 h) and tries again
 * next cycle. Runs are logged to memecoin-collect-log.json.
 *
 * First-split verification: until fee-split-ledger.json holds its first "ok"
 * entry, check every cycle; then confirm the TBA's USDG balance, the owner
 * transfer in the tx receipt and the treasury view, and send one "verified" note.
 *
 * In-process: create({ dir, positions, watched, treasury, alerts, log }).cycle()
 * Standalone (reads the running dashboard over HTTP):
 *   node memecoin-collect.js --once             # one evaluation
 *   node memecoin-collect.js --once --dry-run   # evaluate, never run the collector
 *   --port=8787   dashboard port (or LP_DASHBOARD_PORT)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ethers } = require("ethers");

const HERE = __dirname;
const LOG_FILE = path.join(HERE, "memecoin-collect-log.json");
const STATE_FILE = path.join(HERE, "memecoin-collect-state.json");
const LEDGER_FILE = path.join(HERE, "fee-split-ledger.json");
const LOCKED_REPEAT_MS = 6 * 3600 * 1000;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const USDG_DECIMALS = 6;
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const argv = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || "").split("=")[1] || d;
const PORT = Number(argv("port", process.env.LP_DASHBOARD_PORT || 8787));
const BASE = `http://127.0.0.1:${PORT}`;

function stamp(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
}

function loadConfig() {
  let cfg = {}; try { cfg = require("./settings").load(); } catch {}
  const mc = cfg.memecoinCollect || {};
  return {
    cfg,
    enabled: mc.enabled !== false,
    minUsd: Number(mc.minUsd ?? 20),
    minIntervalMinutes: Number(mc.minIntervalMinutes ?? 30),
    memecoins: Array.isArray(cfg.memecoins) ? cfg.memecoins : null,
    tradingLabel: mc.tradingWalletLabel || "Trading",
  };
}

// ---------------------------------------------------------------------------
// Pure logic (unit-tested): which positions count, what triggers, log parsing.
// ---------------------------------------------------------------------------

/**
 * Memecoin positions with their uncollected fees, from the two dashboard
 * payloads: every v4 position in the Trading wallet, plus any tokenId listed
 * in `memecoins` (config) whichever wallet holds it. The wallet rule means a
 * position re-minted after a close is covered without a config edit.
 */
function memecoinPositions({ positions, watch, memecoins, tradingLabel = "Trading" }) {
  const out = [];
  const byId = new Map((memecoins || []).map((m) => [String(m.tokenId), m]));
  const consider = (p, wallet, walletAddress, served) => {
    const id = String(p.tokenId ?? p.nftId).replace(/^v4-/, "");
    if (!byId.has(id) && !(p.version === 4 && served)) return;
    out.push({ tokenId: id, pair: p.pair, wallet, walletAddress, feesUsd: Number(p.feesUsd) || 0, version: p.version, poolKey: (p.pool && p.pool.key) || (p.poolAddress ? `v${Number(p.version) === 4 ? 4 : 3}:${String(p.poolAddress).toLowerCase()}` : null) });
  };
  // v4 positions count in the main wallet and in every watched wallet the collector serves
  // (settings.json wallets collect: true and approved; the payload's `collector.enabled`), the Trading wallet by name as a fallback.
  if (positions && positions.ok) for (const p of positions.positions || []) consider(p, positions.ownerLabel || "Main", positions.owner, true);
  if (watch && watch.ok) for (const w of watch.wallets || []) {
    if (!w.ok) continue;
    const served = w.collector ? !!w.collector.enabled : (w.label || "") === tradingLabel;
    for (const p of w.positions || []) consider(p, w.label || w.address, w.address, served);
  }
  return out;
}

/** The pool key of a position in the memecoin list, else the position itself (same fallback as alerts.poolKeyOf). */
function poolKeyFor(list, tokenId) {
  const id = String(tokenId).replace(/^v4-/, "");
  const p = (list || []).find((x) => String(x.tokenId) === id);
  return p && p.poolKey ? p.poolKey : `pos:${id}`;
}

/** The position that triggers a run, if any: the richest one above the threshold. */
function pickTrigger(list, minUsd) {
  const above = list.filter((p) => p.feesUsd > minUsd).sort((a, b) => b.feesUsd - a.feesUsd);
  return above[0] || null;
}

/** Should we run now? Threshold met and the interval since the last auto run has passed. */
function shouldRun({ trigger, lastRunAt, minIntervalMinutes, now = Date.now() }) {
  if (!trigger) return { run: false, reason: "no position above threshold" };
  if (lastRunAt && now - lastRunAt < minIntervalMinutes * 60000) {
    const mins = Math.ceil((minIntervalMinutes * 60000 - (now - lastRunAt)) / 60000);
    return { run: false, reason: `last auto run ${Math.round((now - lastRunAt) / 60000)} min ago; next in ${mins} min` };
  }
  return { run: true, reason: `${trigger.pair} has $${trigger.feesUsd.toFixed(2)} uncollected` };
}

/**
 * Parse a collector run's output into what was collected, split and sent,
 * attributed to the owner pass ("--- Label (0x…) ---") it happened in.
 */
function parseCollectorOutput(text) {
  const lines = String(text || "").split("\n");
  const strip = (l) => l.replace(/^\[[^\]]*\]\s*/, "");
  const result = { locked: false, owners: [], collected: [], splits: [], sends: [], failures: [] };
  let cur = null;
  for (const raw of lines) {
    const l = strip(raw);
    let m;
    if (/locked, skipping/.test(l)) result.locked = true;
    if ((m = l.match(/^--- (.+?) \((0x[0-9a-fA-F]{40})\) ---$/))) {
      cur = { wallet: m[1], address: m[2], collected: [], splitUsdg: 0, ownerUsdg: 0 };
      result.owners.push(cur);
      continue;
    }
    if ((m = l.match(/^collect (v4 )?#(\d+) -> (0x[0-9a-fA-F]{64})/))) {
      const e = { tokenId: m[2], version: m[1] ? 4 : 3, tx: m[3], wallet: cur ? cur.wallet : "Main" };
      result.collected.push(e);
      if (cur) cur.collected.push(e);
      continue;
    }
    if ((m = l.match(/^treasury split ([\d.]+) (\w+) \(([\d.]+)%\) -> LOKOVault TBA (0x[0-9a-fA-F]{40}) -> (0x[0-9a-fA-F]{64})/))) {
      const e = { usdg: Number(m[1]), symbol: m[2], pct: Number(m[3]), tba: m[4], tx: m[5], wallet: cur ? cur.wallet : "Main" };
      result.splits.push(e);
      if (cur) cur.splitUsdg += e.usdg;
      continue;
    }
    if ((m = l.match(/^send ([\d.]+) (\w+) -> (0x[0-9a-fA-F]{40}) -> (0x[0-9a-fA-F]{64})/))) {
      const e = { amount: Number(m[1]), symbol: m[2], to: m[3], tx: m[4], wallet: cur ? cur.wallet : "Main" };
      result.sends.push(e);
      if (cur && /USDG/i.test(e.symbol)) cur.ownerUsdg += e.amount;
      continue;
    }
    if (/^\s*! /.test(l)) result.failures.push({ wallet: cur ? cur.wallet : "Main", line: l.trim() });
  }
  // Pair names for collected ids, from the simulation lines "#id A/B" or "v4 #id A/B".
  for (const raw of lines) {
    const l = strip(raw);
    const m = l.match(/^(?:v4 )?#(\d+) ([A-Za-z0-9$._-]+\/[A-Za-z0-9$._-]+) /);
    if (m) for (const c of result.collected) if (c.tokenId === m[1] && !c.pair) c.pair = m[2];
  }
  return result;
}

/** Telegram lines for a run: one per collected position. */
/** One notice per collected position: { text, tokenId, wallet } (the pool cool-down keys on the position's pool). */
function collectNotices(parsed, trigger) {
  const out = [];
  for (const c of parsed.collected) {
    const owner = parsed.owners.find((o) => o.wallet === c.wallet);
    const pct = parsed.splits.find((s) => s.wallet === c.wallet);
    const total = owner ? owner.splitUsdg + owner.ownerUsdg : 0;
    const pair = c.pair || (trigger && trigger.tokenId === c.tokenId ? trigger.pair : `#${c.tokenId}`);
    const share = owner && owner.collected.length > 1 ? " (whole wallet pass)" : "";
    out.push({ text: `💰 Collected $${total.toFixed(2)} from ${pair}${share} (${pct ? pct.pct : 10}% → vault${owner && owner.splitUsdg ? `, $${owner.splitUsdg.toFixed(2)}` : ""}) · ${c.wallet}`, tokenId: String(c.tokenId), wallet: c.wallet });
  }
  return out;
}
function collectMessages(parsed, trigger) { return collectNotices(parsed, trigger).map((n) => n.text); }

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/**
 * create({ dir, positions, watched, treasury, alerts, log })
 *   positions  () => the dashboard's main-wallet payload (with `unlock`) or null
 *   watched    () => the watched-wallet list or null
 *   treasury   async () => the treasury view ({ ok, totalSplitUsdg }) or null
 *   alerts     alerts.js instance or null
 */
function create({ dir = HERE, positions = () => null, watched = () => null, treasury = async () => null, alerts = null, log = stamp, armUrl = "the dashboard" } = {}) {
  const LOG = path.join(dir, "memecoin-collect-log.json");
  const STATE = path.join(dir, "memecoin-collect-state.json");
  const LEDGER = path.join(dir, "fee-split-ledger.json");
  let lastCycleAt = 0, running = false;

  function loadConfig() {
    let cfg = {}; try { cfg = require("./settings").load(); } catch {}
    const mc = cfg.memecoinCollect || {};
    return { cfg, enabled: mc.enabled !== false, minUsd: Number(mc.minUsd ?? 20), minIntervalMinutes: Number(mc.minIntervalMinutes ?? 30),
      memecoins: Array.isArray(cfg.memecoins) ? cfg.memecoins : null, tradingLabel: mc.tradingWalletLabel || "Trading" };
  }
  function runCollector() {
    return new Promise((resolve) => {
      const child = spawn(path.join(dir, "run-collector.sh"), ["full", "--quiet"], { cwd: dir, env: process.env });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, out }));
      child.on("error", (err) => resolve({ code: -1, out: `${out}\n${err.message}` }));
    });
  }
  /** Telegram. With a pool key the message shares the per-pool cool-down with the guardian and the range check. */
  async function notify(text, poolKey = null) {
    try {
      if (!alerts || !alerts.enabled) return false;
      if (poolKey && alerts.sendPool) return await alerts.sendPool(poolKey, text, { source: "collect" });
      return await alerts.send(text);
    } catch (err) {
      log(`telegram: ${err.message}`);
      return false;
    }
  }
  function appendLog(entry) {
    const rows = readJson(LOG, []);
    rows.push(entry);
    while (rows.length > 2000) rows.shift();
    writeJson(LOG, rows);
  }

  async function evaluate({ dryRun } = {}) {
    const conf = loadConfig();
    const state = readJson(STATE, {});
    if (!conf.enabled) return log("memecoinCollect.enabled is false; idle");
    const pos = positions(), w = watched();
    if (!pos || !pos.ok) return log("no position data yet");
    const list = memecoinPositions({ positions: pos, watch: w ? { ok: true, wallets: w } : null, memecoins: conf.memecoins, tradingLabel: conf.tradingLabel });
    const trigger = pickTrigger(list, conf.minUsd);
    const decision = shouldRun({ trigger, lastRunAt: state.lastRunAt, minIntervalMinutes: conf.minIntervalMinutes });
    log(`${list.length} memecoin position(s): ${list.map((p) => `${p.pair} $${p.feesUsd.toFixed(2)}`).join(", ") || "none"} · threshold $${conf.minUsd} · ${decision.reason}`);
    if (!decision.run) return;

    const armed = !!(pos.unlock && pos.unlock.armed);
    if (!armed) {
      const since = state.lockedNoticeAt || 0;
      if (Date.now() - since > LOCKED_REPEAT_MS) {
        const text = `💰 $${trigger.feesUsd.toFixed(2)} uncollected on ${trigger.pair} but the collector is locked — arm it from ${armUrl}`;
        log(text);
        if (!dryRun) {
          await notify(text, poolKeyFor(list, trigger.tokenId));
          state.lockedNoticeAt = Date.now();
          writeJson(STATE, state);
        }
      } else log("collector locked; nudge already sent this episode");
      appendLog({ timestamp: new Date().toISOString(), trigger, ranCollector: false, status: "locked", dryRun });
      return;
    }
    delete state.lockedNoticeAt;

    if (dryRun) {
      log(`DRY RUN: would run ./run-collector.sh full --quiet now (trigger ${trigger.pair} #${trigger.tokenId}, $${trigger.feesUsd.toFixed(2)})`);
      appendLog({ timestamp: new Date().toISOString(), trigger, ranCollector: false, status: "dry-run" });
      return;
    }

    log(`running the collector (trigger ${trigger.pair} #${trigger.tokenId}, $${trigger.feesUsd.toFixed(2)})`);
    state.lastRunAt = Date.now();
    writeJson(STATE, state);
    const { code, out } = await runCollector();
    const parsed = parseCollectorOutput(out);
    const splitUsdg = parsed.splits.reduce((s, x) => s + x.usdg, 0);
    const status = parsed.locked ? "locked" : code !== 0 ? "error" : parsed.collected.length ? "collected" : "nothing-eligible";
    appendLog({ timestamp: new Date().toISOString(), trigger, ranCollector: true, exitCode: code, collected: parsed.collected, splits: parsed.splits, sends: parsed.sends, failures: parsed.failures,
      splitUsdg: +splitUsdg.toFixed(6), status, output: out.split("\n").slice(-25).join("\n") });
    log(`collector finished: ${status} (${parsed.collected.length} collected, split ${splitUsdg.toFixed(2)} USDG, ${parsed.failures.length} failure line(s))`);
    for (const n of collectNotices(parsed, trigger)) await notify(n.text, poolKeyFor(list, n.tokenId));
    if (status === "error") await notify(`⚠️ Auto-collect run exited with code ${code}; see memecoin-collect-log.json`);
  }

  // First vault split verification: once, after the first "ok" ledger row.
  async function verifyFirstSplit({ dryRun } = {}) {
    const state = readJson(STATE, {});
    if (state.firstSplitVerifiedAt) return;
    const ledger = readJson(LEDGER, []);
    const first = ledger.find((r) => r.status === "ok" && Number(r.splitUsdg) > 0);
    if (!first) return;
    const cfg = loadConfig().cfg;
    const provider = require("./rpc").createProvider(cfg);
    const checks = {};
    try {
      const usdg = new ethers.Contract(USDG, ["function balanceOf(address) view returns (uint256)"], provider);
      const bal = Number(ethers.formatUnits(await usdg.balanceOf(first.tbaAddress), USDG_DECIMALS));
      checks.tbaBalance = { value: bal, ok: bal >= Number(first.splitUsdg) - 1e-6 };
    } catch (err) {
      checks.tbaBalance = { ok: false, error: err.shortMessage || err.message };
    }
    try {
      const rc = first.ownerTxHash ? await provider.getTransactionReceipt(first.ownerTxHash) : null;
      let sent = null;
      if (rc) {
        for (const l of rc.logs) {
          if (l.address.toLowerCase() === USDG.toLowerCase() && l.topics[0] === TRANSFER_TOPIC) {
            const to = ethers.getAddress("0x" + l.topics[2].slice(26));
            if (first.walletAddress && to.toLowerCase() === String(first.walletAddress).toLowerCase()) sent = Number(ethers.formatUnits(BigInt(l.data), USDG_DECIMALS));
            else if (!first.walletAddress && sent == null) sent = Number(ethers.formatUnits(BigInt(l.data), USDG_DECIMALS));
          }
        }
      }
      checks.ownerTransfer = { value: sent, ok: sent != null && Math.abs(sent - Number(first.ownerReceived)) < 0.01 };
    } catch (err) {
      checks.ownerTransfer = { ok: false, error: err.shortMessage || err.message };
    }
    try {
      const t = await treasury();
      checks.dashboard = { value: t && t.totalSplitUsdg, ok: !!t && t.ok && Number(t.totalSplitUsdg) >= Number(first.splitUsdg) - 1e-6 };
    } catch (err) {
      checks.dashboard = { ok: false, error: err.message };
    }
    const allOk = Object.values(checks).every((c) => c.ok);
    appendLog({ timestamp: new Date().toISOString(), firstSplit: first, checks, verified: allOk, type: "first-split-verification" });
    log(`first vault split ${allOk ? "VERIFIED" : "check failed"}: ${JSON.stringify(checks)}`);
    if (allOk) {
      if (!dryRun) {
        await notify(`✅ First vault split verified: $${Number(first.splitUsdg).toFixed(2)} to vault, $${Number(first.ownerReceived).toFixed(2)} to wallet (${first.wallet}, ${first.pair || "#" + first.positionId})`);
        writeJson(STATE, { ...readJson(STATE, {}), firstSplitVerifiedAt: Date.now() });
      }
    } else if (!dryRun && !state.firstSplitWarnedAt) {
      await notify(`⚠️ First vault split recorded but a check failed: ${Object.entries(checks).filter(([, c]) => !c.ok).map(([k, c]) => `${k}${c.error ? " (" + c.error + ")" : ""}`).join(", ")}`);
      writeJson(STATE, { ...readJson(STATE, {}), firstSplitWarnedAt: Date.now() });
    }
  }

  /** One evaluation; never runs twice at once. */
  async function cycle(opts = {}) {
    if (running) return log("previous cycle still running (collector in progress); skipped");
    running = true;
    try {
      try { await evaluate(opts); } catch (err) { log(`evaluate: ${err.message}`); }
      lastCycleAt = Date.now();
      try { await verifyFirstSplit(opts); } catch (err) { log(`first-split check: ${err.message}`); }
    } finally { running = false; }
  }

  /** Settings and last activity for status views. */
  function summary() {
    const conf = loadConfig();
    const state = readJson(STATE, {});
    return { enabled: conf.enabled, minUsd: conf.minUsd, minIntervalMinutes: conf.minIntervalMinutes, lastRunAt: state.lastRunAt || null, lastCheckAt: lastCycleAt || null, running };
  }

  return { cycle, summary, get lastCycleAt() { return lastCycleAt; } };
}

if (require.main === module) {
  const opts = { dryRun: flag("--dry-run") };
  let payload = null, wallets = null;
  const getJson = async (p) => { const r = await fetch(`${BASE}${p}`, { signal: AbortSignal.timeout(20000) }); return r.json(); };
  const c = create({ positions: () => payload, watched: () => wallets, treasury: () => getJson("/api/treasury"), alerts: (() => { try { return require("./alerts").create({ log: { error: (...a) => stamp(a.join(" ")) } }); } catch { return null; } })(), armUrl: `${BASE}/arm` });
  (async () => {
    try { [payload, wallets] = await Promise.all([getJson("/api/positions"), getJson("/api/watch").then((w) => w.wallets || [])]); } catch (err) { stamp(`dashboard unreachable on :${PORT}: ${err.message}`); process.exit(1); }
    await c.cycle(opts);
    if (!flag("--once")) stamp("the auto-collect loop now runs inside server.js; this command evaluates once");
    process.exit(0);
  })();
}

module.exports = { create, memecoinPositions, pickTrigger, shouldRun, parseCollectorOutput, collectMessages, collectNotices, poolKeyFor };
