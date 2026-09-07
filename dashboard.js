const $ = s => document.querySelector(s);
const PAGE = location.pathname.replace(/\/+$/, '') === '/analytics' ? 'analytics' : 'dashboard';
document.body.classList.add('page-' + PAGE);
document.title = PAGE === 'analytics' ? 'LP analytics' : document.title;
$('#nav-' + (PAGE === 'analytics' ? 'analytics' : 'dash')).classList.add('here');
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

// Pool statistics line for a card (from the scanner via the server): TVL,
// 24h volume and fees, fee APR, and the sibling pools of the same pair.
const usdK = n => n == null ? '—' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'k' : usd(n);
function poolLine(p){
  const q = p.pool;
  if (!q) return '';
  const own = q.missing ? '<span class="muted">pool not on the scanner</span>'
    : `pool TVL <b>${usdK(q.tvl)}</b> · 24h vol <b>${usdK(q.vol24h)}</b> · fees <b>${usdK(q.fees24h)}</b>${q.aprPct != null ? ` · ~<b>${q.aprPct.toFixed(0)}%</b> fee APR` : ''}${q.stale ? ' <span class="muted" title="scanner data is stale">(stale)</span>' : ''}`;
  const sib = (q.siblings || []).length
    ? ` · <span class="sibs" title="Other pools for this pair, by 24h fee APR">others: ${q.siblings.map(x => `<span title="TVL ${usdK(x.tvl)} · 24h fees ${usdK(x.fees24h)}">${x.feePct != null ? x.feePct + '%' : x.name} ${x.version}${x.tag ? ' ' + x.tag : ''} <b class="${(x.aprPct || 0) > (q.aprPct || 0) ? '' : 'muted'}">${x.aprPct == null ? '—' : x.aprPct.toFixed(0) + '%'}</b></span>`).join(' · ')}</span>`
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
// #scope=all / #scope=0x… picks the Portfolio scope from the URL (a shareable link).
try { const h = new URLSearchParams(location.hash.slice(1)).get('scope'); if (h) setPref('portfolio:scope', h.toLowerCase()); } catch(e){}

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

let allSeriesD = null;
async function loadAllSeries(){
  try { const r = await fetch('/api/portfolio-all'); const d = await r.json(); if (d.ok && d.points.length) { allSeriesD = d; if (lastPortfolio) renderPortfolio(); } } catch(e){}
}

async function loadBalances(){
  try{
    const r = await fetch('/api/portfolio');
    const d = await r.json();
    if (r.status === 503){ setTimeout(loadBalances, 15000); return; } // first pass still running
    if (!d.ok || !d.rows || !d.rows.length) return;
    lastPortfolio = d;
    $('#balpanel').hidden = false;
    renderPortfolio();
  }catch(e){ /* panel stays hidden */ }
}

let lastMain = null;
/**
 * The three leading tiles (held, in positions, uncollected fees) follow the
 * Portfolio scope: the owner alone, one watched wallet, or every wallet
 * together. Collectable, PnL and projection tiles are the collector's own
 * and always describe the owner wallet.
 */
function renderHeadline(){
  const scope = $('#pfscope').hidden ? 'owner' : pfScope();
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
    const link = `<a href="${EXPLORER || ''}/address/${m.owner}" target="_blank" rel="noopener" title="${m.owner}">${ownerLabel()} <span class="muted">${shortA(m.owner)}</span></a>`;
    const ownTotal = m.totals.liquidityUsd + m.totals.feesUsd + (pf ? pf.totals.walletUsd : 0);
    $('#ownerhead').innerHTML = `${link}<span class="wtotal">total <b>${usd(ownTotal)}</b></span>` +
      (pf ? `<span>tokens <b>${usd(pf.totals.walletUsd)}</b>${pf.totals.unpricedCount ? ` <span class="muted">+${pf.totals.unpricedCount} unpriced</span>` : ''}</span>` : '') +
      `<span>in pools <b>${usd(m.totals.liquidityUsd)}</b></span><span>uncollected <b>${usd(m.totals.feesUsd)}</b></span>` +
      `<span><b>${m.totals.count}</b> open${m.totals.idle ? ` · <span class="idle">${m.totals.idle} idle</span>` : ''}</span>`;
    // Section header: this wallet alone, or everything, depending on the picker.
    const W = lastWatchForPf && lastWatchForPf.totals;
    if (scope === 'owner') {
      $('#watchtitle').textContent = 'Positions';
      $('#watchtotal').textContent = usd(ownTotal);
    } else if (scope === 'all' && W) {
      $('#watchtitle').textContent = 'Positions';
      $('#watchtotal').textContent = usd(ownTotal + W.totalUsd);
      $('#watchstats').innerHTML = `<span>${W.wallets + 1} wallets</span><span>tokens in wallets <b>${usd((pf ? pf.totals.walletUsd : 0) + W.walletUsd)}</b></span><span>in pools <b>${usd(m.totals.liquidityUsd + W.liquidityUsd)}</b></span><span>uncollected fees <b>${usd(m.totals.feesUsd + W.feesUsd)}</b></span>`;
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
  if (own && !pf) { if (scope === 'owner') { $('#networth').textContent = '—'; nwp.hidden = true; } return; } // owner tokens not valued yet
  const wallet = (own && pf ? pf.totals.walletUsd : 0) + sel.reduce((s, w) => s + ((w.holdings && w.holdings.walletUsd) || 0), 0);
  const unpriced = (own && pf ? pf.totals.unpricedCount : 0) + sel.reduce((s, w) => s + ((w.holdings && w.holdings.unpricedCount) || 0), 0);
  $('#networth').textContent = usd(liq + fees + wallet);
  nwp.hidden = false;
  nwp.innerHTML = `positions <b>${usd(liq)}</b> · fees <b>${usd(fees)}</b> · tokens in wallet <b>${usd(wallet)}</b>` + (unpriced ? ` · ${unpriced} unpriced` : '');
}

function renderPortfolio(){
  const d = lastPortfolio;
  if (!d) return;
  fillScopeSelect();
  renderHeadline();
  const scope = $('#pfscope').hidden ? 'owner' : pfScope();
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
    (totals.unpricedCount ? `<span>${totals.unpricedCount} token${totals.unpricedCount === 1 ? '' : 's'} unpriced</span>` : '');
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
  const link = x => x.native ? x.symbol : `<a href="${d.explorer}/token/${x.address}${holder ? `?holder_address_hash=${holder}` : ''}" target="_blank" rel="noopener">${x.symbol}</a>`;
  $('#baltable').innerHTML = `<table class="etable">
    <tr><th>Token</th><th>Wallet</th><th>In pools</th><th>Fees</th><th>Total</th><th>Price</th><th>≈ USD</th><th>Share</th><th>24h</th></tr>
    ${main.map(x => `<tr>
      <td>${link(x)}</td>
      <td>${q(x.wallet)}</td>
      <td>${q(x.pools)}</td>
      <td>${q(x.fees)}</td>
      <td><b>${amount(x.total)}</b></td>
      <td>${x.price == null ? '<span class="unpriced">no pool</span>' : x.via ? `<span title="Priced as ${x.via}, redeemable 1:1">$${price(x.price)} <span class="muted">as ${x.via}</span></span>` : '$' + price(x.price)}</td>
      <td class="u">${x.thin ? `<span class="approx" title="The pool this is priced from holds only ${usd(x.depthUsd)} of ${x.address ? 'WETH or USDG' : ''}; selling would move it. Treat as a quote, not cash.">≈</span>` : ''}${usd(x.usd)}</td>
      <td>${x.share == null ? '—' : x.share.toFixed(1) + '%'}</td>
      ${chg(x)}
    </tr>`).join('')}</table>` + (dust || showDust
      ? `<div class="enote"><a href="#" id="dusttoggle">${showDust ? 'hide' : 'show'} ${showDust ? 'dust and unpriced tokens' : dust + ' token' + (dust === 1 ? '' : 's') + ' under $1 or unpriced'}</a></div>` : '');
  const dt = $('#dusttoggle');
  if (dt) dt.addEventListener('click', e => { e.preventDefault(); setPref('portfolio:dust', showDust ? '0' : '1'); renderPortfolio(); });
  const scopeNote = scope === 'owner' ? '' : ` Showing ${label}; the collectable, PnL and projection tiles cover the main wallet only.${series.length >= 2 ? ' The chart is the hourly total for this selection.' : ' The value chart appears after a few hours of history.'}`;
  $('#pnote').textContent = (series.length >= 2
    ? `Total = wallet + positions + uncollected fees, at current prices. Chart is hourly since ${new Date(series[0].t).toLocaleDateString(undefined,{month:'short',day:'numeric'})}. Prices come from the deepest WETH or USDG pool for each token; 24h change once a day of history exists.`
    : 'Total = wallet + positions + uncollected fees, at current prices. Prices come from the deepest WETH or USDG pool for each token; ≈ marks a value larger than that pool holds.' + (scope === 'owner' ? ' The value chart appears after a few hours of history.' : '')) + scopeNote;
}
$('#pfscope').addEventListener('change', e => { setPref('portfolio:scope', e.target.value); renderPortfolio(); if (lastWatchForPf) renderWatch(lastWatchForPf); });

/* ---- incentive rewards (Merkl) ---- */
async function loadRewards(){
  try{
    const r = await fetch('/api/rewards');
    const d = await r.json();
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
  }catch(e){ $('#merklchip').hidden = true; }
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
    <text class="axis" x="${W-PR+6}" y="${(Y(vmax)+3).toFixed(1)}">${usd(vmax)}</text>
    <line class="grid" x1="${PL}" x2="${W-PR}" y1="${Y(vmin).toFixed(1)}" y2="${Y(vmin).toFixed(1)}"/>
    <text class="axis" x="${W-PR+6}" y="${(Y(vmin)+3).toFixed(1)}">${usd(vmin)}</text>
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

// Per-month totals: collects, exact token amounts by symbol, and USD at
// current prices. Close events are included — fees taken on a close are still
// fees earned — matching the headline total.
function monthSummary(rows){
  const m = new Map();
  for (const r of rows){
    if (!r.t) continue;
    const k = monthKey(r.t);
    if (!m.has(k)) m.set(k, { key: k, count: 0, usd: 0, weth: 0, unpriced: 0, approx: 0, tokens: new Map() });
    const o = m.get(k);
    o.count++;
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
    <tr><th>Month</th><th>Collects</th><th>Fees</th><th>≈ USD</th>${weth ? '<th>≈ WETH</th>' : ''}</tr>
    ${months.map(m => `<tr class="mrow${m.key === monthFilter ? ' on' : ''}" data-m="${m.key}">
      <td>${monthLabel(m.key)}</td>
      <td>${m.count}</td>
      <td class="wrap">${[...m.tokens].filter(([,v]) => v > 0).map(([sym, v]) => amount(v) + ' ' + sym).join(' + ') || '—'}</td>
      <td class="u">${m.approx ? '<span class="approx">≈</span>' : ''}${usd(m.usd)}${m.unpriced ? ` <span class="unpriced" title="Collects in pairs no longer held have no current price and are not in the USD figure">${m.unpriced} unpriced</span>` : ''}${m.approx ? ` <span class="unpriced" title="No price record from the time of these collects; valued at today\'s prices">${m.approx} at today\'s prices</span>` : ''}</td>
      ${weth ? `<td>${m.weth.toFixed(4)}</td>` : ''}
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
  const weth = wethSum ? ' · ≈' + wethSum.toFixed(4) + ' WETH' : '';
  $('#etotal').textContent = usd(total) + weth + (monthFilter ? ' · ' + monthLabel(monthFilter) : '');
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
    <tr><th>When</th><th>Position</th><th>Fees</th><th>≈ USD</th><th>Tx</th></tr>
    ${recent.map(r => `<tr>
      <td>${r.t ? new Date(r.t).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'}</td>
      <td>${r.pair || '?'} <span class="mono">#${r.tokenId}</span>${r.principal ? ' (close)' : ''}</td>
      <td>${r.f0 != null ? amount(r.f0) + ' ' + r.sym0 + ' + ' + amount(r.f1) + ' ' + r.sym1 : '—'}</td>
      <td class="u">${r.locked ? '' : '<span class="approx" title="No price record from the time of this collect; valued at today\'s prices">≈</span>'}${usd(r.usd)}</td>
      <td><a href="${histD.explorer}/tx/${r.tx}" target="_blank" rel="noopener">${r.tx.slice(0,10)}…</a></td>
    </tr>`).join('')}</table>` : '';
}

function downloadCsv(){
  const head = 'time,block,tokenId,pair,fee0,symbol0,fee1,symbol1,usd,price_basis,weth_equivalent,weth_usd_at_basis,includes_principal_withdrawal,tx';
  const lines = filteredRows().map(r => [
    r.t ? new Date(r.t).toISOString() : '', r.block, r.tokenId, r.pair || '',
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
    const d = await r.json();
    if (!d.ok) return;
    $('#earnings').hidden = false;
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
    $('#enote').textContent = 'Fees only — principal from closed positions is excluded.' + basis
      + (d.backfilled ? ' Includes full pre-collector history via Blockscout.' : d.backfilling ? ' Historical backfill in progress…' : '')
      + (d.scanning ? ' Scan catching up…' : '');
  }catch(e){ /* panel just stays hidden */ }
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
async function loadDaily(){
  try{
    const r = await fetch('/api/daily');
    const d = await r.json();
    if (!d.ok || !d.hours.length) return;
    dailyD = d;
    renderDaily();
    renderAnalytics();
  }catch(e){ /* panel stays hidden */ }
}

/* ---- analytics page: staking, performance, taxes ---- */
let stakingD = null;
async function loadStaking(){
  try {
    const r = await fetch('/api/staking');
    const d = await r.json();
    if (!d.ok) return;
    stakingD = d;
    renderStaking();
    renderAnalytics();
  } catch(e){}
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
    ev.push({ t: r.t, type: 'LP fees', what: r.pair + (r.principal ? ' (on close)' : ''), amounts: `${amount(r.f0)} ${r.sym0} + ${amount(r.f1)} ${r.sym1}`, usd: r.usd, approx: r.usd != null && !r.locked, tx: r.tx || '' });
  }
  for (const t of (stakingD && stakingD.tokens) || []){
    for (const e of t.events || []) ev.push({ t: e.t, type: 'Staking reward', what: t.label, amounts: `${amount(e.amount)} ${t.symbol}`, usd: e.usd, approx: !!e.approx, tx: '' });
  }
  return ev.sort((a, b) => a.t - b.t);
}

let treasuryD = null;
async function loadTreasury(){
  try { const r = await fetch('/api/treasury'); const d = await r.json(); if (d.ok) { treasuryD = d; renderVault(); renderAnalytics(); } } catch(e){}
}
function renderVault(){
  const d = treasuryD;
  if (!d) return;
  $('#vaultsec').hidden = false;
  $('#vaulttotal').textContent = usd(d.totalSplitUsdg);
  const tile = (n, l, cls = '') => `<div class="stat"><div class="n sm ${cls}">${n}</div><div class="l">${l}</div></div>`;
  $('#vaultgrid').innerHTML =
    tile(usd(d.totalSplitUsdg), 'Split to the vault, all time', 'fees') +
    tile(d.balanceUsdg == null ? '—' : usd(d.balanceUsdg), 'Vault balance (USDG)') +
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
    ? `Treasury account ${d.tba}. ${d.pct}% of every wallet's swept USDG goes to the vault at collect time; the rest goes to the wallet. Ledger: /fee-split-ledger.json.`
    : 'No treasury address configured yet (treasuryTBA in config.json). Deploy the vault, set the address, and splits start with the next collect.';
}

let watchForAnalytics = null;
async function loadWatchForAnalytics(){
  try { const r = await fetch('/api/watch'); const d = await r.json(); if (d && d.ok) { watchForAnalytics = d; renderAnalytics(); } } catch(e){}
}
function renderEarnedByWallet(){
  const rows = [];
  if (dailyD){
    const m = dailyModel(dailyD);
    const now = Date.now();
    const sum = days => m.all.filter(x => now - new Date(x.key + 'T12:00:00').getTime() <= days * 86400000 + 43200000).reduce((s, x) => s + x.total, 0);
    const today = (m.all.find(x => x.key === dayKey(now)) || {}).total || 0;
    rows.push({ name: ownerName(), today, d7: sum(7), d30: sum(30), all: m.all.reduce((s, x) => s + x.total, 0), since: m.all.length ? dayLabel(m.all[0].key) : '' });
  }
  for (const w of (watchForAnalytics && watchForAnalytics.wallets) || []){
    if (!w.ok || !w.earned) continue;
    rows.push({ name: walletName(w), today: w.earned.today, d7: w.earned.d7, d30: w.earned.d30, all: w.earned.all, since: w.earned.since ? dayLabel(w.earned.since) : '' });
  }
  if (!rows.length) return;
  $('#walletearn').innerHTML = `<table class="etable">
    <tr><th class="l">Earned by wallet</th><th>Today</th><th>7 days</th><th>30 days</th><th>All tracked</th><th class="l">Tracking since</th></tr>
    ${rows.map(r => `<tr><td class="l">${r.name}</td><td class="u">${usd(r.today)}</td><td class="u">${usd(r.d7)}</td><td class="u">${usd(r.d30)}</td><td class="u">${usd(r.all)}</td><td class="l muted">${r.since}</td></tr>`).join('')}
  </table>`;
}

function renderAnalytics(){
  renderEarnedByWallet();
  if (PAGE !== 'analytics' || !histD) return;
  const ev = incomeEvents();
  // -- Income for taxes: by year, then by month --
  const byMonth = new Map();
  for (const e of ev){
    const k = monthKey(e.t);
    if (!byMonth.has(k)) byMonth.set(k, { key: k, lp: 0, lpN: 0, stake: 0, stakeN: 0, approx: 0, unpriced: 0 });
    const o = byMonth.get(k);
    if (e.type === 'LP fees') { o.lpN++; if (e.usd == null) o.unpriced++; else { o.lp += e.usd; if (e.approx) o.approx++; } }
    else { o.stakeN++; o.stake += e.usd || 0; if (e.approx) o.approx++; }
  }
  // Vault splits by month, from the split ledger: money that left the wallets for the treasury.
  const vaultBy = (treasuryD && treasuryD.byMonth) || {};
  for (const k of Object.keys(vaultBy)) if (!byMonth.has(k)) byMonth.set(k, { key: k, lp: 0, lpN: 0, stake: 0, stakeN: 0, approx: 0, unpriced: 0 });
  for (const m of byMonth.values()) m.vault = vaultBy[m.key] || 0;
  const months = [...byMonth.values()].sort((a, b) => b.key.localeCompare(a.key));
  const years = new Map();
  for (const m of months){ const y = m.key.slice(0,4); if (!years.has(y)) years.set(y, { y, lp: 0, stake: 0, lpN: 0, stakeN: 0, vault: 0 }); const o = years.get(y); o.lp += m.lp; o.stake += m.stake; o.lpN += m.lpN; o.stakeN += m.stakeN; o.vault += m.vault; }
  const grand = ev.reduce((s, e) => s + (e.usd || 0), 0);
  $('#taxsec').hidden = false;
  $('#taxtotal').textContent = usd(grand);
  const mlabel = k => new Date(k + '-15T12:00:00').toLocaleDateString(undefined, { month: 'long' });
  let rows = '';
  for (const y of [...years.values()].sort((a, b) => b.y.localeCompare(a.y))){
    rows += `<tr class="year"><td class="l">${y.y}</td><td>${y.lpN}</td><td class="u">${usd(y.lp)}</td><td>${y.stakeN}</td><td class="u">${usd(y.stake)}</td><td class="u">${usd(y.lp + y.stake)}</td><td>${y.vault ? usd(y.vault) : '—'}</td></tr>`;
    for (const m of months.filter(m => m.key.startsWith(y.y))){
      rows += `<tr><td class="l">&nbsp;&nbsp;${mlabel(m.key)}</td><td>${m.lpN}</td><td class="u">${m.approx ? '<span class="approx" title="Some collects valued at today\'s prices">≈</span>' : ''}${usd(m.lp)}${m.unpriced ? ` <span class="unpriced">${m.unpriced} unpriced</span>` : ''}</td><td>${m.stakeN || ''}</td><td class="u">${m.stakeN ? usd(m.stake) : '—'}</td><td class="u">${usd(m.lp + m.stake)}</td><td>${m.vault ? usd(m.vault) : '—'}</td></tr>`;
    }
  }
  $('#taxtable').innerHTML = `<table class="etable">
    <tr><th class="l">Period</th><th>Collects</th><th>LP fee income</th><th>Rebases</th><th>Staking income</th><th>Total income</th><th title="Share of swept USDG sent to the LOKOVault treasury (already included in the income figures)">Vault split</th></tr>${rows}</table>`;

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
  $('#perfnote').textContent = `Collected = cash actually swept; earned = accrual between snapshots. ${ev.length} income events on record.`;
}

// Tax CSV: one row per income event, USD at receipt.
$('#taxcsv').addEventListener('click', async e => {
  e.preventDefault();
  const ev = incomeEvents();
  let ledger = [];
  try { ledger = await (await fetch('/fee-split-ledger.json')).json(); } catch(e){}
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [['date_utc','type','description','amounts','usd_at_receipt','price_basis','tx_hash','vault_split_usdg'].join(',')];
  for (const x of ev) lines.push([new Date(x.t).toISOString(), x.type, x.what, x.amounts, x.usd == null ? '' : x.usd.toFixed(2), x.usd == null ? 'unpriced' : x.approx ? 'current price' : 'at receipt', x.tx, ''].map(q).join(','));
  // One row per recorded vault split (the treasury's share of a pass's swept USDG).
  for (const r of ledger) if (r.status !== 'failed' && r.splitUsdg) lines.push([r.timestamp, 'Vault split', `${r.wallet} · ${r.pair || ''} · ${r.splitPct}% of ${r.totalCollectedUsdg} USDG`, `${r.splitUsdg} USDG`, Number(r.splitUsdg).toFixed(2), 'at receipt', r.splitTxHash || '', Number(r.splitUsdg).toFixed(2)].map(q).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'lp-income-' + new Date().toISOString().slice(0,10) + '.csv'; a.click();
});

// Collected per local day, from the collects history (cash actually swept).
function collectedByDay(){
  const by = new Map();
  for (const r of historyRows){ if (!r.t || r.usd == null) continue; const k = dayKey(r.t); by.set(k, (by.get(k) || 0) + r.usd); }
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
    ${row('Fees collected' + (L.collects ? ' · ' + L.collects + ' collect' + (L.collects === 1 ? '' : 's') : ''), L.collected)}
    ${row('Principal withdrawn', L.withdrawn)}
    ${row('Deposited' + (L.adds ? ' · ' + L.adds + ' add' + (L.adds === 1 ? '' : 's') : ''), L.deposited, true)}
    <tr class="sum"><td>Profit vs holding</td><td class="n${p.pnlUsd < 0 ? ' neg' : ''}">${sign(p.pnlUsd)}</td></tr>
  </table>
  <div class="note">Fees earned ${usd(feesTotal)}; ${holdCost < 0 ? 'holding the deposit instead would be worth ' + usd(-holdCost) + ' more' : 'the pool balance is also ' + usd(holdCost) + ' ahead of holding'}. All legs at today\'s prices${p.pnlApprox ? '; deposit history is missing a recent change' : ''}${p.pnlSource === 'rpc' ? ' (history read from the chain)' : p.pnlSource === 'blockscout' ? ' (history from Blockscout until the chain scan reaches the mint)' : ''}.</div></span>`;
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
  $('#armbtn').hidden = !!armed;
  $('#lockbtn').hidden = !armed;
  if (armed) $('#armform').hidden = true;
}

function render(d){
  lastRender = d;
  EXPLORER = d.explorer || null;
  $('#owner').textContent = d.owner.slice(0,6) + '…' + d.owner.slice(-4);
  $('#blockinfo').textContent = 'block ' + d.blockNumber.toLocaleString('en-US')
    + (d.wethUsd ? ' · ETH ' + usd(d.wethUsd) : '');
  $('#pulse').className = 'pulse' + (d.cached ? ' stale' : '');

  renderUnlock(d.unlock);
  const gas = $('#gaschip');
  if (d.operatorGas){
    gas.hidden = false;
    gas.className = 'chip' + (d.operatorGas.low ? ' warn' : '');
    gas.innerHTML = 'Operator gas <b>' + d.operatorGas.eth.toFixed(4) + ' ETH</b>'
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

  $('#list').innerHTML = d.positions.map(p => {
    const v = orient(p);
    const near = p.inRange && (v.toUpper < NEAR || v.toLower < NEAR);
    const cls = 'pos' + (p.inRange ? (near ? ' near' : '') : ' out');

    let state = 'In range';
    if (!p.inRange) state = v.above ? 'Above range · idle' : 'Below range · idle';
    else if (near) state = 'Near the edge';

    // Marker sits at the tick fraction, which is already log-spaced -- so a
    // linear position on the rail is a true log position on price.
    const pct = (v.railPos * 100).toFixed(2);

    // Keep the price flag on-page at the extremes instead of letting it hang
    // off the edge.
    const flagCls = v.railPos < 0.12 ? ' left' : v.railPos > 0.88 ? ' right' : '';
    const flagPos = v.railPos < 0.12 ? 'left:0' : v.railPos > 0.88 ? 'left:100%' : `left:${pct}%`;

    // For an idle position the useful number is the move needed to re-enter.
    const reenter = p.inRange ? null
      : v.above
        ? { dir: 'fall', pct: (1 - v.upper / v.current) * 100 }
        : { dir: 'rise', pct: (v.lower / v.current - 1) * 100 };

    const idleNote = reenter
      ? `<span class="h idle">needs a ${reenter.pct.toFixed(1)}% ${reenter.dir} to start earning</span>`
      : '';
    const lowH = p.inRange
      ? `<span class="h ${v.toLower<NEAR?'warn':''}">&larr; ${v.toLower.toFixed(1)}%</span>`
      : (reenter.dir === 'rise' ? idleNote : '');
    const highH = p.inRange
      ? `<span class="h ${v.toUpper<NEAR?'warn':''}">${v.toUpper.toFixed(1)}% &rarr;</span>`
      : (reenter.dir === 'fall' ? idleNote : '');

    const s0 = p.share0 == null ? 50 : p.share0;
    const s1 = p.share1 == null ? 50 : p.share1;

    return `
    <article class="${cls}">
      <div class="top">
        <div class="name">
          <h2>${p.pair}</h2>
          <span class="tier">${p.feeTierLabel}</span>
          ${p.version === 4 ? `<span class="tier v4" title="Uniswap v4 position${p.hooks ? ' · hooks ' + p.hooks : ''}. Shown read-only; the collector does not collect v4 fees.">v4</span>` : ''}
          <span class="nft mono">${nftLink(d, p, '#' + (p.nftId || p.tokenId))}</span>
          <span class="state ${p.inRange ? (near?'near':'') : 'out'}">${state}</span>
          ${p.approved === false ? '<span class="tag-noappr">not approved</span>' : ''}
          ${p.eligible === true ? '<span class="tag-elig">collectable</span>' : ''}
          ${etaBadge(p, d)}
        </div>
        <div class="vals">
          <span class="v">${usd(p.valueUsd)}</span>
          <span class="f ${(p.feesUsd||0) < 0.005 ? 'zero':''}">${usd(p.feesUsd)} uncollected</span>
        </div>
      </div>

      <div class="rail">
        <div class="track">
          <div class="bar"></div>
          <div class="cap l"></div><div class="cap r"></div><div class="mid"></div>
          <div class="flag${flagCls}" style="${flagPos}">${price(v.current)}</div>
          <div class="stem" style="left:${pct}%"></div>
          <div class="marker" style="left:${pct}%"></div>
        </div>
        <div class="ends">
          <span><span class="mono">${price(v.lower)}</span> &nbsp;${lowH}</span>
          <span class="unit" data-key="${v.key}" data-invert="${v.invert ? 1 : 0}" title="Prices in ${v.unit}. Click to show ${v.invert ? p.symbol1 + ' per ' + p.symbol0 : p.symbol0 + ' per ' + p.symbol1} instead.">${v.unit} &#8646;</span>
          <span>${highH}&nbsp; <span class="mono">${price(v.upper)}</span></span>
        </div>
      </div>

      <div class="comp">
        <div class="split" role="img" aria-label="${s0.toFixed(0)} percent ${p.symbol0}, ${s1.toFixed(0)} percent ${p.symbol1}">
          <i class="a" style="width:${s0}%"></i><i class="b" style="width:${s1}%"></i>
        </div>
        <span class="amts"><b>${amount(p.amount0)}</b> ${p.symbol0} · <b>${amount(p.amount1)}</b> ${p.symbol1}</span>
        ${p.feesOk ? '' : '<span class="amts">fee read unavailable</span>'}
        ${poolLine(p)}
        ${!p.inRange && p.dailyUsd > 0 ? `<span class="rate">not earning while out of range · was <b class="was">${usd(p.dailyUsd)}/day</b> in range${
          ageDays(p) != null && ageDays(p) >= PROJECT_AFTER_DAYS
            ? (rangeW(p) != null
              ? ` · expected <b class="was">${usd(expectedDaily(p))}/day</b> at ${p.range.pctInRange.toFixed(0)}% time in range · next 7d <b>${usd(expectedDaily(p) * 7)}</b> · 30d <b>${usd(expectedDaily(p) * 30)}</b>`
              : ' · projection <b class="was">$0</b> until back in range')
            : ''}</span>` : ''}
        ${p.range && p.range.trackedHours >= 1 ? `<span class="rate">in range <b class="${p.range.pctInRange >= 50 ? '' : 'neg'}">${p.range.pctInRange.toFixed(0)}%</b> of the last ${spanText(p.range.trackedHours)} · ${p.range.flips ? p.range.flips + ' flip' + (p.range.flips === 1 ? '' : 's') : 'no flips'} · ${p.range.streakInRange ? 'in' : 'out'} since ${new Date(p.range.streakSince).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</span>` : ''}
        ${p.inRange && p.dailyUsd != null && (p.dailyUsd > 0 || (p.feesUsd||0) > 0.005) ? `<span class="rate">earning <b>${usd(p.dailyUsd)}/day</b>${
          p.aprPct != null && p.rateWindowH >= 6 && (p.valueUsd||0) >= 50
            ? ' · ~' + p.aprPct.toFixed(1) + '% APR' : ''}${
          p.rateWindowH != null && p.rateWindowH < 24
            ? ` <span title="extrapolated from a short window">(over ${p.rateWindowH.toFixed(1)}h)</span>` : ''}${
          p.dailyUsd > 0 && ageDays(p) != null && ageDays(p) >= PROJECT_AFTER_DAYS ? ` · next 7d <b>${usd(expectedDaily(p) * 7)}</b> · 30d <b>${usd(expectedDaily(p) * 30)}</b>${rangeW(p) != null ? ' at ' + p.range.pctInRange.toFixed(0) + '% time in range' : ''}`
          : p.dailyUsd > 0 && ageDays(p) != null ? ` · <span title="Projections start once a position has been open ${PROJECT_AFTER_DAYS} days">projection in ${Math.max(1, Math.ceil(PROJECT_AFTER_DAYS - ageDays(p)))}d</span>` : ''}</span>` : ''}
        ${p.pnlUsd != null ? `<span class="rate pnl" tabindex="0">PnL vs HODL <b class="${p.pnlUsd < 0 ? 'neg' : ''}">${
          p.pnlUsd >= 0 ? '+' : '−'}${usd(Math.abs(p.pnlUsd))}${
          p.pnlPct != null ? ' (' + (p.pnlPct >= 0 ? '+' : '−') + Math.abs(p.pnlPct).toFixed(1) + '%)' : ''}</b>${
          p.pnlApprox ? ' ≈' : ''}${
          p.pnlSince ? ' · since ' + new Date(p.pnlSince).toLocaleDateString(undefined,{month:'short',day:'numeric'}) : ''}${pnlTip(p)}</span>` : ''}
        ${sparkline(p.spark)}
      </div>
      ${pxChart(p, v)}
    </article>`;
  }).join('');
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
    render(d);
  }catch(e){
    $('#list').innerHTML = `<div class="err">Could not reach the chain. ${e.message}
      <br>Check rpcUrl in config.json and that the server is still running.</div>`;
  }finally{
    btn.disabled = false;
    btn.textContent = 'Refresh';
  }
}

/* ---- collect ---- */
let coTimer = null;

const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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
  if (!e.shiftKey) { location.href = '/arm'; return; }
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
  $('#watchnote').textContent = 'Watched wallets are read-only and never collected from. Value = tokens in the wallet + open positions + uncollected fees, at current prices; tokens with no WETH or USDG pool are unpriced. Updated ' + new Date(d.at).toLocaleTimeString() + '.';
  const scopeW = pfScope();
  const shown = scopeW === 'owner' || scopeW === 'all' ? d.wallets : d.wallets.filter(w => w.address.toLowerCase() === scopeW);
  if (scopeW !== 'all' && scopeW !== 'owner') {
    $('#watchtitle').textContent = 'Positions';
    $('#watchtotal').textContent = shown[0] && shown[0].totals ? usd(shown[0].totals.totalUsd) : '';
  }
  $('#watchstats').hidden = scopeW !== 'all';
  renderHeadline(); // the combined header needs both payloads
  $('#watchlist').innerHTML = shown.map(w => {
    const name = w.label ? `${w.label} <span class="muted">${shortA(w.address)}</span>` : shortA(w.address);
    const link = `<a href="${d.explorer}/address/${w.address}" target="_blank" rel="noopener" title="${w.address}">${name}</a>`;
    if (!w.ok) return `<div class="watchwallet"><div class="wh">${link}<span class="idle">${w.error || 'could not load'}</span></div></div>`;
    const t = w.totals;
    const h = w.holdings;
    const walletPart = h
      ? `<span>tokens <b>${usd(h.walletUsd)}</b>${h.unpricedCount ? ` <span class="muted" title="tokens with no pricing pool">+${h.unpricedCount} unpriced</span>` : ''}${h.ok ? '' : ' <span class="idle" title="Blockscout holdings list unavailable; only position tokens and ETH were checked">partial</span>'}</span>`
      : '';
    const e = w.earned;
    const earnedPart = e && (e.all > 0 || e.since) ? `<span title="Fee accrual from snapshots since ${e.since || 'today'}, at current prices">earned today <b>${usd(e.today)}</b> · 7d <b>${usd(e.d7)}</b></span>` : '';
    const c = w.collector;
    const mark = v => v === true ? '<span class="in">✓</span>' : v === false ? '<span class="idle">✗</span>' : '?';
    const collectorPart = c && c.enabled ? `<span title="The collector collects this wallet's fees once it has approved the operator on the v3 and v4 position managers (/approve-v3, /approve-v4)">collector: v3 ${mark(c.v3)} v4 ${mark(c.v4)}${c.v3 === false || c.v4 === false ? ' <a href="/approve-v3" class="muted">approve</a>' : ''}</span>` : '';
    const head = `<div class="wh">${link}<span class="wtotal">total <b>${usd(t.totalUsd)}</b></span>${walletPart}<span>in pools <b>${usd(t.liquidityUsd)}</b></span><span>uncollected <b>${usd(t.feesUsd)}</b></span>${earnedPart}${collectorPart}<span><b>${t.count}</b> open${t.idle ? ` · <span class="idle">${t.idle} idle</span>` : ''}${w.closed ? ` · <span class="muted">${w.closed} closed</span>` : ''}${w.truncated ? ` · <span class="muted" title="This wallet owns ${w.known} position NFTs; only the newest ${w.known - w.truncated} were read">newest ${w.known - w.truncated} of ${w.known}</span>` : ''}</span></div>`;
    // Top tokens sitting in the wallet, compact.
    const toks = h && h.tokens.length
      ? `<div class="wtokens">${h.tokens.filter(x => x.usd != null && x.usd >= 0.5).slice(0, 8).map(x => `<span title="${x.amount.toLocaleString('en-US',{maximumFractionDigits:6})} ${x.symbol}${x.thin ? ' (thin pool, quote only)' : ''}">${x.symbol} <b>${x.usd == null ? 'unpriced' : usd(x.usd)}</b>${x.thin ? '<span class="idle">≈</span>' : ''}</span>`).join('')}${(n => n > 0 ? `<span class="muted">+${n} more</span>` : '')(h.tokens.filter(x => x.usd != null && x.usd >= 0.5).length - 8)}</div>`
      : '';
    if (!w.positions.length) return `<div class="watchwallet">${head}${toks}<div class="enote">No open positions.</div></div>`;
    const cards = w.positions.map(p => {
      const full = p.tickLower <= -887000 && p.tickUpper >= 887000;
      const v = orient(p);
      const near = !full && p.inRange && (v.toUpper < NEAR || v.toLower < NEAR);
      const cls = 'pos' + (p.inRange ? (near ? ' near' : '') : ' out');
      let state = 'In range';
      if (!p.inRange) state = v.above ? 'Above range · idle' : 'Below range · idle';
      else if (near) state = 'Near the edge';
      const railPos = full ? 0.5 : v.railPos;
      const pct = (railPos * 100).toFixed(2);
      const flagCls = railPos < 0.12 ? ' left' : railPos > 0.88 ? ' right' : '';
      const flagPos = railPos < 0.12 ? 'left:0' : railPos > 0.88 ? 'left:100%' : `left:${pct}%`;
      const reenter = p.inRange ? null : v.above
        ? { dir: 'fall', pct: (1 - v.upper / v.current) * 100 }
        : { dir: 'rise', pct: (v.lower / v.current - 1) * 100 };
      const idleNote = reenter ? `<span class="h idle">needs a ${reenter.pct.toFixed(1)}% ${reenter.dir} to start earning</span>` : '';
      const lowH = full ? '' : p.inRange ? `<span class="h ${v.toLower < NEAR ? 'warn' : ''}">&larr; ${v.toLower.toFixed(1)}%</span>` : (reenter.dir === 'rise' ? idleNote : '');
      const highH = full ? '' : p.inRange ? `<span class="h ${v.toUpper < NEAR ? 'warn' : ''}">${v.toUpper.toFixed(1)}% &rarr;</span>` : (reenter.dir === 'fall' ? idleNote : '');
      const val0 = p.usd0 == null ? null : p.amount0 * p.usd0, val1 = p.usd1 == null ? null : p.amount1 * p.usd1;
      const s0 = val0 != null && val1 != null && val0 + val1 > 0 ? (val0 / (val0 + val1)) * 100 : 50;
      const nft = nftLink(d, p, '#' + p.nftId);
      return `<article class="${cls}">
        <div class="top">
          <div class="name">
            <h2>${p.pair}</h2>
            <span class="tier">${p.feeTierLabel}</span>
            ${p.version === 4 ? `<span class="tier v4" title="Uniswap v4 position${p.hooks ? ' · hooks ' + p.hooks : ''}">v4</span>` : ''}
            ${full ? '<span class="full" title="Liquidity across the whole price range: always earning, never idle">full range</span>' : ''}
            <span class="nft mono">${nft}</span>
            <span class="state ${p.inRange ? (near ? 'near' : '') : 'out'}">${state}</span>
          </div>
          <div class="vals">
            <span class="v">${usd(p.valueUsd)}</span>
            <span class="f ${(p.feesUsd || 0) < 0.005 ? 'zero' : ''}">${usd(p.feesUsd)} uncollected</span>
          </div>
        </div>
        <div class="rail">
          <div class="track">
            <div class="bar"></div>
            <div class="cap l"></div><div class="cap r"></div><div class="mid"></div>
            <div class="flag${flagCls}" style="${flagPos}">${price(v.current)}</div>
            <div class="stem" style="left:${pct}%"></div>
            <div class="marker" style="left:${pct}%"></div>
          </div>
          <div class="ends">
            <span><span class="mono">${full ? '0' : price(v.lower)}</span> &nbsp;${lowH}</span>
            <span class="unit" data-key="${v.key}" data-invert="${v.invert ? 1 : 0}" title="Prices in ${v.unit}. Click to show ${v.invert ? p.symbol1 + ' per ' + p.symbol0 : p.symbol0 + ' per ' + p.symbol1} instead.">${v.unit} &#8646;</span>
            <span>${highH}&nbsp; <span class="mono">${full ? '∞' : price(v.upper)}</span></span>
          </div>
        </div>
        <div class="comp">
          <div class="split"><i class="a" style="width:${s0}%"></i><i class="b" style="width:${100 - s0}%"></i></div>
          <span class="amts"><b>${amount(p.amount0)}</b> ${p.symbol0} · <b>${amount(p.amount1)}</b> ${p.symbol1}</span>
          ${(p.fee0 || 0) > 0 || (p.fee1 || 0) > 0 ? `<span class="amts">fees <b>${amount(p.fee0)}</b> ${p.symbol0} · <b>${amount(p.fee1)}</b> ${p.symbol1}</span>` : ''}
          ${p.feesOk ? '' : '<span class="amts">fee read unavailable</span>'}
          ${poolLine(p)}
        </div>
      </article>`;
    }).join('');
    return `<div class="watchwallet">${head}${toks}<div class="wcards">${cards}</div></div>`;
  }).join('');
}
async function loadWatch(){
  try {
    const r = await fetch('/api/watch');
    const d = await r.json();
    if (r.status === 202 || (d && d.refreshing && !d.ok)) setTimeout(loadWatch, 20000); // first build still running
    renderWatch(d);
    lastWatchForPf = d && d.ok ? d : lastWatchForPf;
    if (lastPortfolio) renderPortfolio();
  } catch(e){}
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
  if (ANALYTICS) { loadHistory(); loadDaily(); loadStaking(); loadWatchForAnalytics(); loadTreasury(); }
  else { loadRewards(); loadBalances(); loadAllSeries(); }
}
$('#reload').addEventListener('click', () => tick(true));
tick(false);
setInterval(() => tick(false), 60000);
