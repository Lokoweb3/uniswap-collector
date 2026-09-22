const $ = s => document.querySelector(s);
const PAGE = location.pathname.replace(/\/+$/, '') === '/analytics' ? 'analytics' : 'dashboard';

// The chain this instance is pointed at, for labelling an aggregate scope. A
// name from the settings wins; the two chains this project runs on are known;
// anything else is named by its id rather than guessed at.
let CHAIN = { id: null, name: null };
const KNOWN_CHAINS = { 4663: 'Robinhood', 5042: 'Arc' };
function chainLabel() {
  return CHAIN.name || KNOWN_CHAINS[CHAIN.id] || (CHAIN.id ? 'chain ' + CHAIN.id : '');
}

// How this instance prices tokens, as the server describes it (`pricing` on
// /api/positions, /api/watch and /api/portfolio). Without it the page says only
// what is true everywhere, and names no particular pricing token.
let PRICING = null;
const PRICING_FALLBACK = 'Prices come from on-chain pools against this instance\u2019s unit of account; a token with no such pool is left unpriced.';
function notePricing(d) {
  if (d && d.pricing && typeof d.pricing.text === 'string' && d.pricing.text.trim()) PRICING = d.pricing;
  const f = document.getElementById('pricefoot');
  if (f) f.textContent = pricingText();
}
function pricingText() { return (PRICING && PRICING.text) || PRICING_FALLBACK; }
// Client time of the last successful fetch of each payload, kept apart from the
// payload's own `at` (when the server last read the data).
const fetchedAt = new WeakMap();
const clock = t => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

document.body.classList.add('page-' + PAGE);
document.title = PAGE === 'analytics' ? 'LP analytics' : document.title;
// A missing nav element must not throw here: this runs at the top level, so an
// exception stops the whole script and the dashboard renders nothing at all.
const navHere = $('#nav-' + (PAGE === 'analytics' ? 'analytics' : 'dash'));
if (navHere) navHere.classList.add('here');
// localStorage is a per-browser convenience; never let it throw.
const pref = k => { try { return localStorage.getItem(k); } catch(e){ return null; } };
const setPref = (k,v) => { try { localStorage.setItem(k,v); } catch(e){} };

const usd = n => {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a === 0) return '$0.00';
  if (a < 0.005) return '<$0.01';
  if (a < 1) return '$' + n.toFixed(3);
  return '$' + n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
};

/**
 * A chain identifier — an address, a token, a transaction — rendered as a link
 * when the chain publishes an explorer, and as selectable text with a copy
 * button when it does not. Arc has no public explorer (Circle's sits behind an
 * access gate), and a link that goes nowhere is worse than no link: it looks
 * like the data is reachable when it is not. Nothing here is Arc-specific —
 * any chain configured without an explorer degrades the same way.
 */
const COPY_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor"/><path d="M10.5 3.5H3.5a1 1 0 0 0-1 1v7" fill="none" stroke="currentColor"/></svg>';
function chainRef(base, path, label, full = '') {
  const t = full ? ` title="${full}"` : '';
  if (base) return `<a href="${base}${path}" target="_blank" rel="noopener"${t}>${label}</a>`;
  const copy = full || label;
  return `<span class="chainref"${t}>${label}<button type="button" class="copyref" data-copy="${copy}" title="Copy ${copy}" aria-label="Copy ${copy}">${COPY_ICON}</button></span>`;
}
// One delegated handler for every copy button the helper renders.
document.addEventListener('click', async e => {
  const b = e.target.closest('.copyref');
  if (!b) return;
  try {
    await navigator.clipboard.writeText(b.dataset.copy || '');
    b.classList.add('copied');
    setTimeout(() => b.classList.remove('copied'), 1200);
  } catch { /* clipboard blocked: the value is selectable text beside the button */ }
});

function price(p){
  if (p == null) return '—';
  if (p === 0) return '0';
  const a = Math.abs(p);
  if (a >= 10000) return p.toLocaleString('en-US',{maximumFractionDigits:0});
  if (a >= 100) return p.toLocaleString('en-US',{maximumFractionDigits:2});
  if (a >= 1) return p.toLocaleString('en-US',{maximumFractionDigits:4});
  // Small prices: four significant figures, always in plain decimal.
  return p.toLocaleString('en-US',{maximumSignificantDigits:4, useGrouping:false});
}

// Pool statistics line for a card: the scanner's row for the pool, or the v4
// pool read straight from chain (pools.js directV4), plus sibling pools of the
// same pair.
// Compact money, for chart axes and pool stats. Above a trillion it switches to an
// exponent: a single misread price on 2026-09-17 printed an axis label forty digits
// long, which stretched the chart's gutter across the page. No real figure here is
// that big, so showing it as 2.34e+39 loses nothing and keeps the layout intact.
const usdK = n => n == null ? '—'
  : Math.abs(n) >= 1e12 ? '$' + Number(n).toExponential(2)
  : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M'
  : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'k'
  : usd(n);
// A pool fee rate in percent, with precision that suits its size: two
// significant digits under 1%, one decimal under 100%, whole numbers above.
// Tiny positive rates read "<0.01%" rather than rounding to a false 0%. No cap.
function ratePct(v) {
  if (v == null || typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v === 0) return '0%';
  const a = Math.abs(v), sign = v < 0 ? '−' : '';
  if (a < 0.01) return v > 0 ? '<0.01%' : '>−0.01%';
  if (a < 1) return sign + a.toLocaleString('en-US', { maximumSignificantDigits: 2 }) + '%';
  if (a < 100) return sign + a.toLocaleString('en-US', { maximumFractionDigits: 1 }) + '%';
  return sign + a.toLocaleString('en-US', { maximumFractionDigits: 0 }) + '%';
}
const POOL_RATE_LABEL = 'Estimated annualized pool fee rate';
const ACTIVE_LIQ_TIP = 'Active (in-range) liquidity: the virtual reserves of the liquidity that is active at the current price, valued at current prices. It is not the pool’s total deposits — out-of-range liquidity is not counted.';
const DIRECT_RATE_TIP = 'Estimated annualized pool fee rate, read from the v4 pool on chain: 24-h fees ÷ active (in-range) liquidity value × 365. '
  + 'The fees are the growth of the pool’s fee-growth counters since the earliest hourly sample in the last 24 h, multiplied by the CURRENT active liquidity and valued at CURRENT token prices, '
  + 'then scaled to 24 h when the window is shorter. It assumes today’s active liquidity was in place for the whole window, so it is a fee rate per unit of in-range liquidity — '
  + 'not this position’s return (see Fee APR and Net return under Performance). Needs at least 30 minutes of samples.';
const SCANNER_RATE_TIP = 'Estimated annualized pool fee rate as reported by the external pool scanner (its 24-h fees over its TVL, annualized). A pool-level rate, not this position’s return (see Fee APR and Net return under Performance).';
// "~0.26%", or "<0.01%" (already a bound, so no "~"), escaped for HTML.
const approxRate = r => esc((/^[<>]/.test(r) ? '' : '~') + r);
function poolRateText(q, tip) {
  const r = ratePct(q.aprPct);
  return r == null ? '' : ` · <span class="poolrate" title="${esc(tip)}">${POOL_RATE_LABEL} <b>${approxRate(r)}</b></span>`;
}
function poolLine(p){
  const q = p.pool;
  if (!q) return '';
  let own;
  if (q.missing) own = '<span class="muted">pool not on the scanner</span>';
  else if (q.direct) {
    const liq = `<span class="liqlabel" title="${esc(ACTIVE_LIQ_TIP)}">active (in-range) liquidity</span> <b>${q.tvl == null ? 'unpriced' : usdK(q.tvl)}</b>`;
    let fees;
    if (q.feesWindowH == null) {
      fees = ' · <span class="muted">fee rate withheld: fewer than 30 minutes of fee-growth samples so far</span>';
    } else if (q.fees24h == null) {
      fees = ` · <span class="muted">fee rate withheld: a token in this pool has no price (window ${q.feesWindowH.toFixed(1)} h)</span>`;
    } else {
      const extrap = q.feesWindowH < 24;
      const win = extrap
        ? `<span class="muted" title="Only ${q.feesWindowH.toFixed(1)} h of samples exist inside the last 24 h; the 24-h figure is that window scaled up">extrapolated to 24 h from ${q.feesWindowH.toFixed(1)} h observed</span>`
        : `<span class="muted">observed over the last ${q.feesWindowH.toFixed(1)} h</span>`;
      const rate = q.aprPct != null ? poolRateText(q, DIRECT_RATE_TIP)
        : ' · <span class="muted">fee rate withheld: active liquidity has no positive value</span>';
      // The estimate uses today's active liquidity for the whole window; say how far
      // the sampled liquidity was from that, when it moved materially.
      const lr = q.liqRange;
      const liqNote = lr && (lr.min < 0.9 || lr.max > 1.1)
        ? ` <span class="muted" title="The fee estimate multiplies the window’s fee growth by today’s active liquidity. Over the window the sampled active liquidity ranged ${lr.min}–${lr.max}× today’s (${lr.samples} hourly samples), so the estimate is only as good as that assumption.">(active liquidity ranged ${lr.min.toFixed(2)}–${lr.max.toFixed(2)}× today’s over the window)</span>`
        : '';
      fees = ` · fees <b>${usdK(q.fees24h)}</b>/24h ${win}${rate}${liqNote}`;
    }
    own = `pool <span class="muted" title="Read straight from the v4 pool state">(on-chain)</span> ${liq}${fees}`;
  } else {
    own = `pool TVL <b>${usdK(q.tvl)}</b> · 24h vol <b>${usdK(q.vol24h)}</b> · fees <b>${usdK(q.fees24h)}</b>${poolRateText(q, SCANNER_RATE_TIP)}` +
      `${q.aprPct == null ? ' · <span class="muted">fee rate withheld: the scanner gives no fees or TVL for this pool</span>' : ''}` +
      `${q.stale ? ' <span class="muted" title="scanner data is stale">(stale)</span>' : ''}`;
  }
  const sib = (q.siblings || []).length
    ? ` · <span class="sibs" title="Other pools for this pair, by ${POOL_RATE_LABEL.toLowerCase()} (from the pool scanner)">other pools’ fee rates: ${q.siblings.map(x => { const r = ratePct(x.aprPct); return `<span title="TVL ${usdK(x.tvl)} · 24h fees ${usdK(x.fees24h)}${r == null ? ' · no fee rate: the scanner gives no fees or TVL' : ''}">${x.feePct != null ? x.feePct + '%' : esc(x.name)} ${x.version}${x.tag ? ' ' + esc(x.tag) : ''} <b class="${(x.aprPct || 0) > (q.aprPct || 0) ? '' : 'muted'}">${r == null ? '—' : approxRate(r)}</b></span>`; }).join(' · ')}</span>`
    : '';
  return `<span class="rate poolstats">${own}${sib}</span>`;
}

// Display orientation for a position's prices. The pool quotes token1 per
// token0, which for a memecoin/WETH pool reads as a tiny fraction of WETH
// per coin; when the current price is below 1 the inverse (coins per WETH)
// is shown instead, with the unit named and clickable to flip. Remembered
// per pair in this browser.
function orient(p){
  const key = 'orient:' + p.symbol0 + '/' + p.symbol1;
  const saved = pref(key);
  const invert = saved != null ? saved === '1' : p.priceCurrent < 1;
  if (!invert) return {
    key, invert, unit: `${p.symbol1} per ${p.symbol0}`,
    lower: p.priceLower, upper: p.priceUpper, current: p.priceCurrent,
    railPos: p.railPos, rawPos: p.rawPos, toUpper: p.toUpperPct, toLower: p.toLowerPct,
    above: p.rawPos > 1, px: p.px || [],
  };
  const lower = 1 / p.priceUpper, upper = 1 / p.priceLower, current = 1 / p.priceCurrent;
  return {
    key, invert, unit: `${p.symbol0} per ${p.symbol1}`,
    lower, upper, current,
    railPos: 1 - p.railPos, rawPos: 1 - p.rawPos,
    toUpper: (upper / current - 1) * 100, toLower: (1 - lower / current) * 100,
    above: p.rawPos < 0, px: (p.px || []).map(x => ({ t: x.t, v: 1 / x.v })),
  };
}

function amount(n){
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a === 0) return '0';
  if (a >= 1000) return n.toLocaleString('en-US',{maximumFractionDigits:0});
  if (a >= 1) return n.toLocaleString('en-US',{maximumFractionDigits:3});
  return n.toPrecision(3);
}

// Within 12% of a bound counts as near the edge -- roughly a day's move on the
// pairs in this wallet.
const NEAR = 12;

// "Collectable in ~X" for below-threshold positions with a measured rate.
function etaBadge(p, d){
  if (p.eligible !== false || !p.dailyUsd || !d.wethUsd || !d.minWethPerPosition) return '';
  const remaining = d.minWethPerPosition * d.wethUsd - (p.feesUsd || 0);
  if (remaining <= 0) return '';
  const days = remaining / p.dailyUsd;
  if (days > 60) return '';
  const label = days < 1 ? '~' + Math.max(1, Math.round(days * 24)) + 'h' : '~' + days.toFixed(days < 10 ? 1 : 0) + 'd';
  return `<span class="nft" title="time until fees cross the ${d.minWethPerPosition} WETH collect threshold at the current rate">collectable in ${label}</span>`;
}

// 7-day pool price against the position's range band.
function pxChart(p, v){
  const pts = v.px;
  if (pts.length < 2) return '';
  const W = 600, H = 46;
  const vs = pts.map(x => x.v);
  const lo = Math.min(...vs, v.lower), hi = Math.max(...vs, v.upper);
  const pad = (hi - lo) * 0.08 || hi * 0.01;
  const ymin = lo - pad, ymax = hi + pad;
  const X = i => (i / (pts.length - 1)) * W;
  const Y = x => H - 4 - ((x - ymin) / (ymax - ymin)) * (H - 8);
  const line = pts.map((x, i) => `${X(i).toFixed(1)},${Y(x.v).toFixed(1)}`).join(' ');
  const yU = Y(v.upper), yL = Y(v.lower);
  // Labels live in HTML beside the drawing: text inside a stretched SVG
  // distorts, and the two bound labels are kept apart by a minimum gap.
  const pct = y => (y / H * 100).toFixed(1) + '%';
  let tU = yU, tL = yL;
  if (tL - tU < 11) { const m = (tU + tL) / 2; tU = m - 5.5; tL = m + 5.5; }
  return `<div class="pxchart"><div class="pxwrap"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <rect class="band" x="0" y="${yU.toFixed(1)}" width="${W}" height="${(yL-yU).toFixed(1)}"/>
    <line class="bandline" x1="0" x2="${W}" y1="${yU.toFixed(1)}" y2="${yU.toFixed(1)}"/>
    <line class="bandline" x1="0" x2="${W}" y1="${yL.toFixed(1)}" y2="${yL.toFixed(1)}"/>
    <polyline class="pline" points="${line}"/>
  </svg><span class="pxcap">7d</span></div>
  <div class="pxlabels"><span style="top:${pct(tU)}">${price(v.upper)}</span><span style="top:${pct(tL)}">${price(v.lower)}</span></div></div>`;
}

