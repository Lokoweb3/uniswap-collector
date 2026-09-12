/**
 * audit.js — the nightly ledger audit: does every valued row still make sense?
 *
 * Three checks, each with an independent source, so a wrong valuation cannot
 * confirm itself (the LAPTOP lesson of 2026-09-11: a multi-hop sale read the
 * first hop's leg as ETH and booked 25x the real proceeds; nothing compared it
 * to anything, so it sat on the lots table until someone read it):
 *
 *   rows        every "sold" disposal against the hourly price log: more than
 *               50% away, valued at nothing while a price exists, matched no leg
 *               (the valuer fell back to the hourly price), or a route shape the
 *               audit has never accepted before (an "unfamiliar route" is not
 *               wrong, it is unverified: check its receipt once, then it is known).
 *   lots        the per-token summary: proceeds or realized out of proportion to
 *               the basis (fee lots do not turn $682 into $10k).
 *   inflows     booked proceeds (USDG / ETH units the valuer says the wallet got)
 *               against what the chain shows arriving at the wallet that day
 *               (USDG Transfer logs, native ETH internal transactions from
 *               Blockscout). Booking more than arrived is the one thing a price
 *               check can never catch.
 *
 * Pure functions take data; run() gathers it, writes ledger-audit.json and returns
 * the report. /api/audit serves the file; the morning summary and the lots table
 * read it. Known route shapes are remembered in the file: the first run accepts
 * the shapes already on record, later runs flag new ones until they are accepted.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const OFF_LOW = 0.5, OFF_HIGH = 1.5; // booked / hourly-price ratio outside this is "off"
const LOTS_MULT = 3; // proceeds or realized beyond this multiple of the basis
const INFLOW_TOLERANCE = 1.02; // booked units may exceed the day's inflow by this factor (rounding)

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Hourly price of `addr` nearest `t` (within 3 h), from a normalised { hourMs: { addrLower: price } } map. */
function priceAt(hours, addr, t) {
  if (!addr || !t) return null;
  const a = String(addr).toLowerCase();
  let best = null;
  for (const h of Object.keys(hours || {})) {
    const d = Math.abs(Number(h) - t);
    if (d <= 3 * HOUR && (!best || d < best.d) && hours[h][a] != null) best = { h, d };
  }
  return best ? Number(hours[best.h][a]) : null;
}

/** Per-row checks on "sold" disposals. */
function auditRows(rows, hours, { knownShapes = [] } = {}) {
  const known = new Set(knownShapes);
  const out = [];
  for (const r of rows || []) {
    if (r.kind !== "sold") continue;
    const px = priceAt(hours, r.tokenAddress, r.t);
    const ref = px != null ? Number(r.amount) * px : null;
    const base = { t: r.t, day: dayOf(r.t), token: r.token, wallet: r.from, amount: r.amount, tx: r.tx, logIndex: r.logIndex, usd: r.usd, hourlyUsd: round(ref), priced: r.priced || null, shape: r.shape || null };
    if (typeof r.priced === "string" && r.priced.startsWith("hourly log (proceeds unmatched")) out.push({ ...base, kind: "unmatched", severity: "warn", note: `no leg of the receipt matched this sale; valued at the hourly price ($${round(r.usd)}), ${r.priced.slice("hourly log (".length, -1)}` });
    else if ((r.usd == null || r.usd === 0) && ref > 0.5) out.push({ ...base, kind: "unpriced", severity: "warn", note: `booked ${r.usd == null ? "nothing" : "$0"} while the hourly price says $${round(ref)}` });
    else if (r.usd != null && ref > 0.5) {
      const ratio = r.usd / ref;
      if (ratio > OFF_HIGH || ratio < OFF_LOW) out.push({ ...base, kind: "off", severity: ratio > 3 || ratio < 1 / 3 ? "bad" : "warn", ratio: round(ratio, 2), note: `booked $${round(r.usd)} is ${round(ratio, 2)}x the hourly price ($${round(ref)})` });
    }
    if (r.shape && !known.has(r.shape)) out.push({ ...base, kind: "unfamiliar", severity: "info", note: `route shape "${r.shape}" not accepted yet — check the receipt once` });
  }
  return out;
}

