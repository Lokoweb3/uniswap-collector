/* aggregate-view.js -- the /portfolio page. Read-only: it fetches /api/aggregate (GET) and draws it.
 *
 * Every string that came from an upstream is passed through esc() before it is put in markup;
 * numbers go through usd()/qty()/pct(); markup fragments are built only by the functions
 * below and named *Html. Nothing is evaluated, no handler is written into markup (events are
 * delegated from the root), and the only request this file makes is a GET of /api/aggregate.
 */
"use strict";

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const isNum = v => typeof v === 'number' && Number.isFinite(v);
/** USD with 2 decimals; a null is "unpriced", never $0.00. */
function usd(v) {
  if (!isNum(v)) return 'unpriced';
  const [i, f] = Math.abs(v).toFixed(2).split('.');
  return (v < 0 ? '-$' : '$') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + f;
}
function qty(v) {
  if (!isNum(v)) return '-';
  if (v === 0) return '0';
  return v >= 1000 ? Math.round(v).toLocaleString('en-US') : Number(v.toPrecision(6)).toString();
}
const pct = (a, b) => (isNum(a) && isNum(b) && b > 0 ? (a / b * 100).toFixed(1) + '%' : '-');
function stamp(ms) {
  return isNum(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'never';
}
function age(ms) {
  if (!isNum(ms)) return '';
  const m = Math.round(ms / 60000);
  return m < 1 ? 'under a minute' : m < 120 ? m + ' min' : Math.round(m / 60) + ' h';
}
const shortAddr = a => (typeof a === 'string' && a.length > 12 ? a.slice(0, 6) + '...' + a.slice(-4) : String(a ?? ''));
const REASONS = {
  'thin-pool': 'thin pool', 'price-gap': 'price gap between the two sides', unanchored: 'no WPLS/stable side',
  unpriced: 'unpriced', 'decimals-unverified': 'decimals not verified', 'duplicate-of-holdings': 'duplicate of a holding',
  'gauge-killed': 'gauge killed', duplicate: 'duplicate',
};
const reasonText = r => REASONS[r] || String(r || '');

// ---- state -> numbers ---------------------------------------------------------------
const SORTS = {
  value: (a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1),
  fees: (a, b) => (b.feesUsd ?? -1) - (a.feesUsd ?? -1),
  chain: (a, b) => String(a.chain).localeCompare(String(b.chain)),
  wallet: (a, b) => String(a.wallet.label || a.wallet.key).localeCompare(String(b.wallet.label || b.wallet.key)),
  protocol: (a, b) => String(a.protocol).localeCompare(String(b.protocol)),
  name: (a, b) => String(a.name).localeCompare(String(b.name)),
};
function sortItems(items, key) {
  return items.slice().sort(SORTS[key] || SORTS.value);
}

/** The visible items for a selection: chains is a Set of keys, wallet is '' (all) or a wallet key. */
function filterItems(payload, sel) {
  return (payload.items || []).filter(it => (!sel.chains || sel.chains.has(it.chain)) && (!sel.wallet || it.wallet.key === sel.wallet));
}

/** Same rules as the server, applied to what is shown. Unfiltered, the server's own totals are used. */
function totalsFor(payload, items, sel) {
  const all = !sel.wallet && sel.chains && (payload.chains || []).every(c => sel.chains.has(c.key));
  if (all && !payload.truncated) return payload.totals;
  const t = { lpUsd: 0, feesUsd: 0, rewardsUsd: 0, tokensUsd: 0, uncountedUsd: 0, uncountedCount: 0, rewardsUncountedUsd: 0, rewardsUncountedCount: 0, assumedUsd: 0, staleUsd: 0 };
  for (const it of items) {
    let c = 0;
    if (it.kind === 'lp') {
      if (it.counted) { t.lpUsd += it.valueUsd; c += it.valueUsd; }
      if (it.counted && isNum(it.feesUsd) && !it.flags.feesUnavailable) { t.feesUsd += it.feesUsd; c += it.feesUsd; }
      if (it.rewardsCounted) { t.rewardsUsd += it.rewardsUsd; c += it.rewardsUsd; }
      else if (it.rewardsReason) { t.rewardsUncountedCount++; if (isNum(it.rewardsUsd)) t.rewardsUncountedUsd += it.rewardsUsd; }
      if (!it.counted) { t.uncountedCount++; if (isNum(it.valueUsd)) t.uncountedUsd += it.valueUsd; }
    } else if (it.counted) {
      t.tokensUsd += it.valueUsd; c += it.valueUsd;
      if (it.flags.assumed) t.assumedUsd += it.valueUsd;
    } else t.uncountedCount++;
    if (it.flags.stale) t.staleUsd += c;
  }
  t.grandUsd = t.lpUsd + t.feesUsd + t.rewardsUsd + t.tokensUsd;
  t.itemCount = items.length;
  return t;
}

function breakdownFor(items) {
  const by = { chain: {}, wallet: {}, protocol: {} };
  for (const it of items) {
    let c = 0;
    if (it.kind === 'lp') {
      if (it.counted) c += it.valueUsd;
      if (it.counted && isNum(it.feesUsd) && !it.flags.feesUnavailable) c += it.feesUsd;
      if (it.rewardsCounted) c += it.rewardsUsd;
    } else if (it.counted) c += it.valueUsd;
    by.chain[it.chain] = (by.chain[it.chain] || 0) + c;
    by.wallet[it.wallet.key] = (by.wallet[it.wallet.key] || 0) + c;
    by.protocol[it.protocol] = (by.protocol[it.protocol] || 0) + c;
  }
  return by;
}

// ---- rendering (string builders; every upstream string goes through esc) ---------------
const accentOf = c => (/^#[0-9a-fA-F]{3,8}$/.test(c.accent) ? c.accent : '#888');
const chainOf = (payload, key) => (payload.chains || []).find(c => c.key === key) || { key, label: key, accent: '#888' };
const walletName = w => w.label || shortAddr(w.key);

function chainTagHtml(payload, key) {
  const c = chainOf(payload, key);
  return `<a class="ctag" href="/?chain=${encodeURIComponent(c.key)}" style="--accent:${esc(accentOf(c))}">${esc(c.label)}</a>`;
}

function badgesHtml(it) {
  const partsHtml = [];
  if (it.flags.staked) partsHtml.push('<span class="badge staked">staked</span>');
  if (it.flags.killedGauge) partsHtml.push('<span class="badge bad">gauge killed</span>');
  if (it.inRange === true) partsHtml.push('<span class="badge good">in range</span>');
  if (it.inRange === false) partsHtml.push('<span class="badge warn">out of range</span>');
  if (it.flags.thin) partsHtml.push('<span class="badge warn">thin</span>');
  if (it.flags.assumed) partsHtml.push('<span class="badge warn">assumed price</span>');
  if (it.flags.stale) partsHtml.push('<span class="badge bad">stale</span>');
  return partsHtml.join(' ');
}

function feesCellHtml(it) {
  const partsHtml = [];
  if (it.flags.feesUnavailable) partsHtml.push('<span class="muted">fees unavailable</span>');
  else if (isNum(it.feesUsd)) partsHtml.push(`<span>fees ${esc(usd(it.feesUsd))}${it.counted ? '' : ' <span class="muted">(not counted)</span>'}</span>`);
  if (it.rewardsReason) {
    partsHtml.push(`<span class="muted">rewards ${isNum(it.rewardsUsd) ? esc(usd(it.rewardsUsd)) + ' ' : ''}not counted (${esc(reasonText(it.rewardsReason))})</span>`);
  } else if (isNum(it.rewardsUsd)) {
    partsHtml.push(`<span>pending rewards ${esc(usd(it.rewardsUsd))}${it.rewardSymbol ? ' ' + esc(it.rewardSymbol) : ''}</span>`);
  }
  return partsHtml.length ? partsHtml.join('<br>') : '-';
}

function lpRowHtml(payload, it) {
  return `<tr><td>${esc(it.protocol)}</td><td>${esc(it.name)}</td><td>${chainTagHtml(payload, it.chain)}</td>`
    + `<td>${esc(walletName(it.wallet))}</td><td>${badgesHtml(it)}</td>`
    + `<td class="num">${esc(usd(it.valueUsd))}${it.reason ? ` <span class="muted">${esc(reasonText(it.reason))}</span>` : ''}</td>`
    + `<td class="num">${feesCellHtml(it)}</td></tr>`;
}
function tokenRowHtml(payload, it) {
  return `<tr><td>${esc(it.name)}</td><td>${chainTagHtml(payload, it.chain)}</td><td>${esc(walletName(it.wallet))}</td>`
    + `<td class="num">${esc(qty(it.amount))}</td><td class="num">${esc(usd(it.price))}</td>`
    + `<td class="num">${esc(usd(it.valueUsd))}${it.reason ? ` <span class="muted">${esc(reasonText(it.reason))}</span>` : ''}</td>`
    + `<td>${badgesHtml(it)}</td></tr>`;
}
function stakingRowHtml(payload, it) {
  const r = it.stakingRewards || {};
  return `<tr><td>${esc(it.name)}</td><td>${chainTagHtml(payload, it.chain)}</td><td>${esc(walletName(it.wallet))}</td>`
    + `<td class="num">${esc(qty(it.amount))}</td><td class="num">${esc(usd(it.valueUsd))}${it.reason ? ` <span class="muted">${esc(reasonText(it.reason))}</span>` : ''}</td>`
    + `<td class="num">${isNum(it.aprPct) ? esc(it.aprPct.toFixed(2)) + '%' : '-'}</td>`
    + `<td class="num">${esc(usd(r.d7Usd))} / ${esc(usd(r.d30Usd))}</td></tr>`;
}

function tableHtml(title, head, rows, notCounted, rowHtml, payload, cols) {
  if (!rows.length && !notCounted.length) return `<section class="agg-sec"><h2>${esc(title)}</h2><p class="muted">Nothing to show.</p></section>`;
  const headHtml = head.map(([label, key]) => (key ? `<th data-sort="${esc(key)}" class="sortable">${esc(label)}</th>` : `<th>${esc(label)}</th>`)).join('');
  const bodyHtml = rows.map(it => rowHtml(payload, it)).join('');
  const countedRowsHtml = notCounted.map(it => rowHtml(payload, it)).join('');
  const groupHtml = notCounted.length ? `<tr class="group"><td colspan="${esc(cols)}">Not counted (${esc(notCounted.length)})</td></tr>${countedRowsHtml}` : '';
  return `<section class="agg-sec"><h2>${esc(title)}</h2><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}${groupHtml}</tbody></table></section>`;
}

function bannersHtml(payload, sel) {
  const out = [];
  for (const c of payload.chains || []) {
    if (c.status === 'ok') continue;
    const probsHtml = (c.problems || []).map(p => `${esc(p.part || p.wallet)}: ${esc(p.code)}`).join(', ');
    let textHtml = `${esc(c.label)} is ${esc(c.status)}`;
    if (c.status === 'stale') textHtml += ` - showing the last good data from ${esc(stamp(c.lastGoodAt))} (${esc(age(c.ageMs))} old), included in the total`;
    else if (c.status === 'down') textHtml += ' - not counted, its figures are missing from the total';
    else if (c.status === 'loading') textHtml += ' - still loading, its figures are missing from the total';
    else textHtml += ' - some parts are missing or old';
    const hiddenHtml = sel.chains && !sel.chains.has(c.key) ? ' (hidden by the chain filter)' : '';
    const detailHtml = probsHtml ? `<div class="muted">${probsHtml}</div>` : '';
    out.push(`<div class="banner ${esc(c.status)}" role="status" style="--accent:${esc(accentOf(c))}"><b>${textHtml}</b>${hiddenHtml}${detailHtml}</div>`);
  }
  return out.join('');
}

function tileHtml(payload, t, items) {
  const notesHtml = [];
  if (payload.incomplete) notesHtml.push('<span class="badge warn">incomplete: some chains or parts are missing</span>');
  if (isNum(t.staleUsd) && t.staleUsd > 0) notesHtml.push(`<span class="badge bad">stale ${esc(usd(t.staleUsd))} included (last good data)</span>`);
  if (payload.truncated) notesHtml.push('<span class="badge warn">list truncated, totals cover everything</span>');
  return `<div class="tile"><div class="label">Total, counted</div><div class="grand">${esc(usd(t.grandUsd))}</div>`
    + `<div class="sub">LP ${esc(usd(t.lpUsd))} + fees ${esc(usd(t.feesUsd))} + pending rewards ${esc(usd(t.rewardsUsd))} + tokens ${esc(usd(t.tokensUsd))}</div>`
    + `<div class="sub">uncounted ${esc(usd(t.uncountedUsd))} (${esc(t.uncountedCount)} items)</div>`
    + `<div class="sub">pending rewards (included) ${esc(usd(t.rewardsUsd))}; rewards not counted: ${esc(t.rewardsUncountedCount)}</div>`
    + `<div class="sub">priced by assumption ${esc(usd(t.assumedUsd))}</div>`
    + `<div class="notes">${notesHtml.join(' ')}</div><div class="muted">${esc(items.length)} items shown</div></div>`;
}

function controlsHtml(payload, sel) {
  const chipsHtml = (payload.chains || []).map(c => {
    const on = !sel.chains || sel.chains.has(c.key);
    return `<label class="chip" style="--accent:${esc(accentOf(c))}"><input type="checkbox" data-chip="${esc(c.key)}"${on ? ' checked' : ''}> ${esc(c.label)}</label>`;
  }).join('');
  const walletOptsHtml = (payload.wallets || []).map(w =>
    `<option value="${esc(w.key)}"${sel.wallet === w.key ? ' selected' : ''}>${esc(w.label || shortAddr(w.address))}${w.aliases && w.aliases.length ? ' (' + esc(w.aliases.join(', ')) + ')' : ''}</option>`).join('');
  const sortOptsHtml = Object.keys(SORTS).map(k => `<option value="${esc(k)}"${sel.sort === k ? ' selected' : ''}>${esc(k)}</option>`).join('');
  return `<div class="controls">${chipsHtml}<label>Wallet <select data-wallet><option value="">All wallets</option>${walletOptsHtml}</select></label>`
    + `<label>Sort <select data-sortsel>${sortOptsHtml}</select></label><button type="button" data-refresh>Refresh</button></div>`;
}

function breakdownHtml(payload, items) {
  const by = breakdownFor(items);
  const total = Object.values(by.chain).reduce((a, b) => a + b, 0);
  const sectionHtml = (title, map, label, extraRowsHtml) => {
    const rowsHtml = Object.entries(map).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(label(k))}</td><td class="num">${esc(usd(v))}</td><td class="num">${esc(pct(v, total))}</td></tr>`).join('');
    const emptyHtml = rowsHtml || extraRowsHtml ? '' : '<tr><td class="muted">none</td></tr>';
    return `<section class="agg-sec half"><h2>${esc(title)}</h2><table><tbody>${rowsHtml}${extraRowsHtml}${emptyHtml}</tbody></table></section>`;
  };
  const downRowsHtml = (payload.chains || []).filter(c => c.status === 'down' || c.status === 'loading').map(c => `<tr><td>${esc(c.label)}</td><td class="num muted">${esc(c.status)}, no figure</td><td></td></tr>`).join('');
  const walletLabel = k => { const w = (payload.wallets || []).find(x => x.key === k); return w ? (w.label || shortAddr(w.address)) : shortAddr(k); };
  const chainHtml = sectionHtml('By chain', by.chain, k => chainOf(payload, k).label, downRowsHtml);
  const walletHtml = sectionHtml('By wallet', by.wallet, walletLabel, '');
  const protocolHtml = sectionHtml('By protocol', by.protocol, k => k, '');
  return `<div class="agg-breakdown">${chainHtml}${walletHtml}${protocolHtml}</div>`;
}

const HEADS = {
  lp: [['Protocol', 'protocol'], ['Pair', 'name'], ['Chain', 'chain'], ['Wallet', 'wallet'], ['', null], ['Value', 'value'], ['Fees / pending rewards', 'fees']],
  token: [['Token', 'name'], ['Chain', 'chain'], ['Wallet', 'wallet'], ['Amount', null], ['Price', null], ['Value', 'value'], ['', null]],
  staking: [['Token', 'name'], ['Chain', 'chain'], ['Wallet', 'wallet'], ['Balance', null], ['Value', 'value'], ['APR', null], ['7d / 30d rewards (already received, not pending)', null]],
};

/** The whole page body for a payload and a selection. */
function renderPage(payload, sel) {
  if (!payload || payload.ok === false) return '<p class="banner down">The portfolio could not be built. Try again in a moment.</p>';
  const items = filterItems(payload, sel);
  const t = totalsFor(payload, items, sel);
  const sorted = sortItems(items, sel.sort);
  const lp = sorted.filter(i => i.kind === 'lp');
  const tokens = sorted.filter(i => i.kind === 'token' && !i.flags.staking);
  const staking = sorted.filter(i => i.kind === 'staking' || (i.kind === 'token' && i.flags.staking));
  const split = list => [list.filter(i => i.counted || i.rewardsCounted), list.filter(i => !i.counted && !i.rewardsCounted)];
  const [lpOk, lpNo] = split(lp);
  const [tkOk, tkNo] = split(tokens);
  const [stOk, stNo] = split(staking);
  return bannersHtml(payload, sel) + tileHtml(payload, t, items) + controlsHtml(payload, sel)
    + tableHtml('LP positions', HEADS.lp, lpOk, lpNo, lpRowHtml, payload, 7)
    + tableHtml('Tokens', HEADS.token, tkOk, tkNo, tokenRowHtml, payload, 7)
    + tableHtml('Staking', HEADS.staking, stOk, stNo, stakingRowHtml, payload, 7)
    + breakdownHtml(payload, items)
    + `<p class="muted foot">As of ${esc(stamp(payload.at))}. ${(payload.chains || []).map(c => `${esc(c.label)} ${esc(stamp(c.dataAt || c.lastGoodAt))}`).join('; ')}</p>`;
}

// ---- boot (browser only) ------------------------------------------------------------------
function initialSelection(payload, search) {
  const q = new URLSearchParams(search || '');
  const keys = new Set((payload.chains || []).map(c => c.key));
  const asked = String(q.get('chains') || '').split(',').filter(k => keys.has(k));
  const w = String(q.get('wallet') || '').toLowerCase();
  const names = x => [x.label, ...(x.aliases || []), ...Object.values(x.labels || {})].map(l => String(l).toLowerCase());
  const hit = w ? (payload.wallets || []).find(x => x.key === w || names(x).includes(w)) : null;
  return { chains: asked.length ? new Set(asked) : new Set(keys), wallet: hit ? hit.key : '', sort: 'value' };
}

function setHtml(el, html) {
  el.innerHTML = html;
}

function boot() {
  const root = document.getElementById('agg-root');
  if (!root) return;
  let payload = null, sel = null, busy = false;
  const draw = () => { if (payload) setHtml(root, renderPage(payload, sel)); };
  async function load(force) {
    if (busy) return;
    busy = true;
    try {
      const r = await fetch(force ? '/api/aggregate?refresh=1' : '/api/aggregate', { headers: { accept: 'application/json' } });
      payload = await r.json();
      if (!sel && payload && payload.ok) sel = initialSelection(payload, location.search);
      if (sel) draw(); else setHtml(root, renderPage(payload, { chains: null, wallet: '', sort: 'value' }));
    } catch (e) {
      setHtml(root, '<p class="banner down">The portfolio request failed. It will retry.</p>');
    } finally { busy = false; }
  }
  root.addEventListener('change', e => {
    const t = e.target;
    if (!sel || !t || !t.dataset) return;
    if (t.dataset.chip) { if (t.checked) sel.chains.add(t.dataset.chip); else sel.chains.delete(t.dataset.chip); }
    else if (t.hasAttribute('data-wallet')) sel.wallet = t.value;
    else if (t.hasAttribute('data-sortsel')) sel.sort = t.value;
    else return;
    draw();
  });
  root.addEventListener('click', e => {
    const t = e.target && e.target.closest ? e.target.closest('[data-refresh],[data-sort]') : null;
    if (!t) return;
    if (t.hasAttribute('data-refresh')) { load(true); return; }
    if (sel && SORTS[t.dataset.sort]) { sel.sort = t.dataset.sort; draw(); }
  });
  load(false);
  setInterval(() => load(false), 60000);
}

if (typeof document !== 'undefined') boot();
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { esc, usd, qty, pct, renderPage, filterItems, totalsFor, breakdownFor, sortItems, initialSelection, bannersHtml, lpRowHtml, tokenRowHtml, stakingRowHtml };
}