// Tiny 48h uncollected-fees sparkline; collects show as drops.
function sparkline(pts){
  if (!pts || pts.length < 2) return '';
  const t0 = pts[0].t, t1 = pts[pts.length-1].t;
  const vmax = Math.max(...pts.map(p => p.v), 0.0001);
  const xy = pts.map(p => {
    const x = t1 === t0 ? 0 : ((p.t - t0) / (t1 - t0)) * 88 + 1;
    const y = 20 - (p.v / vmax) * 18;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  return `<svg class="spark" viewBox="0 0 90 22" aria-label="fee accrual, last 48 hours"><polyline points="${xy}"/></svg>`;
}

/* ---- earnings history ---- */
function historyChart(rows, range){
  const pts = rows.filter(r => r.usd != null && r.t);
  if (pts.length < 1) return '<div class="enote">No collects recorded yet.</div>';
  let cum = 0;
  const series = pts.map(r => ({ t: r.t, v: (cum += r.usd) }));
  const W = 600, H = 130, PL = 8, PR = 56, PT = 10, PB = 20;
  const t0 = range ? range.t0 : series[0].t;
  const t1 = range ? Math.min(range.t1, Date.now()) : Date.now();
  const vmax = series[series.length-1].v;
  const X = t => PL + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (W - PL - PR);
  const Y = v => PT + (1 - v / vmax) * (H - PT - PB);

  // Step path: fees arrive at collect moments and hold until the next.
  let dpath = `M ${X(t0).toFixed(1)} ${Y(0).toFixed(1)}`;
  let prevY = Y(0);
  for (const s of series){
    dpath += ` L ${X(s.t).toFixed(1)} ${prevY.toFixed(1)} L ${X(s.t).toFixed(1)} ${Y(s.v).toFixed(1)}`;
    prevY = Y(s.v);
  }
  dpath += ` L ${X(t1).toFixed(1)} ${prevY.toFixed(1)}`;
  const area = dpath + ` L ${X(t1).toFixed(1)} ${Y(0).toFixed(1)} Z`;

  const grid = [0.5, 1].map(f =>
    `<line class="grid" x1="${PL}" x2="${W-PR}" y1="${Y(vmax*f).toFixed(1)}" y2="${Y(vmax*f).toFixed(1)}"/>
     <text class="axis" x="${W-PR+6}" y="${(Y(vmax*f)+3).toFixed(1)}">${usd(vmax*f)}</text>`).join('');

  const dots = series.map(s =>
    `<circle class="dot" cx="${X(s.t).toFixed(1)}" cy="${Y(s.v).toFixed(1)}" r="3">
       <title>${new Date(s.t).toLocaleString()} — cumulative ${usd(s.v)}</title></circle>`).join('');

  const fmtD = t => new Date(t).toLocaleDateString(undefined, {month:'short', day:'numeric'});
  const xlab = `<text class="axis" x="${PL}" y="${H-4}">${fmtD(t0)}</text>
    <text class="axis" x="${W-PR}" y="${H-4}" text-anchor="end">${fmtD(t1)}</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${grid}<path class="fillarea" d="${area}"/><path class="line" d="${dpath}"/>${dots}${xlab}</svg>`;
}

/* ---- portfolio: every token held, wherever it sits ---- */
// The server values the owner's wallet (/api/portfolio) and each watched
// wallet (/api/watch, holdings + positions). The panel merges them here so
// the scope selector can show one wallet or all of them together.
let lastPortfolio = null, lastWatchForPf = null;
const NATIVE_KEY = 'eth';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const pfScope = () => pref('portfolio:scope') || 'all';
// The picker does not exist on every page, and reading .hidden off null threw from
// inside two render paths. Absent or hidden both mean the owner's own scope.
const currentScope = () => { const el = $('#pfscope'); return !el || el.hidden ? 'owner' : pfScope(); };
// #scope=all / #scope=0x… picks the Portfolio scope from the URL (a shareable link).
try { const h = new URLSearchParams(location.hash.slice(1)).get('scope'); if (h) setPref('portfolio:scope', h.toLowerCase()); } catch(e){}
// #positions=open|closed|all picks the position list filter the same way.
try { const h = new URLSearchParams(location.hash.slice(1)).get('positions'); if (h) setPref('positions:filter', h.toLowerCase()); } catch(e){}

/** Rows for one watched wallet, in the same shape as the owner's rows. */
function watchedRows(w){
  const m = new Map();
  const row = (key, symbol, address, native) => {
    if (!m.has(key)) m.set(key, { symbol, address, native, wallet: 0, pools: 0, fees: 0, price: null, depthUsd: null, source: 'wallet' });
    return m.get(key);
  };
  for (const t of (w.holdings && w.holdings.tokens) || []) {
    const key = t.native ? NATIVE_KEY : t.address.toLowerCase();
    const r = row(key, t.symbol, t.address, !!t.native);
    r.wallet += t.amount; r.price = t.price; r.depthUsd = t.depthUsd;
  }
  const side = (p, addr, sym, amt, fee, usdPer) => {
    const native = !addr || addr === ZERO_ADDR;
    const key = native ? NATIVE_KEY : addr.toLowerCase();
    const r = row(key, native ? 'ETH' : sym, native ? null : addr, native);
    r.pools += amt; r.fees += fee; r.source = 'pools';
    if (r.price == null && usdPer != null) r.price = usdPer;
  };
  for (const p of w.positions || []) {
    side(p, p.token0, p.symbol0, p.amount0, p.fee0, p.usd0);
    side(p, p.token1, p.symbol1, p.amount1, p.fee1, p.usd1);
  }
  return [...m.values()];
}

/** Sum rows of several wallets by token. */
function mergeRows(lists){
  const m = new Map();
  for (const rows of lists) for (const x of rows) {
    const key = x.native ? NATIVE_KEY : x.address.toLowerCase();
    const r = m.get(key) || { symbol: x.symbol, address: x.address, native: x.native, wallet: 0, pools: 0, fees: 0, price: null, depthUsd: null, source: 'wallet', change24h: null };
    r.wallet += x.wallet || 0; r.pools += x.pools || 0; r.fees += x.fees || 0;
    if (r.price == null && x.price != null) { r.price = x.price; r.depthUsd = x.depthUsd; r.via = x.via || null; }
    if (x.source === 'pools') r.source = 'pools';
    if (r.change24h == null && x.change24h != null) r.change24h = x.change24h;
    m.set(key, r);
  }
  const rows = [...m.values()];
  for (const r of rows) {
    r.total = r.wallet + r.pools + r.fees;
    r.walletUsd = r.price == null ? null : r.wallet * r.price;
    r.poolsUsd = r.price == null ? null : r.pools * r.price;
    r.feesUsd = r.price == null ? null : r.fees * r.price;
    r.usd = r.price == null ? null : r.total * r.price;
    r.thin = r.depthUsd != null && r.usd != null && r.usd > r.depthUsd;
  }
  const grand = rows.reduce((s, r) => s + (r.usd || 0), 0);
  for (const r of rows) r.share = grand > 0 && r.usd != null ? (r.usd / grand) * 100 : null;
  rows.sort((a, b) => (b.usd || 0) - (a.usd || 0));
  return rows;
}

const ownerLabel = () => (lastMain && lastMain.ownerLabel) || 'Main wallet';
const ownerName = () => lastMain || lastPortfolio ? `${ownerLabel()} (${shortA((lastMain || lastPortfolio).owner)})` : ownerLabel();
const walletName = w => w.label ? `${w.label} (${shortA(w.address)})` : shortA(w.address);

/* ---- wallet groups open and closed ----
   Each wallet's cards collapse behind a real button, so a page with several
   wallets can be narrowed to the one being worked on. The choice is a per
   browser convenience and defaults to open. */
const walletOpen = key => pref('wallet:open:' + key) !== '0';
function walletToggle(key, targetId, count){
  const open = walletOpen(key);
  const what = count === 1 ? '1 position' : `${count} positions`;
  return `<button type="button" class="wtoggle" data-wkey="${key}" data-wtarget="${targetId}"`
    + ` aria-expanded="${open}" aria-controls="${targetId}">${open ? 'Hide' : 'Show'} ${what}</button>`;
}
function applyWalletOpen(key, targetId){
  const el = document.getElementById(targetId);
  if (el) el.hidden = !walletOpen(key);
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('.wtoggle');
  if (!b) return;
  const key = b.dataset.wkey, target = b.dataset.wtarget;
  const open = !walletOpen(key);
  setPref('wallet:open:' + key, open ? '1' : '0');
  b.setAttribute('aria-expanded', String(open));
  b.textContent = b.textContent.replace(/^(Hide|Show)/, open ? 'Hide' : 'Show');
  applyWalletOpen(key, target);
});

function fillScopeSelect(){
  const sel = $('#pfscope');
  const wallets = (lastWatchForPf && lastWatchForPf.wallets || []).filter(w => w.ok);
  if (!wallets.length) { sel.hidden = true; $('#walletpick').hidden = true; document.body.classList.remove('haspick'); return; }
  const cur = pfScope();
  const opts = [['all', `All ${wallets.length + 1} wallets`], ['owner', ownerName()]].concat(wallets.map(w => [w.address.toLowerCase(), walletName(w)]));
  sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  sel.value = opts.some(o => o[0] === cur) ? cur : 'all';
  sel.hidden = false;
  $('#walletpick').hidden = false;
  document.body.classList.add('haspick');
}

// A refresh that throws is not a quiet no-op. Each load* reports here: the error
// is logged, and a strip at the top of the page names the section that could not
// be refreshed, so stale or blank content is never mistaken for current. The
// entry clears the next time that section loads.
const loadFails = new Map();
function loadFailed(section, err) {
  console.error(`${section}: refresh failed`, err);
  loadFails.set(section, { msg: String((err && err.message) || err || 'unknown error'), at: Date.now() });
  drawLoadFails();
}
function loadOk(section) {
  if (loadFails.delete(section)) drawLoadFails();
}
function drawLoadFails() {
  const el = document.getElementById('loadfails');
  if (!el) return;
  el.hidden = !loadFails.size;
  el.innerHTML = [...loadFails].map(([k, v]) =>
    `<p class="loadfail"><b>${esc(k)}</b> could not be refreshed (${esc(v.msg)}, ${new Date(v.at).toLocaleTimeString()}). What is shown there may be out of date or missing.</p>`).join('');
}

// How an /api answer went. `ok:false` is a failure — whatever the HTTP status —
// unless the server says its first build is still running (202, or `refreshing`
// with no data yet), which is "not yet", not "failed".
function apiOutcome(status, d) {
  if (status < 500 && (status === 202 || (d && d.refreshing === true && d.ok !== true))) return { kind: 'pending' };
  if (status >= 200 && status < 300 && d && d.ok === true) return { kind: 'ok' };
  const why = d && d.error ? String(d.error)
    : `the server answered HTTP ${status}${d && d.ok === false ? ' without data' : ''}`;
  return { kind: 'error', msg: why };
}
/**
 * Record how a refresh went, from the response rather than from the fact that a
 * response arrived.
 *
 * Every caller used to run loadOk() immediately after r.json(), before looking at
 * the status or the body. An endpoint that answers HTTP 500 with a parseable
 * {ok:false} therefore CLEARED the staleness banner -- the one mechanism the page
 * has for admitting it is showing old numbers -- and then returned early, leaving
 * yesterday's figures on screen with nothing to say so.
 */
function noteOutcome(section, status, d) {
  const o = apiOutcome(status, d);
  if (o.kind === 'ok') loadOk(section);
  else if (o.kind === 'error') loadFailed(section, new Error(o.msg));
  return o.kind;                     // 'pending' leaves the previous state alone
}

// A section that kept its last good data after a failed refresh says so, and how old it is.
function staleNote(at, msg) {
  const when = at ? new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  return when
    ? `Showing the last successful refresh from ${esc(when)}. The latest refresh failed: ${esc(msg)}.`
    : `Could not load: ${esc(msg)}. Nothing is shown because nothing has loaded yet \u2014 this is not an empty result.`;
}

let allSeriesD = null;
async function loadAllSeries(){
  try { const r = await fetch('/api/portfolio-all'); const d = await r.json(); noteOutcome('Portfolio history', r.status, d); if (d.ok && d.points.length) { allSeriesD = d; if (lastPortfolio) renderPortfolio(); } } catch(e){ loadFailed('Portfolio history', e); }
}

async function loadBalances(){
  try{
    const r = await fetch('/api/portfolio');
    const d = await r.json(); noteOutcome('Wallet balances', r.status, d);
    if (r.status === 503){ setTimeout(loadBalances, 15000); return; } // first pass still running
    if (!d.ok || !d.rows || !d.rows.length) return;
    notePricing(d);
    lastPortfolio = d;
    $('#balpanel').hidden = false;
    renderPortfolio();
  }catch(e){ loadFailed('Wallet balances', e); }
}

let lastMain = null;
/**
 * The three leading tiles (held, in positions, uncollected fees) follow the
 * Portfolio scope: the owner alone, one watched wallet, or every wallet
 * together. Collectable, PnL and projection tiles are the collector's own
 * and always describe the owner wallet.
 */
function renderHeadline(){
  const scope = currentScope();
  const watched = (lastWatchForPf && lastWatchForPf.wallets || []).filter(w => w.ok);
  const sel = scope === 'all' ? watched : scope === 'owner' ? [] : watched.filter(w => w.address.toLowerCase() === scope);
  const own = scope === 'all' || scope === 'owner';
  const m = lastMain, pf = lastPortfolio;
  const sum = k => sel.reduce((s, w) => s + ((w.totals && w.totals[k]) || 0), 0);
  const liq = (own && m ? m.totals.liquidityUsd : 0) + sum('liquidityUsd');
  const fees = (own && m ? m.totals.feesUsd : 0) + sum('feesUsd');
  const count = (own && m ? m.totals.count : 0) + sum('count');
  const who = scope === 'owner' ? ownerName() : scope === 'all' ? `all ${watched.length + 1} wallets` : (sel[0] && (sel[0].label || shortA(sel[0].address))) || 'wallet';
  $('#pfwho').textContent = `· ${scope === 'all' ? who : scope === 'owner' ? ownerName() : (sel[0] ? walletName(sel[0]) : who)}`;
  $('#tvl').textContent = usd(liq);
  $('#count').textContent = count;
  $('#countlabel').textContent = scope === 'owner' ? 'In' : `${who} · in`;
  $('#fees').textContent = usd(fees);
  $('#feeslabel').textContent = scope === 'owner' ? 'Uncollected fees' : `Uncollected fees · ${who}`;
  $('#networthlabel').textContent = `Held by ${who}`;
  // Owner's group line inside the Positions panel, in the same shape as the watched wallets' lines.
  if (m) {
    const link = chainRef(EXPLORER, `/address/${m.owner}`, `${ownerLabel()} <span class="muted">${shortA(m.owner)}</span>`, m.owner);
    // A missing portfolio means the wallet's loose tokens are UNKNOWN, not zero.
    // Adding 0 quietly deleted them from every total that used this: on Robinhood
    // that is ~$10k of tokens vanishing with nothing on screen to say a component
    // was missing. The figure is now marked partial and labelled wherever it shows.
    const tokensKnown = !!pf;
    const ownTotal = m.totals.liquidityUsd + m.totals.feesUsd + (tokensKnown ? pf.totals.walletUsd : 0);
    const partialNote = tokensKnown ? '' : ' <span class="muted" title="This wallet\'s loose tokens could not be valued, so they are not in this figure.">+ tokens unknown</span>';
    $('#ownerhead').innerHTML =
      `<div class="wh-main">${link}<span class="wcount"><b>${m.totals.count}</b> open${m.totals.idle ? ` · <span class="idle">${m.totals.idle} idle</span>` : ''}</span></div>` +
      `<div class="wh-side"><span class="lpsub" title="The open positions alone, without this wallet's loose tokens or its uncollected fees">LP value <b>${usd(m.totals.liquidityUsd)}</b></span>` +
      walletToggle('owner', 'list', m.totals.count) + `</div>` +
      `<details class="whmore"><summary>Wallet detail</summary><div class="whmore-body">` +
      `<span class="wtotal">total <b>${usd(ownTotal)}</b>${partialNote}</span>` +
      (pf ? `<span>tokens <b>${usd(pf.totals.walletUsd)}</b>${pf.totals.unpricedCount ? ` <span class="muted">+${pf.totals.unpricedCount} unpriced</span>` : ''}</span>` : '') +
      `<span>uncollected <b>${usd(m.totals.feesUsd)}</b></span>` +
      `</div></details>`;
    applyWalletOpen('owner', 'list');
    // Section header: this wallet alone, or everything, depending on the picker.
    const W = lastWatchForPf && lastWatchForPf.totals;
    if (scope === 'owner') {
      $('#watchtitle').textContent = `Positions · Main wallet · ${m.totals.count} open`;
      $('#watchtotal').innerHTML = usd(ownTotal) + partialNote;
    } else if (scope === 'all' && W) {
      const watchedOpen = (lastWatchForPf.wallets || []).reduce((a, w) => a + ((w.totals && w.totals.count) || 0), 0);
      $('#watchtitle').textContent = `Positions · ${m.totals.count + watchedOpen} open across ${W.wallets + 1} wallets`;
      $('#watchtotal').innerHTML = usd(ownTotal + W.totalUsd) + partialNote;
      $('#watchstats').innerHTML = `<span>${W.wallets + 1} wallets</span><span>tokens in wallets <b>${usd((pf ? pf.totals.walletUsd : 0) + W.walletUsd)}</b></span><span>in pools <b>${usd(m.totals.liquidityUsd + W.liquidityUsd)}</b></span><span>uncollected fees <b>${usd(m.totals.feesUsd + W.feesUsd)}</b></span>`;
    } else if (sel[0]) {
      // One watched wallet. renderWatch sets these too, but it does not run on every
      // render that reaches here -- a portfolio refresh alone calls renderHeadline by
      // itself -- and the header then still named whichever wallet was chosen before.
      $('#watchtitle').textContent = `Positions · ${sel[0].label || shortA(sel[0].address)} · ${(sel[0].totals && sel[0].totals.count) || 0} open`;
      $('#watchtotal').textContent = sel[0].totals ? usd(sel[0].totals.totalUsd) : '';
    }
  }
  const idle = (own && m ? m.totals.idle : 0) + sum('idle');
  $('#idle').textContent = m || sel.length ? idle : '—';
  if (PAGE === 'dashboard') {
    document.body.classList.toggle('scope-watched', !own);
    document.body.classList.toggle('scope-owner', scope === 'owner');
    document.body.classList.toggle('scope-all', scope === 'all');
  }
  const nwp = $('#networthparts');
  // Net worth is withheld in EVERY scope when the owner's tokens are unvalued: the
  // guard used to cover 'owner' only, so 'all' returned early leaving a stale figure
  // on screen beside a total that had already dropped those tokens.
  if (own && !pf) { $('#networth').textContent = '—'; nwp.hidden = true; return; } // owner tokens not valued yet
  const wallet = (own && pf ? pf.totals.walletUsd : 0) + sel.reduce((s, w) => s + ((w.holdings && w.holdings.walletUsd) || 0), 0);
  const unpriced = (own && pf ? pf.totals.unpricedCount : 0) + sel.reduce((s, w) => s + ((w.holdings && w.holdings.unpricedCount) || 0), 0);
  $('#networth').textContent = usd(liq + fees + wallet);
  nwp.hidden = false;
  nwp.innerHTML = `positions <b>${usd(liq)}</b> · fees <b>${usd(fees)}</b> · tokens in wallet <b>${usd(wallet)}</b>` + (unpriced ? ` · ${unpriced} unpriced` : '');
}

/** Which tokens carry a price from another, and what that rests on. */
function assumedTip(totals){
  const list = (totals.assumedTokens || []).map(t => `${t.symbol} valued as ${t.via || 'another token'} (${usd(t.usd)})`).join('; ');
  return `${list}. A receipt token with no market of its own is priced one for one against what it represents, because settings.json says to. Nothing on chain confirms that ratio: there is no pool for it and no exchange rate to read. The holding is real; the rate it is valued at is an assumption.`;
}
function renderPortfolio(){
  const d = lastPortfolio;
  if (!d) return;
  fillScopeSelect();
  renderHeadline();
  const scope = currentScope();
  const watched = (lastWatchForPf && lastWatchForPf.wallets || []).filter(w => w.ok);
  // Owner rows carry the server's 24h change; give the same token change to the other scopes.
  const chg24 = new Map(d.rows.map(x => [x.native ? NATIVE_KEY : x.address.toLowerCase(), x.change24h]));
  let rows, totals, holder = d.owner, label;
  if (scope === 'owner') {
    rows = d.rows; totals = d.totals; label = 'this wallet';
  } else {
    const lists = scope === 'all' ? [d.rows, ...watched.map(watchedRows)] : watched.filter(w => w.address.toLowerCase() === scope).map(watchedRows);
    rows = mergeRows(lists);
    for (const x of rows) if (x.change24h == null) x.change24h = chg24.get(x.native ? NATIVE_KEY : x.address.toLowerCase()) ?? null;
    const sum = k => rows.reduce((s, x) => s + (x[k] || 0), 0);
    totals = { walletUsd: sum('walletUsd'), lpUsd: sum('poolsUsd'), feesUsd: sum('feesUsd'), unpricedCount: rows.filter(x => x.usd == null).length };
    // Merged scopes rebuild their own totals, so the assumption has to be re-summed
    // here or it would vanish the moment someone looked at all wallets at once --
    // which is the view where the figure is largest.
    totals.assumedUsd = +rows.filter(x => x.assumed).reduce((t, x) => t + (x.usd || 0), 0).toFixed(2);
    totals.assumedTokens = rows.filter(x => x.assumed).map(x => ({ symbol: x.symbol, via: x.via, usd: +(x.usd || 0).toFixed(2) }));
    totals.totalUsd = totals.walletUsd + totals.lpUsd + totals.feesUsd;
    const w = scope === 'all' ? null : watched.find(w => w.address.toLowerCase() === scope);
    holder = w ? w.address : null;
    label = w ? walletName(w) : `all ${watched.length + 1} wallets`;
  }
  $('#baltotal').textContent = usd(totals.totalUsd);
  $('#pstats').innerHTML =
    `<span>in pools <b>${usd(totals.lpUsd)}</b></span>` +
    `<span>uncollected fees <b>${usd(totals.feesUsd)}</b></span>` +
    `<span>in wallet <b>${usd(totals.walletUsd)}</b></span>` +
    (totals.unpricedCount ? `<span>${totals.unpricedCount} token${totals.unpricedCount === 1 ? '' : 's'} unpriced</span>` : '') +
    // What is missing from the total is already said above. This says what is IN it
    // on an assumption rather than a reading: sNET has no market of its own on this
    // chain, so it is valued at NET one for one because settings.json says to. At
    // four fifths of the wallet, a reader deciding anything on this number should
    // see that before they act on it.
    (totals.assumedUsd ? `<span class="assumed" title="${esc(assumedTip(totals))}">${usd(totals.assumedUsd)} assumed${totals.totalUsd ? ` (${Math.round(totals.assumedUsd / totals.totalUsd * 100)}% of the total)` : ''}</span>` : '');
  // Value chart: the owner's hourly series, or the combined / per-wallet series recorded by the server.
  let series = [];
  if (scope === 'owner') series = (d.series || []).map(s => ({ t: s.t, v: s.total }));
  else if (allSeriesD) series = allSeriesD.points.map(p => ({ t: p.t, v: scope === 'all' ? p.total : (p.wallets && p.wallets[scope]) })).filter(p => p.v != null);
  $('#pchart').innerHTML = series.length >= 2 ? tvChart(series) : '';
  const chg = x => x.change24h == null ? '<td class="chg">—</td>'
    : `<td class="chg ${x.change24h >= 0 ? 'up' : 'down'}">${x.change24h >= 0 ? '+' : '−'}${Math.abs(x.change24h).toFixed(1)}%</td>`;
  const q = x => Math.abs(x) < 1e-6 ? '<span class="unpriced">0</span>' : amount(x);
  const showDust = pref('portfolio:dust') === '1';
  const main = rows.filter(x => showDust || (x.usd == null ? x.source === 'pools' : x.usd >= 1));
  const dust = rows.length - main.length;
  const link = x => x.native ? esc(x.symbol) : chainRef(d.explorer, `/token/${x.address}${holder ? `?holder_address_hash=${holder}` : ''}`, esc(x.symbol), x.address);
  $('#baltable').innerHTML = `<table class="etable">
    <tr><th>Token</th><th>Wallet</th><th>In pools</th><th>Fees</th><th>Total</th><th>Price</th><th>≈ USD</th><th>Share</th><th>24h</th></tr>
    ${main.map(x => `<tr>
      <td>${link(x)}</td>
      <td>${q(x.wallet)}</td>
      <td>${q(x.pools)}</td>
      <td>${q(x.fees)}</td>
      <td><b>${amount(x.total)}</b></td>
      <td>${x.price == null ? '<span class="unpriced">no pool</span>' : x.via ? `<span title="Priced as ${esc(x.via)}, redeemable 1:1">$${price(x.price)} <span class="muted">as ${esc(x.via)}</span></span>` : '$' + price(x.price)}</td>
      <td class="u">${x.thin ? `<span class="approx" title="${esc(`The pool this is priced from holds only ${usd(x.depthUsd)} on its pricing side, so selling would move it. Treat as a quote, not cash. ${pricingText()}`)}">≈</span>` : ''}${usd(x.usd)}</td>
      <td>${x.share == null ? '—' : x.share.toFixed(1) + '%'}</td>
      ${chg(x)}
    </tr>`).join('')}</table>` + (dust || showDust
      ? `<div class="enote"><a href="#" id="dusttoggle">${showDust ? 'hide' : 'show'} ${showDust ? 'dust and unpriced tokens' : dust + ' token' + (dust === 1 ? '' : 's') + ' under $1 or unpriced'}</a></div>` : '');
  const dt = $('#dusttoggle');
  if (dt) dt.addEventListener('click', e => { e.preventDefault(); setPref('portfolio:dust', showDust ? '0' : '1'); renderPortfolio(); });
  const scopeNote = scope === 'owner' ? '' : ` Showing ${label}; the collectable, PnL and projection tiles cover the main wallet only.${series.length >= 2 ? ' The chart is the hourly total for this selection.' : ' The value chart appears after a few hours of history.'}`;
  $('#pnote').textContent = (series.length >= 2
    ? `Total = wallet + positions + uncollected fees, at current prices; claimed fees are not added (they are already in the wallet). Chart is hourly since ${new Date(series[0].t).toLocaleDateString(undefined,{month:'short',day:'numeric'})}. ${pricingText()} 24h change once a day of history exists.`
    : `Total = wallet + positions + uncollected fees, at current prices; claimed fees are not added (they are already in the wallet). ${pricingText()} ≈ marks a value larger than its pricing pool holds.` + (scope === 'owner' ? ' The value chart appears after a few hours of history.' : '')) + scopeNote;
  renderSidebar();
}
const pfScopeEl = $('#pfscope');
if (pfScopeEl) pfScopeEl.addEventListener('change', e => { setPref('portfolio:scope', e.target.value); renderPortfolio(); if (lastWatchForPf) renderWatch(lastWatchForPf); renderSidebar(); });

/* ---- sidebar panels -------------------------------------------------------
 * Wallet overview, collection activity and data coverage are drawn from the
 * payloads this page has already fetched — /api/positions (lastMain and
 * lastRender), /api/portfolio (lastPortfolio), /api/watch (lastWatchForPf) and
 * the read-only summary insights-view.js publishes. No extra request and no
 * extra polling. A figure the data does not carry is named as unavailable; it
 * is never shown as zero, and no row is invented.
 */
let lastInsights = null;
document.addEventListener('lp:insights', e => { lastInsights = e.detail; renderSidebar(); });

function renderSidebar(){
  if (PAGE === 'analytics') return;
  panel(renderWalletPanel, '#walletbars', 'Wallet values are unavailable in this read.');
  panel(renderCollectPanel, '#collectevents', 'Collector status is unavailable in this read.');
  panel(renderCoveragePanel, '#coverlist', '<li>Coverage is unavailable in this read.</li>');
  try { histSync(false); } catch (e) { console.error('position history', e); }
}
// A panel that cannot be built says so where its content would be, rather than
// throwing and taking the rest of the render down with it.
function panel(fn, sel, fallback){
  try { fn(); }
  catch (e) { const el = $(sel); if (el) el.innerHTML = `<p class="enote">${fallback}</p>`; }
}

function renderWalletPanel(){
  const m = lastMain, pf = lastPortfolio, W = lastWatchForPf;
  const box = $('#walletbars'), note = $('#walletpanelnote'), tot = $('#walletpaneltotal');
  if (!box) return;
  // The overview compares wallets with each other, so it is shown only when the
  // Wallet picker is on "All wallets"; a single-wallet view hides it.
  const sec = $('#walletpanel');
  const all = !!$('#pfscope') && !$('#pfscope').hidden && pfScope() === 'all';
  if (sec) sec.hidden = !all;
  if (!all) return;
  const rows = [];
  if (m){
    const tokens = pf ? pf.totals.walletUsd : null;
    rows.push({ cls: 'owner', name: ownerLabel(), addr: m.owner,
      total: tokens == null ? null : m.totals.liquidityUsd + m.totals.feesUsd + tokens,
      lp: m.totals.liquidityUsd, count: m.totals.count,
      unpriced: pf ? pf.totals.unpricedCount : 0,
      why: tokens == null ? 'wallet token values still loading' : null });
  }
  for (const w of ((W && W.wallets) || [])){
    if (!w.ok){ rows.push({ cls: 'watched', name: w.label || shortA(w.address), addr: w.address, total: null, why: w.error || 'could not load' }); continue; }
    rows.push({ cls: 'watched', name: w.label || shortA(w.address), addr: w.address,
      total: w.totals.totalUsd, lp: w.totals.liquidityUsd, count: w.totals.count,
      unpriced: (w.holdings && w.holdings.unpricedCount) || 0,
      partial: !!(w.holdings && w.holdings.ok === false) });
  }
  if (!rows.length){
    box.innerHTML = '<p class="enote">No wallet values yet.</p>';
    tot.textContent = ''; note.textContent = '';
    return;
  }
  const priced = rows.filter(r => typeof r.total === 'number');
  const sum = priced.reduce((s, r) => s + r.total, 0);
  tot.textContent = priced.length ? usd(sum) : '';
  box.innerHTML = rows.map(r => {
    const share = sum > 0 && typeof r.total === 'number' ? (r.total / sum) * 100 : null;
    const bar = share == null ? ''
      : `<div class="wtrack" aria-hidden="true"><span class="wfill" style="width:${share.toFixed(1)}%"></span></div>`;
    const meta = typeof r.total === 'number'
      ? `<span>${r.count} open · LP <b class="mono">${usd(r.lp)}</b>${r.unpriced ? ` · ${r.unpriced} unpriced` : ''}${r.partial ? ' · partial holdings' : ''}</span>`
        + `<span class="wshare">${share == null ? 'share unavailable' : share.toFixed(1) + '%'}</span>`
      : `<span>${esc(r.why || 'unavailable')}</span>`;
    return `<div class="wbar ${r.cls}">`
      + `<div class="wtop"><span class="wname" title="${esc(r.addr || '')}">${esc(r.name)}</span>`
      + `<span class="wval">${typeof r.total === 'number' ? usd(r.total) : 'Unavailable'}</span></div>`
      + bar + `<div class="wmeta">${meta}</div></div>`;
  }).join('');
  const unpricedTotal = rows.reduce((s, r) => s + (r.unpriced || 0), 0);
  note.textContent = 'Value = tokens in the wallet + open positions + uncollected fees, at current prices. '
    + pricingText() + ' '
    + (unpricedTotal ? 'Unpriced tokens are excluded. ' : '')
    + (priced.length < rows.length ? 'Wallets without a value are left out of the shares.' : 'Shares are of the priced total above.');
}

function renderCollectPanel(){
  const box = $('#collectevents'), note = $('#collectpanelnote');
  const d = lastRender;
  if (!box) return;
  if (!d){ box.innerHTML = '<p class="enote">Collector status is not loaded yet.</p>'; note.textContent = ''; return; }
  const out = [];
  const run = d.ops && d.ops.lastRun;
  if (run){
    const dt = run.t ? new Date(run.t) : null;
    const when = dt && !isNaN(dt) ? dt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : run.t ? String(run.t) : 'time not recorded';
    const res = String(run.result || '');
    const cls = /failed|aborted/i.test(res) ? 'failed' : /locked|skip/i.test(res) ? 'skipped' : 'ok';
    const word = cls === 'failed' ? 'failed' : cls === 'skipped' ? 'skipped' : 'ran';
    out.push(`<div class="crun"><span class="clabel">Last run</span>`
      + `<span class="ctext">${esc(when)} · ${esc(run.mode || 'run')}${res ? ' — ' + esc(res) : ' — no result recorded'}</span>`
      + `<span class="cstatus ${cls}">${word}</span></div>`);
  } else {
    out.push('<div class="crun"><span class="clabel">Last run</span><span class="ctext">No collector run recorded yet.</span></div>');
  }
  const t = d.totals || {};
  if (t.eligibleCount){
    out.push(`<div class="cevent"><span class="ctext">${t.eligibleCount} position${t.eligibleCount === 1 ? '' : 's'} over the threshold`
      + ` · <b class="mono">${usd(t.collectableUsd)}</b> ready</span><span class="cstatus pending">pending</span></div>`);
  } else {
    out.push(`<div class="cevent"><span class="ctext">Nothing over the ${d.minWethPerPosition} ${esc((PRICING && PRICING.unit) || 'WETH')} per-position threshold.</span>`
      + `<span class="cstatus skipped">idle</span></div>`);
  }
  if (d.unlock && !d.unlock.armed)
    out.push('<div class="cevent"><span class="ctext">The collector is locked, so a scheduled run will skip.</span><span class="cstatus skipped">locked</span></div>');
  // The server's own count of collects since this browser's last visit.
  const line = ((lastInsights && lastInsights.changes) || []).find(x => /collects recorded|Collect history/.test(x));
  if (line){
    const since = lastInsights.since ? new Date(lastInsights.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    out.push(`<div class="cevent">${since ? `<span class="ctime">since ${esc(since)}</span>` : ''}<span class="ctext">${esc(line)}</span></div>`);
  }
  box.innerHTML = out.join('');
  // Two different things are easy to confuse: this panel and the Analytics
  // earnings table count what THIS collector swept (its own ledger), while the
  // cards' Claimed fees are read from chain and include every settlement the
  // wallet made itself. Zero here says nothing about the chain-derived figure.
  note.innerHTML = 'Per-collect rows, amounts and the CSV live on <a href="/analytics#earnings">Analytics</a>; this panel and that table count only this collector\'s own runs. '
    + 'Fees settled by the wallet itself (or by anything else) are not collector runs: those are the chain-derived <b>Claimed fees</b> on each card and in <b>Total claimed fees</b>. A zero here is not a zero there.';
}

function renderCoveragePanel(){
  const ul = $('#coverlist'), note = $('#coveragenote');
  const d = lastRender, pf = lastPortfolio, W = lastWatchForPf, ins = lastInsights;
  if (!ul) return;
  if (!d && !pf && !W && !ins){ ul.innerHTML = '<li class="enote">Checking what the data covers…</li>'; return; }
  const items = [];
  const li = (cls, html) => items.push(`<li class="${cls}">${html}</li>`);
  if (d && d.cached) li('warn', 'Positions are the last good read, not a fresh one.');
  if (ins && ins.freshness){
    const f = ins.freshness;
    if (f.stale) li('warn', 'Position observations are over 10 minutes old.');
    if (!f.watchAt) li('warn', 'Watched-wallet observations are unavailable.');
    else if (ins.at - f.watchAt > 600000) li('warn', 'Watched-wallet observations are over 10 minutes old.');
  }
  if (pf && pf.totals){
    const n = pf.totals.unpricedCount || 0;
    li(n ? 'warn' : 'ok', n
      ? `<b>${n}</b> unpriced token${n === 1 ? '' : 's'} in the main wallet, excluded from every value here.`
      : 'Every main-wallet token has a price source.');
  } else li('warn', 'Main-wallet token values are not loaded.');
  const wl = ((W && W.wallets) || []).filter(w => w.ok);
  const wUn = wl.reduce((s, w) => s + ((w.holdings && w.holdings.unpricedCount) || 0), 0);
  if (wUn) li('warn', `<b>${wUn}</b> unpriced balance${wUn === 1 ? '' : 's'} across watched wallets — balances, not unique tokens: one token held in two wallets counts twice.`);
  const partial = wl.filter(w => w.holdings && w.holdings.ok === false).length;
  if (partial) li('warn', `${partial} watched wallet${partial === 1 ? '' : 's'} returned a partial holdings list; only position tokens and ETH were checked.`);
  // A holding whose decimals were never read cannot be scaled, so it is left out
  // of the wallet total. Saying so on the page is the whole point: a total that
  // quietly omits a holding is not a total. The API flags it; this shows it.
  const unscaled = [
    ...((pf && pf.unscaled) || []),
    ...wl.flatMap(w => (w.holdings && w.holdings.unscaled) || []),
  ];
  if (unscaled.length) {
    const names = unscaled.map(u => esc(u.symbol || u.address || '?')).slice(0, 4).join(', ');
    li('warn', `<b>${unscaled.length}</b> holding${unscaled.length === 1 ? '' : 's'} (${names}${unscaled.length > 4 ? ', …' : ''}) could not be scaled because their decimals were not read from the chain, so they are missing from the totals above.`);
  }
  const trunc = wl.filter(w => w.truncated).length;
  if (trunc) li('warn', `${trunc} watched wallet${trunc === 1 ? '' : 's'} hold more position NFTs than were read; only the newest are shown.`);
  if (d && d.totals && d.totals.pnlApproxCount)
    li('warn', `<b>${d.totals.pnlApproxCount}</b> position${d.totals.pnlApproxCount === 1 ? '' : 's'} left out of LP vs holding: the deposit history behind them is incomplete.`);
  // Watched wallets count as well: a failed fee read is a failed fee read
  // whoever owns the position.
  const feeBad = [...((d && d.positions) || []),
    ...(wl || []).flatMap(w => w.positions || [])].filter(p => p.feesOk === false).length;
  if (feeBad) li('warn', `${feeBad} position${feeBad === 1 ? '' : 's'} could not report fees in this read.`);
  li('', 'Each position\u2019s collection history opens from its Claimed fees tile, with its coverage and how each claim is valued. Analytics adds the combined collect-by-collect table across positions, its CSV export and the fee-token cost basis.');
  ul.innerHTML = items.join('');
  note.textContent = 'Unavailable is not zero: a figure with no evidence behind it is left out rather than guessed.';
}

/* ---- incentive rewards (Merkl) ---- */
async function loadRewards(){
  try{
    const r = await fetch('/api/rewards');
    const d = await r.json(); noteOutcome('Merkl rewards', r.status, d);
    const chip = $('#merklchip');
    if (!d.ok || d.rewards == null){ chip.hidden = true; return; }
    // The chip only appears when there is something to claim; the check
    // itself keeps running so a new campaign shows up on its own.
    const claimable = d.rewards.filter(x => x.claimable > 0 || x.pending > 0);
    chip.hidden = !claimable.length;
    if (claimable.length){
      chip.className = 'chip ok';
      chip.innerHTML = 'Merkl rewards: ' + claimable.map(x =>
        `<b>${amount(x.claimable + x.pending)} ${x.symbol}</b>`).join(' · ')
        + ` — <a href="${d.claimUrl}" target="_blank" rel="noopener" style="color:inherit">claim</a>`;
    }
  }catch(e){ loadFailed('Merkl rewards', e); $('#merklchip').hidden = true; }
}

// 7-day portfolio value line.
function tvChart(pts){
  if (!pts || pts.length < 2) return '';
  const W = 600, H = 80, PL = 8, PR = 56, PT = 8, PB = 16;
  const t0 = pts[0].t, t1 = pts[pts.length-1].t;
  const vs = pts.map(p => p.v);
  const vmin = Math.min(...vs), vmax = Math.max(...vs);
  const pad = (vmax - vmin) * 0.1 || vmax * 0.01;
  const X = t => PL + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (W - PL - PR);
  const Y = v => PT + (1 - (v - vmin + pad) / (vmax - vmin + 2*pad)) * (H - PT - PB);
  const line = pts.map(p => `${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
  const fmtD = t => new Date(t).toLocaleDateString(undefined, {month:'short', day:'numeric'});
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line class="grid" x1="${PL}" x2="${W-PR}" y1="${Y(vmax).toFixed(1)}" y2="${Y(vmax).toFixed(1)}"/>
    <text class="axis" x="${W-PR+6}" y="${(Y(vmax)+3).toFixed(1)}">${usdK(vmax)}</text>
    <line class="grid" x1="${PL}" x2="${W-PR}" y1="${Y(vmin).toFixed(1)}" y2="${Y(vmin).toFixed(1)}"/>
    <text class="axis" x="${W-PR+6}" y="${(Y(vmin)+3).toFixed(1)}">${usdK(vmin)}</text>
    <polyline class="tline" points="${line}"/>
    <text class="axis" x="${PL}" y="${H-2}">${fmtD(t0)}</text>
    <text class="axis" x="${W-PR}" y="${H-2}" text-anchor="end">${fmtD(t1)}</text>
  </svg>`;
}

// Rows kept for the CSV export.
let historyRows = [];
let histD = null;

// Months are keyed in the browser's local time, so "September" is the
// September the wallet owner lives in.
const monthKey = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'); };
const monthLabel = k => new Date(k + '-01T12:00:00').toLocaleDateString(undefined, {month:'long', year:'numeric'});
// ?month=YYYY-MM preselects a month, so a month view can be bookmarked.
let monthFilter = (new URLSearchParams(location.search).get('month') || '').match(/^\d{4}-\d{2}$/) ? new URLSearchParams(location.search).get('month') : '';

// Wallets present in the history rows, main first, in server order.
function walletsIn(rows){
  const order = (histD && histD.byWallet || []).map(w => w.label);
  const names = [...new Set(rows.map(r => r.wallet || 'Main'))];
  return names.sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)));
}
// "Main $12.30 · LP Rewards $24.90" for a set of rows (USD, priced rows only).
function byWalletText(rows){
  const parts = [];
  for (const name of walletsIn(rows)){
    const mine = rows.filter(r => (r.wallet || 'Main') === name);
    const u = mine.reduce((s, r) => s + (r.usd || 0), 0);
    if (mine.length) parts.push(`${name} <b>${usd(u)}</b>`);
  }
  return parts.join(' · ');
}

// Per-month totals: collects, exact token amounts by symbol, and USD at
// current prices. Close events are included — fees taken on a close are still
// fees earned — matching the headline total.
function monthSummary(rows){
  const m = new Map();
  for (const r of rows){
    if (!r.t) continue;
    const k = monthKey(r.t);
    if (!m.has(k)) m.set(k, { key: k, count: 0, usd: 0, weth: 0, unpriced: 0, approx: 0, tokens: new Map(), rows: [] });
    const o = m.get(k);
    o.count++;
    o.rows.push(r);
    if (r.usd == null) o.unpriced++; else { o.usd += r.usd; o.weth += r.weth || 0; if (!r.locked) o.approx++; }
    if (r.f0 != null){
      o.tokens.set(r.sym0, (o.tokens.get(r.sym0) || 0) + r.f0);
      o.tokens.set(r.sym1, (o.tokens.get(r.sym1) || 0) + r.f1);
    }
  }
  return [...m.values()].sort((a, b) => b.key.localeCompare(a.key));
}

function renderMonths(){
  if (!histD) return;
  const months = monthSummary(histD.rows);
  const sel = $('#mfilter');
  if (!months.some(m => m.key === monthFilter)) monthFilter = '';
  sel.innerHTML = '<option value="">All time</option>'
    + months.map(m => `<option value="${m.key}"${m.key === monthFilter ? ' selected' : ''}>${monthLabel(m.key)}</option>`).join('');
  sel.hidden = months.length < 1;
  $('#mhead').hidden = months.length < 1;
  const weth = histD.wethUsd;
  $('#mtable').innerHTML = months.length ? `<table class="etable">
    <tr><th>Month</th><th>Collects</th><th>Fees</th><th>≈ USD</th>${weth ? `<th>≈ ${esc((PRICING && PRICING.unit) || 'WETH')}</th>` : ''}<th>By wallet</th></tr>
    ${months.map(m => `<tr class="mrow${m.key === monthFilter ? ' on' : ''}" data-m="${m.key}">
      <td>${monthLabel(m.key)}</td>
      <td>${m.count}</td>
      <td class="wrap">${[...m.tokens].filter(([,v]) => v > 0).map(([sym, v]) => amount(v) + ' ' + sym).join(' + ') || '—'}</td>
      <td class="u">${m.approx ? '<span class="approx">≈</span>' : ''}${usd(m.usd)}${m.unpriced ? ` <span class="unpriced" title="Collects in pairs no longer held have no current price and are not in the USD figure">${m.unpriced} unpriced</span>` : ''}${m.approx ? ` <span class="unpriced" title="No price record from the time of these collects; valued at today\'s prices">${m.approx} at today\'s prices</span>` : ''}</td>
      ${weth ? `<td>${m.weth.toFixed(4)}</td>` : ''}
      <td class="wrap">${byWalletText(m.rows) || '—'}</td>
    </tr>`).join('')}</table>` : '';
  for (const tr of $('#mtable').querySelectorAll('tr.mrow')){
    tr.addEventListener('click', () => setMonthFilter(tr.dataset.m === monthFilter ? '' : tr.dataset.m));
  }
}

function setMonthFilter(k){
  monthFilter = k;
  $('#mfilter').value = k;
  for (const tr of $('#mtable').querySelectorAll('tr.mrow')) tr.classList.toggle('on', tr.dataset.m === k);
  renderHistoryHead();
  renderHistoryTable();
}

// Headline total and cumulative chart: all time, or the selected month alone.
// Close events stay in — fees taken on a close are still fees earned.
function renderHistoryHead(){
  if (!histD) return;
  let rows = histD.rows, range = null, total = histD.totalUsd;
  if (monthFilter){
    rows = rows.filter(r => r.t && monthKey(r.t) === monthFilter);
    const [y, mo] = monthFilter.split('-').map(Number);
    range = { t0: new Date(y, mo - 1, 1).getTime(), t1: new Date(y, mo, 1).getTime() };
    total = rows.reduce((s, r) => s + (r.usd || 0), 0);
  }
  const wethSum = rows.reduce((s, r) => s + (r.weth || 0), 0);
  // `weth` on a collect row is not WETH: the server computes it as usd / wethUsd,
  // the value in THIS instance's unit of account. On Arc that unit is USDC and
  // wethUsd is 1, so "≈2.2556 WETH" was $2.26 of USDC read as ~$5,600 of ether.
  const unitName = (PRICING && PRICING.unit) || 'WETH';
  const weth = wethSum ? ' · ≈' + wethSum.toFixed(4) + ' ' + unitName : '';
  $('#etotal').textContent = usd(total) + weth + (monthFilter ? ' · ' + monthLabel(monthFilter) : '');
  const wallets = walletsIn(rows);
  $('#ewallets').innerHTML = wallets.length > 1 || (histD.byWallet || []).length > 1
    ? `<span>all wallets <b>${usd(total)}</b></span>` + wallets.map(name => { const mine = rows.filter(r => (r.wallet || 'Main') === name); return `<span>${name} <b>${usd(mine.reduce((s, r) => s + (r.usd || 0), 0))}</b> <span class="muted">${mine.length} collect${mine.length === 1 ? '' : 's'}</span></span>`; }).join('')
    : '';
  $('#echart').innerHTML = historyChart(rows, range);
}
$('#mfilter').addEventListener('change', (e) => setMonthFilter(e.target.value));

// Rows the collects table and CSV work from: the month filter, then the
// close-event toggle.
function filteredRows(){
  let rows = histD ? histD.rows : [];
  if (monthFilter) rows = rows.filter(r => r.t && monthKey(r.t) === monthFilter);
  if ($('#hidecloses').checked) rows = rows.filter(r => !r.principal);
  return rows;
}

