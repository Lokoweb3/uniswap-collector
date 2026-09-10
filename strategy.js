/**
 * Strategy dataset: the history an agent needs to judge what worked.
 *
 * Assembles, from the dashboard's own views and ledgers, one record per
 * position ever seen (open and closed, every wallet) with its full life:
 * when it opened and closed, what went in and came out, every collect, time
 * in range, realized fee APR, PnL versus holding, and the pool it sits in.
 * Also hourly price series (price-log.json) and the pool scout's record of
 * how sibling pools compared over time.
 *
 * Read-only; served at /api/strategy/* and through the MCP tools
 * position_history, price_history and pool_scout_history.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const HOUR = 3600 * 1000;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const round = (n, p = 2) => (n == null || !isFinite(n) ? null : +Number(n).toFixed(p));

function create({ cfg, dir = __dirname, port, metaFor = null }) {
  const BASE = `http://127.0.0.1:${port}`;
  const WETH = (cfg.contracts.weth || "").toLowerCase();
  const STABLE = ((cfg.usdReference && cfg.usdReference.stable) || "").toLowerCase();

  async function get(p) {
    const r = await fetch(BASE + p, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
    return r.json();
  }

  // ---- prices ----------------------------------------------------------------
  function priceLog() { return readJson(path.join(dir, "price-log.json"), { hours: {} }).hours || {}; }
  /** USD price of a token at time t from the hourly log (nearest hour within 3h). */
  function priceAt(hours, addr, t) {
    if (!addr || !t) return null;
    const key = addr === ethers.ZeroAddress || addr.toLowerCase() === WETH ? "eth" : addr.toLowerCase() === STABLE ? "usdg" : addr.toLowerCase();
    let best = null;
    for (const h of Object.keys(hours)) {
      const d = Math.abs(Number(h) - t);
      if (d <= 3 * HOUR && (!best || d < best.d)) best = { h, d };
    }
    if (!best) return null;
    if (key === "usdg") return 1;
    const v = hours[best.h][key];
    return v > 0 ? v : null;
  }

  // ---- positions -------------------------------------------------------------
  const nftId = (id) => String(id).replace(/^v4-/, "");
  const isV4 = (id) => String(id).startsWith("v4-");

  async function positionHistory({ wallet = null, includeClosed = true, days = null } = {}) {
    const [pos, watch, hist] = await Promise.all([get("/api/positions"), get("/api/watch").catch(() => null), get("/api/history")]);
    const hours = priceLog();
    const ledger = readJson(path.join(dir, "liquidity-ledger.json"), { tokens: {} }).tokens || {};
    const rangeLog = readJson(path.join(dir, "range-log.json"), { positions: {} }).positions || {};
    const basis = readJson(path.join(dir, "watch-pnl-basis.json"), {});
    // Collect-time price records (fee-prices.json: tx:tokenId -> {p0, p1, w, t}) per position, for
    // pricing deposits made before the hourly log existed.
    const feePx = readJson(path.join(dir, "fee-prices.json"), {});
    const pxByPos = new Map();
    for (const [k, v] of Object.entries(feePx)) {
      const id = k.split(":")[1];
      if (!id || !v || !v.t) continue;
      if (!pxByPos.has(id)) pxByPos.set(id, []);
      pxByPos.get(id).push(v);
    }
    /** USD prices of a position's pair at t: the hourly log (exact), else the nearest collect-time record, else the log within 7 days. */
    const pairPricesAt = (id, t0, t1, t) => {
      const a = priceAt(hours, t0.address, t), b = priceAt(hours, t1.address, t);
      if (a != null && b != null) return { p0: a, p1: b, approx: false };
      const recs = pxByPos.get(nftId(id)) || pxByPos.get(`v4-${nftId(id)}`) || [];
      let best = null;
      for (const r of recs) { const d = Math.abs(r.t - t); if (!best || d < best.d) best = { r, d }; }
      if (best) return { p0: best.r.p0, p1: best.r.p1, approx: true, source: `collect-time record ${round(best.d / HOUR, 1)}h away` };
      let bh = null;
      for (const h of Object.keys(hours)) { const d = Math.abs(Number(h) - t); if (d <= 7 * 86400000 && (!bh || d < bh.d)) bh = { h, d }; }
      if (bh) {
        const row = hours[bh.h];
        const k0 = t0.address === ethers.ZeroAddress || t0.address.toLowerCase() === WETH ? "eth" : t0.address.toLowerCase() === STABLE ? null : t0.address.toLowerCase();
        const k1 = t1.address === ethers.ZeroAddress || t1.address.toLowerCase() === WETH ? "eth" : t1.address.toLowerCase() === STABLE ? null : t1.address.toLowerCase();
        const q0 = k0 === null ? 1 : row[k0], q1 = k1 === null ? 1 : row[k1];
        if (q0 > 0 && q1 > 0) return { p0: q0, p1: q1, approx: true, source: `hourly log ${round(bh.d / HOUR, 1)}h away` };
      }
      return null;
    };
    const now = Date.now();
    const since = days ? now - days * 86400000 : null;

    const wallets = [{ label: pos.ownerLabel || "Main", address: pos.owner, main: true, open: pos.positions || [], closedIds: (pos.closed || []).map((c) => ({ id: c.tokenId, version: c.version || 3, pair: c.pair })) }];
    for (const w of (watch && watch.wallets) || []) {
      if (!w.ok) continue;
      const v4ids = readJson(path.join(dir, `v4-positions-${w.address.toLowerCase()}.json`), { ids: [] }).ids || [];
      const openIds = new Set((w.positions || []).map((p) => String(p.tokenId)));
      wallets.push({ label: w.label || w.address, address: w.address, main: false, open: w.positions || [],
        closedIds: v4ids.filter((id) => !openIds.has(`v4-${id}`)).map((id) => ({ id: `v4-${id}`, version: 4, pair: null })) });
    }
    // Positions that collected but are not open any more (watched v3, for instance) come from the history rows.
    const rowsByPos = new Map();
    for (const r of hist.rows || []) {
      const key = `${(r.walletAddress || pos.owner).toLowerCase()}:${r.tokenId}`;
      if (!rowsByPos.has(key)) rowsByPos.set(key, []);
      rowsByPos.get(key).push(r);
    }
    for (const w of wallets) {
      const known = new Set([...w.open.map((p) => String(p.tokenId)), ...w.closedIds.map((c) => String(c.id))]);
      for (const [key, rs] of rowsByPos) {
        const [addr, id] = key.split(":");
        if (addr !== w.address.toLowerCase() || known.has(id)) continue;
        w.closedIds.push({ id, version: isV4(id) ? 4 : 3, pair: rs[0].pair });
      }
    }

    const out = [];
    for (const w of wallets) {
      if (wallet && ![w.label, w.address].some((x) => String(x).toLowerCase() === String(wallet).toLowerCase())) continue;
      const build = async (id, open, meta) => {
        // Token metadata (symbols, decimals, tier) for closed positions comes from the chain via the server.
        if (!open && metaFor) {
          try { const m = await metaFor(isV4(id) ? `v4-${nftId(id)}` : nftId(id)); meta = { ...(meta || {}), token0: m.t0, token1: m.t1, fee: m.fee, pair: (meta && meta.pair) || `${m.t0.symbol}/${m.t1.symbol}` }; } catch {}
        }
        const rows = rowsByPos.get(`${w.address.toLowerCase()}:${id}`) || [];
        const fees = rows.filter((r) => !r.principal);
        const collectedUsd = fees.reduce((s, r) => s + (r.usd || 0), 0) + rows.filter((r) => r.principal).reduce((s, r) => s + (r.usd || 0), 0);
        const rl = rangeLog[id] || rangeLog[nftId(id)];
        let inRangeMs = 0, trackedMs = 0, flips = 0;
        if (rl && rl.segments) {
          for (const sgm of rl.segments) {
            const len = Math.max(0, (sgm.to || sgm.last || now) - sgm.from);
            trackedMs += len;
            if (sgm.inRange) inRangeMs += len;
          }
          flips = Math.max(0, rl.segments.length - 1);
        }
        // Life: deposits/withdrawals from the liquidity ledger (v3), the watched-wallet basis, or the live PnL legs.
        const lg = ledger[nftId(id)];
        let openedAt = null, closedAt = null, depositedUsd = null, withdrawnUsd = null, depositSource = null;
        if (open && open.pnlLegs) {
          depositedUsd = open.pnlLegs.deposited; withdrawnUsd = open.pnlLegs.withdrawn; openedAt = open.pnlSince || null; depositSource = open.pnlSource || "ledger";
        }
        if (lg && lg.events && lg.events.length && open == null) {
          const t0 = meta && meta.token0, t1 = meta && meta.token1;
          let dep = 0, wd = 0, priced = true, approx = false, how = null;
          for (const e of lg.events) {
            const px = t0 && t1 ? pairPricesAt(id, t0, t1, e.t) : null;
            const usd = px ? Number(ethers.formatUnits(e.a0, t0.decimals)) * px.p0 + Number(ethers.formatUnits(e.a1, t1.decimals)) * px.p1 : null;
            if (usd == null) priced = false;
            else if (px.approx) { approx = true; how = how || px.source; }
            if (e.type === "inc") { dep += usd || 0; if (!openedAt || e.t < openedAt) openedAt = e.t; }
            else { wd += usd || 0; if (!closedAt || e.t > closedAt) closedAt = e.t; }
          }
          if (priced) { depositedUsd = dep; withdrawnUsd = wd; depositSource = approx ? `ledger, priced approximately (${how})` : "ledger, priced from the hourly log"; }
          else { openedAt = openedAt || null; depositSource = "ledger (amounts known, no price record for the time)"; }
        }
        const b = basis[`${isV4(id) ? 4 : 3}-${nftId(id)}`];
        if (!openedAt && b) openedAt = b.t;
        if (!openedAt && rows.length) openedAt = Math.min(...rows.map((r) => r.t || now));
        if (!open && !closedAt) {
          // Last time anything was seen of it: the last collect or the range log's last observation.
          const cands = rows.map((r) => r.t || 0);
          if (rl && rl.segments && rl.segments.length) cands.push(rl.segments[rl.segments.length - 1].to || rl.segments[rl.segments.length - 1].last || 0);
          closedAt = cands.length ? Math.max(...cands) || null : null;
        }
        const end = open ? now : closedAt;
        const hoursOpen = openedAt && end ? (end - openedAt) / HOUR : null;
        const realizedAprPct = depositedUsd > 0 && hoursOpen > 0 ? (collectedUsd / depositedUsd) * (8760 / hoursOpen) * 100 : null;
        const rec = {
          wallet: w.label, walletAddress: w.address, tokenId: nftId(id), version: isV4(id) ? 4 : 3,
          pair: (open && open.pair) || (meta && meta.pair) || (rows[0] && rows[0].pair) || null,
          feeTier: open ? open.feeTierLabel : meta && meta.fee != null ? `${(meta.fee / 10000).toFixed(meta.fee % 10000 === 0 ? 0 : 2)}%` : null, hooks: open ? open.hooks || null : null,
          status: open ? "open" : "closed",
          openedAt: openedAt ? new Date(openedAt).toISOString() : null,
          closedAt: closedAt ? new Date(closedAt).toISOString() : null,
          hoursOpen: round(hoursOpen, 1),
          range: open ? { lower: open.priceLower, upper: open.priceUpper, current: open.priceCurrent, unit: `${open.symbol1} per ${open.symbol0}`, widthPct: open.priceLower > 0 ? round((open.priceUpper / open.priceLower - 1) * 100, 1) : null, inRange: open.inRange, pctToUpperEdge: round(open.toUpperPct, 1), pctToLowerEdge: round(open.toLowerPct, 1) } : null,
          timeInRange: trackedMs > 0 ? { pctInRange: round((inRangeMs / trackedMs) * 100, 1), trackedHours: round(trackedMs / HOUR, 1), flips } : null,
          depositedUsd: round(depositedUsd), withdrawnUsd: round(withdrawnUsd), depositSource,
          collects: { count: fees.length, usd: round(collectedUsd), unpricedRows: rows.filter((r) => r.usd == null).length,
            last: rows.length ? new Date(Math.max(...rows.map((r) => r.t || 0))).toISOString() : null,
            perDayUsd: hoursOpen > 0 ? round(collectedUsd / (hoursOpen / 24)) : null },
          realizedFeeAprPct: round(realizedAprPct, 1),
          open: open ? { valueUsd: round(open.valueUsd), uncollectedUsd: round(open.feesUsd), accrualUsdPerDay: round(open.dailyUsd), currentAprPct: round(open.aprPct, 1),
            pnlVsHoldUsd: round(open.pnlUsd), pnlVsHoldPct: round(open.pnlPct, 1), pnlApprox: !!open.pnlApprox, pnlSource: open.pnlSource || null, pnlLegs: open.pnlLegs || null,
            pool: open.pool ? { name: open.pool.name, tvl: round(open.pool.tvl), vol24h: round(open.pool.vol24h), fees24h: round(open.pool.fees24h), aprPct: round(open.pool.aprPct, 1) } : null } : null,
          closed: !open ? { netFeesUsd: round(collectedUsd), principalReturnedUsd: round(withdrawnUsd), resultVsDepositUsd: depositedUsd != null && withdrawnUsd != null ? round(withdrawnUsd + collectedUsd - depositedUsd) : null } : null,
        };
        if (since && (end || now) < since) return;
        out.push(rec);
      };
      for (const p of w.open) await build(String(p.tokenId), p, null);
      if (includeClosed) for (const c of w.closedIds) await build(String(c.id), null, { pair: c.pair, token0: null, token1: null });
    }
    out.sort((a, b) => (b.openedAt || "").localeCompare(a.openedAt || ""));
    const summary = {
      positions: out.length, open: out.filter((p) => p.status === "open").length, closed: out.filter((p) => p.status === "closed").length,
      collectedUsd: round(out.reduce((s, p) => s + (p.collects.usd || 0), 0)),
      byWallet: Object.values(out.reduce((m, p) => { const k = p.wallet; m[k] = m[k] || { wallet: k, positions: 0, collectedUsd: 0 }; m[k].positions++; m[k].collectedUsd += p.collects.usd || 0; return m; }, {})).map((x) => ({ ...x, collectedUsd: round(x.collectedUsd) })),
    };
    return { ok: true, asOf: new Date(now).toISOString(), summary, positions: out,
      notes: ["collects.usd is valued at collect time when a price record exists (see unpricedRows).", "pnlApprox: the deposit basis was taken when the dashboard first saw the position, not at the mint; treat that PnL as indicative.", "realizedFeeAprPct = collected fees / deposited, annualised over hoursOpen.", "Closed v4 positions have no deposit ledger yet; their fees and collects are exact, PnL needs the deposit."] };
  }

  // ---- prices ----------------------------------------------------------------
  async function priceHistory({ token, days = 7, stepHours = 1 } = {}) {
    const hours = priceLog();
    const q = String(token || "").trim();
    if (!q) throw new Error("token (symbol or address) is required");
    let addr = null, symbol = q;
    if (/^eth$|^weth$/i.test(q)) { addr = "eth"; symbol = "ETH"; }
    else if (/^usdg$/i.test(q)) return { ok: true, token: "USDG", note: "the reference stable, 1.00 by definition", points: [] };
    else if (ethers.isAddress(q)) addr = q.toLowerCase();
    else {
      // Resolve a symbol through the views the dashboard already holds.
      const [pos, watch, pf] = await Promise.all([get("/api/positions").catch(() => null), get("/api/watch").catch(() => null), get("/api/portfolio").catch(() => null)]);
      const cands = [];
      for (const p of (pos && pos.positions) || []) { cands.push([p.symbol0, p.token0 && (p.token0.address || p.token0)]); cands.push([p.symbol1, p.token1 && (p.token1.address || p.token1)]); }
      for (const w of (watch && watch.wallets) || []) {
        for (const p of w.positions || []) { cands.push([p.symbol0, p.token0]); cands.push([p.symbol1, p.token1]); }
        for (const t of (w.holdings && w.holdings.tokens) || []) cands.push([t.symbol, t.address]);
      }
      for (const r of (pf && pf.rows) || []) cands.push([r.symbol, r.address]);
      const hit = cands.find(([s, a]) => s && a && s.toLowerCase() === q.toLowerCase());
      if (!hit) throw new Error(`unknown token symbol ${q}; pass the contract address`);
      addr = String(hit[1]).toLowerCase(); symbol = hit[0];
      if (addr === WETH) addr = "eth";
    }
    const since = Date.now() - days * 86400000;
    const step = Math.max(1, Math.round(stepHours));
    const points = [];
    let i = 0;
    for (const h of Object.keys(hours).sort()) {
      if (Number(h) < since) continue;
      const v = hours[h][addr];
      if (v == null) continue;
      if (i++ % step) continue;
      points.push({ t: new Date(Number(h)).toISOString(), usd: v, ...(addr !== "eth" && hours[h].eth ? { perEth: round(v / hours[h].eth, 10), tokensPerEth: round(hours[h].eth / v, 2) } : {}) });
    }
    const first = points[0], last = points[points.length - 1];
    return { ok: true, token: symbol, address: addr === "eth" ? "native ETH / WETH" : addr, days, stepHours: step, points,
      changePct: first && last ? round((last.usd / first.usd - 1) * 100, 1) : null, note: "Hourly prices as the dashboard saw them (pool-derived); tokens are logged only while held or in a position." };
  }

  // ---- token lots (cost basis of fee tokens handed back) ---------------------
  /**
   * Every fee token the collector handed back unconverted (no swap route, or
   * over the swap cap): one lot per hand-back, from collector.log, with the
   * USD price of that hour, so the basis of what you hold (LAPTOP, Bucket,
   * CRUMBS, ...) is on record for the day you sell. Tokens the collector
   * swapped (ETH, WETH, USDG, and anything with a v3 route) are already income.
   */
  function handBacks() {
    let lines = [];
    try { lines = fs.readFileSync(path.join(dir, "collector.log"), "utf8").split("\n"); } catch { return []; }
    const out = [];
    let owner = { label: "Main", address: cfg.ownerAddress };
    let pending = null;
    for (const line of lines) {
      let m;
      if ((m = line.match(/\] --- (.+?) \((0x[0-9a-fA-F]{40})\) ---$/))) owner = { label: m[1], address: m[2] };
      else if ((m = line.match(/\] === (.+?): done ===$/))) owner = { label: "Main", address: cfg.ownerAddress };
      else if ((m = line.match(/! (.+?); sending ([\d.]+) (\S+) to (0x[0-9a-fA-F]{40}) as-is$/))) pending = { why: m[1], amount: Number(m[2]), token: m[3], to: m[4], t: Date.parse(line.slice(1, 25)) };
      else if (pending && (m = line.match(/\] +sent (\S+) -> (0x[0-9a-fA-F]{40}) -> (0x[0-9a-fA-F]{64})$/)) && m[1] === pending.token) {
        out.push({ ...pending, tx: m[3], wallet: owner.address.toLowerCase() === pending.to.toLowerCase() ? owner.label : pending.to });
        pending = null;
      }
    }
    return out;
  }

  async function tokenLots({ token = null, wallet = null, days = null } = {}) {
    const [hist, pos, watch, pf] = await Promise.all([get("/api/history").catch(() => null), get("/api/positions").catch(() => null), get("/api/watch").catch(() => null), get("/api/portfolio").catch(() => null)]);
    const hours = priceLog();
    const latestHour = Object.keys(hours).sort().pop();
    const latest = latestHour ? hours[latestHour] : {};
    const since = days ? Date.now() - days * 86400000 : null;
    // symbol -> address from the live views and the v4 ledger, for prices
    const addrOf = new Map();
    for (const p of (pos && pos.positions) || []) { addrOf.set(p.symbol0, (p.token0 && (p.token0.address || p.token0)) || null); addrOf.set(p.symbol1, (p.token1 && (p.token1.address || p.token1)) || null); }
    for (const w of (watch && watch.wallets) || []) {
      for (const p of w.positions || []) { addrOf.set(p.symbol0, p.token0); addrOf.set(p.symbol1, p.token1); }
      for (const t of (w.holdings && w.holdings.tokens) || []) if (t.address) addrOf.set(t.symbol, t.address);
    }
    for (const r of (pf && pf.rows) || []) if (r.address) addrOf.set(r.symbol, r.address);
    for (const r of readJson(path.join(dir, "v4-collects.json"), [])) for (const t of [r.t0, r.t1]) if (t && t.address && t.address !== ethers.ZeroAddress && !addrOf.has(t.symbol)) addrOf.set(t.symbol, t.address);
    // collect-time price records per symbol (from the priced history rows), for hours the log lacks
    const recs = new Map();
    for (const r of (hist && hist.rows) || []) if (r.locked) { if (r.p0 != null) (recs.get(r.sym0) || recs.set(r.sym0, []).get(r.sym0)).push({ t: r.t, p: r.p0 }); if (r.p1 != null) (recs.get(r.sym1) || recs.set(r.sym1, []).get(r.sym1)).push({ t: r.t, p: r.p1 }); }
    const priceFor = (sym, t) => {
      const a = addrOf.get(sym);
      const fromLog = a ? priceAt(hours, a, t) : null;
      if (fromLog != null) return { p: fromLog, basis: "hourly log" };
      let best = null;
      for (const r of recs.get(sym) || []) { const d = Math.abs(r.t - t); if (d <= 6 * HOUR && (!best || d < best.d)) best = { r, d }; }
      return best ? { p: best.r.p, basis: `collect-time record ${round(best.d / HOUR, 1)}h away` } : null;
    };
    const heldNow = new Map();
    for (const w of (watch && watch.wallets) || []) for (const t of (w.holdings && w.holdings.tokens) || []) { const h = heldNow.get(t.symbol) || { balance: 0, price: null }; h.balance += t.balance || 0; if (t.price != null) h.price = t.price; heldNow.set(t.symbol, h); }
    for (const r of (pf && pf.rows) || []) { const h = heldNow.get(r.symbol) || { balance: 0, price: null }; h.balance += r.balance || 0; if (r.price != null) h.price = r.price; heldNow.set(r.symbol, h); }

    const lots = [];
    for (const h of handBacks()) {
      if (since && h.t < since) continue;
      if (wallet && ![h.wallet, h.to].some((x) => x && String(x).toLowerCase() === String(wallet).toLowerCase())) continue;
      if (token && h.token.toLowerCase() !== String(token).toLowerCase()) continue;
      const px = priceFor(h.token, h.t);
      lots.push({ t: new Date(h.t).toISOString(), wallet: h.wallet, token: h.token, amount: h.amount, usdPerToken: px ? +Number(px.p).toPrecision(6) : null, usd: px ? round(h.amount * px.p, 4) : null, basis: px ? px.basis : "no price record", reason: h.why, tx: h.tx });
    }
    const byToken = {};
    for (const l of lots) {
      const b = byToken[l.token] || (byToken[l.token] = { token: l.token, lots: 0, amount: 0, basisUsd: 0, unpriced: 0, first: l.t, last: l.t });
      b.lots++; b.amount += l.amount; if (l.usd != null) b.basisUsd += l.usd; else b.unpriced++;
      if (l.t < b.first) b.first = l.t; if (l.t > b.last) b.last = l.t;
    }
    const summary = Object.values(byToken).map((b) => {
      const addr = addrOf.get(b.token);
      const now = heldNow.get(b.token);
      const price = (now && now.price) ?? (addr && latest[String(addr).toLowerCase()]) ?? null;
      const priced = b.amount > 0 && b.basisUsd > 0 && b.unpriced === 0;
      return { ...b, amount: round(b.amount, 6), basisUsd: round(b.basisUsd), avgCostUsd: priced ? +(b.basisUsd / b.amount).toPrecision(6) : null,
        priceNowUsd: price != null ? +Number(price).toPrecision(6) : null, valueNowUsd: price != null ? round(b.amount * price) : null,
        unrealizedUsd: price != null && priced ? round(b.amount * price - b.basisUsd) : null,
        stillHeld: now ? round(now.balance, 6) : null };
    }).sort((a, b) => (b.basisUsd || 0) - (a.basisUsd || 0));
    return { ok: true, asOf: new Date().toISOString(), tokens: summary, lots: lots.sort((a, b) => a.t.localeCompare(b.t)),
      notes: ["A lot is one hand-back of a fee token the collector could not swap (collector.log); its basis is the USD price of that hour. Selling later realizes the gain or loss against this basis.",
        "stillHeld is the wallet balance now (all sources), which can differ from the lots total if you bought, sold or moved the token.", "Tokens the collector swapped at collect time (ETH, WETH, USDG, and anything with a v3 route) are already counted as income."] };
  }

  // ---- pool scout ------------------------------------------------------------
  function scoutHistory({ days = 30 } = {}) {
    const log = readJson(path.join(dir, "pool-scout-log.json"), []);
    const since = Date.now() - days * 86400000;
    const rows = log.filter((r) => r.t >= since).map((r) => ({ t: new Date(r.t).toISOString(), wallet: r.wallet, tokenId: r.tokenId, pair: r.pair, ownAprPct: round(r.ownApr, 1), bestSibling: r.best, bestAprPct: round(r.bestApr, 1), bestTvl: round(r.bestTvl), beats: !!r.beats, streakDays: r.streakDays }));
    return { ok: true, days, rows, note: "Hourly comparison of each position's pool fee APR against its best sibling pool (same pair, other tier or version)." };
  }

  return { positionHistory, priceHistory, scoutHistory, tokenLots };
}

module.exports = { create };