/** Per-token checks on the lots summary (/api/strategy/lots tokens[]). */
function auditLots(tokens) {
  const out = [];
  for (const t of tokens || []) {
    const basis = Number(t.basisUsd) || 0;
    if (!(basis > 0)) continue;
    if (t.proceedsUsd != null && t.proceedsUsd > LOTS_MULT * basis) out.push({ kind: "lots", severity: "bad", token: t.token, note: `proceeds $${round(t.proceedsUsd)} are ${round(t.proceedsUsd / basis, 1)}x the $${round(basis)} basis of the disposed fee lots` });
    else if (t.realizedUsd != null && t.realizedUsd > LOTS_MULT * basis) out.push({ kind: "lots", severity: "bad", token: t.token, note: `realized +$${round(t.realizedUsd)} on a $${round(basis)} basis` });
  }
  return out;
}

/**
 * Booked proceeds per wallet / day / currency against the chain's inflows.
 * rows: sold disposals with `units` { usdg, eth } (raw strings); inflows: [{ wallet, t, currency, amount (raw string) }].
 * Only rows that carry units take part; days with no booked units are skipped.
 */
function reconcile(rows, inflows, { now = Date.now(), settleMs = DAY } = {}) {
  const booked = {}, arrived = {};
  const key = (w, day, c) => `${String(w).toLowerCase()}|${day}|${c}`;
  for (const r of rows || []) {
    if (r.kind !== "sold" || !r.units || r.t > now - settleMs) continue; // recent inflows may not be indexed yet
    for (const c of ["usdg", "eth"]) { const v = BigInt(r.units[c] || 0); if (v > 0n) { const k = key(r.from, dayOf(r.t), c); booked[k] = (booked[k] || 0n) + v; } }
  }
  for (const i of inflows || []) { const k = key(i.wallet, dayOf(i.t), i.currency); arrived[k] = (arrived[k] || 0n) + BigInt(i.amount || 0); }
  const out = [];
  for (const [k, b] of Object.entries(booked)) {
    const a = arrived[k] || 0n;
    const [wallet, day, c] = k.split("|");
    const fmt = (v) => (c === "usdg" ? Number(ethers.formatUnits(v, 6)).toFixed(2) + " USDG" : Number(ethers.formatEther(v)).toFixed(4) + " ETH");
    if (Number(b) > Number(a) * INFLOW_TOLERANCE + (c === "usdg" ? 1e4 : 1e12)) out.push({ kind: "inflow", severity: "bad", wallet, day, currency: c, booked: fmt(b), arrived: fmt(a), note: `${day}: sales booked ${fmt(b)} to ${wallet.slice(0, 6)}…${wallet.slice(-4)} but the chain shows ${fmt(a)} arriving` });
  }
  return out;
}

function summarise(findings) {
  const bad = findings.filter((f) => f.severity === "bad").length, warn = findings.filter((f) => f.severity === "warn").length, info = findings.filter((f) => f.severity === "info").length;
  const byToken = {};
  for (const f of findings) if (f.token) byToken[f.token] = (byToken[f.token] || 0) + 1;
  return { total: findings.length, bad, warn, info, byToken, clean: bad + warn === 0 };
}