// Recent-collects table, optionally without close events. The chart and totals
// stay unfiltered — fees taken during a close are still fees earned. With a
// month selected the table shows that whole month, not just the last dozen.
function renderHistoryTable(){
  if (!histD) return;
  const rows = filteredRows();
  const recent = (monthFilter ? rows : rows.slice(-12)).reverse();
  $('#etablewrap').innerHTML = recent.length ? `<table class="etable">
    <tr><th>When</th><th>Wallet</th><th>Position</th><th>Fees</th><th>≈ USD</th><th>Tx</th></tr>
    ${recent.map(r => `<tr>
      <td>${r.t ? new Date(r.t).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'}</td>
      <td>${r.wallet || 'Main'}</td>
      <td>${r.pair || '?'} <span class="mono">#${r.nftId || r.tokenId}</span>${r.version === 4 ? ' <span class="tier v4" title="Uniswap v4 position; recorded by the collector">v4</span>' : ''}${r.src === 'owner-modify' ? ' <span class="tier" title="Collected by the owner through the position manager (an add or remove of liquidity pays out the accrued fees), not by the collector">owner</span>' : ''}${r.principal ? ' (close)' : ''}</td>
      <td>${r.f0 != null ? amount(r.f0) + ' ' + r.sym0 + ' + ' + amount(r.f1) + ' ' + r.sym1 : '—'}${r.note ? ' <span class="muted" title="' + esc(r.note) + '">· ETH leg not recorded</span>' : ''}</td>
      <td class="u">${r.note ? '<span class="approx" title="' + esc(r.note) + '; the USD figure covers the other leg only">≈</span>' : r.locked ? '' : '<span class="approx" title="No price record from the time of this collect; valued at today\'s prices">≈</span>'}${usd(r.usd)}</td>
      <td>${chainRef(histD.explorer, `/tx/${r.tx}`, `${r.tx.slice(0,10)}…`, r.tx)}</td>
    </tr>`).join('')}</table>` : '';
}

function downloadCsv(){
  const head = 'time,wallet,wallet_address,block,tokenId,version,pair,fee0,symbol0,fee1,symbol1,usd,price_basis,weth_equivalent,weth_usd_at_basis,includes_principal_withdrawal,tx';
  const lines = filteredRows().map(r => [
    r.t ? new Date(r.t).toISOString() : '', r.wallet || 'Main', r.walletAddress || '', r.block, r.nftId || r.tokenId, r.version || 3, r.pair || '',
    r.f0 != null ? r.f0 : '', r.sym0 || '', r.f1 != null ? r.f1 : '', r.sym1 || '',
    r.usd != null ? r.usd.toFixed(4) : '', r.usd == null ? '' : r.locked ? 'at collect time' : 'today',
    r.weth != null ? r.weth.toFixed(6) : '', r.locked ? r.wethAt : (histD && histD.wethUsd ? histD.wethUsd.toFixed(2) : ''),
    r.principal ? 'yes' : 'no', r.tx,
  ].map(v => String(v).includes(',') ? '"' + v + '"' : v).join(','));
  const blob = new Blob([[head, ...lines].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lp-collects' + (monthFilter ? '-' + monthFilter : '') + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}
$('#ecsv').addEventListener('click', (e) => { e.preventDefault(); downloadCsv(); });

$('#hidecloses').checked = pref('hideCloses') === '1';
$('#hidecloses').addEventListener('change', (e) => {
  setPref('hideCloses', e.target.checked ? '1' : '0');
  renderHistoryTable();
});

$('#closedtoggle').addEventListener('click', () => {
  const cl = $('#closedlist');
  cl.hidden = !cl.hidden;
  setPref('showClosed', cl.hidden ? '0' : '1');
  $('#closedtoggle').textContent = $('#closedtoggle').textContent.replace(
    cl.hidden ? 'Hide' : 'Show', cl.hidden ? 'Show' : 'Hide');
});

async function loadHistory(){
  try{
    const r = await fetch('/api/history');
    const d = await r.json(); noteOutcome('Collection history', r.status, d);
    if (!d.ok) return;
    $('#earnings').hidden = false;
    renderChainFees();                 // the other source, side by side and named
    historyRows = d.rows;
    histD = d;
    renderAnalytics();
    $('#ecsv').hidden = !d.rows.length;
    if (d.tvSeries && d.tvSeries.length >= 2){
      $('#tvhead').hidden = false;
      $('#tvnow').textContent = usd(d.tvSeries[d.tvSeries.length-1].v);
      $('#tvchart').innerHTML = tvChart(d.tvSeries);
    }
    renderMonths();
    renderHistoryHead();
    renderHistoryTable();
    renderDaily();

    const n = d.rows.length, lk = d.lockedCount || 0;
    const basis = lk === 0 ? ' Valued at today\'s prices.'
      : lk === n ? ' Each collect is valued at the prices of its moment.'
      : ' Collects since ' + new Date(d.lockedSince).toLocaleDateString(undefined,{month:'short',day:'numeric'})
        + ' are valued at the prices of their moment; the ' + (n - lk) + ' earlier ones (≈) at today\'s prices.';
    // This table is the collector's own ledger (what this instance swept, plus any
    // backfill it could read). It is a different scope and a different source from
    // the cards' chain-derived Claimed fees, which include settlements the wallet
    // made itself — so an empty table here does not mean nothing was ever claimed.
    $('#enote').textContent = 'Fees only — principal from closed positions is excluded.' + basis
      + (d.backfilled ? ' Includes full pre-collector history via Blockscout.' : d.backfilling ? ' Historical backfill in progress…' : '')
      + (d.scanning ? ' Scan catching up…' : '')
      + (n === 0 ? ' No rows here means this collector has recorded no collect of its own; it is not a statement about fees the wallet settled itself.' : '')
      + ' Source: this collector\'s ledger — the cards\' Claimed fees and Total claimed fees are read from chain instead, and the two are not interchangeable.';
  }catch(e){ loadFailed('Collection history', e); }
}

/**
 * Claimed fees read from chain, shown beside the collected-fees table because the
 * two are different things: that table is this collector's own runs, this block is
 * every settlement the wallet made, whoever triggered it. They are never added
 * together, and a zero in one says nothing about the other.
 */
let chainFeesD = null;
async function renderChainFees(){
  const box = $('#chainfees'), tot = $('#chainfeestotal');
  if (!box) return;
  const e = await apiGet('/api/claims/total?wallet=all');
  if (e.kind !== 'ok') {
    if (chainFeesD) { box.insertAdjacentHTML('afterbegin', `<p class="chnote err" role="alert">${staleNote(chainFeesD.at, e.msg)}</p>`); return; }
    box.innerHTML = `<p class="enote">${e.kind === 'missing' ? 'Chain-derived claim history is not available from this server yet.' : e.kind === 'pending' ? 'Reading the claim history…' : esc('Claim history could not be loaded: ' + e.msg)}</p>`;
    if (tot) tot.textContent = '';
    if (e.kind === 'error') loadFailed('Claimed fees (chain)', new Error(e.msg));
    return;
  }
  loadOk('Claimed fees (chain)');
  const d = chainFeesD = e.d;
  renderChainTax();
  const money = d.usd.historical != null ? usd(d.usd.historical)
    : d.usd.pricedRecords ? 'priced subtotal ' + usd(d.usd.pricedSubtotal) : '—';
  if (tot) tot.textContent = d.rows.length ? money : 'no verified settlements';
  const rows = (d.positions || []).filter(p => p.records || p.state !== 'complete');
  box.innerHTML =
    `<p class="enote"><b>${esc(d.stateLabel)}</b> — ${esc(d.label)}. This is read from chain: every fee settlement the wallet made, including ones no collector run produced. `
    + `The table above counts only this collector's own runs; the two are different sources and are never added together.</p>`
    + (rows.length ? `<div class="etablewrap"><table class="etable"><thead><tr><th>Position</th><th>Status</th><th class="u">Claims</th><th class="u">Claimed</th><th class="u">USD (at each claim)</th><th>Last settlement</th><th>History</th></tr></thead><tbody>`
      + rows.map(p => `<tr><td>#${esc(p.tokenId)} ${esc(p.pair || '')}</td><td>${esc(p.status)}</td><td class="u">${p.records}</td>`
        + `<td class="u">${(p.tokens || []).map(t => `${amount(t.amount)} ${esc(t.symbol)}`).join(' · ') || '—'}</td>`
        + `<td class="u">${p.usdHistorical != null ? usd(p.usdHistorical) : p.pricedSubtotal ? 'subtotal ' + usd(p.pricedSubtotal) : '—'}</td>`
        + `<td>${p.lastT ? new Date(p.lastT).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</td>`
        + `<td>${esc(p.state === 'complete' ? 'complete history' : p.state)}</td></tr>`).join('')
      + `</tbody></table></div>` : '<p class="enote">No verified settlements in this scope.</p>')
    + `<p class="enote">${esc(d.coverage.note || '')}</p>`;
}

/**
 * Fee income the wallet settled itself, by month, from the chain-derived history.
 * The table above it is this collector's ledger; these are different sources and
 * are never added together. Each settlement is valued at its own transaction.
 */
function renderChainTax(){
  const box = $('#chaintax'), tot = $('#chaintaxtotal');
  if (!box) return;
  const d = chainFeesD;
  if (!d) { box.innerHTML = '<p class="enote">Chain-derived settlements are not loaded.</p>'; if (tot) tot.textContent = ''; return; }
  const by = new Map();
  for (const r of d.rows || []) {
    const k = r.t ? new Date(r.t).toISOString().slice(0, 7) : 'undated';
    if (!by.has(k)) by.set(k, { k, n: 0, usd: 0, unpriced: 0, wallets: {} });
    const o = by.get(k);
    o.n++;
    if (r.usd == null) o.unpriced++;
    else { o.usd += r.usd; o.wallets[r.walletLabel || r.wallet] = (o.wallets[r.walletLabel || r.wallet] || 0) + r.usd; }
  }
  const months = [...by.values()].sort((a, b) => b.k.localeCompare(a.k));
  const total = months.reduce((s, m) => s + m.usd, 0);
  if (tot) tot.textContent = months.length ? usd(total) : 'none';
  const mlabel = k => k === 'undated' ? 'undated' : new Date(k + '-15T12:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  box.innerHTML = months.length
    ? `<div class="etablewrap"><table class="etable"><tr><th class="l">Period</th><th>Settlements</th><th>LP fee income</th><th class="l">By wallet</th><th class="l">Basis</th></tr>`
      + months.map(m => `<tr><td class="l">${esc(mlabel(m.k))}</td><td>${m.n}</td>`
        + `<td class="u">${usd(m.usd)}${m.unpriced ? ` <span class="unpriced">${m.unpriced} unpriced</span>` : ''}</td>`
        + `<td class="l wrap">${Object.entries(m.wallets).sort((a, b) => b[1] - a[1]).map(([w, v]) => `${esc(w)} <b>${usd(v)}</b>`).join(' · ') || '—'}</td>`
        + `<td class="l muted">each settlement at its own transaction price</td></tr>`).join('')
      + `</table></div><p class="enote">Read from chain: fees the wallet settled itself, including ones no collector run produced. Withdrawn principal is not income and is excluded. ${esc(d.stateLabel)}.</p>`
    : '<p class="enote">No verified settlements read from chain yet.</p>';
}

/* ---- daily revenue ---- */
// Hourly accrual buckets from the server, folded into browser-local days and
// grouped by pool (pair + fee tier), so two positions in one pool read as one.
// Pool colors follow first appearance in the ledger and never re-rank; past six
// pools the rest fold into "Other".
const POOL_COLORS = ['#3987e5','#d95926','#199e70','#c98500','#d55181','#9085e9'];
const OTHER_COLOR = '#94A3B8';
const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
const dayLabel = k => new Date(k + 'T12:00:00').toLocaleDateString(undefined, {month:'short', day:'numeric'});

function dailyModel(d){
  const poolOf = id => { const p = d.pools[id] || {}; return (p.pair || '#' + id) + (p.tier ? ' ' + p.tier : ''); };
  const order = [];                       // pools by first appearance
  const days = new Map();                 // dayKey -> { total, pools: Map }
  for (const h of d.hours){
    const k = dayKey(h.h);
    if (!days.has(k)) days.set(k, { key: k, total: 0, pools: new Map() });
    const day = days.get(k);
    for (const [id, usd] of Object.entries(h.p)){
      const pool = poolOf(id);
      if (!order.includes(pool)) order.push(pool);
      day.total += usd;
      day.pools.set(pool, (day.pools.get(pool) || 0) + usd);
    }
  }
  const color = pool => { const i = order.indexOf(pool); return i < POOL_COLORS.length ? POOL_COLORS[i] : OTHER_COLOR; };
  const named = order.slice(0, POOL_COLORS.length);
  const seriesOf = day => {
    const out = named.map(p => ({ pool: p, usd: day.pools.get(p) || 0, color: color(p) }));
    const other = order.slice(POOL_COLORS.length).reduce((s, p) => s + (day.pools.get(p) || 0), 0);
    if (order.length > POOL_COLORS.length) out.push({ pool: 'Other', usd: other, color: OTHER_COLOR });
    return out.filter(x => x.usd > 0);
  };
  // Every calendar day from the first observed to today, so quiet days show as gaps.
  const keys = [...days.keys()].sort();
  const all = [];
  if (keys.length){
    const start = new Date(keys[0] + 'T12:00:00');
    for (let t = start.getTime(); dayKey(t) <= dayKey(Date.now()); t += 86400000){
      const k = dayKey(t);
      all.push(days.get(k) || { key: k, total: 0, pools: new Map() });
    }
  }
  return { all, order, named, color, seriesOf, hasOther: order.length > POOL_COLORS.length };
}

function dailyChart(m, coll){
  const days = m.all.slice(-30);
  if (!days.length) return '';
  const W = 600, H = 170, PL = 8, PR = 56, PT = 14, PB = 20;
  const collOf = d => (coll && coll.get(d.key)) || 0;
  const vmax = Math.max(...days.map(d => Math.max(d.total, collOf(d)))) || 1;
  const slot = (W - PL - PR) / days.length;
  const pair = Math.max(6, Math.min(40, slot * 0.7)); // earned + collected side by side
  const bw = pair / 2 - 1;
  const Y = v => PT + (1 - v / vmax) * (H - PT - PB);
  const today = dayKey(Date.now());
  const grid = [0.5, 1].map(f =>
    `<line class="grid" x1="${PL}" x2="${W-PR}" y1="${Y(vmax*f).toFixed(1)}" y2="${Y(vmax*f).toFixed(1)}"/>
     <text class="axis" x="${W-PR+6}" y="${(Y(vmax*f)+3).toFixed(1)}">${usd(vmax*f)}</text>`).join('');
  let bars = '';
  days.forEach((d, i) => {
    const x = PL + i * slot + (slot - pair) / 2;
    const c = collOf(d);
    if (c > 0) bars += `<rect class="collbar" x="${(x + bw + 2).toFixed(1)}" y="${Y(c).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, Y(0) - Y(c)).toFixed(1)}" rx="1">
        <title>${dayLabel(d.key)} · collected ${usd(c)}</title></rect>`;
    let acc = 0;
    for (const seg of m.seriesOf(d)){
      const y0 = Y(acc), y1 = Y(acc + seg.usd);
      bars += `<rect class="seg" x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, y0 - y1).toFixed(1)}" fill="${seg.color}" rx="1">
        <title>${dayLabel(d.key)}${d.key === today ? ' (so far)' : ''} · ${seg.pool} · ${usd(seg.usd)} — day total ${usd(d.total)}</title></rect>`;
      acc += seg.usd;
    }
    if (d.total > 0 && d.total === Math.max(...days.map(x => x.total)))
      bars += `<text class="dlab" x="${(x + bw/2).toFixed(1)}" y="${(Y(d.total) - 4).toFixed(1)}" text-anchor="middle">${usd(d.total)}</text>`;
  });
  const every = days.length > 14 ? 7 : days.length > 7 ? 2 : 1;
  const xlab = days.map((d, i) => (i % every === 0 || i === days.length - 1)
    ? `<text class="axis" x="${(PL + i * slot + slot/2).toFixed(1)}" y="${H-4}" text-anchor="middle">${dayLabel(d.key)}</text>` : '').join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}
    <line class="base" x1="${PL}" x2="${W-PR}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}"/>${bars}${xlab}</svg>`;
}

let dailyD = null;
// 'loading' until the request comes back, then what came back. An empty series is a
// real answer -- this instance has tracked nothing for the owner wallet -- and saying
// "loading…" forever in its place describes work that finished long ago.
let dailyState = 'loading';
async function loadDaily(){
  try{
    const r = await fetch('/api/daily');
    const d = await r.json(); noteOutcome('Daily revenue', r.status, d);
    if (!d.ok) { dailyState = 'failed'; return; }
    if (!d.hours.length) { dailyState = 'empty'; renderAnalytics(); return; }
    dailyState = 'ok';
    dailyD = d;
    renderDaily();
    renderAnalytics();
  }catch(e){ dailyState = 'failed'; loadFailed('Daily revenue', e); }
}

/* ---- analytics page: fee token lots (cost basis) ---- */
let lotsD = null;
async function loadLots(){
  try {
    const r = await fetch('/api/strategy/lots');
    const d = await r.json(); noteOutcome('Fee token lots', r.status, d);
    if (!d.ok) return;
    lotsD = d;
    renderLots();
    loadAudit();
  } catch(e){ loadFailed('Fee token lots', e); }
}
let auditD = null;
async function loadAudit(){
  try { const r = await fetch('/api/audit', { cache: 'no-store' }); auditD = await r.json(); noteOutcome('Ledger audit', r.status, auditD); renderLots(); } catch(e){ loadFailed('Ledger audit', e); }
}
/** "3 rows look off" next to the lots total, with every finding in the tooltip; an accept button for unfamiliar routes. */
function auditBadge(){
  const a = auditD; if (!a || !a.at) return '';
  const fs = a.findings || [];
  const real = fs.filter(f => f.severity !== 'info'), unf = fs.filter(f => f.kind === 'unfamiliar');
  const when = new Date(a.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const tip = fs.length ? fs.map(f => `${f.severity.toUpperCase()} ${f.token ? f.token + ' ' : ''}${f.day || ''}: ${f.note}`).join('\n') : 'Every valued row sits near its hourly price and inside what arrived on chain.';
  const shapes = [...new Set(unf.map(f => f.shape))];
  // Inflow reconciliation needs an explorer API this chain may not have. Say it
  // is out of scope rather than let the badge read as "everything checks out".
  if (a.inflowsUnavailable) return ` · <span class="audit warn" title="${esc('Ledger audit ' + when + '\nInflow reconciliation is not available on this chain (' + a.inflowsUnavailable + '), so booked proceeds were not checked against arrivals.\n' + tip)}">audit: inflows n/a</span>`;
  return ` · <span class="audit ${real.length ? (real.some(f => f.severity === 'bad') ? 'bad' : 'warn') : 'ok'}" title="${esc('Ledger audit ' + when + '\n' + tip)}">${real.length ? `${real.length} row${real.length === 1 ? '' : 's'} look${real.length === 1 ? 's' : ''} off` : 'audit clean'}</span>${shapes.length && !READ_ONLY ? ` <button class="msel" id="auditaccept" data-shapes="${esc(shapes.join(','))}" title="${esc('Routes not accepted yet: ' + shapes.join(', ') + '. Check one receipt of each, then accept.')}">accept ${shapes.length} route${shapes.length === 1 ? '' : 's'}</button>` : ''}`;
}
function renderLots(){
  const d = lotsD;
  if (!d) return;
  $('#lotsec').hidden = false;
  const fmtN = n => n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 4 : 0 });
  const toks = d.tokens || [];
  const sold = Object.fromEntries((d.soldAtCollect || []).map(x => [x.token, x]));
  const basis = toks.reduce((s,t)=>s+(t.basisUsd||0),0), value = toks.filter(t=>t.valueNowUsd!=null).reduce((s,t)=>s+t.valueNowUsd,0);
  const flagged = new Set(((auditD && auditD.findings) || []).filter(f => f.severity !== 'info' && f.token).map(f => f.token));
  $('#lottotal').innerHTML = toks.length ? `basis <b>${usd(basis)}</b> · now <b>${usd(value)}</b>${auditBadge()}` : '';
  $('#lottable').innerHTML = toks.length ? `<table class="etable">
    <tr><th>Token</th><th>Lots</th><th>Received</th><th>Basis (USD)</th><th>Avg cost</th><th>Price now</th><th>Value now</th><th>Unrealized</th><th title="Proceeds of lots disposed of (sent out of the wallet or sold later) minus their basis">Realized</th><th title="Lot tokens still held after disposals">Remaining</th><th title="The wallet balance now, from every source. It differs from Remaining when the token was bought, sold or moved outside the collector's hand-backs.">Still held</th><th title="Sold by the collector in the token's own v4 pool at collect time (sell-v4.js); these never became lots">Sold at collect</th><th>First · last</th></tr>
    ${toks.map(t => { const sd = sold[t.token]; return `<tr>
      <td><b>${t.token}</b>${flagged.has(t.token) ? ' <span class="audit warn" title="the ledger audit flagged a row of this token; see the badge above">!</span>' : ''}</td><td class="u">${t.lots}${t.unpriced ? ` <span class="muted" title="${t.unpriced} lot(s) have no price record">(${t.unpriced} unpriced)</span>` : ''}</td>
      <td class="u">${fmtN(t.amount)}</td><td class="u">${usd(t.basisUsd)}</td>
      <td class="u">${t.avgCostUsd != null ? '$' + t.avgCostUsd : '—'}</td><td class="u">${t.priceNowUsd != null ? '$' + t.priceNowUsd : t.priceNote ? '<span class="muted" title="' + esc(t.priceNote) + '">no reliable price</span>' : '—'}</td>
      <td class="u">${t.valueNowUsd != null ? usd(t.valueNowUsd) : '—'}</td>
      <td class="u chg ${t.unrealizedUsd == null ? '' : t.unrealizedUsd >= 0 ? 'up' : 'down'}">${t.unrealizedUsd == null ? '—' : (t.unrealizedUsd >= 0 ? '+' : '') + usd(t.unrealizedUsd)}</td>
      <td class="u chg ${t.realizedUsd == null ? '' : t.realizedUsd >= 0 ? 'up' : 'down'}" title="${t.disposedAmount ? fmtN(t.disposedAmount) + ' disposed for ' + usd(t.proceedsUsd) + (t.unpricedDisposals ? '; ' + t.unpricedDisposals + ' disposal(s) had no price record and count as $0 proceeds' : '') : ''}">${t.realizedUsd == null ? (t.disposedAmount ? '<span class="muted">unpriced</span>' : '—') : (t.unpricedDisposals ? '<span class="approx">≈</span>' : '') + (t.realizedUsd >= 0 ? '+' : '') + usd(t.realizedUsd)}</td>
      <td class="u">${t.remainingAmount != null ? fmtN(t.remainingAmount) : '—'}</td>
      <td class="u">${t.stillHeld != null ? fmtN(t.stillHeld) : '—'}</td>
      <td class="u">${sd ? `${fmtN(sd.amountSold)} → ${usd(sd.proceedsUsd)}${sd.skips ? ` <span class="muted" title="${esc(sd.lastSkipReason || '')}">(${sd.skips} skipped)</span>` : ''}` : '<span class="muted">—</span>'}</td>
      <td class="l muted">${t.first.slice(5,10)} · ${t.last.slice(5,10)}</td>
    </tr>`; }).join('')}${Object.keys(sold).filter(k => !toks.some(t => t.token === k)).map(k => { const sd = sold[k]; return `<tr><td><b>${esc(k)}</b></td><td class="u muted">0</td><td class="u muted">—</td><td class="u muted">—</td><td class="u muted">—</td><td class="u muted">—</td><td class="u muted">—</td><td class="u muted">—</td><td class="u muted">—</td><td class="u muted">—</td><td class="u muted">—</td><td class="u">${fmtN(sd.amountSold)} → ${usd(sd.proceedsUsd)}${sd.skips ? ` <span class="muted">(${sd.skips} skipped)</span>` : ''}</td><td class="l muted">sold at collect only</td></tr>`; }).join('')}</table>` : '<div class="muted">No fee tokens received unconverted yet.</div>';
}
document.addEventListener('click', e => {
  if (e.target.id !== 'lotcsv' || !lotsD) return;
  const head = 'time,wallet,token,amount,usd_per_token,usd,basis,tx,disposed_amount,remaining_amount,proceeds_usd,realized_usd,disposal_kind,disposal_tx';
  const lines = lotsD.lots.map(l => [l.t, l.wallet, l.token, l.amount, l.usdPerToken ?? '', l.usd ?? '', l.basis, l.tx, l.disposedAmount ?? '', l.remainingAmount ?? '', l.proceedsUsd ?? '', l.realizedUsd ?? '', l.disposalKind ?? '', l.disposalTx ?? ''].map(v => String(v).includes(',') ? '"' + v + '"' : v).join(','));
  const blob = new Blob([[head, ...lines].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'fee-token-lots.csv'; a.click();
});

/* ---- analytics page: strategy track record ---- */
let trackD = null;
async function loadTrack(){
  try {
    const r = await fetch('/api/strategy/track');
    const d = await r.json(); noteOutcome('Strategy track record', r.status, d);
    if (!d.ok) return;
    trackD = d;
    renderTrack();
  } catch(e){ loadFailed('Strategy track record', e); }
}
function renderTrack(){
  const d = trackD;
  if (!d) return;
  $('#tracksec').hidden = false;
  const s = d.summary || {};
  $('#tracktotal').innerHTML = s.proposals ? `proposals <b>${s.proposals}</b> · scored <b>${s.scored}</b> · avg <b>${s.avgScore != null ? s.avgScore + '%' : '—'}</b>` : '';

  // Per-author averages.
  const authors = (s.byAuthor || []);
  const authHtml = authors.length ? `<h4 class="ehead small">Per author</h4><div class="etablewrap"><table class="etable">
    <tr><th>Author</th><th>Proposals</th><th>Scored</th><th>Avg score</th><th>Items (met / beat / missed)</th><th>Hit rate</th></tr>
    ${authors.map(a => `<tr>
      <td><b>${esc(a.author)}</b></td>
      <td class="u">${a.proposals}</td>
      <td class="u">${a.scored}</td>
      <td class="u">${a.avgScore != null ? a.avgScore + '%' : '—'}</td>
      <td class="l">${a.items
        ? `<span class="chg up">${a.met || 0} met</span> · <span class="chg up">${a.beat || 0} beat</span> · <span class="chg down">${a.missed || 0} missed</span>`
        : '<span class="muted">—</span>'}</td>
      <td class="u">${a.hitRate != null ? a.hitRate + '%' : '—'}</td>
    </tr>`).join('')}</table></div>` : '';

  // Expected vs actual, per item.
  const ev = i => {
    if (i.verdict == null) return '<span class="muted">—</span>';
    const exp = i.expected || {};
    const act = i.actuals || {};
    const bits = [];
    if (exp.feesUsd != null) bits.push(`<span>exp $${exp.feesUsd}</span><span class="muted">→</span><span>${act.collectsUsd != null ? '$' + act.collectsUsd : '—'}</span>`);
    if (exp.feeAprPct != null) bits.push(`<span>exp ${exp.feeAprPct}% APR</span><span class="muted">→</span><span>${act.feeAprPct != null ? act.feeAprPct + '%' : '—'}</span>`);
    if (exp.netResultUsd != null) bits.push(`<span>exp $${exp.netResultUsd}</span><span class="muted">→</span><span>${act.resultVsDepositUsd != null ? '$' + act.resultVsDepositUsd : '—'}</span>`);
    return bits.length ? '<span class="muted small">' + bits.join('&nbsp; ') + '</span>' : '<span class="muted">—</span>';
  };

  const rows = d.proposals || [];
  $('#tracktable').innerHTML = rows.length ? `${authHtml}<div class="etablewrap"><table class="etable">
    <tr><th>Date</th><th>Author</th><th>Horizon</th><th>Score</th><th>Items (pair / action)</th><th>Expected→Actual</th><th>Outcome</th></tr>
    ${rows.map(p => `<tr>
      <td class="l muted">${(p.t||'').slice(0,10)}</td>
      <td><b>${esc(p.author)}</b></td>
      <td class="u">${p.horizonDays}d${p.outcome ? '' : ` <span class="muted" title="Scored at ${p.dueAt}">pending</span>`}</td>
      <td class="u">${p.outcome && p.outcome.score != null ? p.outcome.score + '%' : '—'}</td>
      <td class="l">${(p.items||[]).map(i => `<span class="muted">${esc(i.pair)}</span> <b>${esc(i.action)}</b>`).join(' · ')}</td>
      <td class="l small">${(p.items||[]).map(ev).join('<br>')}</td>
      <td class="l">${(p.items||[]).map(i => i.verdict ? `<span class="chg ${i.verdict==='beat'?'up':i.verdict==='missed'?'down':''}" title="${esc(i.note || '')}">${i.verdict}</span>${i.delta && i.delta.feesUsd != null ? ' <span class="muted">Δ$' + i.delta.feesUsd + '</span>' : ''}` : '').join(' · ')}</td>
    </tr>`).join('')}</table></div>` : '<div class="muted">No strategy proposals recorded yet. Agents record them with the record_strategy_proposal tool.</div>';
}

/* ---- analytics page: staking, performance, taxes ---- */
let stakingD = null;
async function loadStaking(){
  try {
    const r = await fetch('/api/staking');
    const d = await r.json(); noteOutcome('Staking', r.status, d);
    if (!d.ok) return;
    stakingD = d;
    renderStaking();
    renderAnalytics();
  } catch(e){ loadFailed('Staking', e); }
}

function renderStaking(){
  const d = stakingD;
  if (!d || !d.tokens.length) return;
  $('#stakesec').hidden = false;
  const t = d.tokens[0];
  const rw = t.rewards;
  $('#staketotal').textContent = usd(t.usd);
  $('#stakestats').innerHTML =
    `<span>${t.label}</span>` +
    `<span>staked <b>${amount(t.balance)} ${t.symbol}</b>${t.principal != null ? ` <span class="muted">(${amount(t.principal)} principal)</span>` : ''}</span>` +
    `<span>price <b>${t.price == null ? '—' : '$' + price(t.price)}</b></span>` +
    `<span>earned today <b>${amount(rw.today)}</b></span>` +
    `<span>7d <b>${amount(rw.d7)}</b> ${usd(rw.d7Usd)}</span>` +
    `<span>30d <b>${amount(rw.d30)}</b> ${usd(rw.d30Usd)}</span>` +
    `<span>all time <b>${amount(rw.total)} ${t.symbol}</b> ${usd(rw.totalUsd)}</span>` +
    (t.aprPct != null ? `<span>~<b>${t.aprPct.toFixed(0)}% APR</b> realised</span>` : '');
  const days = [...t.daily].reverse().slice(0, 14);
  $('#staketable').innerHTML = `<table class="etable">
    <tr><th class="l">Day</th><th>Reward</th><th>≈ USD</th></tr>
    ${days.map(x => `<tr><td class="l">${dayLabel(x.day)}</td><td>${amount(x.amount)} ${t.symbol}</td><td class="u">${x.approx ? '<span class="approx" title="No price record from the time of this rebase; valued at today\'s price">≈</span>' : ''}${usd(x.usd)}</td></tr>`).join('')}
  </table>`;
  $('#stakenote').textContent = `Rebasing receipt sampled hourly since ${new Date(t.since).toLocaleDateString(undefined,{month:'short',day:'numeric'})}; a balance change that matches the index change is a reward, anything else (a stake or unstake) is not counted. Rewards are valued at the price recorded at the sample.`;
}

/** Income events for the tax view: LP fee collects and staking rewards, USD at receipt. */
function incomeEvents(){
  const ev = [];
  for (const r of historyRows){
    if (!r.t) continue; // close events carry fees net of principal, so they count too
    // The identity fields travel with the row: the tax export has to decide whether
    // a ledger collect and a chain settlement are the same economic event, and a
    // transaction hash alone cannot say that (one transaction can settle several).
    ev.push({ t: r.t, type: 'LP fees', wallet: r.wallet || 'Main', what: r.pair + (r.principal ? ' (on close)' : ''), amounts: `${amount(r.f0)} ${r.sym0} + ${amount(r.f1)} ${r.sym1}`, usd: r.usd, approx: r.usd != null && !r.locked, tx: r.tx || '',
      tokenId: r.nftId != null ? String(r.nftId) : String(r.tokenId ?? '').replace(/^v\d+-/, ''), version: r.version ?? null, block: r.block ?? null });
  }
  for (const t of (stakingD && stakingD.tokens) || []){
    for (const e of t.events || []) ev.push({ t: e.t, type: 'Staking reward', wallet: ownerLabel(), what: t.label, amounts: `${amount(e.amount)} ${t.symbol}`, usd: e.usd, approx: !!e.approx, tx: '' });
  }
  return ev.sort((a, b) => a.t - b.t);
}

let treasuryD = null;
async function loadTreasury(){
  try { const r = await fetch('/api/treasury'); const d = await r.json(); noteOutcome('Vault', r.status, d); if (d.ok) { treasuryD = d; renderVault(); renderAnalytics(); } } catch(e){ loadFailed('Vault', e); }
}
function renderVault(){
  const d = treasuryD;
  if (!d) return;
  $('#vaultsec').hidden = false;
  $('#vaulttotal').textContent = usd(d.totalSplitUsdg);
  const tile = (n, l, cls = '') => `<div class="stat"><div class="n sm ${cls}">${n}</div><div class="l">${l}</div></div>`;
  $('#vaultgrid').innerHTML =
    tile(usd(d.totalSplitUsdg), 'Split to the vault, all time', 'fees') +
    // The treasury's own unit, not the portfolio's. PRICING.unit is what the
    // portfolio prices in -- WETH on Robinhood -- while the vault holds USDG, so
    // this tile labelled a USDG balance "WETH": a 2,500x implied-value error.
    tile(d.balanceUsdg == null ? '—' : usd(d.balanceUsdg), `Vault balance${d.unit ? ` (${esc(d.unit)})` : ''}`) +
    tile(d.enabled ? d.pct + '%' : 'off', d.enabled ? `Current split · max ${d.max}%` : 'Split is off (no treasury address yet)') +
    tile(String(d.count), `Splits recorded${d.failed ? ` · ${d.failed} failed` : ''}`);
  // Six-month bar chart of the split amounts.
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) { const m = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`); }
  const vals = months.map(k => d.byMonth[k] || 0);
  const max = Math.max(1, ...vals);
  const W = 600, H = 130, pad = 8, bw = (W - pad * 2) / months.length;
  const bars = vals.map((v, i) => { const h = Math.round((v / max) * (H - 40)); const x = pad + i * bw + bw * 0.2; return `<rect x="${x}" y="${H - 22 - h}" width="${bw * 0.6}" height="${h}" rx="3" fill="var(--neon-gold, #f5c542)" opacity="${v ? 0.9 : 0.25}"/><text class="axis" x="${x + bw * 0.3}" y="${H - 8}" text-anchor="middle">${new Date(months[i] + '-15T12:00:00').toLocaleDateString(undefined, { month: 'short' })}</text>${v ? `<text class="axis" x="${x + bw * 0.3}" y="${H - 26 - h}" text-anchor="middle">${usd(v)}</text>` : ''}`; }).join('');
  $('#vaultchart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:130px">${bars}</svg>`;
  $('#vaultnote').textContent = d.tba
    ? `Treasury account ${d.tba}. ${d.pct}% of every wallet's swept ${d.unit ? esc(d.unit) : 'proceeds'} goes to the vault at collect time; the rest goes to the wallet. Ledger: /fee-split-ledger.json.`
      + (d.balanceUsdg != null && Math.abs(Number(d.balanceUsdg) - Number(d.totalSplitUsdg || 0)) > 0.005
        ? ` The balance is ${usd(d.balanceUsdg)} while this ledger accounts for ${usd(d.totalSplitUsdg)}: ${usd(Number(d.balanceUsdg) - Number(d.totalSplitUsdg || 0))} reached the vault by some route this collector did not record.`
        : '')
    : 'No treasury address configured yet (vault.tba in settings.json). Deploy the vault, set the address, and splits start with the next collect.';
}

let watchForAnalytics = null;
async function loadWatchForAnalytics(){
  // A failed or ok:false answer keeps the last good payload; the strip says it is stale.
  try {
    const r = await fetch('/api/watch'); const d = await r.json();
    const o = apiOutcome(r.status, d);
    if (o.kind === 'pending') return;
    if (o.kind === 'error') throw new Error(o.msg + (watchForAnalytics ? ' (showing the last good data)' : ''));
    loadOk('Watched wallets');
    watchForAnalytics = d; renderAnalytics();
  } catch(e){ loadFailed('Watched wallets', e); }
}
function renderEarnedByWallet(){
  const rows = [];
  // Wallets this instance has never tracked on this chain are not rows of zeros: a
  // zero says "we watched and it earned nothing", which is a claim, and a false one.
  // The Arc instance is configured with every wallet but only Arc LP was ever used
  // there, so four wallets were reporting $0.00 as if measured. They are counted
  // below the table instead, so nothing disappears without being accounted for.
  const untracked = [];
  // The Main wallet is never missing from this table: while its daily series is still loading
  // the row says so, instead of the wallet silently not being there.
  if (dailyState === 'loading') rows.push({ name: ownerName(), today: null, d7: null, d30: null, all: null, since: 'loading…' });
  if (dailyState === 'failed') rows.push({ name: ownerName(), today: null, d7: null, d30: null, all: null, since: 'could not be read' });
  if (dailyState === 'empty') untracked.push(ownerName());
  if (dailyD){
    const m = dailyModel(dailyD);
    const now = Date.now();
    const sum = days => m.all.filter(x => now - new Date(x.key + 'T12:00:00').getTime() <= days * 86400000 + 43200000).reduce((s, x) => s + x.total, 0);
    const today = (m.all.find(x => x.key === dayKey(now)) || {}).total || 0;
    rows.push({ name: ownerName(), today, d7: sum(7), d30: sum(30), all: m.all.reduce((s, x) => s + x.total, 0), since: m.all.length ? dayLabel(m.all[0].key) : '' });
  }
  for (const w of (watchForAnalytics && watchForAnalytics.wallets) || []){
    if (!w.ok || !w.earned) continue;
    // Tracked here means: there is a date this instance started watching it, or a
    // figure it actually measured. Neither, and it has never been seen on this chain.
    const measured = [w.earned.today, w.earned.d7, w.earned.d30, w.earned.all].some((v) => v != null && Number(v) !== 0);
    if (!w.earned.since && !measured) { untracked.push(walletName(w)); continue; }
    rows.push({ name: walletName(w), today: w.earned.today, d7: w.earned.d7, d30: w.earned.d30, all: w.earned.all, since: w.earned.since ? dayLabel(w.earned.since) : '' });
  }
  if (!rows.length && !untracked.length) return;
  const nothingHere = untracked.length
    ? `<div class="muted" style="margin-top:6px;font-size:12px">${untracked.length === 1 ? 'One other wallet is' : untracked.length + ' other wallets are'} configured but ${untracked.length === 1 ? 'has' : 'have'} never been tracked on this chain: ${untracked.join(', ')}. Not shown rather than shown as zero.</div>`
    : '';
  if (!rows.length) { $('#walletearn').innerHTML = nothingHere; return; }
  $('#walletearn').innerHTML = `<table class="etable">
    <tr><th class="l" title="Fees as they accrued in each position, per hour, by calendar day: the Main wallet from its fee ledger, watched wallets from their accrual snapshots. Attribution's 7-day fee total uses rolling 7 × 24 h windows, so the two can differ by up to a day of fees.">Earned by wallet <span class="muted" style="font-weight:400">accrued, by calendar day</span></th><th>Today</th><th>7 days</th><th>30 days</th><th>All tracked</th><th class="l">Tracking since</th></tr>
    ${rows.map(r => `<tr><td class="l">${r.name}</td><td class="u">${r.today == null ? '—' : usd(r.today)}</td><td class="u">${r.d7 == null ? '—' : usd(r.d7)}</td><td class="u">${r.d30 == null ? '—' : usd(r.d30)}</td><td class="u">${r.all == null ? '—' : usd(r.all)}</td><td class="l muted">${r.since}</td></tr>`).join('')}
  </table>${nothingHere}`;
}

function renderAnalytics(){
  renderEarnedByWallet();
  if (PAGE !== 'analytics' || !histD) return;
  const ev = incomeEvents();
  // -- Income for taxes: by year, then by month --
  const byMonth = new Map();
  for (const e of ev){
    const k = monthKey(e.t);
    if (!byMonth.has(k)) byMonth.set(k, { key: k, lp: 0, lpN: 0, stake: 0, stakeN: 0, approx: 0, unpriced: 0, wallets: {} });
    const o = byMonth.get(k);
    if (e.type === 'LP fees') { o.lpN++; if (e.usd == null) o.unpriced++; else { o.lp += e.usd; if (e.approx) o.approx++; o.wallets[e.wallet] = (o.wallets[e.wallet] || 0) + e.usd; } }
    else { o.stakeN++; o.stake += e.usd || 0; if (e.approx) o.approx++; }
  }
  // Vault splits by month, from the split ledger: money that left the wallets for the treasury.
  const vaultBy = (treasuryD && treasuryD.byMonth) || {};
  for (const k of Object.keys(vaultBy)) if (!byMonth.has(k)) byMonth.set(k, { key: k, lp: 0, lpN: 0, stake: 0, stakeN: 0, approx: 0, unpriced: 0, wallets: {} });
  for (const m of byMonth.values()) m.vault = vaultBy[m.key] || 0;
  const months = [...byMonth.values()].sort((a, b) => b.key.localeCompare(a.key));
  const years = new Map();
  for (const m of months){ const y = m.key.slice(0,4); if (!years.has(y)) years.set(y, { y, lp: 0, stake: 0, lpN: 0, stakeN: 0, vault: 0 }); const o = years.get(y); o.lp += m.lp; o.stake += m.stake; o.lpN += m.lpN; o.stakeN += m.stakeN; o.vault += m.vault; }
  const grand = ev.reduce((s, e) => s + (e.usd || 0), 0);
  $('#taxsec').hidden = false;
  // Scoped on purpose: an empty collector ledger is $0.00 for THIS source, and says
  // nothing about the fees the wallet settled itself (the chain block below).
  $('#taxtotal').textContent = ev.length ? usd(grand) : '$0.00 — nothing recorded here';
  const mlabel = k => new Date(k + '-15T12:00:00').toLocaleDateString(undefined, { month: 'long' });
  let rows = '';
  for (const y of [...years.values()].sort((a, b) => b.y.localeCompare(a.y))){
    const yw = {}; for (const m of months.filter(m => m.key.startsWith(y.y))) for (const [w, v] of Object.entries(m.wallets)) yw[w] = (yw[w] || 0) + v;
    const wtext = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([w, v]) => `${w} <b>${usd(v)}</b>`).join(' · ') || '—';
    rows += `<tr class="year"><td class="l">${y.y}</td><td>${y.lpN}</td><td class="u">${usd(y.lp)}</td><td class="l wrap">${wtext(yw)}</td><td>${y.stakeN}</td><td class="u">${usd(y.stake)}</td><td class="u">${usd(y.lp + y.stake)}</td><td>${y.vault ? usd(y.vault) : '—'}</td></tr>`;
    for (const m of months.filter(m => m.key.startsWith(y.y))){
      rows += `<tr><td class="l">&nbsp;&nbsp;${mlabel(m.key)}</td><td>${m.lpN}</td><td class="u">${m.approx ? '<span class="approx" title="Some collects valued at today\'s prices">≈</span>' : ''}${usd(m.lp)}${m.unpriced ? ` <span class="unpriced">${m.unpriced} unpriced</span>` : ''}</td><td class="l wrap">${wtext(m.wallets)}</td><td>${m.stakeN || ''}</td><td class="u">${m.stakeN ? usd(m.stake) : '—'}</td><td class="u">${usd(m.lp + m.stake)}</td><td>${m.vault ? usd(m.vault) : '—'}</td></tr>`;
    }
  }
  $('#taxtable').innerHTML = `<table class="etable">
    <tr><th class="l">Period</th><th>Collects</th><th>LP fee income</th><th class="l">By wallet</th><th>Rebases</th><th>Staking income</th><th>Total income</th><th title="Share of swept USDG sent to the LOKOVault treasury (already included in the income figures)">Vault split</th></tr>${rows}</table>`;

  // -- Performance: trading-oriented figures --
  const now = Date.now();
  const inWin = ms => ev.filter(e => now - e.t <= ms);
  const sumUsd = arr => arr.reduce((s, e) => s + (e.usd || 0), 0);
  const lp30 = sumUsd(inWin(30 * 86400000).filter(e => e.type === 'LP fees'));
  const lp7 = sumUsd(inWin(7 * 86400000).filter(e => e.type === 'LP fees'));
  const st30 = sumUsd(inWin(30 * 86400000).filter(e => e.type !== 'LP fees'));
  const thisMonth = ev.filter(e => monthKey(e.t) === monthKey(now));
  const ytd = ev.filter(e => new Date(e.t).getFullYear() === new Date(now).getFullYear());
  // Earned (accrual) per day from the daily ledger: best day and 30-day average.
  let best = null, avg30 = null, earnedDays = 0;
  if (dailyD){
    const m = dailyModel(dailyD);
    const days = m.all.filter(x => now - new Date(x.key + 'T12:00:00').getTime() <= 30 * 86400000);
    earnedDays = days.length;
    if (days.length){ best = days.reduce((a, x) => (x.total > (a ? a.total : -1) ? x : a), null); avg30 = days.reduce((s, x) => s + x.total, 0) / days.length; }
  }
  const lpAll = sumUsd(ev.filter(e => e.type === 'LP fees'));
  const tile = (n, l, cls = '') => `<div class="stat"><div class="n sm ${cls}">${n}</div><div class="l">${l}</div></div>`;
  $('#perfsec').hidden = false;
  $('#perfgrid').innerHTML =
    tile(usd(lp30 + st30), 'Income, last 30 days', 'fees') +
    tile(usd(lp7), 'LP fees collected, 7 days') +
    tile(usd(sumUsd(thisMonth)), 'Income this month') +
    tile(usd(sumUsd(ytd)), 'Income year to date') +
    tile(avg30 == null ? '—' : usd(avg30) + '<span class="l">/day</span>', `Average earned per day${earnedDays ? ` · ${earnedDays}d` : ''}`) +
    tile(best ? usd(best.total) : '—', best ? `Best day · ${dayLabel(best.key)}` : 'Best day') +
    tile(usd(st30), 'Staking rewards, 30 days') +
    tile(usd(lpAll), 'LP fees collected, all time');
  // These tiles are the collector's own ledger and the accrual snapshots, for the
  // main wallet. Fees the wallet settled itself are chain-derived and shown below.
  $('#perfnote').textContent = `Collected = cash actually swept by this collector; earned = accrual between snapshots. ${ev.length} income events on record here`
    + ` — this collector's ledger and its snapshots only. Fees the wallet settled itself are in "Claimed fees — read from chain" below, and the two are never added together.`;
}

/**
 * One row per economic fee settlement, from both records of it.
 *
 * The same settlement can be written down twice: once by this collector when it
 * performed the collect, and once by the chain scan that reads every settlement the
 * wallet made. A tax export must contain each settlement once, so the two records
 * are matched on the settlement's identity — chain, position manager, position,
 * transaction, and the log index of the event inside that transaction — not on the
 * transaction hash, which is not unique: one transaction can settle several
 * positions, and a single position can be settled twice in one transaction (a
 * decrease and a collect).
 *
 * The collector's ledger records no log index. That is fine while a transaction
 * holds one settlement for the position, and it is exactly what makes the crowded
 * case undecidable: two chain settlements for one position in one transaction
 * cannot be told apart from the ledger's side. Those records are flagged and left
 * out of the reconciled total rather than guessed at — the reader still gets them,
 * labelled, and can settle the question by hand.
 *
 * Staking rewards are income from a different act and are never matched against
 * fees; vault splits are a movement of money already counted as income, so they
 * are carried for the record and counted in no total.
 */
function reconcileIncome({ events = [], chain = null, splits = [], chainId = null, managers = {} }){
  const lc = v => String(v ?? '').toLowerCase();
  const tid = v => String(v ?? '').replace(/^v\d+-/, '');
  const pairOf = new Map(((chain && chain.positions) || []).map(p => [tid(p.tokenId), p.pair || '']));
  const key = (c, m, id, tx) => [c ?? '', lc(m), tid(id), lc(tx)].join('|');
  const loose = (c, id, tx) => [c ?? '', tid(id), lc(tx)].join('|');

  // Group both records by the identity they share.
  const groups = new Map(), byLoose = new Map();
  const group = (k, c, m, id, tx) => {
    if (!groups.has(k)) {
      const g = { k, chainId: c, manager: lc(m), tokenId: tid(id), tx: lc(tx), chain: [], ledger: [] };
      groups.set(k, g);
      const l = loose(c, id, tx);
      byLoose.set(l, [...(byLoose.get(l) || []), g]);
    }
    return groups.get(k);
  };
  for (const r of (chain && chain.rows) || []) {
    const p = String(r.positionKey || '').split(':');
    const c = p[0] ? Number(p[0]) : chainId;
    const m = p[1] || managers[4] || '';
    group(key(c, m, r.tokenId, r.tx), c, m, r.tokenId, r.tx).chain.push(r);
  }
  const orphans = [];                       // ledger rows whose identity is incomplete
  for (const x of events) {
    if (x.type !== 'LP fees') continue;
    if (!x.tx || !x.tokenId) { orphans.push({ x, why: !x.tx ? 'the collector recorded no transaction hash, so this collect cannot be matched against the chain record' : 'the collector recorded no position id, so this collect cannot be matched against the chain record' }); continue; }
    const m = managers[x.version] || '';
    const k = key(chainId, m, x.tokenId, x.tx);
    if (groups.has(k)) { groups.get(k).ledger.push(x); continue; }
    // No exact match. Before treating it as a settlement the chain scan has not
    // seen, check whether the chain knows this position and transaction under a
    // different manager: that is a disagreement, not a second settlement.
    const near = byLoose.get(loose(chainId, x.tokenId, x.tx)) || [];
    if (near.length === 1 && !m) { near[0].ledger.push(x); continue; }   // manager unknown here: the chain record supplies it
    if (near.length) { orphans.push({ x, why: `the chain record for this position and transaction is under position manager ${near.map(g => g.manager).join(', ')}, which is not the one the collector recorded (${lc(m) || 'none'})` }); continue; }
    group(k, chainId, m, x.tokenId, x.tx).ledger.push(x);
  }

  const rows = [];
  const basisOf = r => r.usd == null ? 'unpriced'
    : r.priceSrc === 'block' ? 'at settlement (same-block swap)' : `at settlement (${r.priceSrc || 'pool'})`;
  const chainRow = (g, r, extra) => ({
    t: r.t, type: 'LP fees', chainId: g.chainId, manager: g.manager, tokenId: g.tokenId, tx: g.tx,
    logIndex: r.logIndex == null ? '' : r.logIndex,
    wallet: r.walletLabel || r.wallet, description: `#${g.tokenId} ${pairOf.get(g.tokenId) || ''}`.trim(),
    amounts: (r.tokens || []).map(t => `${t.amount} ${t.symbol}`).join(' + '),
    usd: r.usd == null ? null : r.usd, priceBasis: basisOf(r), collectorUsd: null,
    source: 'chain', matchStatus: 'chain only', counted: r.usd != null, note: '', ...extra,
  });
  const ledgerRow = (g, x, extra) => ({
    t: x.t, type: 'LP fees', chainId: g ? g.chainId : chainId, manager: g ? g.manager : lc(managers[x.version] || ''),
    tokenId: tid(x.tokenId), tx: lc(x.tx), logIndex: '',
    wallet: x.wallet || 'Main', description: x.what, amounts: x.amounts,
    usd: x.usd == null ? null : x.usd,
    priceBasis: x.usd == null ? 'unpriced' : x.approx ? "today's price (no price recorded at receipt)" : 'at receipt',
    collectorUsd: x.usd == null ? null : x.usd,
    source: 'collector ledger', matchStatus: 'collector only', counted: x.usd != null, note: '', ...extra,
  });

  for (const g of groups.values()) {
    if (g.chain.length && g.ledger.length) {
      if (g.chain.length === 1 && g.ledger.length === 1) {
        // One settlement, two records of it: one row, carrying both.
        const r = g.chain[0], x = g.ledger[0];
        rows.push(chainRow(g, r, { source: 'chain + collector ledger', matchStatus: 'matched',
          collectorUsd: x.usd == null ? null : x.usd,
          note: x.usd != null && r.usd != null && Math.abs(x.usd - r.usd) > Math.max(0.01, Math.abs(r.usd) * 0.01)
            ? `the two records value this settlement differently (chain ${r.usd.toFixed(2)}, collector ${x.usd.toFixed(2)}); the chain figure is used` : '' }));
        continue;
      }
      // Several settlements share this transaction and position. The ledger carries
      // no log index, so which collect is which cannot be established here.
      const why = `${g.chain.length} chain settlement${g.chain.length === 1 ? '' : 's'} and ${g.ledger.length} collector record${g.ledger.length === 1 ? '' : 's'} share this position and transaction; the collector records no log index, so they cannot be matched one to one`;
      for (const r of g.chain) rows.push(chainRow(g, r, { matchStatus: 'ambiguous', counted: false, note: why }));
      for (const x of g.ledger) rows.push(ledgerRow(g, x, { matchStatus: 'ambiguous', counted: false, note: why }));
      continue;
    }
    for (const r of g.chain) rows.push(chainRow(g, r));
    for (const x of g.ledger) rows.push(ledgerRow(g, x));
  }
  for (const o of orphans) rows.push(ledgerRow(null, o.x, { matchStatus: 'ambiguous', counted: false, note: o.why }));

  // Staking is income from a different act: never matched, counted on its own.
  for (const x of events) {
    if (x.type === 'LP fees') continue;
    rows.push({ t: x.t, type: x.type, chainId, manager: '', tokenId: '', tx: lc(x.tx), logIndex: '',
      wallet: x.wallet || 'Main', description: x.what, amounts: x.amounts, usd: x.usd == null ? null : x.usd,
      priceBasis: x.usd == null ? 'unpriced' : x.approx ? "today's price (no price recorded at receipt)" : 'at receipt',
      collectorUsd: null, source: 'collector ledger', matchStatus: 'not applicable', counted: false, note: '' });
  }
  // A vault split moves income that is already counted above; it is never income again.
  for (const r of splits) {
    if (r.status === 'failed' || !r.splitUsdg) continue;
    rows.push({ t: Date.parse(r.timestamp) || 0, type: 'Vault split', chainId, manager: '', tokenId: '',
      tx: lc(r.splitTxHash || ''), logIndex: '', wallet: r.wallet || 'Main',
      description: `${r.wallet} · ${r.pair || ''} · ${r.splitPct}% of ${r.totalCollectedUsdg} USDG`,
      amounts: `${r.splitUsdg} USDG`, usd: Number(r.splitUsdg), priceBasis: 'at receipt', collectorUsd: null,
      source: 'collector ledger', matchStatus: 'not applicable', counted: false,
      note: 'a share of income already counted above, moved to the treasury; not income again',
      splitUsdg: Number(r.splitUsdg) });
  }

  rows.sort((a, b) => a.t - b.t || String(a.tokenId).localeCompare(String(b.tokenId)) || (a.logIndex === '' ? -1 : a.logIndex) - (b.logIndex === '' ? -1 : b.logIndex));
  const lp = rows.filter(r => r.type === 'LP fees');
  // Each row is exported rounded to the cent, so the stated total is the sum of
  // those rounded figures: a reader who adds the column up must land on it exactly.
  const cents = v => Math.round(v * 100) / 100;
  const totals = {
    reconciledUsd: +lp.filter(r => r.counted).reduce((s, r) => s + cents(r.usd), 0).toFixed(2),
    settlements: lp.filter(r => r.matchStatus !== 'ambiguous').length,
    matched: lp.filter(r => r.matchStatus === 'matched').length,
    chainOnly: lp.filter(r => r.matchStatus === 'chain only').length,
    collectorOnly: lp.filter(r => r.matchStatus === 'collector only').length,
    ambiguous: lp.filter(r => r.matchStatus === 'ambiguous').length,
    unpriced: lp.filter(r => r.matchStatus !== 'ambiguous' && r.usd == null).length,
    stakingUsd: +rows.filter(r => r.type === 'Staking reward').reduce((s, r) => s + (r.usd || 0), 0).toFixed(2),
  };
  return { rows, totals };
}

const INCOME_CSV_COLUMNS = ['date_utc','match_status','source','chain_id','position_manager','position_id','tx_hash','log_index','wallet','type','description','amounts','usd_at_receipt','price_basis','collector_recorded_usd','in_reconciled_total','vault_split_usdg','note'];

/** The CSV text for an export: the header notes, the column row, then the rows. */
function incomeCsv({ rows, totals }, { partial = null } = {}){
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const n2 = v => v == null ? '' : Number(v).toFixed(2);
  const lines = [];
  // The notes ride in the file itself: a spreadsheet outlives the page it came from.
  lines.push(q(`Reconciled LP fee income: ${totals.reconciledUsd.toFixed(2)} USD across ${totals.settlements} settlements (${totals.matched} recorded by both sources, ${totals.chainOnly} by the chain only, ${totals.collectorOnly} by this collector only).`));
  if (totals.unpriced) lines.push(q(`${totals.unpriced} settlement(s) have no price record and carry an amount only; they are not in that total.`));
  if (totals.ambiguous) lines.push(q(`${totals.ambiguous} record(s) could not be matched one to one and are excluded from that total: see match_status "ambiguous" and the note column.`));
  lines.push(q(`Staking rewards, listed separately: ${totals.stakingUsd.toFixed(2)} USD. Vault splits are a movement of income already counted and are in no total.`));
  // The page totals the exact values; this file totals the rounded ones, so that the
  // column adds up to the figure above it. The two can differ by a cent or two.
  lines.push(q('Each row is rounded to the cent and the totals above are the sums of those rounded rows, so this file adds up exactly; the dashboard totals the unrounded values and can differ by a cent or two.'));
  if (partial) lines.push(q(`INCOMPLETE EXPORT — ${partial}`));
  lines.push(INCOME_CSV_COLUMNS.join(','));
  for (const r of rows) {
    lines.push([new Date(r.t).toISOString(), r.matchStatus, r.source, r.chainId, r.manager, r.tokenId, r.tx,
      r.logIndex, r.wallet, r.type, r.description, r.amounts, n2(r.usd), r.priceBasis, n2(r.collectorUsd),
      r.counted ? 'yes' : 'no', r.splitUsdg == null ? '' : n2(r.splitUsdg), r.note].map(q).join(','));
  }
  return lines.join('\n');
}

// Tax CSV: one row per economic settlement, both records of it on that row.
$('#taxcsv').addEventListener('click', async e => {
  e.preventDefault();
  const note = $('#taxcsvnote');
  let splits = [];
  try { splits = await (await fetch('/fee-split-ledger.json')).json(); } catch(e){}
  let chain = chainFeesD, failed = null;
  if (!chain) {
    try {
      const j = await (await fetch('/api/claims/total?wallet=all')).json();
      if (j && j.ok) chain = j; else failed = (j && j.error) || 'the server did not return the claim history';
    } catch(err){ failed = err.message; }
  }
  // A ledger-only file looks like a complete record and is not one: the settlements
  // the wallet made itself are missing from it. Say so and make the reader choose.
  if (failed) {
    const msg = `The chain-derived settlements could not be read (${failed}).\n\nA download now would contain this collector's own ledger only — ${incomeEvents().filter(x => x.type === 'LP fees').length} collect(s) — and would be missing every fee the wallet settled itself. It is not a complete income record.\n\nDownload the incomplete ledger-only export anyway?`;
    if (note) { note.textContent = 'chain settlements unavailable — export is incomplete'; note.classList.add('err'); }
    if (!confirm(msg)) return;
  } else if (note) { note.textContent = 'both sources below'; note.classList.remove('err'); }

  const d = lastRender || {};
  const out = reconcileIncome({ events: incomeEvents(), chain, splits,
    chainId: CHAIN.id != null ? CHAIN.id : d.chainId, managers: { 4: d.positionManagerV4, 3: d.positionManager } });
  const csv = incomeCsv(out, { partial: failed ? `the chain-derived settlements could not be read (${failed}); this file holds this collector's ledger only and is missing every fee the wallet settled itself` : null });
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (failed ? 'lp-income-INCOMPLETE-ledger-only-' : 'lp-income-') + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
});

// Collected per local day, from the collects history (cash actually swept).
function collectedByDay(){
  const by = new Map();
  for (const r of historyRows){ if (!r.t || r.usd == null || r.mainWallet === false) continue; const k = dayKey(r.t); by.set(k, (by.get(k) || 0) + r.usd); }
  return by;
}

function renderDaily(){
  const d = dailyD;
  if (!d) return;
  try{
    const m = dailyModel(d);
    const coll = collectedByDay();
    $('#dailysec').hidden = false;

    const today = dayKey(Date.now());
    const byKey = new Map(m.all.map(x => [x.key, x]));
    const todayUsd = (byKey.get(today) || {}).total || 0;
    const yest = byKey.get(dayKey(Date.now() - 86400000));
    const full = m.all.filter(x => x.key !== today);
    const last7 = full.slice(-7);
    const avg7 = last7.length ? last7.reduce((s, x) => s + x.total, 0) / last7.length : null;
    const month = m.all.filter(x => x.key.slice(0,7) === today.slice(0,7)).reduce((s, x) => s + x.total, 0);
    const monthName = new Date().toLocaleDateString(undefined, {month:'long'});
    const collToday = coll.get(today) || 0;
    $('#dstats').innerHTML =
      `<span><b>${usd(todayUsd)}</b>earned today so far</span>`
      + (collToday ? `<span><b>${usd(collToday)}</b>collected today</span>` : '')
      + (yest ? `<span><b>${usd(yest.total)}</b>earned yesterday</span>` : '')
      + (avg7 != null ? `<span><b>${usd(avg7)}</b>/day, ${last7.length}-day average</span>` : '')
      + `<span><b>${usd(month)}</b>${monthName} so far</span>`;

    $('#dchart').innerHTML = dailyChart(m, coll);
    $('#dlegend').innerHTML = '<span class="lhead">Earned by pool:</span>' + m.named.map(p => `<span><i style="background:${m.color(p)}"></i>${p}</span>`).join('')
      + (m.hasOther ? `<span><i style="background:${OTHER_COLOR}"></i>Other</span>` : '')
      + (coll.size ? '<span><i class="outline"></i>Collected that day</span>' : '');

    const firstH = d.hours[0].h;
    const partialFirst = m.all.length && new Date(firstH).getHours() > 0 ? m.all[0].key : null;
    const rows = m.all.slice(-31).reverse();
    $('#dtable').innerHTML = `<table class="etable dtable">
      <tr><th>Day</th><th>Earned</th><th>Collected</th><th>Earned by pool</th></tr>
      ${rows.map(d => `<tr>
        <td>${dayLabel(d.key)}${d.key === today ? ' <span class="pool">(so far)</span>' : d.key === partialFirst ? ' <span class="pool">(from ' + new Date(firstH).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}) + ')</span>' : ''}</td>
        <td class="u">${usd(d.total)}</td>
        <td>${coll.has(d.key) ? usd(coll.get(d.key)) : '<span class="pool">—</span>'}</td>
        <td class="wrap">${m.seriesOf(d).sort((a, b) => b.usd - a.usd).map(x =>
          `<span class="pool"><i style="background:${x.color}"></i>${x.pool} <b>${usd(x.usd)}</b></span>`).join(' &nbsp;·&nbsp; ') || '<span class="pool">—</span>'}</td>
      </tr>`).join('')}</table>`;

    const first = m.all[0];
    $('#dnote').textContent = 'Earned is fees as they accrue, whether or not collected yet: the change in each position\'s uncollected fees between snapshots every five minutes, valued at the prices at that moment. Collected is what collect runs actually swept that day, which includes fees earned on earlier days. Days in your local time; tracking began ' + dayLabel(first.key) + '.';
  }catch(e){ /* panel stays hidden */ }
}

