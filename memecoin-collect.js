#!/usr/bin/env node
/**
 * memecoin-collect.js — collect memecoin fees as soon as they are worth it.
 *
 * Every 15 minutes: read the dashboard's /api/positions and /api/watch, find
 * memecoin positions (config.json `memecoins`, else every v4 position in the
 * Trading wallet) whose uncollected fees exceed `memecoinCollect.minUsd`
 * (default $20), and run `./run-collector.sh full --quiet` — the normal
 * collector, which handles every wallet and the 10% LOKOVault split — instead
 * of waiting for the 09:00 run. At most one auto run per `minIntervalMinutes`.
 *
 * The collector only signs while armed; when it is locked this sends one
 * Telegram nudge per lock episode (then at most every 6 h) and tries again
 * next cycle. Runs are logged to memecoin-collect-log.json.
 *
 * First-split verification: until fee-split-ledger.json holds its first "ok"
 * entry, check every cycle; then confirm the TBA's USDG balance, the owner
 * transfer in the tx receipt and /api/treasury, and send one "verified" note.
 *
 *   node memecoin-collect.js                # loop (started by start-all.sh)
 *   node memecoin-collect.js --once         # one evaluation
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
const CYCLE_MS = 15 * 60 * 1000;
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
  const cfg = readJson(path.join(HERE, "config.json"), {});
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
 * payloads. `memecoins` (config) selects by tokenId when present; otherwise
 * every v4 position in the Trading wallet counts.
 */
