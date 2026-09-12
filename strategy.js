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

/**
 * Disposals of held lots: token-disposals.json (outbound transfers found by the
 * disposal scan, kind "sent", and any future batch sale, kind "sold"). Sales the
 * collector makes at collect time (token-sales.json) are NOT disposals: those
 * tokens were sold before they were handed back, so they never became lots.
 */
function readDisposals(dir) {
  const rows = readJson(path.join(dir, "token-disposals.json"), { rows: [] }).rows;
  // kind "received" rows are inbound flows (attribution), not disposals of lots.
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => (r.kind || "sent") !== "received")
    .map((r) => ({ t: r.t, token: r.token, amount: Number(r.amount) || 0, usd: r.usd != null ? Number(r.usd) : null, tx: r.tx || null, kind: r.kind || "sent", to: r.to || null }));
}

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const V4_SWAP_TOPIC = ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const V4_SWAP_IFACE = new ethers.Interface(["event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"]);
/** Two raw amounts within 1e-9 of each other (a stored amount is a double, the log is exact). */
const nearRaw = (a, b) => { if (a === b) return true; const [x, y] = a > b ? [a, b] : [b, a]; return x > 0n && ((x - y) * 1000000000n) / x === 0n; };
/** A hop's input may be up to 10% under the previous hop's output: an intermediate token with a transfer tax loses a slice between pools. */
const feedsFrom = (paid, out) => nearRaw(paid, out) || (paid <= out && paid >= (out * 90n) / 100n);

/**
 * What a sale through a router actually brought back, from the receipt's logs.
 * Only tokens the logs can name count: USDG transferred to the wallet, WETH
 * transferred to the wallet, and WETH unwrapped (burned) for it. When none of
 * those appear (a native-ETH v4 pool pays ETH without a log) the swap chain is
 * followed from the token's own leg to its last hop and that output is read as
 * ETH. A first hop's intermediate token is never taken for ETH (a multi-hop
 * LAPTOP → X → USDG → WETH once valued 0.25 ETH of proceeds as 6 ETH). Any
 * result more than 3x away from the hourly price is an unmatched leg and the
 * hourly price wins. Returns { sold, usd, priced } — usd null when nothing prices.
 */