let EXPLORER = null;

// What the PnL figure is made of, all legs at today's prices.
function pnlTip(p){
  const L = p.pnlLegs;
  if (!L) return '';
  const sign = v => (v < 0 ? '−' : '+') + usd(Math.abs(v));
  const row = (label, v, neg) => `<tr><td>${label}</td><td class="n">${neg ? '−' : ''}${usd(v)}</td></tr>`;
  const feesTotal = L.collected + L.uncollected;
  const holdCost = p.pnlUsd - feesTotal;
  return `<span class="tip"><table>
    ${row('Still in the pool', L.held)}
    ${row('Uncollected fees', L.uncollected)}
    ${row('Fees collected (all time)' + (L.collects ? ' · ' + L.collects + ' collect' + (L.collects === 1 ? '' : 's') : '') + (L.collects && L.collectedBasis === 'today' ? ' (at today\'s prices)' : ''), L.collected)}
    ${row('Principal withdrawn', L.withdrawn)}
    ${row('Deposited from wallet' + (L.adds ? ' · ' + L.adds + ' add' + (L.adds === 1 ? '' : 's') : ''), L.deposited)}
    <tr class="sum"><td>Profit vs holding</td><td class="n${p.pnlUsd < 0 ? ' neg' : ''}">${sign(p.pnlUsd)}</td></tr>
  </table>
  <div class="note">Profit = still in the pool + fees + principal withdrawn − deposited. Fees earned ${usd(feesTotal)}; ${holdCost < 0 ? 'holding the deposit instead would be worth ' + usd(-holdCost) + ' more' : 'the pool balance is also ' + usd(holdCost) + ' ahead of holding'}. All legs at today\'s prices${p.pnlApprox ? '; deposit history is missing a recent change' : ''}${p.pnlSource === 'rpc' ? ' (history read from the chain)' : p.pnlSource === 'blockscout' ? ' (history from Blockscout until the chain scan reaches the mint)' : p.pnlSource === 'first-seen' ? ' (deposit = the amounts first seen by the dashboard, not the mint)' : ''}.</div></span>`;
}

// Projections need a track record: a position's age, from its first deposit.
const PROJECT_AFTER_DAYS = 7;
const ageDays = p => p.pnlSince ? (Date.now() - p.pnlSince) / 86400000 : null;
// Time in range, as a weight on the rate, once a day of it has been observed.
const rangeW = p => p.range && p.range.pctInRange != null && p.range.trackedHours >= 24 ? p.range.pctInRange / 100 : null;
const spanText = h => h < 48 ? h.toFixed(0) + 'h' : (h / 24).toFixed(1) + 'd';
// Expected daily fees: the in-range rate times the share of time spent in range.
// Without a day of range history, an in-range position counts at full rate and
// an idle one at zero.
const expectedDaily = p => { if (p.dailyUsd == null) return null; const w = rangeW(p); return w != null ? p.dailyUsd * w : p.inRange ? p.dailyUsd : 0; };

// Explorer link for a position NFT, on whichever position manager minted it.
function nftLink(d, p, label){
  const mgr = p.version === 4 ? d.positionManagerV4 : d.positionManager;
  return EXPLORER && mgr
    ? `<a href="${EXPLORER}/token/${mgr}/instance/${p.nftId || p.tokenId}" target="_blank" rel="noopener">${label}</a>`
    : label;
}

// Status chips: is the collector armed, and can we arm/lock it from here?
let READ_ONLY = false;
function applyReadOnly(d){
  READ_ONLY = !!d.readOnly;
  if (!READ_ONLY) return;
  for (const id of ['collect','armbtn','lockbtn','armform']) { const el = $('#'+id); if (el) el.hidden = true; }
}

function renderUnlock(unlock){
  if (READ_ONLY) { for (const id of ['armbtn','lockbtn','armform']) $('#'+id).hidden = true; return; }
  $('#chips').hidden = false;
  const arm = $('#armchip');
  const armed = unlock && unlock.armed;
  if (armed){
    const dd = Math.floor(unlock.minutesLeft / 1440), h = Math.floor((unlock.minutesLeft % 1440) / 60), m = unlock.minutesLeft % 60;
    arm.className = 'chip ok';
    arm.innerHTML = 'Collector armed · <b>' + (dd ? dd + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm</b> left';
  } else {
    arm.className = 'chip warn';
    arm.textContent = unlock && unlock.lost
      ? 'Collector lost its arm window at a restart (was armed until ' + new Date(unlock.until).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) + ') — re-arm'
      : 'Collector locked — scheduled and button collects will skip';
  }
  // Watchdog: a background loop that stopped reporting shows as a warning chip.
  let lc = document.getElementById('loopchip');
  if (!lc) { lc = document.createElement('span'); lc.id = 'loopchip'; lc.className = 'chip warn'; lc.hidden = true; arm.parentNode.insertBefore(lc, arm.nextSibling); }
  const stale = Object.values((lastRender && lastRender.loops) || {}).filter(l => l.stale);
  lc.hidden = !stale.length;
  if (stale.length) lc.textContent = stale.map(l => `${l.label} not reporting${l.ageMin == null ? '' : ' for ' + Math.round(l.ageMin) + ' min'}`).join(' · ');
  $('#armbtn').hidden = !!armed;
  $('#lockbtn').hidden = !armed;
  if (armed) $('#armform').hidden = true;
}