function memecoinPositions({ positions, watch, memecoins, tradingLabel = "Trading" }) {
  const out = [];
  const byId = memecoins ? new Map(memecoins.map((m) => [String(m.tokenId), m])) : null;
  const consider = (p, wallet, walletAddress) => {
    const id = String(p.tokenId ?? p.nftId).replace(/^v4-/, "");
    if (byId) {
      if (!byId.has(id)) return;
    } else if (!(p.version === 4 && wallet === tradingLabel)) return;
    out.push({ tokenId: id, pair: p.pair, wallet, walletAddress, feesUsd: Number(p.feesUsd) || 0, version: p.version });
  };
  if (positions && positions.ok) for (const p of positions.positions || []) consider(p, positions.ownerLabel || "Main", positions.owner);
  if (watch && watch.ok) for (const w of watch.wallets || []) if (w.ok) for (const p of w.positions || []) consider(p, w.label || w.address, w.address);
  return out;
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
function collectMessages(parsed, trigger) {
  const msgs = [];
  for (const c of parsed.collected) {
    const owner = parsed.owners.find((o) => o.wallet === c.wallet);
    const pct = parsed.splits.find((s) => s.wallet === c.wallet);
    const total = owner ? owner.splitUsdg + owner.ownerUsdg : 0;
    const pair = c.pair || (trigger && trigger.tokenId === c.tokenId ? trigger.pair : `#${c.tokenId}`);
    const share = owner && owner.collected.length > 1 ? " (whole wallet pass)" : "";
    msgs.push(`💰 Collected $${total.toFixed(2)} from ${pair}${share} (${pct ? pct.pct : 10}% → vault${owner && owner.splitUsdg ? `, $${owner.splitUsdg.toFixed(2)}` : ""}) · ${c.wallet}`);
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

async function getJson(pathname) {
  const r = await fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(20000) });
  return r.json();
}

function runCollector() {
  return new Promise((resolve) => {
    const child = spawn(path.join(HERE, "run-collector.sh"), ["full", "--quiet"], { cwd: HERE, env: process.env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.on("error", (err) => resolve({ code: -1, out: `${out}\n${err.message}` }));
  });
}

let telegram = null;
async function notify(text) {
  try {
    if (!telegram) telegram = require("./alerts").create({ log: { error: (...a) => stamp(a.join(" ")) } });
    if (!telegram.enabled) return false;
    return await telegram.send(text);
  } catch (err) {
    stamp(`telegram: ${err.message}`);
    return false;
  }
}

function appendLog(entry) {
  const rows = readJson(LOG_FILE, []);
  rows.push(entry);
  while (rows.length > 2000) rows.shift();
  writeJson(LOG_FILE, rows);
}

async function evaluate({ dryRun }) {
  const conf = loadConfig();
  const state = readJson(STATE_FILE, {});
  if (!conf.enabled) return stamp("memecoinCollect.enabled is false; idle");
  let positions, watch;
  try {
    [positions, watch] = await Promise.all([getJson("/api/positions"), getJson("/api/watch")]);
  } catch (err) {
    return stamp(`dashboard unreachable on :${PORT}: ${err.message}`);
  }
  const list = memecoinPositions({ positions, watch, memecoins: conf.memecoins, tradingLabel: conf.tradingLabel });
  const trigger = pickTrigger(list, conf.minUsd);
  const decision = shouldRun({ trigger, lastRunAt: state.lastRunAt, minIntervalMinutes: conf.minIntervalMinutes });
  stamp(`${list.length} memecoin position(s): ${list.map((p) => `${p.pair} $${p.feesUsd.toFixed(2)}`).join(", ") || "none"} · threshold $${conf.minUsd} · ${decision.reason}`);
  if (!decision.run) return;

  const armed = !!(positions.unlock && positions.unlock.armed);
  if (!armed) {
    const since = state.lockedNoticeAt || 0;
    if (Date.now() - since > LOCKED_REPEAT_MS) {
      const text = `💰 $${trigger.feesUsd.toFixed(2)} uncollected on ${trigger.pair} but the collector is locked — arm at ${BASE}/arm`;
      stamp(text);
      if (!dryRun) {
        await notify(text);
        state.lockedNoticeAt = Date.now();
        writeJson(STATE_FILE, state);
      }
    } else stamp("collector locked; nudge already sent this episode");
    appendLog({ timestamp: new Date().toISOString(), trigger, ranCollector: false, status: "locked", dryRun });
    return;
  }
  delete state.lockedNoticeAt;

  if (dryRun) {
    stamp(`DRY RUN: would run ./run-collector.sh full --quiet now (trigger ${trigger.pair} #${trigger.tokenId}, $${trigger.feesUsd.toFixed(2)})`);
    appendLog({ timestamp: new Date().toISOString(), trigger, ranCollector: false, status: "dry-run" });
    return;
  }

  stamp(`running the collector (trigger ${trigger.pair} #${trigger.tokenId}, $${trigger.feesUsd.toFixed(2)})`);
  state.lastRunAt = Date.now();
  writeJson(STATE_FILE, state);
  const { code, out } = await runCollector();
  const parsed = parseCollectorOutput(out);
  const splitUsdg = parsed.splits.reduce((s, x) => s + x.usdg, 0);
  const status = parsed.locked ? "locked" : code !== 0 ? "error" : parsed.collected.length ? "collected" : "nothing-eligible";
  appendLog({
    timestamp: new Date().toISOString(),
    trigger,
    ranCollector: true,
    exitCode: code,
    collected: parsed.collected,
    splits: parsed.splits,
    sends: parsed.sends,
    failures: parsed.failures,
    splitUsdg: +splitUsdg.toFixed(6),
    status,
    output: out.split("\n").slice(-25).join("\n"),
  });
  stamp(`collector finished: ${status} (${parsed.collected.length} collected, split ${splitUsdg.toFixed(2)} USDG, ${parsed.failures.length} failure line(s))`);
  for (const m of collectMessages(parsed, trigger)) await notify(m);
  if (status === "error") await notify(`⚠️ Auto-collect run exited with code ${code}; see memecoin-collect-log.json`);
}

// ---------------------------------------------------------------------------
// First vault split verification
// ---------------------------------------------------------------------------

async function verifyFirstSplit({ dryRun }) {
  const state = readJson(STATE_FILE, {});
  if (state.firstSplitVerifiedAt) return;
  const ledger = readJson(LEDGER_FILE, []);
  const first = ledger.find((r) => r.status === "ok" && Number(r.splitUsdg) > 0);
  if (!first) return stamp("first vault split: not recorded yet");
  const cfg = readJson(path.join(HERE, "config.json"), {});
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, Number(cfg.chainId));
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
    const t = await getJson("/api/treasury");
    checks.dashboard = { value: t.totalSplitUsdg, ok: t.ok && Number(t.totalSplitUsdg) >= Number(first.splitUsdg) - 1e-6 };
  } catch (err) {
    checks.dashboard = { ok: false, error: err.message };
  }
  const allOk = Object.values(checks).every((c) => c.ok);
  const entry = { timestamp: new Date().toISOString(), firstSplit: first, checks, verified: allOk };
  appendLog({ ...entry, type: "first-split-verification" });
  stamp(`first vault split ${allOk ? "VERIFIED" : "check failed"}: ${JSON.stringify(checks)}`);
  if (allOk) {
    if (!dryRun) {
      await notify(`✅ First vault split verified: $${Number(first.splitUsdg).toFixed(2)} to vault, $${Number(first.ownerReceived).toFixed(2)} to wallet (${first.wallet}, ${first.pair || "#" + first.positionId})`);
      state.firstSplitVerifiedAt = Date.now();
      writeJson(STATE_FILE, state);
    }
  } else if (!dryRun && !state.firstSplitWarnedAt) {
    await notify(`⚠️ First vault split recorded but a check failed: ${Object.entries(checks).filter(([, c]) => !c.ok).map(([k, c]) => `${k}${c.error ? " (" + c.error + ")" : ""}`).join(", ")}`);
    state.firstSplitWarnedAt = Date.now();
    writeJson(STATE_FILE, state);
  }
}

const HEARTBEAT_FILE = path.join(HERE, "memecoin-collect-heartbeat.json");
async function cycle(opts) {
  try {
    await evaluate(opts);
  } catch (err) {
    stamp(`evaluate: ${err.message}`);
  }
  // Heartbeat for the dashboard's watchdog: written every cycle whatever happened.
  try {
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ at: Date.now(), pid: process.pid, dryRun: !!(opts && opts.dryRun) }));
  } catch {}
  try {
    await verifyFirstSplit(opts);
  } catch (err) {
    stamp(`first-split check: ${err.message}`);
  }
}

if (require.main === module) {
  const opts = { dryRun: flag("--dry-run") };
  if (flag("--once")) {
    cycle(opts).then(() => process.exit(0));
  } else {
    stamp(`memecoin auto-collect loop: every ${CYCLE_MS / 60000} min against ${BASE}${opts.dryRun ? " (dry run)" : ""}`);
    cycle(opts);
    setInterval(() => cycle(opts), CYCLE_MS);
  }
}

module.exports = { memecoinPositions, pickTrigger, shouldRun, parseCollectorOutput, collectMessages };