/** One line for the morning summary. */
function summaryLine(report) {
  if (!report || !report.at) return "🧾 Ledger audit: not run yet";
  const s = report.summary || summarise(report.findings || []);
  const when = new Date(report.at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (s.clean) return `🧾 Ledger audit (${when}): clean${s.info ? `, ${s.info} unfamiliar route${s.info === 1 ? "" : "s"} to accept` : ""}`;
  const top = (report.findings || []).filter((f) => f.severity !== "info").slice(0, 2).map((f) => `${f.token ? f.token + " " : ""}${f.note}`).join("; ");
  return `🧾 Ledger audit (${when}): ${s.bad + s.warn} finding${s.bad + s.warn === 1 ? "" : "s"} — ${top}`;
}

/**
 * Inflows to the wallets from Blockscout: USDG and WETH Transfer logs (topic2 =
 * wallet; a router may hand WETH back unwrapped or not, both count as ETH) and
 * native ETH internal transactions with value to the wallet, since `since` (ms).
 * Best effort: a wallet whose query fails is reported in `errors` and skipped.
 */
async function fetchInflows({ wallets, since, stable, weth = null, log = () => {} }) {
  const bs = require("./blockscout");
  const TRANSFER = ethers.id("Transfer(address,address,uint256)");
  const inflows = [], errors = [];
  // An explorer answer that is not a row list is a failed query, never "nothing arrived":
  // "No records found" is the one empty answer that counts as data. One retry per query.
  const rowsOf = async (query) => {
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await bs.bsFetch(query, { timeoutMs: 30000 });
        const d = await r.json();
        if (Array.isArray(d.result)) return d.result;
        if (/no (records|transactions|logs) found/i.test(String(d.message || d.result || ""))) return [];
        last = new Error(`HTTP ${r.status}: ${String(d.message || d.result || "unexpected answer").slice(0, 80)}`);
      } catch (err) { last = err; }
      await new Promise((x) => setTimeout(x, 1500));
    }
    throw last || new Error("no answer");
  };
  for (const w of wallets) {
    const wl = String(w).toLowerCase();
    for (const [token, currency] of [[stable, "usdg"], [weth, "eth"]]) {
      if (!token) continue;
      try {
        for (const l of await rowsOf(`?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${token}&topic0=${TRANSFER}&topic2=${ethers.zeroPadValue(wl, 32)}&topic0_2_opr=and`)) {
          const t = l.timeStamp ? parseInt(l.timeStamp, 16) * 1000 : null;
          if (!t || t < since) continue;
          inflows.push({ wallet: wl, t, currency, amount: BigInt(l.data || "0x0").toString(), tx: l.transactionHash });
        }
      } catch (err) { errors.push(`${currency} ${wl.slice(0, 8)}: ${err.message}`); }
    }
    try {
      for (const x of await rowsOf(`?module=account&action=txlistinternal&address=${wl}&sort=desc`)) {
        const t = Number(x.timeStamp) * 1000;
        if (!t || t < since || String(x.to).toLowerCase() !== wl || !(BigInt(x.value || 0) > 0n) || (x.isError && x.isError !== "0")) continue;
        inflows.push({ wallet: wl, t, currency: "eth", amount: BigInt(x.value).toString(), tx: x.hash || x.transactionHash });
      }
    } catch (err) { errors.push(`eth ${wl.slice(0, 8)}: ${err.message}`); }
    await new Promise((r) => setTimeout(r, 300));
  }
  log(`audit: ${inflows.length} inflow(s) read for ${wallets.length} wallet(s)${errors.length ? `, ${errors.length} query error(s)` : ""}`);
  return { inflows, errors };
}