function render(d){
  lastRender = d;
  notePricing(d);
  EXPLORER = d.explorer || null;
  $('#owner').textContent = d.owner.slice(0,6) + '…' + d.owner.slice(-4);
  // The address is the configured main wallet, not the owner of everything on
  // the page: watched wallets appear here too, and on Analytics most sections
  // cover a different scope. Say which wallet it is and let each section say
  // what it covers.
  CHAIN = { id: d.chainId, name: d.chainName || null };
  const ol = $('#ownerline');
  if (ol) ol.firstChild && (ol.firstChild.textContent = PAGE === 'analytics' ? 'Main wallet ' : 'Positions held by ');
  // The unit of account is this instance's, not ETH everywhere: on Arc it is USDC.
  $('#blockinfo').textContent = 'block ' + d.blockNumber.toLocaleString('en-US')
    + (d.wethUsd ? ' · ' + ((PRICING && PRICING.unit) || (d.pricing && d.pricing.unit) || 'ETH') + ' ' + usd(d.wethUsd) : '');
  $('#pulse').className = 'pulse' + (d.cached ? ' stale' : '');

  renderUnlock(d.unlock);
  const gas = $('#gaschip');
  if (d.operatorGas){
    gas.hidden = false;
    gas.className = 'chip' + (d.operatorGas.low ? ' warn' : '');
    gas.innerHTML = 'Operator gas <b>' + d.operatorGas.eth.toFixed(4) + ' ' + esc(d.operatorGas.symbol || (PRICING && PRICING.native) || '') + '</b>'
      + (d.operatorGas.low ? ' — running low, top up' : '');
  } else {
    gas.hidden = true;
  }

  // Ops strip: last collector run + 24h gas budget.
  const run = $('#runchip');
  if (d.ops && d.ops.lastRun){
    const lr = d.ops.lastRun;
    let when = '';
    if (lr.t){
      const dt = new Date(lr.t);
      when = isNaN(dt) ? lr.t
        : dt.toLocaleString(undefined, {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
    }
    run.hidden = false;
    run.className = 'chip' + (/locked|failed|aborted/.test(lr.result) ? ' warn' : '');
    run.innerHTML = 'Last run <b>' + when + '</b> · ' + lr.mode + ' — ' + lr.result;
  } else {
    run.hidden = true;
  }
  const gd = $('#gasday');
  if (d.ops && d.ops.gas24h && d.ops.gas24h.capEth){
    const g = d.ops.gas24h;
    gd.hidden = false;
    gd.className = 'chip' + (g.eth > g.capEth * 0.8 ? ' warn' : '');
    gd.innerHTML = 'Gas 24h <b>' + g.eth.toFixed(5) + '</b> / ' + g.capEth + ' ETH cap';
  } else {
    gd.hidden = true;
  }

  $('#summary').hidden = false;
  $('#watchsec').hidden = false;
  lastMain = d;
  renderHeadline();
  renderSidebar();
  const coll = $('#collectable');
  coll.textContent = usd(d.totals.collectableUsd);
  coll.className = 'n sm' + (d.totals.eligibleCount ? ' fees' : '');
  $('#collectlabel').textContent = d.totals.eligibleCount
    ? 'Collectable now, across ' + d.totals.eligibleCount + ' position' + (d.totals.eligibleCount === 1 ? '' : 's')
    : 'Collectable now (threshold ' + d.minWethPerPosition + ' WETH each)';
  $('#idle').textContent = d.totals.idle;
  applyReadOnly(d);

  // Headline profit: verified PnL vs HODL across open positions.
  // LP versus holding, in its two halves: fees earned, and what price moves
  // cost against simply holding the deposit. Red when holding would have won.
  // Run-rate projection: today's accrual rate carried forward, only for
  // positions that have been open at least a week (a few days of rate is not
  // a basis for a month). Idle positions count as zero; younger ones and those
  // without a measurable rate yet are called out.
  const seasoned = p => ageDays(p) != null && ageDays(p) >= PROJECT_AFTER_DAYS;
  const earning = d.positions.filter(p => seasoned(p) && expectedDaily(p) != null);
  const young = d.positions.filter(p => !seasoned(p)).length;
  const unmeasured = d.positions.filter(p => p.inRange && p.dailyUsd == null && seasoned(p)).length;
  const weightedN = earning.filter(p => rangeW(p) != null).length;
  const idleN = earning.filter(p => !p.inRange && rangeW(p) == null).length;
  const daily = earning.reduce((s, p) => s + expectedDaily(p), 0);
  const shortest = earning.reduce((m, p) => p.rateWindowH != null && (m == null || p.rateWindowH < m) ? p.rateWindowH : m, null);
  if (earning.length){
    $('#proj30').textContent = usd(daily * 30);
    $('#projlabel').textContent = 'Projected fees, next 30 days · at current rates';
    $('#projparts').innerHTML = '<b>' + usd(daily * 7) + '</b> next 7 days · <b>' + usd(daily) + '</b>/day'
      + (weightedN ? ' · ' + weightedN + ' weighted by time in range' : '')
      + (idleN ? ' · ' + idleN + ' idle at $0' : '')
      + (young ? ' · ' + young + ' under ' + PROJECT_AFTER_DAYS + ' days old, not projected' : '')
      + (unmeasured ? ' · ' + unmeasured + ' without a rate yet' : '')
      + (shortest != null && shortest < 24 ? ' · shortest window ' + shortest.toFixed(1) + 'h' : '');
    $('#projparts').hidden = false;
  } else {
    $('#proj30').textContent = '—';
    $('#projlabel').textContent = 'Projected fees, next 30 days';
    $('#projparts').innerHTML = young ? 'No position has been open ' + PROJECT_AFTER_DAYS + ' days yet' : '';
    $('#projparts').hidden = !young;
  }

  const pt = $('#pnltotal'), pl = $('#pnllabel'), pp = $('#pnlparts');
  if (d.totals.pnlCount){
    const net = d.totals.pnlUsd, fees = d.totals.feesEarnedUsd || 0, move = d.totals.holdCostUsd || 0;
    const n = d.totals.pnlCount, excl = d.totals.pnlApproxCount;
    const scope = n + ' position' + (n === 1 ? '' : 's') + (excl ? ' (' + excl + ' unverified excluded)' : '');
    pt.textContent = (net >= 0 ? '+' : '−') + usd(Math.abs(net));
    pt.className = 'n sm ' + (net >= 0 ? 'fees' : 'loss');
    pl.textContent = (net >= 0 ? 'LP beat holding · ' : 'Holding would have earned more · ') + scope;
    pl.className = 'l' + (net >= 0 ? '' : ' warn');
    pp.innerHTML = 'Fees earned <b>' + usd(fees) + '</b> · price move <b class="' + (move < 0 ? 'neg' : '') + '">'
      + (move < 0 ? '−' : '+') + usd(Math.abs(move)) + '</b>';
    pp.hidden = false;
  } else {
    pt.textContent = '—';
    pt.className = 'n sm';
    pl.textContent = 'LP vs holding';
    pl.className = 'l';
    pp.hidden = true;
  }

  // Tab title as a passive monitor for a pinned tab.
  const alerts = [];
  if (d.totals.idle) alerts.push('⚠' + d.totals.idle + ' idle');
  if (d.totals.eligibleCount) alerts.push(usd(d.totals.collectableUsd) + ' ready');
  if (d.unapproved && d.unapproved.length) alerts.push(d.unapproved.length + ' unapproved');
  document.title = alerts.length ? alerts.join(' · ') + ' — LP' : 'Liquidity positions';
  $('#idlelabel').textContent = d.totals.idle === 1
    ? 'Position sitting outside its range'
    : 'Positions sitting outside their range';

  const warn = (d.unapproved && d.unapproved.length)
    ? `<div class="warn-banner">
        <b>${d.unapproved.length === 1 ? 'New position' : 'New positions'} not yet approved for the collector:</b>
        ${d.unapproved.map(id => '#' + id).join(', ')} —
        the operator cannot collect fees from ${d.unapproved.length === 1 ? 'it' : 'these'} until approved.
        Run this from the project directory (it will ask for the owner key):
        <code>node approve-operator.js ${d.unapproved.join(' ')}</code>
      </div>`
    : '';

  $('#errors').innerHTML = warn + (d.errors || []).map(e =>
    `<div class="err">Position ${e.tokenId} could not be read. ${e.error}</div>`).join('');

  // Closed positions: hidden behind a toggle, remembered per browser.
  const ct = $('#closedtoggle'), cl = $('#closedlist');
  if (d.closed && d.closed.length){
    const show = pref('showClosed') === '1';
    ct.hidden = false;
    ct.textContent = (show ? 'Hide' : 'Show') + ' closed positions (' + d.closed.length + ')';
    cl.hidden = !show;
    cl.innerHTML = d.closed.map(c => {
      const label = '#' + (c.nftId || c.tokenId) + (c.version === 4 ? ' v4' : '') + (c.pair ? ' · ' + c.pair : '');
      return `<span class="closedrow">${nftLink(d, c, label)}</span>`;
    }).join('');
  } else {
    ct.hidden = true;
    cl.hidden = true;
  }

  if (!d.positions.length){
    $('#list').innerHTML = '<div class="empty">No open positions found for this address.</div>';
    return;
  }

  lastRenderD = d;
  $('#list').innerHTML = sortLT(d.positions).map(p => {
    const v = orient(p);
    const near = p.inRange && (v.toUpper < NEAR || v.toLower < NEAR);
    // Extras the owner's cards carry that a watched wallet's do not.
    const perf = [
      !p.inRange && p.dailyUsd > 0 ? `<span class="rate">not earning while out of range · was <b class="was">${usd(p.dailyUsd)}/day</b> in range</span>` : '',
      p.range && p.range.trackedHours >= 1 ? `<span class="rate">in range <b class="${p.range.pctInRange >= 50 ? '' : 'neg'}">${p.range.pctInRange.toFixed(0)}%</b> of the last ${spanText(p.range.trackedHours)} · ${p.range.flips ? p.range.flips + ' flip' + (p.range.flips === 1 ? '' : 's') : 'no flips'}</span>` : '',
      p.inRange && p.dailyUsd != null && (p.dailyUsd > 0 || (p.feesUsd||0) > 0.005) ? `<span class="rate">earning <b>${usd(p.dailyUsd)}/day</b>${p.aprPct != null && p.rateWindowH >= 6 && (p.valueUsd||0) >= 50 ? ' · ~' + p.aprPct.toFixed(1) + '% APR' : ''}${p.rateWindowH != null && p.rateWindowH < 24 ? ` <span title="extrapolated from a short window">(over ${p.rateWindowH.toFixed(1)}h)</span>` : ''}</span>` : '',
      p.pnlUsd != null ? `<span class="rate pnl" tabindex="0">PnL vs HODL <b class="${p.pnlUsd < 0 ? 'neg' : ''}">${p.pnlUsd >= 0 ? '+' : '−'}${usd(Math.abs(p.pnlUsd))}${p.pnlPct != null ? ' (' + (p.pnlPct >= 0 ? '+' : '−') + Math.abs(p.pnlPct).toFixed(1) + '%)' : ''}</b>${p.pnlApprox ? ' ≈' : ''}${p.pnlSince ? ' · since ' + new Date(p.pnlSince).toLocaleDateString(undefined,{month:'short',day:'numeric'}) : ''}${pnlTip(p)}</span>` : '',
    ].filter(Boolean).join('');
    return positionCard(p, d, { wallet: d.ownerLabel || 'Main', walletAddr: d.owner, eta: etaBadge(p, d), perf });
  }).join('');
}

// Claimed fees opens this position's collection history. A real <button> means
// Enter and Space already work and it is in the tab order; this only has to move
// aria-expanded and fill the panel. Rows come from /api/history, which the page
// has already loaded — no new request, no new endpoint.
document.addEventListener('click', async e => {
  const b = e.target.closest('button.claimed[data-claim]');
  if (!b) return;
  const panel = document.getElementById(b.dataset.claim);
  if (!panel) return;
  const open = b.getAttribute('aria-expanded') === 'true';
  b.setAttribute('aria-expanded', open ? 'false' : 'true');
  panel.hidden = open;
  if (open) return;
  await refreshClaimPanel(panel, b);
});

// Loaded on demand from /api/claims, not from the analytics bundle, and fetched
// again on every open because the background scan keeps extending it. The last
// good answer is kept per panel: a failed or ok:false refresh shows it with its
// age and the failure, and never replaces it with an error or an empty table.
const claimPanels = new Map();   // panel id -> { d, at }
async function refreshClaimPanel(panel, b) {
  const last = claimPanels.get(panel.id);
  panel.innerHTML = last
    ? claimPanelHtml(last.d) + '<p class="chnote" role="status">Refreshing\u2026</p>'
    : '<p class="chnote" role="status">Loading this position\u2019s collections\u2026</p>';
  const q = new URLSearchParams({ tokenId: b.dataset.tokenid || '', chainId: b.dataset.chainid || '', manager: b.dataset.manager || '' });
  // The wallet whose ownership the history covers (a transferred position has had several).
  if (b.dataset.wallet) q.set('wallet', b.dataset.wallet);
  let msg = null, d = null;
  try {
    const r = await fetch('/api/claims?' + q);
    d = await r.json();
    const o = apiOutcome(r.status, d);
    if (o.kind !== 'ok') msg = o.kind === 'pending' ? 'the server is still starting' : o.msg;
  } catch (err) { msg = err.message || String(err); }
  if (msg == null) {
    claimPanels.set(panel.id, { d, at: Date.now() });
    panel.innerHTML = claimPanelHtml(d);
    return;
  }
  // An error is not an empty history. Say which, keep what was known, stay retryable.
  panel.innerHTML = last
    ? `<p class="chnote err" role="alert">${staleNote(last.at, msg)} Close and reopen to retry.</p>` + claimPanelHtml(last.d)
    : `<p class="chnote err" role="alert">Collection history could not be loaded: ${esc(msg)}. ` +
      `This is a failed read, not a statement that nothing was collected. Close and reopen to retry.</p>`;
}

// ---- claimed fees: one state, every view ------------------------------------
// The server names where a position's claim history stands (`claimed.state`).
// An older server does not, so the state is derived from status + coverage the
// same way the server defines it. The tile, the line, the footer and the panel
// all read it from here, so the four can never disagree.
const CLAIM_STATES = ['complete', 'scanning', 'lookback-reached', 'undecodable', 'not-scanned', 'unsupported'];
function claimState(c) {
  if (!c) return 'not-scanned';
  if (CLAIM_STATES.includes(c.state)) return c.state;
  const cov = c.coverage;
  if (c.status === 'unavailable') return cov ? 'undecodable' : 'not-scanned';
  if (c.status === 'ok' && cov && cov.coversOpening === true) return 'complete';
  if (cov && cov.reachedLookbackFloor && cov.coversOpening !== true) return 'lookback-reached';
  return 'scanning';
}
// A zero is a finding only when the server says so. An older server gives no
// flag: then only a complete history with an explicit count of 0 and $0 counts
// (or, in the panel, a complete scan that listed no rows). Missing records are
// never read as zero.
function claimVerifiedZero(c, rows) {
  if (!c) return false;
  if (typeof c.verifiedZero === 'boolean') return c.verifiedZero;
  if (claimState(c) !== 'complete') return false;
  if (c.count === 0 && c.usd === 0) return true;
  return Array.isArray(rows) && rows.length === 0 && c.count == null && c.usd == null;
}
const cDate = t => t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null;
const cTime = t => t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
// How a claimed-fee dollar figure was valued. `short` fits a tile, `text` a tooltip.
// Historical prices are named for what they are; any share at today's price is
// called out and marks the figure approximate.
function claimValuation(c) {
  const ps = c && c.priceSources;
  if (ps && typeof ps === 'object') {
    const b = ps.block || 0, h = ps.pricelog || 0, t = ps.today || 0;
    const hist = b && h ? `valued at each claim’s transaction price (${b}) or the hourly price log (${h})`
      : b ? 'valued at each claim’s transaction price'
      : h ? 'valued at the hourly price log for each claim' : '';
    const histShort = b && h ? 'valued at claim-time prices (transaction or hourly log)'
      : b ? 'valued at each claim’s transaction price'
      : h ? 'valued at the hourly price log' : '';
    const none = ps.none || 0;
    if (!t && none && (b || h)) return { text: `${hist}; ${none} without a price from their moment ${none === 1 ? 'is' : 'are'} left out of any USD figure`, short: histShort, approx: false };
    if (!t) return { text: hist, short: histShort, approx: false };
    if (!b && !h) return { text: 'valued at today’s prices, not the prices when claimed', short: 'at today’s prices', approx: true };
    return { text: `${hist}; ${t} of ${b + h + t} at today’s prices because no price from their moment was found`,
      short: 'partly at today’s prices', approx: true };
  }
  if (c && c.usdBasis === 'at-claim') return { text: 'valued at each claim’s transaction price or the hourly price log', short: 'valued at claim-time prices', approx: false };
  if (c && c.usdBasis === 'mixed') return { text: 'partly valued at today’s prices because no price from some claims’ moment was found', short: 'partly at today’s prices', approx: true };
  if (c && c.usdBasis === 'today') return { text: 'valued at today’s prices, not the prices when claimed', short: 'at today’s prices', approx: true };
  return { text: '', short: '', approx: false };
}
// "$X", "≈$X", "at least $X" or "at least ≈$X"; null when there is no USD total.
function claimMoney(c, floor) {
  if (!c || c.usd == null) return null;
  return (floor ? 'at least ' : '') + (claimValuation(c).approx ? '≈' : '') + usd(c.usd);
}
// No total unless every record has a historical price. With some priced, the
// priced part is a named subtotal and the rest is counted as left out.
function claimSubtotal(c) {
  if (!c || c.usd != null) return null;
  const n = Number(c.pricedRecords) || 0;
  if (!(n > 0) || typeof c.usdPricedSubtotal !== 'number' || !Number.isFinite(c.usdPricedSubtotal)) return null;
  const x = Number(c.unpricedRecords) || 0;
  return { text: 'Priced subtotal ' + usd(c.usdPricedSubtotal), priced: n, excluded: x,
    note: `Priced subtotal of the ${n} record${n === 1 ? '' : 's'} with a verified historical price; ${x} without one ${x === 1 ? 'is' : 'are'} excluded, so it is not the full total` };
}
// Today's value of the same verified amounts: a separate figure, always labelled,
// never added to the historical one.
function claimCurrent(c) {
  const cur = c && c.usdCurrent;
  if (!cur || typeof cur.usd !== 'number' || !Number.isFinite(cur.usd)) return null;
  return { text: `${usd(cur.usd)} at today’s prices`,
    note: `Separately, the same token amounts are worth ${usd(cur.usd)} at today’s prices${cur.note ? ' (' + String(cur.note).replace(/[.]$/, '') + ')' : ''}; that is not what they were worth when claimed and is not added to it` };
}
const CLAIM_MIXED_NOTE = 'Claimed fees are valued at historical prices; uncollected fees are valued at current prices, so the two are not one uniform earnings total.';
// The sentence that explains a non-complete state: the server's reason when it
// gives one, otherwise a plain statement of the state (never a guessed cause).
function claimWhy(c, st) {
  if (c && c.reason) return String(c.reason);
  return {
    scanning: 'The history scan has not reached this position’s opening yet.',
    'lookback-reached': 'The scan reached the configured lookback limit before this position’s opening, so lifetime history is incomplete.',
    undecodable: 'A payout in the scanned history could not be decoded or attributed to this position.',
    'not-scanned': 'No block range has been scanned for this position yet.',
    unsupported: 'Claim history is not supported for this position.',
  }[st] || '';
}
const endStop = s => !s ? '' : /[.!?]$/.test(s) ? s : s + '.';

// The panel body, one branch per state. Every one says what it knows and what it does not.
function claimPanelHtml(d) {
  // /api/claims carries the figures in `summary`; its own top-level fields win.
  const sm = Object.assign({}, (d && d.summary && typeof d.summary === 'object') ? d.summary : {}, d);
  const cov = d.coverage;
  const st = claimState(d);
  const rows = d.rows || [];
  const window_ = cov && cov.fromT && cov.toT
    ? `blocks ${cov.fromBlock}–${cov.toBlock} (${new Date(cov.fromT).toLocaleString()} – ${new Date(cov.toT).toLocaleString()})`
    : cov && cov.fromBlock ? `blocks ${cov.fromBlock}–${cov.toBlock}` : 'an unrecorded range';
  const why = esc(endStop(claimWhy(d, st)));
  const val = claimValuation(d);
  let note;
  if (st === 'complete') {
    const money = claimMoney(sm, false);
    const part = money ? null : claimSubtotal(sm);
    const cur = rows.length ? claimCurrent(sm) : null;
    note = `<p class="chnote">Complete history: scanned ${esc(window_)}, from the block this position was opened in.` +
      (money && rows.length ? ` Total <b>${esc(money)}</b>${val.text ? ', ' + esc(val.text) : ''}.` : '') +
      (part && rows.length ? ` <b>${esc(part.text)}</b>: ${esc(endStop(part.note))}` : '') +
      (cur ? ` ${esc(endStop(cur.note))}` : '') + '</p>';
  } else if (st === 'scanning') {
    note = `<p class="chnote warn">Scan in progress: only ${esc(window_)} has been scanned so far. ${why} Collections before that are not listed yet, so anything below is a floor, not a total.` +
      `${cov && !cov.reachedLookbackFloor ? ' Opening this panel extends the scan a little further back each time.' : ''}</p>`;
  } else if (st === 'lookback-reached') {
    note = `<p class="chnote warn">Lifetime history incomplete: the scan reached its lookback limit` +
      `${cov && cov.fromT ? ` and covers only claims since ${esc(cDate(cov.fromT))}` : ''} (${esc(window_)}). ${why} Anything below is a floor, not a lifetime total.</p>`;
  } else if (st === 'undecodable') {
    note = `<p class="chnote warn">No figure: ${why} Scanned ${esc(window_)}. No total is given, and this is not a zero.</p>`;
  } else if (st === 'unsupported') {
    return `<p class="chnote warn">Claim history not supported: ${why} Nothing is known either way.</p>`;
  } else {
    return `<p class="chnote warn">Claim history not scanned yet: ${why} Nothing is known either way — this is not a zero.</p>`;
  }
  if (!rows.length) {
    if (st === 'undecodable') return note;
    return note + `<p class="chnote">${claimVerifiedZero(d, rows)
      ? 'No collections in the complete history: this position has never had fees collected (verified).'
      : st === 'complete'
        ? 'No collections are listed, but the server did not confirm a zero total, so none is shown.'
        : 'No collections in the scanned range. That is not the same as none having happened — earlier blocks are not covered.'}</p>`;
  }
  return note + '<table class="chtable"><caption>Fees only — withdrawn principal and added deposits are excluded from every row. USD is per row, at the price named beside it.</caption>' +
    '<thead><tr><th scope="col">When</th><th scope="col">Kind</th><th scope="col">Fees claimed</th><th scope="col">USD value</th><th scope="col">Tx</th></tr></thead><tbody>' +
    rows.map(r => `<tr><td>${r.t ? new Date(r.t).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'unknown'}</td>` +
      `<td>${claimKindLabel(r.kind)}</td>` +
      `<td class="mono">${r.unavailable ? `<span class="unavail" title="${esc(r.unavailable)}">not separable</span>`
        : (r.fee0 == null || r.fee1 == null)
          ? '<span class="unavail" title="A token’s decimals could not be read, so this amount cannot be shown">amount unavailable</span>'
          : `<span class="amt">${esc(r.fee0)}</span><span class="amt">${esc(r.fee1)}</span>`}</td>` +
      `<td>${claimRowValue(r)}</td>` +
      `<td class="mono">${r.tx ? txRef(r.tx) : '—'}</td></tr>`).join('') +
    '</tbody></table>';
}
// What a row was. v4 pays out accrued fees on every liquidity change, so an add
// realises fees too (netted against the deposit) and is listed with its fee part.
function claimKindLabel(kind) {
  if (kind === 'withdrawal') return '<span title="This transaction also withdrew principal; only the fee part above the principal is counted">withdrawal (principal excluded)</span>';
  if (kind === 'increase') return '<span title="Liquidity was added. v4 pays out the fees accrued so far at the same time, netted against the deposit; only that fee part is counted">add (fees netted)</span>';
  return 'collect';
}
// Which price a collection's USD value uses, and from when. Only the transaction
// price and the hourly log describe what was actually received; today's price is
// an approximation and says so.
function claimPriceLabel(r) {
  if (r.unavailable) return '—';
  const at = r.priceT ? cTime(r.priceT) : null;
  if (r.priceSrc === 'block') return `<span class="psrc" title="Valued at the pool price at this claim’s own transaction (after any earlier swap in its block)${at ? ', block time ' + esc(at) : ''}. The token priced against the unit of account comes from this position’s own pool.">transaction price${at ? ' · ' + esc(at) : ''}</span>`;
  if (!r.priceSrc && !(typeof r.usd === 'number' && Number.isFinite(r.usd))) return '<span class="psrc approx" title="No verified price from this collection’s moment was found, so it has no USD value and is left out of any USD total">no historical price</span>';
  if (r.priceSrc) return `<span class="psrc" title="Valued at the hourly price log${at ? ' entry of ' + esc(at) : ''}, within three hours of this collection">hourly price log${at ? ' · ' + esc(at) : ''}</span>`;
  return `<span class="psrc approx" title="No price from this collection’s moment was found, so it is valued at today’s price — an approximation, not what was received">today’s price${at ? ' · ' + esc(at) : ''}</span>`;
}
// A transaction hash: an explorer link when the chain has one, otherwise
// selectable text with a copy button. Anything that is not a hash is plain text.
function txRef(tx) {
  const h = String(tx || '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) return esc(h || '—');
  return chainRef(EXPLORER, `/tx/${h}`, h.slice(0, 10) + '…', h);
}
// A row's USD figure with its source. No figure is "no USD value", never $0.
function claimRowValue(r) {
  if (r.unavailable) return '—';
  const v = typeof r.usd === 'number' && Number.isFinite(r.usd)
    ? `<b class="mono">${r.priceSrc ? '' : '≈'}${usd(r.usd)}</b>`
    : '<span class="unavail" title="This row has no USD value in this answer">no USD value</span>';
  return `<span class="rowusd">${v}<span class="rowsrc">${claimPriceLabel(r)}</span></span>`;
}
// ---- positions: Open · Closed · All ------------------------------------------
// A per-browser list filter. Open is the view the page always had. Closed lists
// every position that is no longer open for its wallet — closed, burned,
// transferred or unreadable — each under its own name: a transferred position is
// not called closed, because it may still hold liquidity for its new owner. All
// shows both. The counts and the closed cards come from /api/positions/history,
// for the same wallet scope as the rest of the page.
const POS_FILTERS = [['open', 'Open'], ['closed', 'Closed'], ['all', 'All']];
const HIST_GROUPS = [['closed', 'Closed'], ['burned', 'Burned'], ['transferred', 'Transferred'], ['unavailable', 'Unavailable']];
const HIST_GROUP_NOTE = {
  closed: 'Still owned by the wallet, with no liquidity left.',
  burned: 'The position NFT was burned.',
  transferred: 'The wallet no longer owns these. They may still hold liquidity for their new owner, so they are not called closed. Claimed fees cover only what was settled while this wallet owned them.',
  unavailable: 'These could not be read. Each card gives the reason; nothing about them is guessed.',
};
function posFilter() {
  const v = pref('positions:filter');
  return POS_FILTERS.some(f => f[0] === v) ? v : 'open';
}
// The wallet parameter for a scope: every wallet on this instance, the main
// wallet's address, or one watched address. null until it can be known.
function histWallet(scope, owner) {
  if (scope === 'all') return 'all';
  if (scope === 'owner') return owner && /^0x[0-9a-fA-F]{40}$/.test(owner) ? owner.toLowerCase() : null;
  return typeof scope === 'string' && /^0x[0-9a-fA-F]{40}$/.test(scope) ? scope.toLowerCase() : null;
}
// Which status group a history entry belongs to. An unknown status is not guessed at.
function histGroupOf(p) {
  const s = p && p.status;
  if (s === 'open') return 'open';
  return HIST_GROUPS.some(g => g[0] === s) ? s : 'unavailable';
}
function histLabel(g) {
  const hit = HIST_GROUPS.find(x => x[0] === g);
  return hit ? hit[1] : 'Open';
}
// The filter's counts: "Closed" is everything that is not open.
function posFilterCounts(c) {
  if (!c || typeof c !== 'object') return null;
  const n = k => (Number.isFinite(c[k]) ? c[k] : 0);
  const other = n('closed') + n('burned') + n('transferred') + n('unavailable');
  return { open: n('open'), closed: other, all: Number.isFinite(c.all) ? c.all : n('open') + other };
}
// A radio group: one tab stop, arrow keys move the choice, aria-checked marks it.
function posFilterHtml(sel, counts) {
  return POS_FILTERS.map(([v, label]) => {
    const on = v === sel;
    const n = counts ? counts[v] : null;
    const name = `${label}${n == null ? ' (count not available yet)' : `, ${n} position${n === 1 ? '' : 's'}`}`;
    return `<button type="button" role="radio" class="pfopt" data-pfilter="${v}" aria-checked="${on}" tabindex="${on ? 0 : -1}" aria-label="${esc(name)}">` +
      `${label}${n == null ? '' : `<span class="pfn" aria-hidden="true">${n}</span>`}</button>`;
  }).join('');
}
const histSafe = s => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '');
const histAddr = a => (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? a : '');
// An address as a short link (or copyable text where the chain has no explorer).
function addrRef(a, path) {
  const x = histAddr(a);
  if (!x) return esc(a || '—');
  return chainRef(EXPLORER, `${path || '/address/'}${x}`, shortA(x), x);
}
function chainNameOf(id) {
  if (id == null || id === '') return 'unknown chain';
  const n = Number(id);
  const name = (CHAIN.id === n && CHAIN.name) || KNOWN_CHAINS[n];
  return name ? `${name} (${n})` : `chain ${n}`;
}
function feeTierText(fee) {
  return Number.isFinite(fee) ? `${+(fee / 10000).toFixed(4)}%` : 'fee tier unknown';
}
// When the entry left the open set, for sorting: newest first.
function histWhen(p) {
  const e = p.status === 'transferred' ? p.transferredAt : p.status === 'burned' ? (p.burnedAt || p.closedAt) : p.closedAt;
  return (e && e.t) || 0;
}
// "Closed Sep 12, 2026 · 0xabc…" — only for the events the server recorded.
// A closing the server could not verify says so.
function histDateLine(p) {
  const at = e => (e && e.t ? cDate(e.t) : e && e.block != null ? `at block ${e.block}` : null);
  const tx = e => (e && e.tx ? ' · ' + txRef(e.tx) : '');
  const out = [];
  if (p.closedAt && at(p.closedAt)) {
    const what = p.status === 'closed' ? 'Closed' : 'Liquidity reached zero';
    out.push(`<span class="hdate">${what} ${esc(at(p.closedAt))}` +
      (p.closedAt.verified === false ? ' <span class="hunver">— not verified: history before it is not fully scanned</span>' : '') + tx(p.closedAt) + '</span>');
  }
  if (p.burnedAt && at(p.burnedAt)) out.push(`<span class="hdate">Burned ${esc(at(p.burnedAt))}${tx(p.burnedAt)}</span>`);
  if (p.transferredAt && at(p.transferredAt)) {
    out.push(`<span class="hdate">Transferred ${esc(at(p.transferredAt))}` +
      (p.transferredAt.to ? ` to ${addrRef(p.transferredAt.to)}` : '') + tx(p.transferredAt) + '</span>');
  }
  return out.join('');
}
// Fees left in the position: v4 settles them all when liquidity reaches zero.
function unsettledText(u) {
  if (!u || !u.state) return { label: 'Not reported', cls: 'unavail', text: 'The server did not say whether any fees are left unsettled.' };
  if (u.state === 'none') return { label: 'None', cls: 'zero', text: endStop(u.reason || 'v4 settles all fees when liquidity reaches zero') };
  return { label: 'Unknown', cls: 'unavail', text: endStop(u.reason || 'Whether any fees are left unsettled cannot be established') };
}
// A position that is no longer open for this wallet: the shared card look,
// without a range rail or live value. Nothing here is a return figure, and
// withdrawn principal never appears as earnings.
function closedCard(p, d) {
  const g = histGroupOf(p);
  const label = histLabel(g);
  const chainId = p.chainId != null ? p.chainId : d && d.chainId;
  const pm = p.positionManager || (d && d.positionManager) || '';
  const tokenId = String(p.tokenId ?? '');
  const wallet = histAddr(p.wallet).toLowerCase();
  const uid = `hc-${histSafe(chainId)}-${histSafe(tokenId)}-${histSafe(wallet.replace(/^0x/, ''))}`;
  const claimed = p.claimed ? { ...p.claimed, scope: { chainId, positionManager: pm, tokenId, ...(p.claimed.scope || {}) } } : null;
  const us = unsettledText(p.unsettledFees);
  const dates = histDateLine(p);
  const opened = p.openedAt && (p.openedAt.t || p.openedAt.block != null)
    ? `${esc(p.openedAt.t ? cDate(p.openedAt.t) : 'block ' + p.openedAt.block)}${p.openedAt.tx ? ' · ' + txRef(p.openedAt.tx) : ''}` : 'not recorded';
  const pair = p.pair || [p.token0 && p.token0.symbol, p.token1 && p.token1.symbol].filter(Boolean).join(' / ') || 'Unknown pair';
  const nft = histAddr(pm) && /^[0-9]+$/.test(tokenId)
    ? chainRef(EXPLORER, `/token/${histAddr(pm)}/instance/${tokenId}`, '#' + tokenId, `#${tokenId} on ${histAddr(pm)}`) : '#' + esc(tokenId);
  const scopeNote = g === 'transferred' || g === 'burned'
    ? 'Claimed fees here cover only what was settled while this wallet owned the position.' : '';
  return `
  <article class="pos card2 hist hist-${g}" data-key="${esc(p.key || '')}">
    <header class="pchead">
      <div class="pcid">
        <h4 class="hname">${esc(pair)}</h4>
        ${p.walletLabel || wallet ? `<span class="pcwallet" title="${esc(wallet)}">${esc(p.walletLabel || shortA(wallet))}</span>` : ''}
        <span class="nft mono">${nft}</span>
        <span class="tier">${esc(p.protocol || 'v4')}</span>
        <span class="tier">${esc(feeTierText(p.fee))}</span>
      </div>
      <span class="state hstate hs-${g}">${label}</span>
    </header>
    <div class="metrics">
      <div class="metric"><span class="ml">Status</span><span class="mv hv hs-${g}">${label}</span>
        <span class="msub">${dates || esc(endStop(p.statusReason || ''))}</span></div>
      ${claimedMetric({ nftId: tokenId, tokenId, chainId, positionManager: pm, claimed }, uid, wallet)}
      <div class="metric"><span class="ml">Unsettled fees</span><span class="mv ${us.cls}">${us.label}</span>
        <span class="msub">${esc(us.text)}</span></div>
      <div class="metric"><span class="ml">Held since</span><span class="mv hv">${p.openedAt && p.openedAt.t ? esc(cDate(p.openedAt.t)) : 'Not recorded'}</span>
        <span class="msub">minted, or received by this wallet</span></div>
    </div>
    <div class="claimhist" id="${uid}" hidden></div>
    <dl class="hfacts">
      <div><dt>Chain</dt><dd>${esc(chainNameOf(chainId))}</dd></div>
      <div><dt>Wallet</dt><dd>${p.walletLabel ? esc(p.walletLabel) + ' ' : ''}${addrRef(wallet)}</dd></div>
      <div><dt>Protocol</dt><dd>Uniswap ${esc(p.protocol || 'v4')}</dd></div>
      <div><dt>Position manager</dt><dd>${addrRef(pm)}</dd></div>
      <div><dt>Token ID</dt><dd class="mono">${esc(tokenId)}</dd></div>
      <div><dt>Opened</dt><dd>${opened}</dd></div>
      ${g === 'transferred' || p.currentOwner ? `<div><dt>Current owner</dt><dd>${p.currentOwner ? addrRef(p.currentOwner) : 'unknown'}</dd></div>` : ''}
      <div class="wide"><dt>Evidence</dt><dd>${esc(endStop(p.statusReason || 'The server gave no reason.'))}</dd></div>
    </dl>
    <footer class="dfoot">
      <span>${coverageText({ claimed })}${scopeNote ? ' ' + esc(scopeNote) : ''}</span>
      <span>Fees only: withdrawn principal is never counted as earnings, and no return is given for a position that is no longer open.</span>
    </footer>
  </article>`;
}
// Why the list may be short: wallets whose position discovery is not complete.
function histDiscoveryNote(d) {
  const inc = ((d && d.wallets) || []).filter(w => !w.discovery || w.discovery.complete !== true);
  if (!inc.length) return '';
  return 'Position discovery is not complete for ' + inc.map(w => {
    const r = w.discovery && w.discovery.error ? `: ${w.discovery.error}` : w.discovery ? '' : ': not started';
    return `${w.label || shortA(w.address)}${r}`;
  }).join('; ') + '. Positions it has not reached yet are not listed.';
}
function histListHtml(d, filter) {
  if (filter === 'open') return '';
  const list = (d && Array.isArray(d.positions) ? d.positions : []).filter(p => histGroupOf(p) !== 'open');
  const disc = histDiscoveryNote(d);
  const groups = HIST_GROUPS
    .map(([k, label]) => [k, label, list.filter(p => histGroupOf(p) === k).sort((a, b) => histWhen(b) - histWhen(a))])
    .filter(x => x[2].length);
  const scan = d && d.scanner && d.scanner.idle === false
    ? `<p class="enote" role="status">The history scan is still running${d.scanner.pending ? ` (${d.scanner.pending} pending)` : ''}; these cards may still change.</p>` : '';
  if (!groups.length) {
    return scan + `<p class="enote">${disc ? 'No closed, burned or transferred positions found so far. ' + esc(disc) + ' This is not a verified none.'
      : 'No closed, burned, transferred or unreadable positions for this wallet scope.'}</p>`;
  }
  return scan + (disc ? `<p class="chnote warn">${esc(disc)}</p>` : '') + groups.map(([k, label, ps]) =>
    `<section class="histgroup" aria-labelledby="hg-${k}">` +
    `<h3 class="histgh" id="hg-${k}">${label} <span class="pfn">${ps.length}</span></h3>` +
    `<p class="enote">${HIST_GROUP_NOTE[k]}</p>` +
    `<div class="wcards">${ps.map(p => closedCard(p, d)).join('')}</div></section>`).join('');
}
// A read of one of the new endpoints. A route this server does not have yet
// (404 without a JSON answer) is "not available", not a failure of the data.
async function apiGet(url) {
  let r, d = null;
  try { r = await fetch(url, { cache: 'no-store' }); }
  catch (e) { return { kind: 'error', msg: (e && e.message) || String(e) }; }
  try { d = await r.json(); } catch (e) { d = null; }
  if (r.status === 404 && !(d && typeof d === 'object')) return { kind: 'missing', msg: 'this server does not offer it yet (HTTP 404)' };
  return { ...apiOutcome(r.status, d), d };
}
// The history list's state line: loading, not offered, still building, or a
// failed refresh (the last good list stays below it).
function histStatusNote(e, entry) {
  if (!e) return '';
  if (e.kind === 'pending') return entry ? '' : 'The server is still building the position history…';
  if (e.kind === 'missing' && !entry) return 'Closed-position history is not available from this server yet (HTTP 404). Only open positions can be listed; this is not an empty result.';
  return staleNote(entry && entry.at, e.msg);
}
const HIST = { key: null, seq: 0, byKey: new Map(), err: null, html: null };
function renderPosHistory() {
  const filter = posFilter();
  const entry = HIST.byKey.get(HIST.key) || null;
  const d = entry && entry.d;
  const box = $('#posfilter');
  if (box) {
    const had = !!(document.activeElement && box.contains(document.activeElement));
    box.innerHTML = posFilterHtml(filter, d ? posFilterCounts(d.counts) : null);
    const on = had && box.querySelector('[aria-checked="true"]');
    if (on) on.focus();
  }
  if (document.body) for (const [v] of POS_FILTERS) document.body.classList.toggle('pf-' + v, v === filter);
  const sec = $('#histsec'), note = $('#histstale'), list = $('#histlist');
  if (!sec) return;
  sec.hidden = filter === 'open';
  const msg = histStatusNote(HIST.err, entry);
  note.hidden = !msg;
  note.className = HIST.err && HIST.err.kind === 'pending' ? 'chnote' : 'loadfail';
  note.innerHTML = msg;
  if (filter === 'open') return;
  const html = d ? histListHtml(d, filter) : HIST.err ? '' : '<p class="enote" role="status">Loading positions that are no longer open…</p>';
  if (html === HIST.html) return;            // unchanged: keep any open history panel as it is
  HIST.html = html;
  list.innerHTML = html;
}
async function loadPosHistory() {
  const w = histScope();
  if (!w) return;
  const seq = ++HIST.seq;
  if (w !== HIST.key) { HIST.key = w; HIST.err = null; renderPosHistory(); }
  const res = await apiGet('/api/positions/history?' + new URLSearchParams({ wallet: w }));
  if (seq !== HIST.seq) return;              // a newer request (another scope) is under way
  if (res.kind === 'ok') {
    HIST.byKey.set(w, { d: res.d, at: Date.now() });
    HIST.err = null;
    loadOk('Position history');
  } else {
    HIST.err = res;
    if (res.kind === 'error') loadFailed('Position history', new Error(res.msg));
  }
  renderPosHistory();
}
// Arrow keys move the choice (wrapping), Home and End jump to the ends.
function posFilterStep(cur, key) {
  const i = POS_FILTERS.findIndex(f => f[0] === cur), n = POS_FILTERS.length;
  if (i < 0) return null;
  const j = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1 + n, ArrowUp: i - 1 + n, Home: n, End: 2 * n - 1 }[key];
  return j == null ? null : POS_FILTERS[j % n][0];
}
function setPosFilter(v, focus) {
  if (!POS_FILTERS.some(f => f[0] === v)) return;
  setPref('positions:filter', v);
  renderPosHistory();
  if (focus) { const b = document.querySelector(`#posfilter [data-pfilter="${v}"]`); if (b) b.focus(); }
}

// ---- Total claimed fees: a read-only history summary ------------------------
// The button shows the headline for every position of the selected wallet
// scope, whatever the list filter; its panel has its own filters. Nothing here
// sends a transaction.
const CT_STATUS = [['all', 'Open + closed'], ['open', 'Open'], ['closed', 'Closed'], ['other', 'Burned, transferred or unavailable']];
function ctDay(s, end) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = end ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999) : new Date(+m[1], +m[2] - 1, +m[3]);
  // a date that rolled over (month 13, day 31 of a 30-day month) is not a date
  if (!Number.isFinite(d.getTime()) || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return d.getTime();
}
// The query for /api/claims/total. Dates are whole local days, inclusive.
function ctotalQuery(f) {
  const q = new URLSearchParams({ wallet: (f && f.wallet) || 'all', status: CT_STATUS.some(s => s[0] === (f && f.status)) ? f.status : 'all' });
  const from = ctDay(f && f.from, false), to = ctDay(f && f.to, true);
  if (from != null) q.set('from', String(from));
  if (to != null) q.set('to', String(to));
  return q.toString();
}
const ctNum = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// A token amount as the API gives it: a formatted string, or a number this
// formats without dropping the small digits fees arrive in.
const ctAmount = v => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 6 }) : v == null ? '?' : String(v));
// Token amounts, grouped by address. Two tokens with one symbol keep their addresses apart.
function ctTokensText(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  const seen = {};
  for (const t of list) seen[t.symbol] = (seen[t.symbol] || 0) + 1;
  return list.map(t => `${ctAmount(t.amount)} ${t.symbol || '?'}${seen[t.symbol] > 1 ? ` (${shortA(t.address)})` : ''}`).join(' + ');
}
// The headline figure: a historical total, a priced subtotal, a floor, a verified
// zero, or a plain statement that there is nothing verified — never a guessed zero.
function ctotalHeadline(d) {
  if (!d) return { fig: 'Loading…', sub: 'Reading the claim history', cls: 'muted' };
  const u = d.usd || {};
  const hist = ctNum(u.historical);
  const priced = Number(u.pricedRecords) || 0, unpriced = Number(u.unpricedRecords) || 0;
  const part = priced > 0 && ctNum(u.pricedSubtotal) != null ? `Priced subtotal ${usd(u.pricedSubtotal)}` : null;
  const lbl = d.stateLabel ? String(d.stateLabel) : '';
  if (d.state === 'unavailable') return { fig: 'Unavailable', sub: lbl || 'The claim history could not be read', cls: 'unavail' };
  if (d.verifiedZero === true) return { fig: usd(0), sub: 'Verified zero — complete history, nothing settled', cls: 'zero' };
  if (d.state === 'empty') return { fig: 'No verified settlements', sub: 'Nothing verified in this scope — not a zero', cls: 'unavail' };
  if (d.state === 'partial') {
    return { fig: hist > 0 ? `at least ${usd(hist)}` : hist == null && part ? part : 'Verified claimed so far',
      sub: 'Verified claimed so far — partial history' + (hist == null && part ? ` · ${unpriced} without a historical price excluded` : ''), cls: 'partial' };
  }
  if (d.state === 'complete') {
    if (hist === 0) return { fig: ctTokensText(d.tokens) || 'No verified value', sub: 'Complete history · the server did not confirm a zero', cls: 'unavail' };
    if (hist != null) return { fig: usd(hist), sub: lbl || 'Verified claimed — complete history', cls: '' };
    if (part) return { fig: part, sub: `Complete history · ${unpriced} record${unpriced === 1 ? '' : 's'} without a historical price excluded`, cls: 'partial' };
    return { fig: ctTokensText(d.tokens) || 'No USD total', sub: 'Complete history · no historical price for these settlements', cls: 'unavail' };
  }
  return { fig: 'Unavailable', sub: lbl || 'The server gave an unrecognised state', cls: 'unavail' };
}
function ctotalFailHead(e) {
  if (!e || e.kind === 'pending') return ctotalHeadline(null);
  if (e.kind === 'missing') return { fig: 'Not available yet', sub: 'This server does not offer the total yet', cls: 'unavail' };
  return { fig: 'Could not load', sub: e.msg || 'the request failed', cls: 'unavail' };
}
function ctotalButtonHtml(label, h, staleMsg) {
  return `<span class="ctl">${esc(label)}</span>` +
    `<span class="ctv ${h.cls || ''}">${esc(h.fig)}</span>` +
    `<span class="cts">${esc(h.sub)}${staleMsg ? ' · <span class="ctstale">stale: latest refresh failed</span>' : ''}</span>` +
    `<span class="cthint">Read-only history — no transaction</span>`;
}
// One subtotal figure: the historical value, or the priced part, or none. With no
// records behind it there is no figure at all — a $0.00 there would read as a
// verified zero, which it is not.
function ctUsdText(hist, part, records) {
  if (records != null && !(Number(records) > 0)) return 'no settlements';
  if (ctNum(hist) != null) return usd(hist);
  if (ctNum(part) != null && part > 0) return `Priced subtotal ${usd(part)}`;
  return 'no USD total';
}
function ctTokenList(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  if (!list.length) return '<span class="muted">none</span>';
  return list.map(t => `<span class="amt">${esc(ctAmount(t.amount))} ${esc(t.symbol || '?')} <span class="muted">${addrRef(t.address, '/token/')}</span></span>`).join('');
}
const CT_STATE_TEXT = { complete: 'complete history', partial: 'partial history', empty: 'no verified settlements', unavailable: 'unavailable' };
function ctotalPanelHtml(d, walletScoped) {
  const u = d.usd || {};
  const hist = ctNum(u.historical);
  const priced = Number(u.pricedRecords) || 0, unpriced = Number(u.unpricedRecords) || 0;
  const h = ctotalHeadline(d);
  const sc = d.scope || {};
  const wname = (a, label) => { const w = (sc.wallets || []).find(x => String(x.address).toLowerCase() === String(a).toLowerCase()); return label || (w && w.label) || shortA(a); };
  const out = [];
  out.push(`<p class="ctstate ${h.cls}"><b>${esc(d.stateLabel || CT_STATE_TEXT[d.state] || d.state || '')}</b>` +
    `${sc.from || sc.to ? ` · ${sc.from ? 'from ' + esc(cDate(sc.from)) : ''}${sc.to ? ' to ' + esc(cDate(sc.to)) : ''}` : ''}` +
    `${d.at ? ` · read ${esc(cTime(d.at))}` : ''}</p>`);
  // figures: historical (or the priced part) and, apart from it, today's value
  const figs = [];
  if (d.verifiedZero === true) {
    figs.push(`<div class="metric"><span class="ml">Historical value</span><span class="mv zero">${usd(0)}</span><span class="msub">verified zero: every relevant position has a complete history and nothing was settled</span></div>`);
  } else if (hist === 0) {
    figs.push(`<div class="metric"><span class="ml">Historical value</span><span class="mv unavail">No verified value</span><span class="msub">the server did not confirm a zero, so none is shown</span></div>`);
  } else if (hist != null) {
    figs.push(`<div class="metric"><span class="ml">Historical value</span><span class="mv${d.state === 'partial' ? ' partial' : ''}">${d.state === 'partial' ? 'at least ' : ''}${usd(hist)}</span>` +
      `<span class="msub">each settlement at its own verified price${d.state === 'partial' ? ' · partial history, a floor' : ''}</span></div>`);
  } else if (priced > 0 && ctNum(u.pricedSubtotal) != null) {
    figs.push(`<div class="metric"><span class="ml">Priced subtotal</span><span class="mv partial">${usd(u.pricedSubtotal)}</span>` +
      `<span class="msub">${priced} record${priced === 1 ? '' : 's'} with a verified historical price; ${unpriced} excluded — not the full total</span></div>`);
  } else {
    figs.push(`<div class="metric"><span class="ml">Historical value</span><span class="mv unavail">No USD total</span><span class="msub">${d.state === 'empty' ? 'nothing verified to value' : 'no settlement here has a verified historical price'}</span></div>`);
  }
  const cur = d.current && ctNum(d.current.usd) != null ? d.current : null;
  figs.push(`<div class="metric ctcur"><span class="ml">At today’s prices</span><span class="mv approx">${cur ? usd(cur.usd) : '—'}</span>` +
    `<span class="msub">${cur ? 'A separate figure: today’s value of the same verified tokens. Not a historical value and never added to it.' : 'No value at today’s prices in this answer.'}` +
    `${d.current && d.current.note ? ' ' + esc(endStop(d.current.note)) : ''}</span></div>`);
  out.push(`<div class="metrics ctfigs">${figs.join('')}</div>`);
  const excl = Array.isArray(u.excluded) ? u.excluded : [];
  if (excl.length) {
    out.push(`<details class="ctmore"><summary>${excl.length} record${excl.length === 1 ? '' : 's'} left out of the USD figure</summary><ul class="ctlist">` +
      excl.map(x => `<li>#${esc(x.tokenId)} — ${esc(endStop(x.reason || 'no verified historical price'))}</li>`).join('') + '</ul></details>');
  }
  // tokens, by address
  const toks = Array.isArray(d.tokens) ? d.tokens : [];
  out.push('<h4 class="cth">Tokens claimed</h4>' + (toks.length
    ? '<div class="ctscroll"><table class="chtable"><caption>Grouped by token contract, not by symbol. Fees only — withdrawn principal is excluded.</caption>' +
      '<thead><tr><th scope="col">Token</th><th scope="col">Contract</th><th scope="col">Amount</th></tr></thead><tbody>' +
      toks.map(t => `<tr><td>${esc(t.symbol || '?')}</td><td class="mono">${addrRef(t.address, '/token/')}</td><td class="mono">${esc(ctAmount(t.amount))}</td></tr>`).join('') +
      '</tbody></table></div>'
    : `<p class="chnote">${d.verifiedZero === true ? 'No tokens were claimed (verified).' : 'No verified token amounts in this scope. That is not a zero.'}</p>`));
  // subtotals
  const subs = d.subtotals || {};
  out.push('<h4 class="cth">By position status</h4><div class="ctsubs">' + [['open', 'Open'], ['closed', 'Closed'], ['other', 'Burned, transferred or unavailable']].map(([k, name]) => {
    const s = subs[k];
    if (!s) return `<div class="ctsub"><span class="ml">${name}</span><span class="msub">not in this answer</span></div>`;
    return `<div class="ctsub"><span class="ml">${name}</span><span class="ctsv">${esc(ctUsdText(s.usdHistorical, s.pricedSubtotal, s.records))}</span>` +
      `<span class="msub">${Number(s.positions) || 0} position${s.positions === 1 ? '' : 's'} · ${Number(s.records) || 0} record${s.records === 1 ? '' : 's'}</span>` +
      `<span class="ctamts">${ctTokenList(s.tokens)}</span></div>`;
  }).join('') + '</div>');
  // per position
  // A position the chain cannot reconstruct still shows "none", because none of its
  // payout can be verified from logs -- a native-asset leg moves no ERC-20 and leaves
  // nothing to read. But the collector was the thing collecting, and it wrote down
  // what it took: eight of those positions have real amounts in its own ledger. That
  // is a different provenance, so it sits beside the verified column rather than in
  // it, and says whose record it is.
  const ctCollectorNote = (p) => {
    const c = p.collector;
    if (!c || !c.records) return '';
    const amounts = (c.tokens || []).filter(t => Number(t.amount) > 0)
      .map(t => `${Number(t.amount).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${esc(t.symbol)}`).join(' + ');
    if (!amounts) return '';
    const verified = Number(p.records) > 0;
    return `<div class="ctcollector" title="From this collector's own run ledger, not reconstructed from the chain. It covers only what this collector took${c.unknownLegs ? `, and ${c.unknownLegs} leg${c.unknownLegs === 1 ? ' was' : 's were'} not measured at the time` : ''}; fees the wallet settled itself are not counted here.">`
      + `${verified ? 'collector also recorded' : 'collector recorded'} ${amounts} over ${c.records} run${c.records === 1 ? '' : 's'}`
      + `${c.unknownLegs ? ` <span class="muted">(${c.unknownLegs} unmeasured leg${c.unknownLegs === 1 ? '' : 's'})</span>` : ''}</div>`;
  };
  const ps = Array.isArray(d.positions) ? d.positions : [];
  out.push('<h4 class="cth">By position</h4>' + (ps.length
    ? '<div class="ctscroll"><table class="chtable ctpos"><thead><tr><th scope="col">Position</th>' + (walletScoped ? '' : '<th scope="col">Wallet</th>') +
      '<th scope="col">Status</th><th scope="col">Claimed</th><th scope="col">USD</th><th scope="col">Records</th><th scope="col">Last settlement</th><th scope="col">History</th></tr></thead><tbody>' +
      ps.map(p => `<tr><td>#${esc(p.tokenId)} <span class="muted">${esc(p.pair || '')}</span></td>` +
        (walletScoped ? '' : `<td>${esc(p.walletLabel || shortA(p.wallet))}</td>`) +
        `<td>${esc(p.status === 'open' ? 'Open' : histLabel(histGroupOf(p)))}</td>` +
        `<td class="mono">${ctTokenList(p.tokens)}${ctCollectorNote(p)}</td>` +
        `<td class="mono">${esc(ctUsdText(p.usdHistorical, p.pricedSubtotal, p.records))}</td>` +
        `<td>${Number(p.records) || 0}</td>` +
        `<td>${p.lastT ? esc(cTime(p.lastT)) : '—'}</td>` +
        `<td>${esc(CT_STATE_TEXT[p.state] || p.state || '')}${p.reason ? ` <span class="muted">— ${esc(endStop(p.reason))}</span>` : ''}</td></tr>`).join('') +
      '</tbody></table></div>'
    : '<p class="chnote">No positions in this selection.</p>'));
  // rows
  // A row's own key is its log, not its position: match on the position's identity.
  const byPos = new Map(ps.map(p => [`${p.tokenId}:${String(p.wallet).toLowerCase()}`, p]));
  const rows = Array.isArray(d.rows) ? d.rows : [];
  out.push('<h4 class="cth">Collections</h4>' + (rows.length
    ? '<div class="ctscroll" role="region" aria-label="Collection rows, scrolls sideways" tabindex="0"><table class="chtable ctrows"><caption>Fees only — withdrawn principal and added deposits are excluded from every row. USD is per row, at the price named beside it.</caption>' +
      '<thead><tr><th scope="col">When</th><th scope="col">Position</th><th scope="col">Action</th><th scope="col">Recipient</th><th scope="col">Fees claimed</th><th scope="col">USD value</th><th scope="col">Tx</th></tr></thead><tbody>' +
      rows.map(r => {
        const p = byPos.get(`${r.tokenId}:${String(r.wallet).toLowerCase()}`);
        const amts = Array.isArray(r.tokens) && r.tokens.length
          ? r.tokens.map(t => `<span class="amt">${esc(ctAmount(t.amount))} ${esc(t.symbol || '?')}</span>`).join('')
          : '<span class="unavail">amount unavailable</span>';
        return `<tr><td>${r.t ? esc(cTime(r.t)) : 'unknown'}</td>` +
          `<td>#${esc(r.tokenId)}${p && p.pair ? ` <span class="muted">${esc(p.pair)}</span>` : ''}${walletScoped ? '' : `<br><span class="muted">${esc(r.walletLabel || (p && p.walletLabel) || wname(r.wallet))}</span>`}</td>` +
          `<td>${claimKindLabel(r.kind)}</td>` +
          `<td class="mono ctaddr">${addrRef(r.recipient)}</td>` +
          `<td class="mono">${amts}</td>` +
          `<td>${claimRowValue(r)}</td>` +
          `<td class="mono ctaddr">${r.tx ? txRef(r.tx) : '—'}</td></tr>`;
      }).join('') + '</tbody></table></div>'
    : '<p class="chnote">No verified collections in this selection.</p>'));
  // coverage
  const cov = d.coverage || {};
  const li = (x) => `<li>#${esc(x.tokenId)}${x.state ? ` (${esc(CT_STATE_TEXT[x.state] || x.state)})` : ''} — ${esc(endStop(x.reason || 'no reason given'))}</li>`;
  const disc = Array.isArray(cov.discovery) ? cov.discovery : [];
  out.push('<section class="ctcov" aria-labelledby="ctcovtitle"><h4 class="cth" id="ctcovtitle">Coverage</h4>' +
    `<p class="chnote">${Number(cov.positionsComplete) || 0} of ${Number(cov.positionsTotal) || 0} position${cov.positionsTotal === 1 ? '' : 's'} have a complete claim history.</p>` +
    (cov.partial && cov.partial.length ? `<p class="chnote warn">Partial histories — their figures are floors:</p><ul class="ctlist">${cov.partial.map(li).join('')}</ul>` : '') +
    (cov.unsupported && cov.unsupported.length ? `<p class="chnote warn">Not covered (unsupported histories, such as native-asset legs, v3 or undecodable payouts):</p><ul class="ctlist">${cov.unsupported.map(li).join('')}</ul>` : '') +
    (disc.length ? '<p class="chnote">Position discovery per wallet:</p><ul class="ctlist">' + disc.map(w =>
      `<li>${esc(wname(w.wallet, w.label))} — ${w.complete ? 'complete' : 'not complete'}${w.scannedFrom != null ? `, scanned from block ${esc(w.scannedFrom)}` : ''}${w.error ? ` — ${esc(endStop(w.error))}` : ''}</li>`).join('') + '</ul>' : '') +
    (cov.note ? `<p class="chnote">${esc(endStop(cov.note))}</p>` : '') + '</section>');
  return out.join('');
}
// The panel body for its current request: loading, a failure (with the last good
// answer for the same selection kept below it), or the answer.
function ctotalBodyHtml(g, e, busy, walletScoped) {
  let top = '';
  if (busy) top = `<p class="chnote" role="status">${g ? 'Refreshing…' : 'Loading total claimed fees…'}</p>`;
  else if (e && e.kind === 'pending') top = '<p class="chnote" role="status">The server is still building the claim history…</p>';
  else if (e && e.kind === 'missing' && !g) top = '<p class="chnote err" role="alert">Total claimed fees are not available from this server yet (HTTP 404). This is a failed read, not a zero.</p>';
  else if (e) top = `<p class="chnote err" role="alert">${staleNote(g && g.at, e.msg)}</p>`;
  return top + (g ? ctotalPanelHtml(g.d, walletScoped) : '');
}
const CTOT = { open: false, f: { wallet: '', status: 'all', from: '', to: '' },
  want: { head: null, panel: null }, good: { head: null, panel: null }, err: { head: null, panel: null },
  busy: { head: false, panel: false }, seq: { head: 0, panel: 0 } };