function proceedsFromReceipt({ logs, wallet, tokenRaw, ethPx, weth, stable, refUsd = null, tokenAddr = null }) {
  wallet = String(wallet).toLowerCase(); weth = String(weth || "").toLowerCase(); stable = String(stable || "").toLowerCase();
  const swaps = (logs || []).filter((l) => l.topics && l.topics[0] === V4_SWAP_TOPIC);
  if (!swaps.length) return { sold: false };
  const xfers = (logs || []).filter((l) => l.topics && l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3).map((l) => ({ token: String(l.address).toLowerCase(), from: ("0x" + l.topics[1].slice(26)).toLowerCase(), to: ("0x" + l.topics[2].slice(26)).toLowerCase(), amount: BigInt(l.data || "0x0") }));
  // One transaction can move the token out of the wallet in several transfers (a sell in
  // slices); each row gets its share of what came back, and the swap chain starts from the total.
  const outTotal = tokenAddr ? xfers.filter((x) => x.token === String(tokenAddr).toLowerCase() && x.from === wallet).reduce((s, x) => s + x.amount, 0n) : 0n;
  const share = outTotal > tokenRaw && !nearRaw(outTotal, tokenRaw) ? Number(tokenRaw) / Number(outTotal) : 1;
  let usd = null, how = [], units = { usdg: 0n, eth: 0n };
  const usdgIn = xfers.filter((x) => x.token === stable && x.to === wallet).reduce((s, x) => s + x.amount, 0n);
  if (usdgIn > 0n) { usd = Number(ethers.formatUnits(usdgIn, 6)); how.push("usdg"); units.usdg = usdgIn; }
  const wethIn = xfers.filter((x) => x.token === weth && (x.to === wallet || x.to === ethers.ZeroAddress)).reduce((s, x) => s + x.amount, 0n);
  if (wethIn > 0n && ethPx != null) { usd = (usd || 0) + Number(ethers.formatEther(wethIn)) * ethPx; how.push("eth"); units.eth = wethIn; }
  if (usd == null && ethPx != null) {
    // Follow the chain: the hop that took the token, then each hop that took the previous output.
    const legs = swaps.map((l) => { const ev = V4_SWAP_IFACE.parseLog(l); return [ev.args.amount0, ev.args.amount1]; });
    const abs = (x) => (x < 0n ? -x : x);
    let paid = outTotal > tokenRaw ? outTotal : tokenRaw, out = null;
    const used = new Set();
    for (let guard = 0; guard < legs.length; guard++) {
      // The first hop must take the wallet's exact amount; later hops may take a taxed slice of the previous output.
      const match = guard === 0 ? nearRaw : feedsFrom;
      let i = legs.findIndex((leg, j) => !used.has(j) && ((leg[0] < 0n && match(abs(leg[0]), paid)) || (leg[1] < 0n && match(abs(leg[1]), paid))));
      if (i < 0 && guard === 0 && paid !== tokenRaw) { paid = tokenRaw; i = legs.findIndex((leg, j) => (leg[0] < 0n && nearRaw(abs(leg[0]), paid)) || (leg[1] < 0n && nearRaw(abs(leg[1]), paid))); }
      if (i < 0) break;
      used.add(i);
      const leg = legs[i];
      out = leg[0] < 0n && match(abs(leg[0]), paid) ? leg[1] : leg[0];
      if (out <= 0n) { out = null; break; }
      paid = out;
    }
    if (out != null && out > 0n) { usd = Number(ethers.formatEther(out)) * ethPx; how.push("eth (last hop)"); units.eth = out; }
  }
  // The route's shape, for the ledger audit: a shape never seen before is worth a look before its valuation is trusted.
  const shape = `${swaps.length}hop:${usdgIn > 0n ? "usdg" : ""}${wethIn > 0n ? "+weth" : ""}${units.eth > 0n && wethIn === 0n ? "+native" : ""}${share < 1 ? "+split" : ""}`.replace(/:\+/, ":") || null;
  const scaled = (x) => (share < 1 ? (x * BigInt(Math.round(share * 1e9))) / 1000000000n : x);
  const unitsOut = { usdg: scaled(units.usdg).toString(), eth: scaled(units.eth).toString() };
  if (usd != null && share < 1) { usd *= share; how.push(`${Math.round(share * 100)}% of the tx`); }
  if (usd != null && refUsd > 0 && (usd > 3 * refUsd || usd < refUsd / 3)) return { sold: true, usd: round(refUsd, 4), priced: `hourly log (proceeds unmatched: ${how.join("+") || "none"} gave $${round(usd, 2)})`, shape, units: null };
  if (usd == null && refUsd != null) return { sold: true, usd: round(refUsd, 4), priced: "hourly log", shape, units: null };
  return { sold: true, usd: usd != null ? round(usd, 4) : null, priced: how.join("+") || null, shape, units: usd != null ? unitsOut : null };
}

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
    // v4 liquidity changes live in their own ledger (ledger-v4.js), keyed by bare id there;
    // merged here under the v4- prefix so a v3 and a v4 position with the same number never collide.
    for (const [id, e] of Object.entries(readJson(path.join(dir, "v4-liquidity-ledger.json"), { tokens: {} }).tokens || {})) ledger[`v4-${id}`] = e;
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
        const lg = isV4(id) ? ledger[id] : ledger[nftId(id)];
        let openedAt = null, closedAt = null, depositedUsd = null, withdrawnUsd = null, depositSource = null;
        if (open && open.pnlLegs) {
          depositedUsd = open.pnlLegs.deposited; withdrawnUsd = open.pnlLegs.withdrawn; openedAt = open.pnlSince || null; depositSource = open.pnlSource || "ledger";
        }
        if (lg && lg.events && lg.events.length && open == null) {
          const t0 = meta && meta.token0, t1 = meta && meta.token1;
          let dep = 0, wd = 0, priced = true, approx = false, how = null;
          for (const e of lg.events) {
            if (e.priced === false) { priced = false; continue; } // v4 row without a pool price at its block: no amounts to value
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
    // Disposals consume lots FIFO per token. Each lot keeps its received amount;
    // disposed / remaining / proceeds / realized are tracked alongside.
    for (const l of lots) { l.received = l.amount; l.disposedAmount = 0; l.remainingAmount = l.amount; l.proceedsUsd = 0; l.realizedUsd = 0; l.disposalKind = null; l.disposalTx = null; }
    const disposedByToken = {}; // token -> { disposedAmount, proceedsUsd, realizedUsd, unpricedDisposals }
    {
      const byTok = {};
      for (const d of readDisposals(dir)) {
        if (since && d.t < since) continue;
        if (token && String(d.token).toLowerCase() !== String(token).toLowerCase()) continue;
        (byTok[d.token] || (byTok[d.token] = [])).push(d);
      }
      for (const [tok, ds] of Object.entries(byTok)) {
        const ls = lots.filter((l) => l.token === tok).sort((a, b) => a.t.localeCompare(b.t));
        const acc = (disposedByToken[tok] = { disposedAmount: 0, proceedsUsd: 0, realizedUsd: 0, unpricedDisposals: 0 });
        let li = 0;
        for (const d of ds.sort((a, b) => (a.t || 0) - (b.t || 0))) {
          let left = d.amount;
          // A disposal can only consume lots received before it; earlier transfers were other holdings of the token.
          while (left > 0 && li < ls.length && Date.parse(ls[li].t) <= (d.t || 0)) {
            const lot = ls[li];
            const take = Math.min(left, lot.remainingAmount);
            const basisPer = lot.usd != null && lot.received > 0 ? lot.usd / lot.received : null;
            const proceeds = d.usd != null && d.amount > 0 ? (d.usd / d.amount) * take : null;
            if (proceeds == null) acc.unpricedDisposals++;
            const realized = basisPer != null && proceeds != null ? proceeds - basisPer * take : null;
            lot.disposedAmount += take; lot.remainingAmount -= take;
            lot.proceedsUsd += proceeds || 0; lot.realizedUsd += realized || 0;
            lot.disposalKind = d.kind; lot.disposalTx = d.tx;
            acc.disposedAmount += take; acc.proceedsUsd += proceeds || 0; acc.realizedUsd += realized || 0;
            left -= take;
            if (lot.remainingAmount <= 1e-12) { lot.remainingAmount = 0; li++; }
          }
        }
      }
    }
    const byToken = {};
    for (const l of lots) {
      const b = byToken[l.token] || (byToken[l.token] = { token: l.token, lots: 0, amount: 0, basisUsd: 0, unpriced: 0, first: l.t, last: l.t, remainingAmount: 0, remainingBasisUsd: 0 });
      b.lots++; b.amount += l.received; if (l.usd != null) b.basisUsd += l.usd; else b.unpriced++;
      b.remainingAmount += l.remainingAmount; if (l.usd != null && l.received > 0) b.remainingBasisUsd += (l.usd / l.received) * l.remainingAmount;
      if (l.t < b.first) b.first = l.t; if (l.t > b.last) b.last = l.t;
    }
    const summary = Object.values(byToken).map((b) => {
      const addr = addrOf.get(b.token);
      const now = heldNow.get(b.token);
      let price = (now && now.price) ?? (addr && latest[String(addr).toLowerCase()]) ?? null;
      let priceNote = null;
      // A drained pool yields a price of effectively zero; that is no price, not a value.
      if (price != null && !(price > 1e-12)) { priceNote = `pool price ${Number(price).toExponential(2)} is below any sane floor (drained pool)`; price = null; }
      const priced = b.amount > 0 && b.basisUsd > 0 && b.unpriced === 0;
      const disp = disposedByToken[b.token] || { disposedAmount: 0, proceedsUsd: 0, realizedUsd: 0, unpricedDisposals: 0 };
      return { ...b, amount: round(b.amount, 6), basisUsd: round(b.basisUsd), avgCostUsd: priced ? +(b.basisUsd / b.amount).toPrecision(6) : null,
        priceNowUsd: price != null ? +Number(price).toPrecision(6) : null, valueNowUsd: price != null ? round(b.remainingAmount * price) : null,
        unrealizedUsd: price != null && priced ? round(b.remainingAmount * price - b.remainingBasisUsd) : null,
        disposedAmount: round(disp.disposedAmount, 6), proceedsUsd: disp.disposedAmount > 0 ? round(disp.proceedsUsd) : null,
        realizedUsd: disp.disposedAmount > 0 && priced ? round(disp.realizedUsd) : null, unpricedDisposals: disp.unpricedDisposals,
        remainingAmount: round(b.remainingAmount, 6), remainingBasisUsd: round(b.remainingBasisUsd),
        stillHeld: now ? round(now.balance, 6) : null, priceNote };
    }).sort((a, b) => (b.basisUsd || 0) - (a.basisUsd || 0));
    // Sales made at collect time (sell-v4.js, token-sales.json): those tokens never became lots; report them alongside.
    const salesRows = readJson(path.join(dir, "token-sales.json"), []).filter((r) => !since || r.t >= since);
    const sales = {};
    for (const r of salesRows) {
      if (token && String(r.token).toLowerCase() !== String(token).toLowerCase()) continue;
      const b = sales[r.token] || (sales[r.token] = { token: r.token, sales: 0, amountSold: 0, proceedsUsd: 0, skips: 0, lastSkipReason: null });
      if (r.skipped) { b.skips++; b.lastSkipReason = r.reason; continue; }
      b.sales++; b.amountSold += Number(r.amount) || 0; b.proceedsUsd += Number(r.usd) || 0;
    }
    return { ok: true, asOf: new Date().toISOString(), tokens: summary,
      lots: lots.sort((a, b) => a.t.localeCompare(b.t)).map((l) => ({
        t: l.t, wallet: l.wallet, token: l.token, amount: round(l.received, 6), usdPerToken: l.usdPerToken, usd: l.usd, basis: l.basis, reason: l.reason, tx: l.tx,
        disposedAmount: round(l.disposedAmount, 6), remainingAmount: round(l.remainingAmount, 6), proceedsUsd: l.disposedAmount > 0 ? round(l.proceedsUsd) : null, realizedUsd: l.disposedAmount > 0 && l.usd != null ? round(l.realizedUsd) : null,
        disposalKind: l.disposalKind, disposalTx: l.disposalTx,
      })),
      soldAtCollect: Object.values(sales).map((b) => ({ ...b, amountSold: round(b.amountSold, 6), proceedsUsd: round(b.proceedsUsd) })),
      notes: ["A lot is one hand-back of a fee token the collector could not swap (collector.log); its basis is the USD price of that hour. Selling later realizes the gain or loss against this basis.",
        "Disposals consume lots FIFO, and only lots received before the disposal (earlier transfers were other holdings of the token) (token-disposals.json, from the outbound-transfer scan): a transfer into the protocol whose transaction swapped is a sale through a router (kind 'sold'); a transfer to any other address that is not one of your own wallets, the operator or the vault is 'sent'; a transfer into the protocol without a swap is a liquidity deposit and is not a disposal. Both kinds are valued at the hourly price of that hour, not at actual proceeds. realizedUsd = that value minus the disposed lots' basis; unrealized and value now cover the remaining amount only.",
        "soldAtCollect: fee tokens the collector sold in their v4 pool at collect time (token-sales.json); those proceeds are income already and never became lots.",
        "stillHeld is the wallet balance now (all sources), which can differ from the lots total if you bought, sold or moved the token.", "Tokens the collector swapped at collect time (ETH, WETH, USDG, and anything with a v3 route) are already counted as income."] };
  }

  // ---- pool scout ------------------------------------------------------------
  function scoutHistory({ days = 30 } = {}) {
    const log = readJson(path.join(dir, "pool-scout-log.json"), []);
    const since = Date.now() - days * 86400000;
    const rows = log.filter((r) => r.t >= since).map((r) => ({ t: new Date(r.t).toISOString(), wallet: r.wallet, tokenId: r.tokenId, pair: r.pair, ownAprPct: round(r.ownApr, 1), bestSibling: r.best, bestAprPct: round(r.bestApr, 1), bestTvl: round(r.bestTvl), beats: !!r.beats, streakDays: r.streakDays }));
    return { ok: true, days, rows, note: "Hourly comparison of each position's pool fee APR against its best sibling pool (same pair, other tier or version)." };
  }

  // ---- disposal scan (outbound ERC-20 transfers of handed-back tokens) --------
  /**
   * Find where handed-back fee tokens went after they arrived: outbound ERC-20
   * Transfer events of each lot token from each wallet, via Blockscout's log
   * query (address = the token, topic1 = the wallet), cached incrementally in
   * token-disposals.json. A transfer to one of your own addresses (main wallet,
   * watched wallets, the operator, the vault) is a move, not a disposal, and is
   * skipped. Each disposal is valued at the hourly price log for that hour.
   */
  async function scanDisposals({ ownAddresses = [] } = {}) {
    const bs = require("./blockscout");
    const FILE = path.join(dir, "token-disposals.json");
    const state = readJson(FILE, { lastBlock: {}, rows: [] });
    if (!Array.isArray(state.rows)) state.rows = [];
    if (!state.lastBlock || typeof state.lastBlock !== "object") state.lastBlock = {};
    const hours = priceLog();
    const [pos, watch, pf] = await Promise.all([get("/api/positions").catch(() => null), get("/api/watch").catch(() => null), get("/api/portfolio").catch(() => null)]);
    // Tokens that were ever handed back, with address and decimals.
    const tokens = new Map(); // symbol -> { address, decimals }
    const note = (sym, addr, dec) => {
      if (!sym || !addr || addr === ethers.ZeroAddress) return;
      const cur = tokens.get(sym);
      if (!cur) tokens.set(sym, { address: String(addr).toLowerCase(), decimals: dec != null ? Number(dec) : null });
      else if (cur.decimals == null && dec != null) cur.decimals = Number(dec); // a later source may know the decimals
    };
    for (const p of (pos && pos.positions) || []) { note(p.symbol0, p.token0 && (p.token0.address || p.token0), p.token0 && p.token0.decimals); note(p.symbol1, p.token1 && (p.token1.address || p.token1), p.token1 && p.token1.decimals); }
    for (const w of (watch && watch.wallets) || []) for (const t of (w.holdings && w.holdings.tokens) || []) note(t.symbol, t.address, t.decimals);
    for (const r of (pf && pf.rows) || []) note(r.symbol, r.address, r.decimals);
    for (const r of readJson(path.join(dir, "v4-collects.json"), [])) for (const t of [r.t0, r.t1]) if (t) note(t.symbol, t.address, t.decimals);
    const handed = new Set(handBacks().map((h) => h.token));
    const own = new Set([String(cfg.ownerAddress || "").toLowerCase(), ...((watch && watch.wallets) || []).map((w) => String(w.address).toLowerCase()), ...ownAddresses.map((a) => String(a).toLowerCase()), String(cfg.treasuryTBA || "").toLowerCase(), String(cfg.treasuryNFT || "").toLowerCase()].filter(Boolean));
    const wallets = [String(cfg.ownerAddress || "").toLowerCase(), ...((watch && watch.wallets) || []).map((w) => String(w.address).toLowerCase())].filter(Boolean);
    const TRANSFER = ethers.id("Transfer(address,address,uint256)");
    // Transfers into the protocol are liquidity deposits (a move, not a disposal)
    // unless the same transaction swapped: then the wallet sold through a router.
    const protocol = new Set([cfg.contracts.v4 && cfg.contracts.v4.poolManager, cfg.contracts.v4 && cfg.contracts.v4.positionManager, cfg.contracts.positionManager, cfg.contracts.swapRouter02, cfg.contracts.v4 && cfg.contracts.v4.universalRouter, cfg.contracts.v4 && cfg.contracts.v4.permit2].filter(Boolean).map((a) => String(a).toLowerCase()));
    const provider = require("./rpc").createProvider(cfg);
    const stable = String((cfg.usdReference && cfg.usdReference.stable) || "").toLowerCase();
    const codeCache = new Map();
    const isContract = async (a) => { if (!codeCache.has(a)) { try { codeCache.set(a, (await provider.getCode(a)) !== "0x"); } catch { codeCache.set(a, null); } } return codeCache.get(a); };
    /**
     * Did this transaction swap, and what came back? The token leg of the Swap
     * event matches the transferred amount; the other leg is the proceeds: USDG
     * when the wallet received USDG in the same transaction, else native ETH.
     * Returns { sold: true, usd } / { sold: false } / null when the receipt is unavailable.
     */
    const swapProceeds = async (tx, wallet, tokenRaw, t, tokenAddr = null, amount = null) => {
      let r; try { r = await provider.getTransactionReceipt(tx); } catch { return null; }
      if (!r) return null;
      const ethPx = t != null ? priceAt(hours, ethers.ZeroAddress, t) : null;
      const ref = t != null && tokenAddr ? priceAt(hours, tokenAddr, t) : null;
      const refUsd = ref != null && amount != null ? amount * ref : null;
      const sp = proceedsFromReceipt({ logs: r.logs, wallet, tokenRaw, ethPx, weth: WETH, stable, refUsd, tokenAddr });
      if (sp.sold) saveFixture({ tx, wallet, tokenAddr, tokenRaw, t, ethPx, refUsd, logs: r.logs, sp });
      return sp;
    };
    // A route shape the audit has not accepted yet gets its receipt saved as a test fixture
    // (test/fixtures/receipts/<tx>.json); accepting the shape stamps the valuation as the
    // expected result and test/fixtures.test.js replays it through the valuer from then on.
    const known = new Set((readJson(path.join(dir, "ledger-audit.json"), {}).knownShapes) || []);
    const FIX_DIR = path.join(dir, "test", "fixtures", "receipts");
    function saveFixture({ tx, wallet, tokenAddr, tokenRaw, t, ethPx, refUsd, logs, sp }) {
      try {
        if (!sp.shape || known.has(sp.shape)) return;
        const f = path.join(FIX_DIR, `${tx}.json`);
        if (fs.existsSync(f)) return;
        fs.mkdirSync(FIX_DIR, { recursive: true });
        const sym = [...tokens.entries()].find(([, v]) => v.address === String(tokenAddr).toLowerCase());
        fs.writeFileSync(f, JSON.stringify({ tx, wallet, token: sym ? sym[0] : null, tokenAddr, tokenRaw: tokenRaw.toString(), t, ethPx, refUsd, shape: sp.shape, valuation: { usd: sp.usd, priced: sp.priced, units: sp.units }, accepted: false, expected: null,
          logs: logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })) }, null, 1));
      } catch {}
    }
    // Rows valued before the receipt valuer learned multi-hop swaps, split transfers and the
    // audit's units / shape (rev < 4) are re-valued once.
    let revalued = 0;
    for (const r of state.rows) {
      if (r.kind !== "sold" || r.rev >= 6 || revalued >= 60) continue;
      const tk = tokens.get(r.token);
      if (!tk || tk.decimals == null || !r.tx) continue;
      let raw; try { raw = ethers.parseUnits(Number(r.amount).toFixed(Math.min(tk.decimals, 12)), tk.decimals); } catch { continue; }
      const sp = await swapProceeds(r.tx, r.from, raw, r.t, r.tokenAddress || tk.address, r.amount);
      if (sp === null) continue;
      revalued++;
      if (sp.sold) { if (r.usdBefore == null) r.usdBefore = r.usd; r.usd = sp.usd; r.priced = sp.priced; r.shape = sp.shape; r.units = sp.units; }
      r.rev = 6;
    }
    const seen = new Set([...state.rows.map((r) => `${r.tx}:${r.logIndex}`), ...(state.deposits || [])]);
    let added = 0, queries = 0, deposits = 0;
    for (const sym of handed) {
      const tk = tokens.get(sym);
      if (!tk || tk.decimals == null) continue;
      for (const w of wallets) {
        const key = `${tk.address}:${w}`;
        const from = (Number(state.lastBlock[key]) || 0) + 1;
        const query = `module=logs&action=getLogs&fromBlock=${from}&toBlock=latest&address=${tk.address}&topic0=${TRANSFER}&topic1=${ethers.zeroPadValue(w, 32)}&topic0_1_opr=and`;
        let d = null;
        try { const r = await bs.bsFetch(`?${query}`, { timeoutMs: 30000 }); d = await r.json(); } catch { continue; }
        queries++;
        if (!d || !Array.isArray(d.result)) continue;
        let top = Number(state.lastBlock[key]) || 0;
        for (const l of d.result) {
          const k = `${l.transactionHash}:${l.logIndex}`;
          const bn = parseInt(l.blockNumber, 16);
          if (bn > top) top = bn;
          if (seen.has(k) || !l.topics || l.topics.length < 3) continue;
          const to = ("0x" + l.topics[2].slice(26)).toLowerCase();
          if (own.has(to)) continue; // a move between your own addresses
          seen.add(k);
          const t = l.timeStamp ? parseInt(l.timeStamp, 16) * 1000 : null;
          const raw = BigInt(l.data || "0x0");
          const amount = Number(ethers.formatUnits(raw, tk.decimals));
          let kind = "sent", usd = null, priced = null, shape = null, units = null;
          // A transfer to a contract: a swap in the same transaction (Uniswap or a launchpad's own
          // trading contract) makes it a sale, valued from the swap; into the protocol without a
          // swap it is a liquidity deposit, still yours.
          if (protocol.has(to) || (await isContract(to))) {
            const sp = await swapProceeds(l.transactionHash, w, raw, t, tk.address, amount);
            if (sp === null) continue; // receipt unavailable; retried next scan
            if (sp.sold) { kind = "sold"; usd = sp.usd; priced = sp.priced; shape = sp.shape; units = sp.units; }
            else if (protocol.has(to)) { deposits++; (state.deposits || (state.deposits = [])).push(k); continue; }
          }
          if (usd == null) { const px = t != null ? priceAt(hours, tk.address, t) : null; usd = px != null ? round(amount * px, 4) : null; }
          state.rows.push({ t, tx: l.transactionHash, logIndex: l.logIndex, from: w, to, token: sym, tokenAddress: tk.address, amount, usd, kind, priced, shape, units, rev: 6 });
          added++;
        }
        state.lastBlock[key] = top;
        // Inbound transfers (kind "received"): a flow into the wallet from outside our
        // addresses and outside the protocol. topic2 = wallet (the recipient). LP deposits
        // and collects come back from the protocol and are internal moves, not flows, so
        // a sender that is one of our addresses or a protocol contract is skipped.
        const inKey = `${tk.address}:${w}:in`;
        const inFrom = (Number(state.lastBlock[inKey]) || 0) + 1;
        const inQuery = `module=logs&action=getLogs&fromBlock=${inFrom}&toBlock=latest&address=${tk.address}&topic0=${TRANSFER}&topic2=${ethers.zeroPadValue(w, 32)}&topic0_2_opr=and`;
        let inD = null;
        try { const r = await bs.bsFetch(`?${inQuery}`, { timeoutMs: 30000 }); inD = await r.json(); } catch { /* retried next scan */ }
        queries++;
        if (inD && Array.isArray(inD.result)) {
          let inTop = Number(state.lastBlock[inKey]) || 0;
          for (const l of inD.result) {
            const k = `${l.transactionHash}:${l.logIndex}`;
            const bn = parseInt(l.blockNumber, 16);
            if (bn > inTop) inTop = bn;
            if (seen.has(k) || !l.topics || l.topics.length < 3) continue;
            const from = ("0x" + l.topics[1].slice(26)).toLowerCase();
            if (own.has(from) || protocol.has(from)) continue; // internal move / back from the protocol
            seen.add(k);
            const t = l.timeStamp ? parseInt(l.timeStamp, 16) * 1000 : null;
            const raw = BigInt(l.data || "0x0");
            const amount = Number(ethers.formatUnits(raw, tk.decimals));
            const px = t != null ? priceAt(hours, tk.address, t) : null;
            state.rows.push({ t, tx: l.transactionHash, logIndex: l.logIndex, from, to: w, token: sym, tokenAddress: tk.address, amount, usd: px != null ? round(amount * px, 4) : null, kind: "received" });
            added++;
          }
          state.lastBlock[inKey] = inTop;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    // Merge into whatever is on disk now, never overwrite: a scan holds its state for minutes
    // (paced explorer reads) and another writer (a second scan, a re-valuation run by hand)
    // may have landed meanwhile. Rows are keyed by tx:logIndex, the newer revision wins.
    const cur = readJson(FILE, { lastBlock: {}, rows: [] });
    const merged = new Map((Array.isArray(cur.rows) ? cur.rows : []).map((r) => [`${r.tx}:${r.logIndex}`, r]));
    for (const r of state.rows) { const k = `${r.tx}:${r.logIndex}`; const have = merged.get(k); if (!have || (r.rev || 0) >= (have.rev || 0)) merged.set(k, r); }
    state.rows = [...merged.values()].sort((a, b) => (a.t || 0) - (b.t || 0));
    for (const [k, v] of Object.entries(cur.lastBlock || {})) if (Number(v) > (Number(state.lastBlock[k]) || 0)) state.lastBlock[k] = Number(v);
    state.deposits = [...new Set([...(cur.deposits || []), ...(state.deposits || [])])];
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, FILE);
    return { ok: true, added, deposits, queries, revalued, tokens: handed.size };
  }

  return { positionHistory, priceHistory, scoutHistory, tokenLots, scanDisposals, proceedsFromReceipt };
}

module.exports = { create, proceedsFromReceipt };