function create({ cfg, dir = __dirname, port, log = console.log }) {
  const FILE = path.join(dir, "ledger-audit.json");
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`); return r.json(); };
  const WETH = String((cfg.contracts && cfg.contracts.weth) || "").toLowerCase();
  const STABLE = String((cfg.usdReference && cfg.usdReference.stable) || "").toLowerCase();

  /** The price log with WETH / native ETH under both their address keys, so priceAt works for every row. */
  function priceHours() {
    const pl = readJson(path.join(dir, "price-log.json"), { hours: {} });
    const out = {};
    for (const [h, row] of Object.entries(pl.hours || {})) {
      const r = {};
      for (const [a, p] of Object.entries(row)) r[a.toLowerCase()] = p;
      if (r.eth != null) { r[ethers.ZeroAddress] = r.eth; if (WETH) r[WETH] = r.eth; }
      if (STABLE && r[STABLE] == null) r[STABLE] = 1;
      out[h] = r;
    }
    return out;
  }

  function read() { return readJson(FILE, null); }

  /** Mark route shapes as accepted (they stop being flagged); their saved receipts become expected-value fixtures. */
  function acceptShapes(shapes) {
    const cur = read() || { at: null, findings: [], knownShapes: [] };
    cur.knownShapes = [...new Set([...(cur.knownShapes || []), ...shapes])];
    const fixDir = path.join(dir, "test", "fixtures", "receipts");
    try {
      for (const f of fs.readdirSync(fixDir)) {
        const p = path.join(fixDir, f);
        const fx = readJson(p, null);
        if (!fx || fx.accepted || !shapes.includes(fx.shape)) continue;
        fx.accepted = true; fx.acceptedAt = new Date().toISOString(); fx.expected = fx.valuation;
        fs.writeFileSync(p, JSON.stringify(fx, null, 1));
      }
    } catch {}
    cur.findings = (cur.findings || []).filter((f) => !(f.kind === "unfamiliar" && cur.knownShapes.includes(f.shape)));
    cur.summary = summarise(cur.findings);
    fs.writeFileSync(FILE, JSON.stringify(cur));
    return cur;
  }

  async function run({ days = 30, now = Date.now(), inflows: inflowsOverride = null } = {}) {
    const prev = read();
    const rows = (readJson(path.join(dir, "token-disposals.json"), { rows: [] }).rows || []).filter((r) => r.t && r.t >= now - days * DAY);
    const hours = priceHours();
    // First run: every shape already on record is accepted; only new ones are flagged after that.
    const knownShapes = prev && Array.isArray(prev.knownShapes) ? prev.knownShapes : [...new Set(rows.map((r) => r.shape).filter(Boolean))];
    const findings = auditRows(rows, hours, { knownShapes });
    let lotsTokens = [];
    try { lotsTokens = (await get("/api/strategy/lots")).tokens || []; } catch (err) { log(`audit: lots view unavailable (${err.message})`); }
    findings.push(...auditLots(lotsTokens));
    const wallets = [...new Set(rows.filter((r) => r.kind === "sold" && r.units).map((r) => String(r.from).toLowerCase()))];
    let inflowErrors = [];
    if (wallets.length) {
      const since = Math.min(...rows.filter((r) => r.kind === "sold" && r.units).map((r) => r.t)) - DAY;
      const { inflows, errors } = inflowsOverride ? { inflows: inflowsOverride, errors: [] } : await fetchInflows({ wallets, since, stable: STABLE, weth: WETH, log });
      inflowErrors = errors;
      // A wallet whose inflow query failed cannot be reconciled; do not report its days as short.
      const failed = new Set(errors.map((e) => e.split(" ")[1].replace(":", "")));
      if (failed.size) log(`audit: inflow queries failed for ${failed.size} wallet(s); their days are not reconciled (${errors.join("; ").slice(0, 200)})`);
      findings.push(...reconcile(rows.filter((r) => !failed.has(String(r.from).toLowerCase().slice(0, 8))), inflows, { now }));
    }
    findings.sort((a, b) => ({ bad: 0, warn: 1, info: 2 }[a.severity] - { bad: 0, warn: 1, info: 2 }[b.severity]) || (b.t || 0) - (a.t || 0));
    const report = { at: now, days, rows: rows.length, sold: rows.filter((r) => r.kind === "sold").length, findings, summary: summarise(findings), knownShapes, inflowErrors, fingerprint: findings.filter((f) => f.severity !== "info").map((f) => `${f.kind}:${f.tx || f.token || f.day}:${f.logIndex || ""}`).sort().join(",") };
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(report));
    fs.renameSync(tmp, FILE);
    log(`audit: ${report.summary.total} finding(s) (${report.summary.bad} bad, ${report.summary.warn} warn, ${report.summary.info} info) over ${rows.length} row(s)`);
    return { report, changed: !prev || prev.fingerprint !== report.fingerprint };
  }

  return { run, read, acceptShapes, summaryLine };
}

module.exports = { create, auditRows, auditLots, reconcile, summarise, summaryLine, priceAt, fetchInflows };