function ctotalScopeName(w) {
  if (w === 'all') return 'All wallets';
  if (lastMain && lastMain.owner && w === lastMain.owner.toLowerCase()) return ownerLabel();
  const x = ((lastWatchForPf && lastWatchForPf.wallets) || []).find(v => v.address.toLowerCase() === w);
  return x ? (x.label || shortA(x.address)) : shortA(w);
}
function renderClaimTotalButton() {
  const b = $('#ctotbtn');
  if (!b) return;
  const want = CTOT.want.head;
  const g = CTOT.good.head && CTOT.good.head.key === want ? CTOT.good.head : null;
  const e = CTOT.err.head;
  const label = (g && g.d.label) || `Total claimed fees · ${want ? ctotalScopeName(new URLSearchParams(want).get('wallet')) : 'this wallet'} · Open + closed`;
  const h = g ? ctotalHeadline(g.d) : e ? ctotalFailHead(e) : ctotalHeadline(null);
  const stale = g && e && e.kind !== 'pending' ? e.msg : null;
  b.innerHTML = ctotalButtonHtml(label, h, stale);
  b.title = 'Read-only history — no transaction. Opens a breakdown of fees already claimed.' + (stale ? ` Showing the last successful refresh; the latest failed: ${stale}.` : '');
}
function renderClaimTotalPanel() {
  const body = $('#ctbody');
  if (!body) return;
  const want = CTOT.want.panel;
  const g = CTOT.good.panel && CTOT.good.panel.key === want ? CTOT.good.panel : null;
  const base = histScope();
  const walletScoped = base !== 'all' || !!CTOT.f.wallet;
  body.innerHTML = ctotalBodyHtml(g, CTOT.err.panel, CTOT.busy.panel, walletScoped);
  // the wallet filter only means something when the scope is every wallet
  const ww = $('#ctwalletwrap'), sel = $('#ctwallet');
  if (ww && sel) {
    ww.hidden = base !== 'all';
    const src = (g && g.d.scope && g.d.scope.wallets) || (CTOT.good.head && CTOT.good.head.d.scope && CTOT.good.head.d.scope.wallets) ||
      ((HIST.byKey.get('all') || {}).d || {}).wallets || [];
    const opts = [['', 'All wallets']].concat(src.map(w => [String(w.address).toLowerCase(), w.label ? `${w.label} (${shortA(w.address)})` : shortA(w.address)]));
    const html = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
    if (sel.dataset.opts !== html) { sel.innerHTML = html; sel.dataset.opts = html; }
    sel.value = CTOT.f.wallet;
  }
}
async function loadClaimTotal(which) {
  const base = histScope();
  if (!base) return;
  const f = which === 'head' ? { wallet: base, status: 'all' } : { ...CTOT.f, wallet: (base === 'all' && CTOT.f.wallet) || base };
  const key = ctotalQuery(f);
  const seq = ++CTOT.seq[which];
  if (CTOT.want[which] !== key) CTOT.err[which] = null;
  CTOT.want[which] = key;
  CTOT.busy[which] = true;
  // the panel can start from the headline's answer when the selection is the same
  if (which === 'panel' && !(CTOT.good.panel && CTOT.good.panel.key === key) && CTOT.good.head && CTOT.good.head.key === key) CTOT.good.panel = CTOT.good.head;
  if (which === 'panel') renderClaimTotalPanel(); else renderClaimTotalButton();
  const res = await apiGet('/api/claims/total?' + key);
  if (seq !== CTOT.seq[which]) return;
  CTOT.busy[which] = false;
  if (res.kind === 'ok') {
    CTOT.good[which] = { d: res.d, at: Date.now(), key };
    CTOT.err[which] = null;
    if (which === 'head') loadOk('Total claimed fees');
  } else {
    CTOT.err[which] = res;
    if (which === 'head' && res.kind === 'error') loadFailed('Total claimed fees', new Error(res.msg));
  }
  if (which === 'panel') renderClaimTotalPanel(); else renderClaimTotalButton();
}
function readCtFilters() {
  const v = id => { const el = $(id); return el ? el.value : ''; };
  CTOT.f = { wallet: histScope() === 'all' ? v('#ctwallet') : '', status: v('#ctstatus') || 'all', from: v('#ctfrom'), to: v('#ctto') };
}
// The wallet scope the page is on, as a history parameter; null until the page
// knows whether there are watched wallets (the picker is filled from them).
function histScope() {
  const sel = $('#pfscope');
  if (!sel) return null;
  if (sel.hidden && !lastWatchForPf && !loadFails.has('Watched wallets')) return null;
  return histWallet(sel.hidden ? 'owner' : pfScope(), lastMain && lastMain.owner);
}
// Called whenever the page redraws: a new wallet scope reloads the history and the total.
function histSync(force) {
  if (PAGE !== 'dashboard') return;
  const w = histScope();
  if (!w || (!force && w === HIST.key)) return;
  if (w !== HIST.key) CTOT.f.wallet = '';
  loadPosHistory();
  loadClaimTotal('head');
  if (CTOT.open) loadClaimTotal('panel');
}

// Flip a pair's price orientation from its unit label.
let lastRender = null;
document.addEventListener('click', e => {
  const u = e.target.closest('.ends .unit');
  if (!u || !lastRender) return;
  setPref(u.dataset.key, u.dataset.invert === '1' ? '0' : '1');
  render(lastRender);
  if (lastWatchForPf) renderWatch(lastWatchForPf);
});

async function load(fresh){
  const btn = $('#reload');
  btn.disabled = true;
  btn.textContent = 'Reading…';
  try{
    const r = await fetch('/api/positions' + (fresh ? '?fresh=1' : ''));
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'request failed');
    fetchedAt.set(d, Date.now());
    render(d);
  }catch(e){
    $('#list').innerHTML = `<div class="err">Could not reach the chain. ${e.message}
      <br>Check chain.rpcUrl in settings.json and that the server is still running.</div>`;
  }finally{
    btn.disabled = false;
    btn.textContent = 'Refresh';
  }
}

/* ---- collect ---- */
let coTimer = null;

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

// ---- Long-term returns (TASK-52): fee APR and net return side by side, from /api/positions
// longTerm (longterm.js). Last 30 days on the card, since-open in the tooltip; when the
// position is a re-mint of an earlier one in the same pool the chained figures are shown.
const ltPref = () => pref('positions:sort') || 'default';
function sortLT(arr){
  const k = ltPref();
  if (k !== 'fee' && k !== 'net') return arr;
  const val = p => { const lt = p.longTerm; if (!lt) return null; const src = lt.chained && lt.chain ? lt.chain : lt; const m = src.d30 || src.sinceOpen; return m ? (k === 'fee' ? m.feeAprPct : m.netPct) : null; };
  return [...arr].sort((a, b) => { const x = val(a), y = val(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return y - x; });
}
const ltDate = t => t ? new Date(t).toLocaleDateString(undefined,{month:'short',day:'numeric'}) : '?';
const ltPctText = (v, signed) => v == null ? '—' : (signed ? (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) : v.toFixed(0)) + '%';
function ltBasisText(m){ return m.basis === 'twa' ? `time-weighted value ${usd(m.basisUsd)}` : m.basis === 'open' ? `value at open ${usd(m.basisUsd)}` : 'no basis (no price at open)'; }
// What a long-term figure still needs, read from the measure longterm.js returned
// (measureOne / measureChain). Fee APR = window fees ÷ basis, annualised, and needs
// a window of at least an hour; net return = net USD ÷ basis. Each missing input
// is named on its own, so the card never claims both are absent when only one is.
const LT_NEEDS = {
  basis: 'an opening value (no price was recorded at the deposit, and the daily value ledger does not cover enough of the window for a time-weighted value)',
  fees: 'a fee observation at the start of the window (the daily value ledger has no uncollected-fee reading there)',
  window: 'a window of at least one hour',
  net: 'every leg of net return (the deposit history behind the price move and impermanent loss is incomplete)',
};
function ltNeeds(m) {
  const basis = m.basisUsd == null || !(m.basisUsd > 0);
  const out = { fee: [], net: [] };
  if (basis) { out.fee.push(LT_NEEDS.basis); out.net.push(LT_NEEDS.basis); }
  if (m.feeAprPct == null) {
    if (m.feesUsd == null) out.fee.push(LT_NEEDS.fees);
    if (m.days != null && m.days < 1 / 24) out.fee.push(LT_NEEDS.window);
  }
  if (m.netPct == null && m.netUsd == null) out.net.push(LT_NEEDS.net);
  if (m.feeAprPct != null) out.fee = [];
  if (m.netPct != null) out.net = [];
  return out;
}
// The Performance group's empty note, when no long-term block could be drawn at all.
function perfEmptyNote(p) {
  const lt = p.longTerm;
  const head = 'No performance figures yet. ';
  if (!lt) return head + 'Fee APR and net return have not been computed for this position in this read (no long-term record was returned for it).';
  const src = lt.chained && lt.chain ? lt.chain : lt;
  if (!src.d30 || !src.sinceOpen) return head + 'Fee APR and net return need the time this position was opened, and no first deposit is recorded for it.';
  const n = ltNeeds(src.d30);
  const parts = [];
  if (n.fee.length) parts.push('Fee APR needs ' + n.fee.join(' and '));
  if (n.net.length) parts.push('Net return needs ' + n.net.join(' and '));
  return head + (parts.length ? parts.join('. ') + '.' : 'Nothing is missing, but the figures were not drawn.');
}
function longTermLine(p){
  const lt = p.longTerm;
  if (!lt) return '';
  const src = lt.chained && lt.chain ? lt.chain : lt;
  const d30 = src.d30, all = src.sinceOpen;
  if (!d30 || !all) return '';
  const win = d30.days != null && all.days != null && d30.days < all.days ? `last ${d30.days.toFixed(0)} d` : `since open (${(d30.days || 0).toFixed(1)} d)`;
  const approx = d30.approx ? ' ≈ deposit basis taken when the dashboard first saw the position' : '';
  const chainNote = lt.chained ? `\nChained: ${lt.members} positions in this pool counted as one (re-minted within 48 h of a close); this position alone: fee APR ${ltPctText(lt.d30 && lt.d30.feeAprPct)}, net ${ltPctText(lt.d30 && lt.d30.netPct, true)}.` : '';
  const needs = ltNeeds(d30);
  const feeMissing = needs.fee.length ? `\nUnavailable: needs ${needs.fee.join(' and ')}.` : '';
  const netMissing = needs.net.length ? `\nUnavailable: needs ${needs.net.join(' and ')}.` : '';
  const feeTip = `This position's own fee APR, ${win}: fees ${usd(d30.feesUsd)} on the ${ltBasisText(d30)}, annualised over the actual days${d30.unpricedCollects ? ` (${d30.unpricedCollects} unpriced collect${d30.unpricedCollects === 1 ? '' : 's'} not counted)` : ''}.${feeMissing}\nSince open (${(all.days || 0).toFixed(1)} d): ${ltPctText(all.feeAprPct)}, fees ${usd(all.feesUsd)}.${approx}${chainNote}`;
  const netTip = `Net return, ${win}: fees + price move + IL = ${d30.netUsd == null ? 'unknown (a leg is missing)' : (d30.netUsd >= 0 ? '+' : '−') + usd(Math.abs(d30.netUsd))} on the ${ltBasisText(d30)}.${netMissing}\nSince open: ${all.netUsd == null ? 'unknown' : (all.netUsd >= 0 ? '+' : '−') + usd(Math.abs(all.netUsd)) + ' (' + ltPctText(all.netPct, true) + ')'}.${approx}${chainNote}`;
  // Neither figure exists: say exactly which inputs are missing, per figure, and
  // keep the full explanation on hover, rather than a bare dash or a substitute measure.
  if (d30.feeAprPct == null && d30.netPct == null) {
    const same = needs.fee.join() === needs.net.join();
    const text = same
      ? `Fee APR and net return unavailable — need ${needs.fee.join(' and ')}`
      : `Fee APR unavailable — needs ${needs.fee.join(' and ') || 'inputs not reported'}; net return unavailable — needs ${needs.net.join(' and ') || 'inputs not reported'}`;
    return `<span class="rate lt nobasis" tabindex="0" title="${esc(feeTip + "\n\n" + netTip)}">${esc(text)}</span>`;
  }
  const chainHint = lt.chained ? ` <span class="ltchain" title="${esc(`Re-minted ${lt.members - 1}× within 48 h of a close; fees and days run from the first open`)}">⛓ since ${ltDate(lt.chainSince)}</span>` : '';
  return `<span class="rate lt"><span class="ltstat" title="${esc(feeTip)}">Fee APR <b>${ltPctText(d30.feeAprPct)}</b></span><span class="ltstat" title="${esc(netTip)}">Net return <b class="${d30.netPct != null && d30.netPct < 0 ? 'neg' : ''}">${ltPctText(d30.netPct, true)}</b></span>${chainHint}</span>`;
}
let lastRenderD = null;
{
  const sel = document.getElementById('ltsort');
  if (sel) { sel.value = ltPref(); sel.addEventListener('change', e => { setPref('positions:sort', e.target.value); if (lastRenderD) render(lastRenderD); if (typeof lastWatchForPf !== 'undefined' && lastWatchForPf) renderWatch(lastWatchForPf); }); }
}
// "claimed $X · N collects · last <date>" for a position card (main, watched and memecoin cards).
// The uncollected-fee figure on a card face. A read that failed is not zero: it
// says so, and carries the reason. Dropping to $0.00 here would read as "this
// position has earned nothing", which is the one thing it does not mean.
function feeFace(p) {
  if (p.feesOk === false) {
    const why = p.feesError ? esc(String(p.feesError)) : 'the fee read did not return a value in this refresh';
    return `<span class="f unavail" title="Fees unavailable: ${why}. The position itself loaded; only the fee read failed.">Fees unavailable</span>`;
  }
  return `<span class="f ${(p.feesUsd || 0) < 0.005 ? 'zero' : ''}">${usd(p.feesUsd)} uncollected</span>`;
}


// ---------------------------------------------------------------------------
// One position card, used for the owner's positions and for watched wallets so
// the two can never drift apart. Everything it prints comes from the position
// object the API already returns; nothing here computes a value of its own.
//
//   header   pair, wallet, id, protocol, fee tier, status badge
//   metrics  Position value | Uncollected fees | Claimed fees | Range status
//   rail     full-width, log-spaced (railPos is a tick fraction, already log)
//   details  collapsed; two columns on desktop, stacked narrow
//
// Claimed fees is a real <button>: it is in the tab order, answers Enter and
// Space for free, carries aria-expanded/aria-controls, and opens this position's
// collection history from the rows /api/history already loaded.
// ---------------------------------------------------------------------------
function rangeStatus(p, v, near) {
  if (p.tickLower <= -887000 && p.tickUpper >= 887000) return { text: 'Full range', sub: 'Full range — fees accrue when eligible swaps occur.', cls: '' };
  if (p.inRange) return { text: near ? 'Near the edge' : 'In range',
    sub: `${v.toLower.toFixed(1)}% to the floor · ${v.toUpper.toFixed(1)}% to the ceiling`, cls: near ? 'near' : '' };
  const reenter = v.above ? { dir: 'fall', pct: (1 - v.upper / v.current) * 100 }
                          : { dir: 'rise', pct: (v.lower / v.current - 1) * 100 };
  return { text: v.above ? 'Above range · idle' : 'Below range · idle',
    sub: `needs a ${reenter.pct.toFixed(1)}% ${reenter.dir} to start earning`, cls: 'out' };
}

// The claimed-fees metric: the state from claimState(), condensed to a tile. A
// number only with verified records behind it; a floor reads "at least"; a zero
// only when verified. Its title says how the figure was valued, because the
// uncollected-fee tile beside it is at current prices.
function claimedMetric(p, uid, wallet) {
  const c = p.claimed;
  const sc = (c && c.scope) || {};
  const st = claimState(c);
  const cov = (c && c.coverage) || {};
  const open = `<button type="button" class="metric claimed" aria-expanded="false" aria-controls="${uid}" data-claim="${uid}" data-state="${st}"` +
    ` data-tokenid="${esc(String(sc.tokenId || p.nftId || p.tokenId || ''))}"` +
    ` data-chainid="${esc(String(sc.chainId || p.chainId || ''))}"` +
    ` data-manager="${esc(String(sc.positionManager || p.positionManager || ''))}"` +
    (wallet ? ` data-wallet="${esc(String(wallet).toLowerCase())}"` : '');
  const tile = (title, cls, mv, sub, subCls) => `${open} title="${esc(title)}">` +
    `<span class="ml">Claimed fees</span><span class="mv${cls ? ' ' + cls : ''}">${mv}</span>` +
    `<span class="msub${subCls ? ' ' + subCls : ''}">${sub}</span></button>`;
  const n = (c && c.count) || 0;
  const nClaims = `${n} claim${n === 1 ? '' : 's'}`;
  const val = claimValuation(c);
  const why = endStop(claimWhy(c, st));
  const cur = claimCurrent(c);
  const tail = (cur ? ' ' + endStop(cur.note) : '') + ' Already paid out to the wallet, so it is not part of the position value. ' + CLAIM_MIXED_NOTE + ' Opens the collection history.';
  const blocks = cov.fromBlock != null ? ` Scanned blocks ${cov.fromBlock}–${cov.toBlock}${cov.fromT ? ' (since ' + cDate(cov.fromT) + ')' : ''}.` : '';
  if (st === 'complete') {
    if (claimVerifiedZero(c)) {
      return tile(`Complete history: the scan covers this position from its opening${cov.openedBlock != null ? ' at block ' + cov.openedBlock : ''} and every payout decoded; none was found. A verified zero.` + tail,
        'zero', usd(0), 'none claimed · complete history, verified');
    }
    if (!n) {
      return tile(`Complete history, but the server did not confirm a zero total${c.usdMissing ? ' (' + c.usdMissing + ')' : ''}, so no figure is shown.` + tail,
        'unavail', 'No figure', 'complete history · total not confirmed');
    }
    const money = claimMoney(c, false);
    const part = money ? null : claimSubtotal(c);
    const when = cTime(c.last);
    return tile(`${nClaims} over this position’s complete history (collects, withdrawals and liquidity adds that paid out fees).` +
      `${val.text ? ' USD ' + val.text + '.' : ''}${part ? ' ' + endStop(part.note) : c.usdMissing ? ' No USD total: ' + c.usdMissing + '.' : ''}` + tail,
      money ? (val.approx ? 'approx' : '') : part ? 'partial' : 'unavail', money ? esc(money) : part ? esc(part.text) : 'No USD total',
      `${nClaims}${when ? ' · last ' + esc(when) : ''} · complete history${money && val.short ? ' · ' + esc(val.short) : ''}` +
      `${part ? ` · ${part.excluded} without a historical price excluded` : ''}${cur ? ' · ' + esc(cur.text) + ' (separate)' : ''}`);
  }
  if (st === 'scanning' || st === 'lookback-reached') {
    const found = n > 0 && c.tokens && c.tokens.length;
    const money = found ? claimMoney(c, true) : null;
    const part = found && !money ? claimSubtotal(c) : null;
    const from = cDate(cov.fromT);
    const floorNote = found ? ` ${nClaims} verified in that range; the figure is a floor, not a lifetime total.` : ' None found in that range so far, which is not the same as none claimed.';
    const title = why + blocks + floorNote + (money && val.text ? ' USD ' + val.text + '.' : '') + tail;
    const label = st === 'scanning' ? 'scan in progress' : 'lifetime history incomplete';
    const sub = st === 'scanning'
      ? `${found ? nClaims + ' found so far' : 'none found so far'}${from ? ' since ' + esc(from) : ''} · ${label}`
      : `${label} · covers ${from ? 'since ' + esc(from) : 'a limited range'}${found ? ' · ' + nClaims : ''}`;
    if (money) return tile(title, 'partial', esc(money), sub + (val.approx ? ' · ' + esc(val.short) : ''));
    if (part) return tile(title + ' ' + endStop(part.note), 'partial', esc(part.text), `${sub} · ${part.excluded} without a historical price excluded`);
    return tile(title, 'partial', st === 'scanning' ? 'Scanning…' : 'Incomplete', sub);
  }
  if (st === 'undecodable') {
    return tile(why + blocks + ' No figure is given, and this is not a zero.' + tail,
      'unavail', 'No figure', esc(why), 'reason');
  }
  if (st === 'unsupported') {
    return tile(why + ' Nothing is known either way; this is not a zero.', 'unavail', 'Not supported', esc(why), 'reason');
  }
  return tile(why + ' Nothing is known either way; this is not a zero.', 'unavail', 'Not scanned yet', 'no block range scanned yet');
}

function positionCard(p, d, opts) {
  const o = opts || {};
  const v = orient(p);
  const near = p.inRange && (v.toUpper < NEAR || v.toLower < NEAR);
  // Full range: liquidity across the whole tick space, so there is no floor or
  // ceiling to show; fees accrue whenever eligible swaps occur.
  const full = p.tickLower <= -887000 && p.tickUpper >= 887000;
  const st = rangeStatus(p, v, near);
  const cls = 'pos card2' + (p.inRange ? (near ? ' near' : '') : ' out');
  const uid = `ch-${(p.chainId || (d && d.chainId) || 'c')}-${(p.nftId || p.tokenId)}`;
  const pctPos = (v.railPos * 100).toFixed(2);
  const flagCls = v.railPos < 0.12 ? ' left' : v.railPos > 0.88 ? ' right' : '';
  const flagPos = v.railPos < 0.12 ? 'left:0' : v.railPos > 0.88 ? 'left:100%' : `left:${pctPos}%`;
  const s0 = p.share0 != null ? p.share0
    : (p.usd0 != null && p.usd1 != null && (p.amount0 * p.usd0 + p.amount1 * p.usd1) > 0
        ? (p.amount0 * p.usd0) / (p.amount0 * p.usd0 + p.amount1 * p.usd1) * 100 : 50);
  const s1 = 100 - s0;

  return `
  <article class="${cls}">
    <header class="pchead">
      <div class="pcid">
        <h3>${p.pair}</h3>
        ${o.wallet ? `<span class="pcwallet" title="Held by ${esc(o.wallet)}">${esc(o.wallet)}</span>` : ''}
        <span class="nft mono">${nftLink(d, p, '#' + (p.nftId || p.tokenId))}</span>
        <span class="tier">${p.version === 4 ? 'v4' : 'v3'}</span>
        <span class="tier">${p.feeTierLabel}</span>
        ${full ? '<span class="full" title="Liquidity across the whole price range">full range</span>' : ''}
        ${p.approved === false ? '<span class="tag-noappr">not approved</span>' : ''}
        ${p.eligible === true ? '<span class="tag-elig">collectable</span>' : ''}
        ${o.eta || ''}
      </div>
      <span class="state ${st.cls}">${st.text}</span>
    </header>

    <div class="metrics">
      <div class="metric"><span class="ml">Position value</span><span class="mv">${usd(p.valueUsd)}</span>
        <span class="msub">${p.symbol0} + ${p.symbol1}</span></div>
      <div class="metric"><span class="ml">Uncollected fees</span>${feeMetric(p)}</div>
      ${claimedMetric(p, uid, o.walletAddr)}
      <div class="metric"><span class="ml">Range status</span><span class="mv ${st.cls}">${st.text}</span>
        <span class="msub">${st.sub}</span></div>
    </div>

    <div class="rail wide">
      <div class="track">
        <div class="bar"></div>
        <div class="cap l"></div><div class="cap r"></div><div class="mid"></div>
        <div class="flag${flagCls}" style="${flagPos}">${price(v.current)}</div>
        <div class="stem" style="left:${pctPos}%"></div>
        <div class="marker" style="left:${pctPos}%"></div>
      </div>
      <div class="ends">
        <span><span class="rl">min</span> <span class="mono">${full ? '0' : price(v.lower)}</span></span>
        <button type="button" class="unit" data-key="${v.key}" data-invert="${v.invert ? 1 : 0}"
          title="Prices in ${v.unit}. Switch to ${v.invert ? p.symbol1 + ' per ' + p.symbol0 : p.symbol0 + ' per ' + p.symbol1}.">${v.unit} &#8646;</button>
        <span><span class="mono">${full ? '∞' : price(v.upper)}</span> <span class="rl">max</span></span>
      </div>
    </div>

    <div class="claimhist" id="${uid}" hidden></div>

    <details class="posmore">
      <summary>View details</summary>
      <div class="detailgrid">
        <section class="dgroup">
          <h4>Position composition</h4>
          <div class="split" role="img" aria-label="${s0.toFixed(0)} percent ${p.symbol0}, ${s1.toFixed(0)} percent ${p.symbol1}">
            <i class="a" style="width:${s0}%"></i><i class="b" style="width:${s1}%"></i>
          </div>
          <span class="amts"><b>${amount(p.amount0)}</b> ${p.symbol0} · <b>${amount(p.amount1)}</b> ${p.symbol1}</span>
          <span class="rate muted">${s0.toFixed(0)}% ${p.symbol0} / ${s1.toFixed(0)}% ${p.symbol1} at current prices</span>
        </section>

        <section class="dgroup">
          <h4>Uncollected fee breakdown</h4>
          ${p.feesOk === false
            ? `<span class="amts unavail">Fee read unavailable — ${esc(String(p.feesError || 'the read did not return a value'))}</span>`
            : `<span class="amts"><b>${amount(p.fee0)}</b> ${p.symbol0} · <b>${amount(p.fee1)}</b> ${p.symbol1}</span>
               <span class="rate muted">${usd(p.feesUsd)} at current prices · not yet withdrawn, still in the pool</span>`}
          ${o.collectHint || ''}
        </section>

        <section class="dgroup">
          <h4>Performance</h4>
          ${dgroupBody([incomeLine(p), longTermLine(p), o.perf, sparkline(p.spark)], esc(perfEmptyNote(p)))}
        </section>

        <section class="dgroup">
          <h4>Pool statistics</h4>
          ${dgroupBody([poolLine(p), pxChart(p, v)], 'No pool statistics for this pool yet.')}
        </section>
      </div>
      <footer class="dfoot">
        <span>${esc(freshText(d))}</span>
        <span>${coverageText(p)}</span>
      </footer>
    </details>
  </article>`;
}

// When the data was read and when this page last fetched it, stated separately.
// `at` is the server's read time; the fetch time is this browser's clock at the
// last successful fetch. A failed refresh leaves both as they were, and the
// section's stale warning says so.
function freshText(d) {
  if (!d) return 'Last successful update unknown.';
  const read = d.at ? clock(d.at) : null;
  const got = fetchedAt.get(d);
  return `Last successful update: data read ${read || 'at an unrecorded time'}${d.cached ? ' (a cached read)' : ''}` +
    (got ? ` \u00b7 page last refreshed it ${clock(got)}.` : '.');
}

// A group with nothing in it says so, rather than rendering a heading over empty
// space that reads as a rendering fault.
function dgroupBody(parts, emptyNote) {
  const body = parts.filter(x => x && String(x).trim()).join('');
  return body || `<span class="rate muted">${emptyNote}</span>`;
}

// The uncollected-fee metric body. A failed read is not zero and says so.
function feeMetric(p) {
  if (p.feesOk === false) {
    return `<span class="mv unavail">Unavailable</span><span class="msub">${esc(String(p.feesError || 'the fee read did not return a value'))}</span>`;
  }
  return `<span class="mv ${(p.feesUsd || 0) < 0.005 ? 'zero' : ''}">${usd(p.feesUsd)}</span>` +
    `<span class="msub" title="Valued at current prices. The Claimed fees tile beside it uses historical prices, so the two are not one uniform total.">at current prices \u00b7 still in the pool</span>`;
}

// What the claim history does and does not cover, stated on every card.
function coverageText(p) {
  const c = p.claimed;
  const st = claimState(c);
  const cov = (c && c.coverage) || {};
  const why = esc(endStop(claimWhy(c, st)));
  if (st === 'complete') {
    return `Claim history: complete history from this position’s opening` +
      `${cov.openedT ? ' on ' + esc(cDate(cov.openedT)) : cov.openedBlock != null ? ' at block ' + esc(String(cov.openedBlock)) : ''}` +
      `${cov.toT ? ' to ' + esc(cTime(cov.toT)) : ''}`;
  }
  if (st === 'scanning') {
    return `Claim history: scan in progress, covering ${cov.fromT ? 'since ' + esc(cDate(cov.fromT)) : 'part of this position’s life'} so far — ${why} Any figure is a floor.`;
  }
  if (st === 'lookback-reached') {
    return `Claim history: lifetime history incomplete, covers only since ${cov.fromT ? esc(cDate(cov.fromT)) : 'the lookback limit'} — ${why} Any figure is a floor.`;
  }
  if (st === 'undecodable') return `Claim history: no figure — ${why}`;
  if (st === 'unsupported') return `Claim history: not supported — ${why}`;
  return `Claim history: not scanned yet — ${why}`;
}

function claimedLine(p){
  // Fees already taken out of this position, scoped to one chain + position
  // manager + token id, in the same states as the tile (claimState). Only a
  // complete history prints a total; a scanning or lookback-limited one prints a
  // floor ("at least"); a zero is printed only when verified.
  //
  // This is money that has ALREADY LEFT the position. It is deliberately not added
  // to the card's value, to uncollected fees, or to any wallet balance: it is
  // already sitting in the wallet as tokens, and counting it again would
  // double-count it in the portfolio total.
  const c = p.claimed;
  const st = claimState(c);
  const why = esc(endStop(claimWhy(c, st)));
  const val = claimValuation(c);
  if (st === 'not-scanned') return `<span class="c unavail" title="${why} Nothing is known either way.">Claim history not scanned yet</span>`;
  if (st === 'unsupported') return `<span class="c unavail" title="${why} Nothing is known either way.">Claim history not supported</span>`;
  if (st === 'undecodable') return `<span class="c unavail" title="${why} No figure is given, and this is not a zero.">Claimed fees: no figure — ${why}</span>`;
  const amounts = (c.tokens || []).map(t => `${esc(t.amount)} ${esc(t.symbol)}`).join(' + ');
  const n = c.count || 0;
  const money = claimMoney(c, st !== 'complete');
  const part = money ? null : claimSubtotal(c);
  const cur = claimCurrent(c);
  const partHtml = part ? ` · <b>${esc(part.text)}</b> <span class="muted" title="${esc(endStop(part.note))}">(${part.excluded} excluded: no historical price)</span>` : '';
  const curHtml = cur ? ` · <span class="muted" title="${esc(endStop(cur.note))}">${esc(cur.text)}, a separate figure</span>` : '';
  const valTip = val.text ? ` USD ${esc(val.text)}.` : '';
  if (st === 'scanning' || st === 'lookback-reached') {
    const cov = c.coverage || {};
    const since = cDate(cov.fromT);
    const label = st === 'scanning' ? 'scan in progress' : 'lifetime history incomplete';
    if (!n) return `<span class="c partial" title="${why}">No claims found ${since ? 'since ' + esc(since) : 'in the scanned range'} — ${label}; not a zero</span>`;
    return `<span class="c partial" title="${why} The figure is a floor, not a lifetime total.${valTip} ${esc(CLAIM_MIXED_NOTE)}">` +
      `Claimed at least <b>${amounts}</b>${money ? ` · <b>${esc(money)}</b>` : partHtml} ${since ? 'since ' + esc(since) : ''} — ${label}</span>`;
  }
  // complete
  if (claimVerifiedZero(c)) {
    return `<span class="c zero" title="Complete history from this position's opening; no fee collect and no withdrawal. A verified zero, not an assumption.">No fees claimed yet <span class="muted">(verified, complete history)</span></span>`;
  }
  if (!n) return `<span class="c unavail" title="Complete history, but the server did not confirm a zero total.">Claimed fees: total not confirmed</span>`;
  const when = cTime(c.last) || '';
  const title = `${n} claim${n === 1 ? '' : 's'} across this position's complete history.${valTip}` +
    `${c.principalSeparated ? ' Withdrawals are included with their principal removed, so only fees are counted.' : ''}` +
    ` Already paid out to the wallet, so it is not part of the position value above. ${CLAIM_MIXED_NOTE}`;
  return `<span class="c" title="${esc(title)}">Claimed <b>${amounts}</b>` +
    `${money ? ` · <b>${esc(money)}</b>${val.short ? ` <span class="muted">${esc(val.short)}</span>` : ''}` : part ? partHtml : ` <span class="muted" title="${esc(c.usdMissing || '')}">· no USD total (a leg is unpriced)</span>`}` +
    `${curHtml} · ${n}×${when ? ' · last ' + esc(when) : ''} · complete history</span>`;
}
// What this position has earned, from the chain-derived history: capital in and
// out at the price of each transaction, claimed fees at the price of each
// settlement, and the fees still in the pool at today's price. Every figure says
// which basis it uses; a missing input is named instead of guessed around.
function incomeLine(p) {
  const i = p && p.income;
  if (!i) return '';
  const parts = [];
  if (i.feesUsd != null) {
    const bits = [];
    if (i.claimedUsd != null) bits.push(`${usd(i.claimedUsd)} claimed, at each settlement's price`);
    if (i.uncollectedUsd) bits.push(`${usd(i.uncollectedUsd)} still in the pool, at today's price`);
    parts.push(`<span class="rate">Fees earned <b>${usd(i.feesUsd)}</b>${bits.length ? ' — ' + esc(bits.join(' + ')) : ''}</span>`);
  }
  if (i.twaCapitalUsd != null) {
    // An annualised figure from a few days is arithmetic, not a forecast: it always
    // carries the window it was extrapolated from.
    const rate = i.feeRatePct != null
      ? ` · <b>${esc(ratePct(i.feeRatePct) || '—')}</b> a year <span class="muted">extrapolated from ${esc(i.days >= 1 ? i.days.toFixed(1) + ' days' : (i.days * 24).toFixed(1) + ' h')}</span>`
      : i.annualNote ? ` · <span class="muted">${esc(i.annualNote)}</span>` : '';
    parts.push(`<span class="rate" title="Time-weighted capital: the net capital in this position (valued at the prices it went in and out) averaged over its life, ${esc(String(i.days))} days so far. ${esc(i.basis || '')}">`
      + `On capital <b>${usd(i.twaCapitalUsd)}</b> time-weighted${i.onCapitalPct != null ? ` · <b>${esc(ratePct(i.onCapitalPct) || '—')}</b> of it` : ''}${rate}</span>`);
  }
  if (i.depositedUsd != null) {
    parts.push(`<span class="rate muted" title="Principal only — fees are not counted here. Each movement is valued at the price of its own transaction.">`
      + `Capital in <b>${usd(i.depositedUsd)}</b>${i.withdrawnUsd ? ` · out <b>${usd(i.withdrawnUsd)}</b>` : ''} over ${esc(String(i.capitalEvents))} movement${i.capitalEvents === 1 ? '' : 's'}</span>`);
  }
  if (i.missing && i.missing.length) {
    parts.push(`<span class="rate muted">Income figures need: ${esc(i.missing.join('; '))}.</span>`);
  }
  return parts.join('');
}
// Tx hashes in the run log become explorer links.
const linkify = s => EXPLORER
  ? esc(s).replace(/0x[0-9a-fA-F]{64}/g, h =>
      `<a href="${EXPLORER}/tx/${h}" target="_blank" rel="noopener">${h}</a>`)
  : esc(s);

function showRun(run){
  $('#cologwrap').hidden = false;
  const pre = $('#colog');
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  pre.innerHTML = run.output ? linkify(run.output) : '(starting…)';
  if (atBottom) pre.scrollTop = pre.scrollHeight;
  $('#costate').textContent = run.done
    ? (run.code === 0 ? 'finished' : 'failed (exit ' + run.code + ')')
    : 'running…';
}

function finishRun(run){
  const btn = $('#collect');
  btn.disabled = false;
  btn.textContent = 'Collect fees';
  const hint = $('#cohint');
  if (/locked, skipping/.test(run.output)){
    hint.textContent = 'The operator key is locked. Run ./unlock.sh in the WSL terminal, then press Collect fees again.';
    hint.hidden = false;
  } else {
    hint.hidden = true;
    load(true); // fees moved; re-read the chain
    loadHistory();
    loadDaily();
  }
}

async function pollRun(){
  try{
    const r = await fetch('/api/collect');
    const d = await r.json();
    if (!d.run) return stopPolling();
    showRun(d.run);
    if (d.run.done){ stopPolling(); finishRun(d.run); }
  }catch(e){ /* transient; keep polling */ }
}

function stopPolling(){ if (coTimer){ clearInterval(coTimer); coTimer = null; } }

function watchRun(){
  const btn = $('#collect');
  btn.disabled = true;
  btn.textContent = 'Collecting…';
  $('#cohint').hidden = true;
  if (!coTimer) coTimer = setInterval(pollRun, 2000);
  pollRun();
}

async function startCollect(){
  const btn = $('#collect');
  btn.disabled = true;
  btn.textContent = 'Collecting…';
  try{
    const r = await fetch('/api/collect', { method: 'POST' });
    const d = await r.json();
    if (!d.ok && r.status !== 409) throw new Error(d.error || 'could not start');
    watchRun(); // 409 = already running; just attach to it
  }catch(e){
    btn.disabled = false;
    btn.textContent = 'Collect fees';
    $('#cologwrap').hidden = false;
    $('#costate').textContent = 'failed';
    $('#colog').textContent = 'Could not start the collect run: ' + e.message;
  }
}

$('#collect').addEventListener('click', startCollect);

/* ---- arm / lock ---- */
// Arm collector opens the wallet-signature page (/arm); shift-click keeps the inline passphrase form.
$('#armbtn').addEventListener('click', (e) => {
  if (!e.shiftKey) { location.href = '/wallet#arm'; return; }
  $('#armform').hidden = false;
  $('#armmsg').textContent = '';
  $('#armpass').focus();
});
$('#armcancel').addEventListener('click', () => {
  $('#armpass').value = '';
  $('#armform').hidden = true;
});

$('#armform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = $('#armgo'), msg = $('#armmsg');
  go.disabled = true; go.textContent = 'Verifying…';
  msg.className = 'armmsg'; msg.textContent = '';
  try{
    const r = await fetch('/api/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: $('#armpass').value, minutes: Number($('#armdur').value) }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'unlock failed');
    $('#armpass').value = '';
    $('#armform').hidden = true;
    renderUnlock(d.unlock);
  }catch(err){
    msg.textContent = err.message === 'wrong passphrase'
      ? 'Wrong passphrase.' : 'Could not arm: ' + err.message;
  }finally{
    go.disabled = false; go.textContent = 'Arm';
  }
});

$('#lockbtn').addEventListener('click', async () => {
  try{
    const r = await fetch('/api/lock', { method: 'POST' });
    const d = await r.json();
    if (d.ok) renderUnlock(d.unlock);
  }catch(e){ /* next refresh will correct the chip */ }
});

// If a run is already going (page reload mid-collect), pick it back up.
// ---- watched wallets: read-only views of extra addresses (config.watchWallets) ----
const shortA = a => a ? a.slice(0,6) + '…' + a.slice(-4) : '—';
function renderWatch(d){
  if (!d || !d.ok || !d.wallets || !d.wallets.length) { $('#watchlist').innerHTML = ''; $('#watchnote').textContent = ''; return; }
  $('#watchsec').hidden = false;
  notePricing(d);
  $('#watchnote').textContent = 'Watched wallets are read-only and never collected from. Value = tokens in the wallet + open positions + uncollected fees, at current prices. ' + pricingText() + ' ' + freshText(d);
  const scopeW = pfScope();
  const shown = scopeW === 'owner' || scopeW === 'all' ? d.wallets : d.wallets.filter(w => w.address.toLowerCase() === scopeW);
  if (scopeW !== 'all' && scopeW !== 'owner') {
    $('#watchtitle').textContent = shown[0] ? `Positions · ${shown[0].label || 'watched wallet'} · ${(shown[0].totals && shown[0].totals.count) || 0} open` : 'Positions';
    $('#watchtotal').textContent = shown[0] && shown[0].totals ? usd(shown[0].totals.totalUsd) : '';
  }
  $('#watchstats').hidden = scopeW !== 'all';
  renderHeadline(); // the combined header needs both payloads
  $('#watchlist').innerHTML = shown.map(w => {
    const name = w.label ? `${w.label} <span class="muted">${shortA(w.address)}</span>` : shortA(w.address);
    const link = chainRef(d.explorer, `/address/${w.address}`, name, w.address);
    if (!w.ok) return `<div class="watchwallet"><div class="wh">${link}<span class="idle">${w.error || 'could not load'}</span></div></div>`;
    const t = w.totals;
    const h = w.holdings;
    const walletPart = h
      ? `<span>tokens <b>${usd(h.walletUsd)}</b>${h.unpricedCount ? ` <span class="muted" title="tokens with no pricing pool">+${h.unpricedCount} unpriced</span>` : ''}${h.ok ? '' : ' <span class="idle" title="Blockscout holdings list unavailable; only position tokens and ETH were checked">partial</span>'}</span>`
      : '';
    const e = w.earned;
    const earnedPart = e && (e.all > 0 || e.since) ? `<span title="Fee accrual from snapshots since ${e.since || 'today'}, at current prices">earned today <b>${usd(e.today)}</b> · 7d <b>${usd(e.d7)}</b></span>` : '';
    // What this wallet is earning right now, beside what it is worth. Measured from
    // the hourly accrual buckets, not projected from a total: a wallet with under an
    // hour of history reports no rate rather than one divided by a day it has not
    // lived through, and one that has never accrued shows nothing at all.
    const ratePart = e && e.perHour != null
      ? `<span class="lprate" title="Average over the last ${e.rateWindowH} hour${e.rateWindowH === 1 ? '' : 's'} of recorded accrual, valued at current prices${e.rateWindowH < 24 ? ' — a short window, so it moves easily' : ''}">fees/hr <b>${usd(e.perHour)}</b></span>`
      : '';
    const c = w.collector;
    const mark = v => v === true ? '<span class="in">✓</span>' : v === false ? '<span class="idle">✗</span>' : '?';
    const collectorPart = c && c.enabled ? `<span title="The collector collects this wallet's fees once it has approved the operator on the v3 and v4 position managers (Wallet page, Approvals tab)">collector: v3 ${mark(c.v3)} v4 ${mark(c.v4)}${c.v3 === false || c.v4 === false ? ' <a href="/wallet#approvals" class="muted">approve</a>' : ''}</span>` : '';
    const cardsId = 'wcards-' + w.address.toLowerCase();
    // Name and count read first; the LP subtotal and the control sit opposite. The
    // wallet's own balance, its loose tokens, what it has earned and whether the
    // collector is approved are all kept, one disclosure down.
    const head = `<div class="wh">
      <div class="wh-main">${link}<span class="wcount"><b>${t.count}</b> open${t.idle ? ` · <span class="idle">${t.idle} idle</span>` : ''}${w.closed ? ` · <span class="muted">${w.closed} closed</span>` : ''}${w.truncated ? ` · <span class="muted" title="This wallet owns ${w.known} position NFTs; only the newest ${w.known - w.truncated} were read">newest ${w.known - w.truncated} of ${w.known}</span>` : ''}</span></div>
      <div class="wh-side">${ratePart}<span class="lpsub" title="The open positions alone, without this wallet's loose tokens or its uncollected fees">LP value <b>${usd(t.liquidityUsd)}</b></span>${w.positions.length ? walletToggle(w.address.toLowerCase(), cardsId, t.count) : ''}</div>
      <details class="whmore"><summary>Wallet detail</summary><div class="whmore-body"><span class="wtotal">total <b>${usd(t.totalUsd)}</b></span>${walletPart}<span>uncollected <b>${usd(t.feesUsd)}</b></span>${earnedPart}${collectorPart}</div></details>
    </div>`;
    // Top tokens sitting in the wallet, compact.
    const toks = h && h.tokens.length
      ? `<div class="wtokens">${h.tokens.filter(x => x.usd != null && x.usd >= 0.5).slice(0, 8).map(x => `<span title="${x.amount.toLocaleString('en-US',{maximumFractionDigits:6})} ${x.symbol}${x.thin ? ' (thin pool, quote only)' : ''}">${x.symbol} <b>${x.usd == null ? 'unpriced' : usd(x.usd)}</b>${x.thin ? '<span class="idle">≈</span>' : ''}</span>`).join('')}${(n => n > 0 ? `<span class="muted">+${n} more</span>` : '')(h.tokens.filter(x => x.usd != null && x.usd >= 0.5).length - 8)}</div>`
      : '';
    if (!w.positions.length) return `<div class="watchwallet">${head}${toks}<div class="wempty">No open positions.</div></div>`;
    const cards = sortLT(w.positions).map(p =>
      // The same card as the owner's, so the two can never drift apart. The wallet
      // label rides in the header because a watched card is read out of context.
      positionCard(p, d, { wallet: w.label || shortA(w.address), walletAddr: w.address })
    ).join('');
    return `<div class="watchwallet">${head}${toks}<div class="wcards" id="${cardsId}">${cards}</div></div>`;
  }).join('');
  for (const w of shown) if (w.ok && w.positions && w.positions.length)
    applyWalletOpen(w.address.toLowerCase(), 'wcards-' + w.address.toLowerCase());
  renderSidebar();
}
// The watched-wallet cards. A failed read or an ok:false answer never replaces
// them: the last good cards stay, marked with their age and the failure. Only a
// successful answer redraws the section.
async function loadWatch(){
  let r, d;
  try { r = await fetch('/api/watch'); d = await r.json(); }
  catch(e){ return watchFailed(e.message || String(e)); }
  const o = apiOutcome(r.status, d);
  if (o.kind === 'pending') {                                  // first build still running
    setTimeout(loadWatch, 20000);
    if (!lastWatchForPf) { const n = $('#watchstale'); if (n) { n.hidden = false; n.className = 'chnote'; n.textContent = 'Watched wallets are still loading\u2026'; } }
    return;
  }
  if (o.kind === 'error') return watchFailed(o.msg);
  if (d && typeof d === 'object') fetchedAt.set(d, Date.now());
  try { renderWatch(d); }
  catch(e){ return watchFailed(`the page could not draw the answer (${e.message})`); }
  loadOk('Watched wallets');
  const n = $('#watchstale'); if (n) { n.hidden = true; n.textContent = ''; }
  lastWatchForPf = d;
  if (lastPortfolio) renderPortfolio();
}
function watchFailed(msg){
  loadFailed('Watched wallets', new Error(msg));
  const n = $('#watchstale');
  if (!n) return;
  n.hidden = false;
  n.className = 'loadfail';
  n.innerHTML = staleNote(lastWatchForPf && lastWatchForPf.at, msg);
}
if (PAGE !== 'analytics') { loadWatch(); setInterval(loadWatch, 120000); }

fetch('/api/collect').then(r => r.json()).then(d => {
  if (d.run && !d.run.done) watchRun();
  else if (d.run) showRun(d.run);
}).catch(() => {});

// Each page fetches only what it shows. Analytics still runs load() for the
// header (block, owner, ETH price); the dashboard skips the fee-history and
// daily-revenue fetches, which only feed the analytics panels.
const ANALYTICS = PAGE === 'analytics';
function tick(fresh){
  load(fresh);
  if (ANALYTICS) { loadHistory(); loadDaily(); loadStaking(); loadWatchForAnalytics(); loadTreasury(); loadLots(); loadTrack(); }
  else { loadRewards(); loadBalances(); loadAllSeries(); }
}
$('#reload').addEventListener('click', () => tick(true));
tick(false);
setInterval(() => tick(false), 60000);

// Positions filter and the claimed-fee total: wired once the whole file (esc,
// shortA, …) is initialised.
if (PAGE === 'dashboard') {
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('#posfilter [data-pfilter]');
    if (b) setPosFilter(b.dataset.pfilter, true);
  });
  document.addEventListener('keydown', e => {
    const b = e.target.closest && e.target.closest('#posfilter [data-pfilter]');
    if (!b) return;
    const next = posFilterStep(b.dataset.pfilter, e.key);
    if (next == null) return;
    e.preventDefault();
    setPosFilter(next, true);
  });
  const btn = document.getElementById('ctotbtn');
  if (btn) btn.addEventListener('click', () => {
    CTOT.open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(CTOT.open));
    const p = document.getElementById('ctotalpanel');
    if (p) p.hidden = !CTOT.open;
    if (CTOT.open) { renderClaimTotalPanel(); loadClaimTotal('panel'); }
  });
  const form = document.getElementById('ctfilters');
  if (form) {
    form.addEventListener('change', () => { readCtFilters(); loadClaimTotal('panel'); });
    form.addEventListener('submit', e => { e.preventDefault(); readCtFilters(); loadClaimTotal('panel'); });
    form.addEventListener('reset', () => setTimeout(() => { readCtFilters(); loadClaimTotal('panel'); }, 0));
  }
  renderPosHistory();
  renderClaimTotalButton();
  setInterval(() => histSync(true), 120000);
}

// === launch-watch ===
// Launch Watch: the launch scanner's status, live candidates (score >= 50) and recent alerts, from /api/launches every 60 s.
async function loadLaunches(){
  try {
    const r = await fetch('/api/launches', { cache: 'no-store' });
    const d = await r.json(); noteOutcome('Launch watch', r.status, d);
    const sec = $('#launchsec'); if (!d.ok) return;
    if (!d.enabled) { sec.hidden = true; return; }
    sec.hidden = false;
    const ago = d.at ? Math.round((Date.now() - d.at) / 60000) : null;
    const dot = d.stale ? '🔴' : '🟢';
    $('#launchnote').innerHTML = `${dot} ${d.stale ? 'scanner stopped or not run yet' : 'scanner running'} · last scan ${ago == null ? 'never' : ago + ' min ago'} · scanned today <b>${d.scannedToday ?? 0}</b> · alerts sent <b>${d.alertsToday ?? 0}</b>${d.tokensInWindow != null ? ` · ${d.tokensInWindow} tokens in the ${(d.settings && d.settings.maxAgeMinutes || 240) / 60}h window` : ''}`;
    const fmtM = n => n == null ? '—' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(0) + 'K' : '$' + n.toFixed(0);
    const rows = (d.candidates || []).slice(0, 12);
    const mark = (ok) => ok ? '<span class="up">✓</span>' : '<span class="down">✗</span>';
    $('#launchtable tbody').innerHTML = rows.length ? rows.map(c => {
      const ch = c.checks || {};
      const checks = [['mcap','mcap'],['contract','contract'],['lp','LP'],['honeypot','sell'],['holders','holders'],['volume','buys'],['newToken','new']].map(([k,l]) => `<span title="${k}">${mark(ch[k])}${l}</span>`).join(' ');
      return `<tr class="${c.alerted ? 'u' : ''}"><td><b>${c.symbol || '?'}</b>/${c.quoteSymbol || 'ETH'}${c.feePct != null ? ' <span class="muted">' + c.feePct + '%</span>' : ''}${c.alerted ? ' 🚀' : ''}</td><td class="u">${fmtM(c.mcapUsd)}</td><td>${c.ageMin == null ? '—' : c.ageMin < 120 ? c.ageMin + ' min' : Math.round(c.ageMin / 60) + ' h'}</td><td><b class="${c.score >= 70 ? 'up' : c.score >= 50 ? 'warn' : ''}">${c.score}</b></td><td class="muted" style="font-size:11px">${checks}${c.honeypot && c.honeypot.sellTaxPct != null ? ' · tax ' + c.honeypot.sellTaxPct + '%' : ''}${c.volume && c.volume.buys != null ? ' · ' + c.volume.buys + ' buys/' + (c.volume.sells || 0) + ' sells' : ''}</td><td>${c.pool ? `<a href="https://app.uniswap.org/explore/pools/robinhood/${c.pool}" target="_blank" rel="noopener">pool</a> · <a href="https://dexscreener.com/robinhoodchain/${c.pool}" target="_blank" rel="noopener">chart</a> · ` : ''}<a href="${(EXPLORER || 'https://robinhoodchain.blockscout.com')}/token/${c.token}" target="_blank" rel="noopener">contract</a></td></tr>`;
    }).join('') : `<tr><td colspan="6" class="muted">No candidate scored 50 or more in the window. Criteria: mcap ${fmtM(d.settings && d.settings.minMcapUsd)}–${fmtM(d.settings && d.settings.maxMcapUsd)}, pool ${(d.settings && d.settings.minAgeMinutes) || 10}–${(d.settings && d.settings.maxAgeMinutes) || 240} min old, ≥ ${fmtM(d.settings && d.settings.minTvlUsd)} in range, sellable with tax under ${(d.settings && d.settings.maxSellTaxPct) || 10}%, ≥ ${(d.settings && d.settings.minHolders) || 20} holders, top wallet under ${(d.settings && d.settings.maxTopHolderPct) || 30}%, ≥ ${(d.settings && d.settings.minBuys10min) || 5} buys in 10 min.</td></tr>`;
    $('#launchrecent').innerHTML = (d.recentAlerts || []).length ? 'Alerted: ' + d.recentAlerts.slice(0, 6).map(a => `${a.symbol || a.token.slice(0, 8)} ${fmtM(a.mcap)} (${a.score}) ${new Date(a.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`).join(' · ') : `Alerts go to Telegram at score ≥ ${(d.settings && d.settings.minScore) || 70}; the same token at most once per ${(d.settings && d.settings.alertCooldownHours) || 24} h, with a follow-up when its market cap triples.`;
  } catch(e){ loadFailed('Launch watch', e); }
}
if (PAGE !== 'analytics') { loadLaunches(); setInterval(loadLaunches, 60000); }
// === end launch-watch ===
// === risk-guardian ===
// Risk section: every open position the guardian watches (v3 and v4, every wallet),
// its status, its rule block (click a threshold to change it), the auto-close
// toggle and a Close-now button. Status from /api/risk every 30 s.
const RULE_LABELS = { alertPct: 'Alert when the token drops more than this % in 1 hour:', closePct: 'Close-now alert (or close, when auto-close is on) when the token is down this % from entry:', outOfRangeMinutes: 'Alert (or close, when auto-close is on) after the position has been out of range this many minutes:', tvlDropPct: 'Alert when the pool\'s liquidity drops more than this % from its 24h high:', feeFloorPerHour: 'Alert when the 15-minute fee rate falls under this many $ per hour (empty = off):', collectedTargetUsd: 'Alert once when the swept USDG for this position reaches this amount (empty = off):' };
/** keep / watch / close / hold pill from the server's verdict (verdict.js), with the reasons as the tooltip. */
function verdictBadge(p){
  const v = p.verdict; if (!v) return '';
  const title = { keep: 'Green, in range and earning', watch: 'Worth a look', close: 'The data says close it', hold: 'Kept by choice: the daily summary never asks you to close it' }[v.verdict] || '';
  return `<span class="verdict ${v.verdict}" title="${esc(title + (v.why && v.why.length ? ' — ' + v.why.join(', ') : ''))}">${v.verdict}${v.why && v.why.length ? ' · ' + esc(v.why[0]) : ''}</span>`;
}
function lastEarnedText(v){
  if (!v || v.idleHours == null) return 'never';
  if (v.idleHours < 1) return 'now';
  if (v.idleHours < 24) return Math.round(v.idleHours) + 'h ago';
  return (v.idleHours / 24).toFixed(v.idleHours < 240 ? 1 : 0) + 'd ago';
}
function rulesLine(p){
  const r = p.rules || p;
  const tone = (past, near) => past ? 'down' : near ? 'warn' : 'up';
  const th = (k, txt, title) => `<b class="rk-th" data-k="${k}" title="${title || 'click to change'}">${txt}</b>`;
  const parts = [];
  const c1 = p.change1hPct, past1 = c1 != null && c1 <= -r.alertPct, near1 = c1 != null && c1 <= -r.alertPct * 0.6;
  parts.push(`1h <b class="${tone(past1, near1)}">${c1 == null ? '—' : (c1 >= 0 ? '+' : '') + c1.toFixed(1) + '%'}</b> vs ${th('alertPct', '-' + r.alertPct + '%')} alert`);
  const dd = p.drawdownPct, pastD = dd != null && dd >= r.closePct, nearD = dd != null && dd >= r.closePct * 0.6;
  parts.push(`entry <b class="${tone(pastD, nearD)}">${dd == null ? '—' : '-' + dd.toFixed(1) + '%'}</b> vs ${th('closePct', '-' + r.closePct + '%')} ${p.canClose ? 'close' : 'close-now alert'}`);
  const om = p.inRange ? 0 : p.outMinutes || 0;
  parts.push(`out <b class="${tone(om >= r.outOfRangeMinutes, om >= r.outOfRangeMinutes * 0.6)}">${p.inRange ? 'no' : Math.round(om) + ' min'}</b> vs ${th('outOfRangeMinutes', r.outOfRangeMinutes + ' min')}`);
  const lq = p.liqDropFromMaxPct || 0;
  parts.push(`liquidity <b class="${tone(lq >= r.tvlDropPct, lq >= r.tvlDropPct * 0.6)}">-${lq.toFixed(0)}%</b> vs ${th('tvlDropPct', '-' + r.tvlDropPct + '%')} 24h`);
  if (r.feeFloorPerHour != null) {
    const v = p.feesPerHour15m != null ? p.feesPerHour15m : p.feesPerHour;
    parts.push(`fees <b class="${tone(v != null && v < r.feeFloorPerHour, v != null && v < r.feeFloorPerHour * 1.2)}">${v == null ? '—' : usd(v)}/h</b> vs ${th('feeFloorPerHour', '$' + r.feeFloorPerHour)} floor`);
  } else parts.push(`fee floor ${th('feeFloorPerHour', 'off')}`);
  if (r.collectedTargetUsd != null) {
    const v = p.collectedUsd || 0;
    parts.push(`collected <b class="${v >= r.collectedTargetUsd ? 'up' : v >= r.collectedTargetUsd * 0.8 ? 'warn' : ''}">${usd(v)}</b> of ${th('collectedTargetUsd', '$' + r.collectedTargetUsd)}`);
  }
  return `<div class="reasons rules" data-nft="${p.tokenId}" title="This position's rules; click a threshold to change it">${parts.join(' · ')} · auto-close <button class="rk-toggle ${p.canClose ? 'on' : ''}" ${READ_ONLY ? 'disabled' : ''} title="${p.canClose ? 'Auto-close is ON: the operator closes the position when a close trigger holds for 3 checks' : 'Auto-close is off: rules only alert'}">${p.canClose ? 'ON' : 'off'}</button> · hold <button class="rk-hold ${r.hold ? 'on' : ''}" ${READ_ONLY ? 'disabled' : ''} title="${r.hold ? 'Hold is ON: you keep this position by choice; the daily verdict says hold instead of close' : 'Hold is off: the daily verdict follows the data'}">${r.hold ? 'ON' : 'off'}</button>${p.closeConfirm ? ` <span class="warn">closing ${p.closeConfirm}</span>` : ''}</div>`;
}

async function loadRisk(){
  try {
    const r = await fetch('/api/risk', { cache: 'no-store' });
    const d = await r.json(); noteOutcome('Risk guardian', r.status, d);
    if (!d.ok) return;
    const sec = $('#risksec');
    if (!d.watching && !d.stale) { sec.hidden = true; return; }
    sec.hidden = false;
    const fmtN = n => n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 4 });
    const pct = (n, d = 1) => n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
    const cls = n => n == null ? '' : n >= 0 ? 'up' : 'down';
    const age = d.at ? Math.round((Date.now() - d.at) / 1000) : null;
    $('#risknote').textContent = d.stale ? 'guardian not reporting' : `${d.watching} watched · updated ${age}s ago · v4 every 60 s, v3 every 5 min${d.wethUsd ? ' · ETH ' + usd(d.wethUsd) : ''}`;
    const order = { red: 0, yellow: 1, green: 2 };
    // One card per wallet:tokenId, whatever the guardian sends (a re-mint or a rule block for a
    // position it also discovered must never show the same position twice).
    const seenKey = new Set();
    const list = (d.positions || []).filter(p => !p.closed).filter(p => { const k = `${p.wallet || ''}:${p.tokenId}`; if (seenKey.has(k)) return false; seenKey.add(k); return true; }).sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || (b.valueUsd || 0) - (a.valueUsd || 0));
    $('#risklist').innerHTML = list.map(p => {
      const lc = p.lastClose;
      return `<article class="pos meme ${p.status === 'red' ? 'out' : ''} ${d.stale ? 'stale' : ''}">
        <div class="top">
          <div class="name"><span class="dot ${p.status}"></span><h3>${p.pair}</h3><span class="tier">v${p.version || 4} #${p.tokenId}</span><span class="muted">${p.wallet}</span>
            <span class="state ${p.inRange ? '' : 'out'}">${p.inRange ? 'In range' : 'Out of range · ' + Math.round(p.outMinutes) + ' min'}</span>${verdictBadge(p)}</div>
          <div class="vals"><span class="v">${usd(p.valueUsd)}</span><span class="f ${(p.feeUsd || 0) < 0.005 ? 'zero' : ''}">${usd(p.feeUsd)} uncollected</span>${claimedLine(p)}</div>
        </div>
        <div class="grid">
          <span>Price (${p.symbolToken || 'token'} per ${p.quoteSymbol || 'ETH'})<b>${fmtN(p.price)}</b></span>
          <span>Entry${p.entrySource && p.entrySource !== 'config' ? ` <span class="muted" title="${p.entrySource === 'first seen' ? 'No price record from the mint; the entry is the price when the guardian first saw the position' : p.entrySource === 'set by hand' ? 'Entry price set from this page' : 'Entry price taken from the hourly price log at the mint time'}">(${p.entrySource})</span>` : ''}<b class="rk-entry" title="click to set the entry price">${fmtN(p.entryPrice)}</b></span>
          <span>vs entry (token value)<b class="${cls(p.priceVsEntryPct)}">${pct(p.priceVsEntryPct)}</b></span>
          <span>Last hour<b class="${cls(p.change1hPct)}">${pct(p.change1hPct)}</b></span>
          <span>Fees / hour<b>${p.feesPerHour == null ? '—' : usd(p.feesPerHour)}${p.feeRateChangePct != null ? ' <span class="' + cls(p.feeRateChangePct) + '" style="font-size:11px">' + pct(p.feeRateChangePct, 0) + '</span>' : ''}</b></span>
          <span>Last earned<b>${lastEarnedText(p.verdict)}</b></span>
          <span>Pool liquidity, 1h<b class="${cls(p.liqChange1hPct)}">${pct(p.liqChange1hPct)}</b></span>
          <span>Holdings<b>${p.amountEth == null ? '—' : amount(p.amountEth) + ' ' + (p.quoteSymbol || 'ETH') + ' · ' + fmtN(p.amountToken) + ' ' + (p.symbolToken || '')}</b></span>
        </div>
        ${rulesLine(p)}
        ${p.reasons && p.reasons.length ? `<div class="reasons">${p.reasons.join(' · ')}</div>` : ''}
        ${lc ? `<div class="reasons">last close attempt: ${lc.status}${lc.error ? ' — ' + lc.error : ''}</div>` : ''}
        <button class="reload closebtn" data-close="${p.tokenId}" data-pair="${p.pair}" ${READ_ONLY ? 'disabled' : ''}>Close now</button>
      </article>`;
    }).join('');
    const df = d.defaults || {};
    $('#riskrecent').innerHTML = (d.recent || []).length
      ? 'Recent: ' + d.recent.slice(0, 5).map(r => `${new Date(r.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ${r.pair} ${r.status}${r.tx ? ' <a href="' + (EXPLORER || '') + '/tx/' + r.tx + '" target="_blank" rel="noopener">tx</a>' : ''}${r.error ? ' (' + r.error + ')' : ''}`).join(' · ')
      : `One Telegram message per event. Defaults for discovered positions: dump -${df.alertPct ?? 20}%/1h, close-now -${df.closePct ?? 50}% from entry, out of range ${df.outOfRangeMinutes ?? 120} min, liquidity -${df.tvlDropPct ?? 50}% vs 24h high. Auto-close only where switched on; proceeds go to the position's own wallet.`;
  } catch(e){ loadFailed('Risk guardian', e); }
}
async function postRule(body){
  const r = await fetch('/api/risk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'failed');
  await loadRisk();
}
document.addEventListener('click', async e => {
  if (e.target.id === 'auditaccept') {
    const shapes = (e.target.dataset.shapes || '').split(',').filter(Boolean);
    if (!shapes.length || !confirm('Accept these route shapes as known?\n' + shapes.join('\n'))) return;
    try { const r = await fetch('/api/audit/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shapes }) }); if (!(await r.json()).ok) throw new Error('refused'); await loadAudit(); } catch (err) { alert('Could not accept: ' + err.message); }
    return;
  }
  const b = e.target.closest('button[data-close]');
  if (b) {
    if (!confirm(`Close ${b.dataset.pair} #${b.dataset.close} now? All liquidity and fees are withdrawn to the position's wallet. The collector must be armed.`)) return;
    b.disabled = true; b.textContent = 'Closing…';
    try {
      const r = await fetch('/api/memecoins/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tokenId: b.dataset.close }) });
      const j = await r.json();
      const res = j.result || {};
      alert(j.ok ? `Closed: ${res.recovered || ''} tx ${res.tx || ''}` : `Not closed: ${res.error || j.error || 'see memecoin-guardian-log.json'}`);
    } catch (err) { alert('Close request failed: ' + err.message); }
    b.disabled = false; b.textContent = 'Close now';
    loadRisk();
    return;
  }
  const card = e.target.closest('article.meme'); if (!card || READ_ONLY) return;
  const line = card.querySelector('.rules'); const nftId = line && line.dataset.nft; if (!nftId) return;
  if (e.target.classList.contains('rk-toggle')){
    const on = !e.target.classList.contains('on');
    if (on && !confirm('Turn ON automatic closing for #' + nftId + '?\nWhen a close trigger (drawdown or out-of-range time) holds for 3 checks, the operator removes 100% of the liquidity and sends the tokens to the position\'s owner wallet. It needs the collector to be armed.\n\nThis also releases the alert-only latch for this position, which is what allows it to act rather than only warn.')) return;
    // Both fields, explicitly. The server no longer infers one from the other: a
    // latch that a neighbouring switch can release is not a latch.
    try { await postRule({ tokenId: nftId, autoClose: on, alertOnly: !on }); } catch(err){ alert('Could not save: ' + err.message); }
  } else if (e.target.classList.contains('rk-hold')){
    const on = !e.target.classList.contains('on');
    try { await postRule({ tokenId: nftId, hold: on }); } catch(err){ alert('Could not save: ' + err.message); }
  } else if (e.target.classList.contains('rk-th')){
    const k = e.target.dataset.k;
    const cur = e.target.textContent.replace(/[^0-9.]/g, '');
    const v = prompt(RULE_LABELS[k] || k, cur);
    if (v == null) return;
    try { await postRule({ tokenId: nftId, [k]: v.trim() === '' ? null : Number(v) }); } catch(err){ alert('Could not save: ' + err.message); }
  } else if (e.target.classList.contains('rk-entry')){
    const v = prompt('Entry price (token per quote) used for the drawdown rule:', e.target.textContent.replace(/[^0-9.]/g, ''));
    if (v == null || v.trim() === '') return;
    try { await postRule({ tokenId: nftId, entryPrice: Number(v) }); } catch(err){ alert('Could not save: ' + err.message); }
  }
});
if (PAGE !== 'analytics') { loadRisk(); setInterval(loadRisk, 30000); }
// === end risk-guardian ===

// === performance-attribution ===
// PnL vs HODL line for watched cards (same markup as the owner cards).
function pnlLine(p){
  if (p.pnlUsd == null) return '';
  return `<span class="rate pnl" tabindex="0">PnL vs HODL <b class="${p.pnlUsd < 0 ? 'neg' : ''}">${p.pnlUsd >= 0 ? '+' : '−'}${usd(Math.abs(p.pnlUsd))}${p.pnlPct != null ? ' (' + (p.pnlPct >= 0 ? '+' : '−') + Math.abs(p.pnlPct).toFixed(1) + '%)' : ''}</b>${p.pnlApprox ? ' ≈' : ''}${p.pnlSince ? ' · since ' + new Date(p.pnlSince).toLocaleDateString(undefined,{month:'short',day:'numeric'}) : ''}${pnlTip(p)}</span>`;
}

// The PnL tooltip is absolutely positioned under its label; near the right edge of
// the page it would run past the viewport and get cut off. Flip it to hang from the
// label's right edge when that happens (phones get a fixed bottom sheet via CSS).
document.addEventListener('mouseover', e => {
  const pnl = e.target.closest && e.target.closest('.pnl'); if (!pnl) return;
  const tip = pnl.querySelector('.tip'); if (!tip) return;
  tip.classList.remove('flip');
  const r = tip.getBoundingClientRect();
  if (r.width && r.right > window.innerWidth - 12 && pnl.getBoundingClientRect().right - r.width >= 8) tip.classList.add('flip');
});
document.addEventListener('focusin', e => { const pnl = e.target.closest && e.target.closest('.pnl'); if (pnl) pnl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });

let attribD = null;
const ATTRIB_PARTS = [
  ['fees', 'Fees', 'var(--neon-green, #39ff88)'],
  ['price', 'Price move', 'var(--neon-cyan, #22d3ee)'],
  ['flows', 'Flows', '#6ee7b7'],
  ['il', 'Impermanent loss', '#ff7a59'],
  ['staking', 'Staking', '#a78bfa'],
  ['vault', 'Vault split', 'var(--neon-gold, #f5c542)'],
  ['gas', 'Gas', '#94a3b8'],
];
async function loadAttribution(){
  try {
    const days = Number(($('#attribdays') || {}).value) || 30;
    const r = await fetch('/api/attribution?days=' + days);
    const d = await r.json(); noteOutcome('Performance attribution', r.status, d);
    if (!d.ok) return;
    attribD = d;
    renderAttribution();
  } catch(e){ loadFailed('Performance attribution', e); }
}
function attribScope(){
  const sel = $('#attribscope');
  const want = sel.value || 'book';
  const opts = [['book', chainLabel() ? 'All ' + chainLabel() + ' wallets' : 'All wallets']].concat((attribD.wallets || []).map(w => [w.key, w.label]));
  sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  sel.value = opts.some(o => o[0] === want) ? want : 'book';
  return sel.value === 'book' ? attribD.book : attribD.wallets.find(w => w.key === sel.value);
}
function renderAttribution(){
  const d = attribD;
  if (!d || PAGE !== 'analytics') return;
  $('#attribsec').hidden = false;
  const scope = attribScope();
  const T = scope.totals;
  // Nothing recorded for this window is not a row of zeros. A second chain
  // starts with no history at all, and printing $0.00 across every leg reads
  // as "nothing happened here" rather than "nothing was observed yet".
  const anyRecorded = (scope.rows || []).some(r =>
    ATTRIB_PARTS.some(([k]) => Number(r[k] || 0) !== 0) || Number(r.dv || 0) !== 0);
  if (!anyRecorded) {
    $('#attribtotal').innerHTML = '<span class="muted">History unavailable</span>';
    $('#attribstats').innerHTML = '<span class="muted">No value observations recorded for this wallet on this chain yet, so no fees, price move or impermanent loss can be attributed. This is missing history, not a zero result.</span>';
    $('#attribchart').innerHTML = '';
    $('#attriblegend').innerHTML = '';
    $('#attribtable').innerHTML = '';
    $('#attribnote').textContent = 'Attribution needs at least one recorded value sample. Nothing is substituted from another wallet or chain.';
    $('#attribpos') && ($('#attribpos').innerHTML = '');
    return;
  }
  const sgn = v => v == null ? '—' : (v < 0 ? '−' : '+') + usd(Math.abs(v));
  const cls = v => v == null ? '' : v < 0 ? 'neg' : '';
  $('#attribtotal').innerHTML = `<span class="${T.net < 0 ? 'neg' : ''}">${sgn(T.net)} net</span>`;
  $('#attribstats').innerHTML = ATTRIB_PARTS.map(([k, label]) => `<span><b class="${cls(T[k])}">${sgn(T[k])}</b> ${label.toLowerCase()}</span>`).join('') +
    `<span>value change <b class="${cls(T.dv)}">${sgn(T.dv)}</b></span>` + (T.incomplete ? `<span class="muted">${T.incomplete} day${T.incomplete === 1 ? '' : 's'} without a full value sample</span>` : '');
  // Stacked bars: positive parts up from zero, negative parts down.
  const rows = scope.rows;
  const W = 600, H = 170, padL = 6, padB = 18, top = 14;
  const maxPos = Math.max(1e-9, ...rows.map(r => ATTRIB_PARTS.reduce((s, [k]) => s + Math.max(0, r[k] || 0), 0)));
  const maxNeg = Math.max(0, ...rows.map(r => ATTRIB_PARTS.reduce((s, [k]) => s + Math.max(0, -(r[k] || 0)), 0)));
  const span = maxPos + maxNeg;
  const zeroY = top + (H - top - padB) * (maxPos / span);
  const scale = (H - top - padB) / span;
  const bw = (W - padL * 2) / rows.length;
  let svg = `<line x1="${padL}" x2="${W - padL}" y1="${zeroY}" y2="${zeroY}" stroke="rgba(255,255,255,.25)" stroke-width="1"/>`;
  rows.forEach((r, i) => {
    const x = padL + i * bw + bw * 0.15, w = bw * 0.7;
    let up = zeroY, down = zeroY;
    for (const [k, , color] of ATTRIB_PARTS) {
      const v = r[k] || 0;
      if (!v) continue;
      const h = Math.abs(v) * scale;
      if (v > 0) { up -= h; svg += `<rect x="${x}" y="${up}" width="${w}" height="${h}" fill="${color}" opacity="${r.exact ? .9 : .45}"><title>${r.day} ${k} ${sgn(v)}</title></rect>`; }
      else { svg += `<rect x="${x}" y="${down}" width="${w}" height="${h}" fill="${color}" opacity="${r.exact ? .9 : .45}"><title>${r.day} ${k} ${sgn(v)}</title></rect>`; down += h; }
    }
    if (rows.length <= 31 && (rows.length <= 10 || i % Math.ceil(rows.length / 10) === 0)) svg += `<text class="axis" x="${x + w / 2}" y="${H - 4}" text-anchor="middle">${dayLabel(r.day)}</text>`;
  });
  $('#attribchart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:170px">${svg}</svg>`;
  $('#attriblegend').innerHTML = '<span class="lhead">Per day:</span>' + ATTRIB_PARTS.map(([, label, color]) => `<span><i style="background:${color}"></i>${label}</span>`).join('') + '<span class="muted">faded bars: no full value sample that day, so no IL figure</span>';
  const recent = [...rows].reverse().filter(r => Math.abs(r.net) > 0.005 || r.exact).slice(0, 14);
  $('#attribtable').innerHTML = `<table class="etable">
    <tr><th class="l">Day</th>${ATTRIB_PARTS.map(([, l]) => `<th>${l}</th>`).join('')}<th>Value change</th><th>Net</th></tr>
    ${recent.map(r => `<tr><td class="l">${dayLabel(r.day)}</td>${ATTRIB_PARTS.map(([k]) => `<td class="u ${cls(r[k])}">${r[k] == null ? '<span class="muted">—</span>' : sgn(r[k])}</td>`).join('')}<td class="u ${cls(r.dv)}">${r.dv == null ? '<span class="muted">—</span>' : sgn(r.dv)}</td><td class="u ${cls(r.net)}"><b>${sgn(r.net)}</b></td></tr>`).join('')}
  </table>`;
  // Benchmarks.
  const B = ($('#attribscope').value === 'main' ? d.mainBenchmarks : d.benchmarks) || d.benchmarks;
  const pct = v => v == null ? '<span class="muted">—</span>' : `<span class="${v < 0 ? 'neg' : ''}">${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%</span>`;
  // A benchmark column needs a price history this instance actually records. Where
  // it keeps none for ETH or USDG, the columns are withheld rather than printed as
  // +0.00% — an absent history, not a measured flat market. The stablecoin column,
  // where it is shown, is a configured $1.00 baseline and says so on hover.
  const BA = d.benchmarkAssets || { eth: 'ETH', stable: 'USDG' };
  const hasEth = !!BA.eth;
  const stableTitle = esc(BA.stableBasis || 'a configured $1.00 baseline for a dollar stablecoin, not a measured market price');
  $('#benchtable').innerHTML = `<table class="etable">
    <tr><th class="l">Window</th><th>Portfolio</th>${hasEth ? `<th>Holding ${esc(BA.eth)}</th><th title="${stableTitle}">Holding ${esc(BA.stable)} <span class="muted">(baseline)</span></th>` : ''}<th>Staking NET</th>${hasEth ? `<th>vs ${esc(BA.eth)}</th>` : ''}<th>vs staking</th><th class="l">Note</th></tr>
    ${B.map(b => `<tr><td class="l">${b.windowDays}d</td><td class="u">${pct(b.portfolioPct)}</td>${hasEth ? `<td>${pct(b.ethPct)}</td><td>${pct(b.usdgPct)}</td>` : ''}<td>${pct(b.stakingPct)}</td>${hasEth ? `<td>${b.portfolioPct != null && b.ethPct != null ? pct(b.portfolioPct - b.ethPct) : '—'}</td>` : ''}<td>${b.portfolioPct != null && b.stakingPct != null ? pct(b.portfolioPct - b.stakingPct) : '—'}</td><td class="l muted">${esc(b.note || '')}</td></tr>`).join('')}
  </table>`;
  $('#benchnote').textContent = (d.history && d.history.bookSince ? `Book history since ${new Date(d.history.bookSince).toLocaleString()}; main wallet since ${d.history.mainSince ? new Date(d.history.mainSince).toLocaleDateString() : '—'}. Recorded transfers across the wallet boundary are netted out of the return; a window whose transfers cannot be netted, or whose value change no recorded transfer explains, shows no percentage at all.` : 'No value history yet.')
    + (BA.note ? ' ' + BA.note : hasEth ? ` The ${BA.stable} column is ${BA.stableBasis || 'a configured $1.00 baseline'}; the ${BA.eth} column is measured from recorded prices.` : '');
  // Per position.
  const P = ($('#attribscope').value === 'book' ? d.positions : d.positions.filter(p => p.key === $('#attribscope').value));
  const wl = k => k === 'main' ? (d.wallets.find(w => w.main) || {}).label || 'Main' : (d.wallets.find(w => w.key === k) || {}).label || shortA(k);
  $('#attribpos').innerHTML = P.length ? `<table class="etable">
    <tr><th class="l">Wallet</th><th class="l">Position</th><th>Value</th><th title="Uncollected fees now plus collects this collector recorded. Fees the wallet settled itself are chain-derived: see Claimed fees — read from chain.">Fees (uncollected + collector collects)</th><th>Fees today</th><th>Price + IL</th><th>PnL vs HODL</th><th class="l">Since</th></tr>
    ${P.map(p => `<tr><td class="l">${wl(p.key)}</td><td class="l">${p.pair} <span class="muted">#${String(p.tokenId).replace('v4-', '')} v${p.version}</span></td><td class="u">${usd(p.valueUsd)}</td><td class="u">${usd(p.fees)}</td><td class="u">${p.feesToday == null ? '<span class="muted">—</span>' : usd(p.feesToday)}</td><td class="u ${cls(p.priceAndIl)}">${sgn(p.priceAndIl)}</td><td class="u ${cls(p.pnlUsd)}"><b>${sgn(p.pnlUsd)}</b>${p.approx ? ' ≈' : ''}</td><td class="l muted">${p.since ? new Date(p.since).toLocaleDateString(undefined,{month:'short',day:'numeric'}) : '—'}</td></tr>`).join('')}
  </table>` : '<div class="enote">No open positions.</div>';
  $('#attribnote').textContent = `Exact: ${d.notes.exact.join(', ')}. Approximate: ${d.notes.approximate.join('; ')}. ${d.notes.incompleteDays}.`;
}
$('#attribscope') && $('#attribscope').addEventListener('change', renderAttribution);
$('#attribdays') && $('#attribdays').addEventListener('change', loadAttribution);
if (ANALYTICS) { loadAttribution(); setInterval(loadAttribution, 10 * 60 * 1000); }
// === /performance-attribution ===
// === weekly-digest-and-vault ===
// "Preview the weekly digest" link under the Performance note on the Analytics page.
(function () {
  if (typeof PAGE === 'undefined' || PAGE !== 'analytics') return;
  function addLink() {
    const note = document.querySelector('#perfnote');
    if (!note || document.querySelector('#digestlink')) return;
    const a = document.createElement('a');
    a.id = 'digestlink';
    a.href = '#';
    a.textContent = 'Preview the weekly Telegram digest';
    a.style.marginLeft = '10px';
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      let box = document.querySelector('#digestbox');
      if (!box) {
        box = document.createElement('pre');
        box.id = 'digestbox';
        box.style.cssText = 'white-space:pre-wrap;font-size:12px;margin-top:10px;padding:12px;border-radius:10px;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.1)';
        note.parentElement.appendChild(box);
      }
      box.textContent = 'Building…';
      try {
        const r = await fetch('/api/digest');
        const d = await r.json();
        box.textContent = d.ok ? `${d.text}\n\n(sent every Monday 09:00 · this week ${d.week}${d.lastSentWeek ? ` · last sent ${d.lastSentWeek}` : ' · not sent yet'})` : 'Could not build the digest: ' + d.error;
      } catch (err) {
        box.textContent = 'Could not build the digest: ' + err.message;
      }
    });
    note.appendChild(a);
  }
  // The note is filled by renderAnalytics(); poll briefly until it exists.
  let tries = 0;
  const t = setInterval(() => { addLink(); if (document.querySelector('#digestlink') || ++tries > 60) clearInterval(t); }, 500);
})();
// === end weekly-digest-and-vault ===
// === pool-scout-and-IL =================================================// Range advisor + IL forecast lines on every position card (owner and watched),
// added after each render by looking the card up through its NFT number, so
// the card templates themselves stay untouched. Data: /api/advisor.
let advisorD = null;
async function loadAdvisor(){
  if (PAGE === 'analytics') return;
  try { const r = await fetch('/api/advisor'); const d = await r.json(); noteOutcome('Range advisor', r.status, d); if (d.ok) { advisorD = d; decorateAdvisor(); } } catch(e){ loadFailed('Range advisor', e); }
}
function advisorLine(r){
  if (!r || !r.ranges) return r && r.status ? `<span class="rate advisor muted" title="Range advisor">range advisor: ${r.status}</span>` : '';
  const a = r.ranges.actual, t = r.ranges.tighter, w = r.ranges.wider;
  const pct = x => x == null ? '' : ` (${x >= 0 ? '+' : ''}${x.toFixed(0)}%)`;
  const cls = x => x != null && x >= 25 ? 'up' : x != null && x <= -25 ? 'down' : '';
  let line = `<span class="rate advisor" title="Fees the same capital would have earned over the last ${r.windowHours}h of this pool's swaps, scaled to 7 days; hourly resolution, approximate">` +
    `Your range: <b>${usd(a.fees7dUsd)}</b>/7d. Tighter: <b class="${cls(t.vsActualPct)}">${usd(t.fees7dUsd)}</b>${pct(t.vsActualPct)}. Wider: <b class="${cls(w.vsActualPct)}">${usd(w.fees7dUsd)}</b>${pct(w.vsActualPct)}` +
    ` → <b>${r.recommendation}</b>${r.status && r.status !== 'ok' ? ` <span class="muted">(${r.status})</span>` : ''}</span>`;
  const f = r.forecast;
  if (f) {
    const neg = f.net7dUsd < 0;
    line += `<span class="rate advisor ${neg ? 'warnline' : ''}" title="Expected fees = replay of the actual range; expected IL from a lognormal price at the pool's realised 7d volatility (${f.sigma7dPct.toFixed(0)}%); the quote token's USD price is held fixed">` +
      `Next 7d: <b>+${usd(f.fees7dUsd)}</b> fees, <b class="down">${usd(f.il7dUsd)}</b> IL = <b class="${neg ? 'down' : 'up'}">${f.net7dUsd >= 0 ? '+' : ''}${usd(f.net7dUsd)}</b> net${neg ? ' · ⚠️ IL > fees — not worth staying' : ''}${f.volCapped ? ` <span class="muted" title="Realised 7d volatility ${f.sigmaRaw7dPct.toFixed(0)}% is capped at 150% for the forecast">(vol capped)</span>` : ''}</span>`;
  }
  return line;
}
function decorateAdvisor(){
  if (!advisorD || !advisorD.results) return;
  const byNft = {};
  for (const r of Object.values(advisorD.results)) byNft[String(r.tokenId)] = r;
  for (const card of document.querySelectorAll('article.pos')) {
    const nft = card.querySelector('.nft');
    if (!nft) continue;
    const id = (nft.textContent.match(/#(\d+)/) || [])[1];
    const r = byNft[id];
    // The card now has two: the overview on its face and the full set inside
    // "View details". The range advisor is a comparison, so it belongs in the
    // details; fall back to whatever .comp exists for cards without a disclosure.
    const comp = card.querySelector('.posmore .comp') || card.querySelector('.comp');
    if (!comp || !r) continue;
    if (comp.dataset.advisorAt === String(advisorD.at)) continue; // already decorated with this data
    for (const old of comp.querySelectorAll('.advisor')) old.remove();
    comp.insertAdjacentHTML('beforeend', advisorLine(r));
    comp.dataset.advisorAt = String(advisorD.at);
  }
}
// Re-decorate after the main list and the watched wallets render (cards are rebuilt from scratch).
new MutationObserver(() => { if (advisorD) decorateAdvisor(); }).observe(document.body, { childList: true, subtree: true });
if (PAGE !== 'analytics') { loadAdvisor(); setInterval(loadAdvisor, 10 * 60 * 1000); }
// === end pool-scout-and-IL ===
// === token-health-and-approvals ===
// Risk badge per Portfolio row from /api/token-health. Decorates the rendered
// table by DOM lookup (rows are matched by the token link's address), so the
// Portfolio renderer itself stays untouched; re-applied on every re-render.
let tokenHealthD = null;
function decorateTokenHealth(){
  if (!tokenHealthD || PAGE !== 'dashboard') return;
  const by = tokenHealthD.byAddress || {};
  for (const a of document.querySelectorAll('#baltable td:first-child a[href*="/token/"]')){
    if (a.parentElement.querySelector('.thbadge')) continue;
    const m = a.getAttribute('href').match(/\/token\/(0x[0-9a-fA-F]{40})/);
    const h = m && by[m[1].toLowerCase()];
    if (!h) continue;
    const b = document.createElement('span');
    b.className = 'thbadge th-' + h.level;
    b.textContent = h.badge;
    b.title = `${h.label}: ${(h.notes || []).join(', ')}` + (h.holders != null ? ` · ${h.holders.toLocaleString('en-US')} holders` : '') + (h.ageDays != null ? ` · ${Math.round(h.ageDays)} days old` : '') + (h.verified === false ? ' · unverified' : '');
    a.parentElement.appendChild(b);
  }
}
async function loadTokenHealth(){
  try { const r = await fetch('/api/token-health'); const d = await r.json(); noteOutcome('Token health', r.status, d); if (d.ok) { tokenHealthD = d; decorateTokenHealth(); } } catch(e){ loadFailed('Token health', e); }
}
if (PAGE === 'dashboard'){
  const bt = document.getElementById('baltable');
  if (bt) new MutationObserver(() => decorateTokenHealth()).observe(bt, { childList: true });
  loadTokenHealth();
  setInterval(loadTokenHealth, 10 * 60 * 1000);
}
// === end token-health-and-approvals ===

/* ===========================================================================
   Long-table disclosure — view only.
   ---------------------------------------------------------------------------
   Long tables get a search box and, past a second threshold, show a first page
   with a control to reveal the rest.

   This is deliberately a DOM-only filter. Every CSV in this file is built from
   the data arrays (filteredRows(), lotsD, the tax fetch), and every total is
   computed before a row is ever rendered, so hiding a <tr> cannot change an
   exported figure or a displayed sum. The on-page note states that, because a
   filter that silently narrowed a total would be exactly the kind of quiet
   wrongness this dashboard is supposed to avoid.

   Tables are re-rendered by innerHTML in several places, so rather than hook
   every render path this observes the document and re-applies. Each control bar
   is tied to its table by a data attribute and rebuilt when the table changes.
   =========================================================================== */
(function longTableDisclosure(){
  const SEARCH_FROM = 12;   // show the search box past this many body rows
  const PAGE        = 12;   // show this many before "show the rest"
  let uid = 0;

  const bodyRows = (table) =>
    Array.from(table.rows).filter(r =>
      !r.querySelector('th') && !(r.parentElement && r.parentElement.tagName === 'TFOOT'));

  function apply(bar, table){
    const rows  = bodyRows(table);
    const term  = bar._input ? bar._input.value.trim().toLowerCase() : '';
    const all   = bar._expanded || !!term;
    let shown = 0;
    for (const r of rows){
      const hit = !term || r.textContent.toLowerCase().includes(term);
      const vis = hit && (all || shown < PAGE);
      r.hidden = !vis;
      if (hit) shown++;
    }
    const visible = rows.filter(r => !r.hidden).length;
    bar._count.textContent = term
      ? `${visible} of ${rows.length} rows match`
      : visible < rows.length ? `Showing ${visible} of ${rows.length} rows` : `${rows.length} rows`;
    bar._none.hidden = !(term && visible === 0);
    const hiddenByPage = !term && !bar._expanded && rows.length > PAGE;
    bar._more.hidden = !hiddenByPage;
    bar._more.textContent = `Show all ${rows.length}`;
  }

  function build(table){
    const wrap = table.closest('.etablewrap') || table.parentElement;
    if (!wrap || !wrap.parentElement) return;
    const rows = bodyRows(table);
    if (rows.length < SEARCH_FROM){
      const block = wrap.closest('.tblock');
      if (block){
        block.parentElement.insertBefore(wrap, block);
        block.remove();   // takes the bar and the note with it
      }
      delete table.dataset.tfid;
      return;
    }
    if (!table.dataset.tfid) table.dataset.tfid = 'tf' + (++uid);
    const id = table.dataset.tfid;

    // The controls live in a block with the table rather than beside it. The
    // wrapper may sit in a grid (Portfolio places its table in a named area),
    // and loose siblings would be laid out somewhere else entirely.
    let block = wrap.closest('.tblock');
    if (!block){
      block = document.createElement('div');
      block.className = 'tblock';
      wrap.parentElement.insertBefore(block, wrap);
      block.appendChild(wrap);
    }

    // One block, one set of controls. Looking the bar up by the table's id meant a
    // re-rendered table -- innerHTML replaces the element, so the id goes with it --
    // found nothing and built another, while the old bar stayed behind as a sibling
    // of the table rather than inside it. Every refresh added one, which is how the
    // page came to carry twenty-one identical "Filter rows" boxes. So the bar is
    // found by what it is, not by which table it was built for, and any extra ones
    // left behind by earlier renders are cleared out here.
    const bars = block.querySelectorAll('.tfilter');
    for (let i = 1; i < bars.length; i++) bars[i].remove();
    const notes = block.querySelectorAll('.tscope');
    for (let i = 1; i < notes.length; i++) notes[i].remove();
    let bar = bars[0] || null;
    if (bar && bar.dataset.tfilter !== id){
      // Same controls, new table underneath: re-point them instead of rebuilding,
      // so the term someone has typed survives the refresh.
      bar.dataset.tfilter = id;
      const note = block.querySelector('.tscope');
      if (note) note.dataset.tfilter = id + '-note';
      const inputId = id + '-q';
      const label = bar.querySelector('label');
      if (label) label.setAttribute('for', inputId);
      if (bar._input) bar._input.id = inputId;
    }
    if (!bar){
      bar = document.createElement('div');
      bar.className = 'tfilter';
      bar.dataset.tfilter = id;
      const inputId = id + '-q';
      bar.innerHTML =
        `<label for="${inputId}">Filter rows</label>` +
        `<input type="search" id="${inputId}" placeholder="Type to narrow this view" autocomplete="off">` +
        `<span class="tcount" role="status" aria-live="polite"></span>` +
        `<span class="tnone" hidden>No rows match</span>` +
        `<button type="button" class="tmore"></button>`;
      const scope = document.createElement('p');
      scope.className = 'tscope';
      scope.dataset.tfilter = id + '-note';
      scope.textContent = 'Filtering changes this view only. Totals and CSV exports always use the complete data set.';
      block.insertBefore(bar, wrap);
      block.insertBefore(scope, wrap);
      bar._input = bar.querySelector('input');
      bar._count = bar.querySelector('.tcount');
      bar._none  = bar.querySelector('.tnone');
      bar._more  = bar.querySelector('.tmore');
      bar._expanded = false;
      // Bound to bar._table, not to `table`: the listeners outlive the table they
      // were created for, and a closure over it would keep filtering a detached one.
      bar._input.addEventListener('input', () => apply(bar, bar._table));
      bar._more.addEventListener('click', () => { bar._expanded = true; apply(bar, bar._table); });
    } else {
      // The table was re-rendered underneath us: page state resets, the typed
      // term does not, so a refresh does not throw away what someone is reading.
      bar._expanded = false;
    }
    bar._table = table;
    apply(bar, table);
  }

  function scan(){
    for (const t of document.querySelectorAll('.etablewrap table, table.etable')) {
      try { build(t); } catch {}
    }
  }

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
  else schedule();
  new MutationObserver((recs) => {
    // Ignore our own writes, or we would loop.
    for (const r of recs){
      const t = r.target;
      if (t && t.closest && t.closest('.tfilter')) continue;
      if (r.type === 'attributes' && r.attributeName === 'hidden') continue;
      return schedule();
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
