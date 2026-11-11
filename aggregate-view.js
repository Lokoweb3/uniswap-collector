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
  roi: (a, b) => (b.roi ? b.roi.pct : -Infinity) - (a.roi ? a.roi.pct : -Infinity),
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
  return (payload.items || []).filter(it => it.testnet !== true && (!sel.chains || sel.chains.has(it.chain)) && (!sel.wallet || it.wallet.key === sel.wallet));
}

/** Same rules as the server, applied to what is shown. Unfiltered, the server's own totals are used. */
function isUnfiltered(payload, sel) {
  return !!(!sel.wallet && sel.chains && (payload.chains || []).every(c => c.testnet === true || sel.chains.has(c.key)));
}
function isFiltered(payload, sel) { return !isUnfiltered(payload, sel); }

function totalsFor(payload, items, sel) {
  if (isUnfiltered(payload, sel)) return payload.totals;
  return clientTotals(items);
}

/** The server's totals rules applied to a list of items (used when a filter is on). */
function clientTotals(items) {
  const t = { lpUsd: 0, feesUsd: 0, rewardsUsd: 0, tokensUsd: 0, uncountedUsd: 0, uncountedCount: 0, rewardsUncountedUsd: 0, rewardsUncountedCount: 0, feesUncountedUsd: 0, feesUncountedCount: 0, assumedUsd: 0, staleUsd: 0 };
  for (const it of items) {
    let c = 0;
    if (it.kind === 'lp') {
      if (it.counted) { t.lpUsd += it.valueUsd; c += it.valueUsd; }
      if (it.counted && isNum(it.feesUsd) && !it.flags.feesUnavailable) { t.feesUsd += it.feesUsd; c += it.feesUsd; }
      else if (isNum(it.feesUsd)) { t.feesUncountedCount++; t.feesUncountedUsd += it.feesUsd; }
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
  const by = { chain: {}, wallet: {}, protocol: {}, feesChain: {}, feesWallet: {} };
  for (const it of items) {
    let c = 0;
    if (it.kind === 'lp') {
      if (it.counted) c += it.valueUsd;
      if (it.counted && isNum(it.feesUsd) && !it.flags.feesUnavailable) {
        c += it.feesUsd;
        by.feesChain[it.chain] = (by.feesChain[it.chain] || 0) + it.feesUsd;
        by.feesWallet[it.wallet.key] = (by.feesWallet[it.wallet.key] || 0) + it.feesUsd;
      }
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
  if (it.flags.holdingsUnknown) partsHtml.push('<span class="badge warn">tokens unknown (discovery failed)</span>');
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
    + `<td class="num">${feesCellHtml(it)}</td><td class="num">${roiCellHtml(it)}</td></tr>`;
}
const signedUsd = v => (v < 0 ? '-' : '+') + usd(Math.abs(v));
const signedPct = v => (v < 0 ? '-' : '+') + Math.abs(v).toFixed(1) + '%';
const ROI_TIP = 'Return on capital: value now + uncollected and collected fees + withdrawals, against the deposits priced when they went in';
function roiCellHtml(it) {
  const r = it.roi;
  if (!r) return '<span class="muted" title="No deposit record for this position on its chain dashboard">not tracked</span>';
  const since = isNum(r.since) ? ` since ${new Date(r.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : '';
  const tip = `${ROI_TIP}. Deposited ${usd(r.basisUsd)}${since}${r.approx ? '; approximate' : ''}`;
  return `<span title="${esc(tip)}"><b class="${r.pct < 0 ? 'neg' : 'pos'}">${esc(signedPct(r.pct))}</b>${r.approx ? ' ≈' : ''}<br><span class="muted">${esc(signedUsd(r.usd))}</span></span>`;
}
function roiTotalHtml(payload, sel) {
  const lp = filterItems(payload, sel).filter(it => it.kind === 'lp');
  const m = lp.filter(it => it.roi);
  if (!m.length) return '<span class="muted">not tracked</span>';
  const gain = m.reduce((s, it) => s + it.roi.usd, 0), basis = m.reduce((s, it) => s + it.roi.basisUsd, 0);
  return `<span title="${esc(ROI_TIP)}"><b class="${gain < 0 ? 'neg' : 'pos'}">${esc(signedPct(gain / basis * 100))}</b> ${esc(signedUsd(gain))}`
    + `<br><span class="muted">${esc(m.length)} of ${esc(lp.length)} positions tracked</span></span>`;
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

// ---- LP totals row and earning rate -----------------------------------------------------
const SHORT_WINDOW_H = 6;
const hours = h => (isNum(h) ? h.toFixed(1) + ' h' : '-');

function unavailableWallet(payload, sel) {
  return (sel && sel.wallet ? (payload.wallets || []).find(w => w.key === sel.wallet && w.unavailable === true) : null) || null;
}

function totalsRowHtml(payload, t, sel) {
  if (unavailableWallet(payload, sel)) return '<tr class="total"><td colspan="5">Total (counted)</td><td class="num">unavailable</td><td class="num">unavailable</td><td class="num">unavailable</td></tr>';
  const linesHtml = [`<span>fees ${esc(usd(t.feesUsd))}</span>`, `<span>pending rewards ${esc(usd(t.rewardsUsd))}</span>`];
  if (t.feesUncountedCount > 0) linesHtml.push(`<span class="muted">fees not counted ${esc(usd(t.feesUncountedUsd))} (${esc(t.feesUncountedCount)} items)</span>`);
  if (t.rewardsUncountedCount > 0) {
    // A dollar figure only when known: priced-but-uncounted rewards (killed gauge). Unpriced ones have no amount.
    const unpriced = filterItems(payload, sel).filter(it => it.kind === 'lp' && !it.rewardsCounted && it.rewardsReason && !isNum(it.rewardsUsd)).length;
    const note = t.rewardsUncountedUsd > 0 ? ` (${unpriced > 0 ? unpriced + ' unpriced, ' : ''}${usd(t.rewardsUncountedUsd)}${unpriced > 0 ? ' priced' : ''})` : ' (unpriced)';
    linesHtml.push(`<span class="muted">rewards not counted: ${esc(t.rewardsUncountedCount)}${esc(note)}</span>`);
  }
  return `<tr class="total"><td colspan="5">Total (counted)</td><td class="num">${esc(usd(t.lpUsd))}</td><td class="num">${linesHtml.join('<br>')}</td><td class="num">${roiTotalHtml(payload, sel)}</td></tr>`;
}

/** The rate entries in scope: same chain set and wallet rule as filterItems. */
function ratesFor(payload, sel) {
  return (payload.rates || []).filter(r => (!sel.chains || sel.chains.has(r.chain)) && (!sel.wallet || r.wallet === sel.wallet));
}

function ratesHtml(payload, sel) {
  const rs = ratesFor(payload, sel);
  const head = 'Fees earning (measured, uncollected fees only, excludes pending rewards)';
  if (!rs.length) return `<p class="agg-rate muted">${esc(head)}: no measured source in this selection</p>`;
  const wname = k => { const w = (payload.wallets || []).find(x => x.key === k); return w ? (w.label || shortAddr(w.address)) : shortAddr(k); };
  const known = rs.filter(r => isNum(r.perDayUsd));
  const srcHtml = rs.map(r => {
    if (r.wallet === null) return `<li>${esc(chainOf(payload, r.chain).label)}: rate unknown (chain down)</li>`;
    const whoHtml = `${esc(chainOf(payload, r.chain).label)} ${esc(wname(r.wallet))}`;
    if (!isNum(r.perDayUsd)) return `<li>${whoHtml}: rate unknown</li>`;
    const bitsHtml = [];
    if (isNum(r.windowH)) bitsHtml.push(`over ${esc(hours(r.windowH))}`);
    if (r.kind === 'wallet') bitsHtml.push('wallet accrual, all positions');
    else {
      bitsHtml.push('sum of per-position accrual');
      if (isNum(r.measured) && isNum(r.total) && r.measured < r.total) bitsHtml.push(`${esc(r.measured)} of ${esc(r.total)} positions measured`);
    }
    if (isNum(r.windowH) && r.windowH < SHORT_WINDOW_H) bitsHtml.push('short window');
    return `<li>${whoHtml}: ${esc(usd(r.perDayUsd))}/day, ${bitsHtml.join(', ')}${r.stale ? ' <span class="badge bad">stale</span>' : ''}</li>`;
  }).join('');
  let headlineHtml;
  if (!known.length) headlineHtml = `${esc(head)}: rate unknown`;
  else {
    const day = known.reduce((a, r) => a + r.perDayUsd, 0);
    const wins = known.map(r => r.windowH).filter(isNum);
    const lo = Math.min(...wins), hi = Math.max(...wins);
    const winHtml = wins.length ? `; measured over ${esc(lo === hi ? hours(lo) : lo.toFixed(1) + '-' + hours(hi))}` : '';
    const flagsHtml = (known.some(r => isNum(r.windowH) && r.windowH < SHORT_WINDOW_H) ? ' (short window)' : '')
      + (known.some(r => r.stale) ? ' <span class="badge bad">stale</span>' : '');
    headlineHtml = `${esc(head)}: <b>${esc(usd(day))}/day</b>, ${esc(usd(day * 7))}/week (x7, extrapolated)${winHtml}${flagsHtml}`
      + `; from ${esc(known.length)} of ${esc(rs.length)} sources (chain/wallet)`
      + `<br><span class="muted">main wallet: sum of per-position accrual; watched wallets: wallet accrual, all positions</span>`;
  }
  return `<div class="agg-rate"><p>${headlineHtml}</p><ul>${srcHtml}</ul></div>`;
}

function tableHtml(title, head, rows, notCounted, rowHtml, payload, cols, extra) {
  if (!rows.length && !notCounted.length && !(extra && extra.always)) return `<section class="agg-sec"><h2>${esc(title)}</h2><p class="muted">Nothing to show.</p></section>`;
  const headHtml = head.map(([label, key]) => (key ? `<th data-sort="${esc(key)}" class="sortable">${esc(label)}</th>` : `<th>${esc(label)}</th>`)).join('');
  const bodyHtml = rows.map(it => rowHtml(payload, it)).join('');
  const countedRowsHtml = notCounted.map(it => rowHtml(payload, it)).join('');
  const groupHtml = notCounted.length ? `<tr class="group"><td colspan="${esc(cols)}">Not counted (${esc(notCounted.length)})</td></tr>${countedRowsHtml}` : '';
  const footRowHtml = extra && extra.foot ? extra.foot : '';
  const afterHtml = extra && extra.after ? extra.after : '';
  const footHtml = footRowHtml ? `<tfoot>${footRowHtml}</tfoot>` : '';
  return `<section class="agg-sec"><h2>${esc(title)}</h2><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}${groupHtml}</tbody>${footHtml}</table>${afterHtml}</section>`;
}

/** The test networks, on their own: never in a total, never with a USD figure. */
function testnetHtml(payload, sel) {
  const chains = (payload.chains || []).filter(c => c.testnet === true && (!sel.chains || sel.chains.has(c.key)));
  if (!chains.length) return '';
  const keys = new Set(chains.map(c => c.key));
  const items = (payload.items || []).filter(it => it.testnet === true && keys.has(it.chain) && (!sel.wallet || it.wallet.key === sel.wallet));
  const statusHtml = chains.map(c => `<span class="badge ${c.status === 'ok' ? 'good' : 'bad'}">${esc(c.label)}: ${esc(c.status)}</span>`).join(' ');
  const amountHtml = it => (it.decimalsUnverified && it.amountRaw ? esc(it.amountRaw) + ' wei <span class="badge warn">decimals unverified</span>' : esc(qty(it.amount)));
  const rowsHtml = items.map(it => `<tr><td>${esc(it.name || 'token')} <span class="badge warn">TESTNET</span></td><td>${esc(chainOf(payload, it.chain).label)}</td><td>${esc(it.wallet.label || shortAddr(it.wallet.address || it.wallet.key))}</td><td class="num">${amountHtml(it)}</td><td class="muted">no USD value, not counted</td></tr>`).join('');
  const bodyHtml = rowsHtml || '<tr><td colspan="5" class="muted">Nothing to show.</td></tr>';
  return `<section class="agg-sec agg-testnet"><h2>Testnets (not counted) <span class="badge warn">TESTNET</span></h2><p class="muted">Test tokens have no market value: nothing here is part of any total above.</p><p>${statusHtml}</p>`
    + `<table><thead><tr><th>Token</th><th>Chain</th><th>Wallet</th><th>Amount</th><th></th></tr></thead><tbody>${bodyHtml}</tbody></table></section>`;
}

function bannersHtml(payload, sel) {
  const out = [];
  for (const c of payload.chains || []) {
    if (c.status === 'ok') continue;
    if (c.testnet === true) {
      out.push(`<div class="banner ${esc(c.status)}" role="status" style="--accent:${esc(accentOf(c))}"><b>${esc(c.label)} (testnet) is ${esc(c.status)}</b> - shown on its own below; it is never part of the total</div>`);
      continue;
    }
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

function tileHtml(payload, t, items, filtered, sel) {
  // A wallet the chains could not read at all has no figure, not a zero one.
  const selWallet = sel && sel.wallet ? (payload.wallets || []).find(w => w.key === sel.wallet && w.unavailable === true) : null;
  const notesHtml = [];
  if (payload.incomplete) notesHtml.push('<span class="badge warn">incomplete: some chains or parts are missing</span>');
  if (isNum(t.staleUsd) && t.staleUsd > 0) notesHtml.push(`<span class="badge bad">stale ${esc(usd(t.staleUsd))} included (last good data)</span>`);
  if (payload.truncated) notesHtml.push(filtered
    ? '<span class="badge warn">list truncated: the totals shown cover only the listed items</span>'
    : '<span class="badge warn">list truncated, totals cover everything</span>');
  if (selWallet) {
    return `<div class="tile"><div class="label">Total, counted</div><div class="grand">unavailable</div>`
      + `<div class="sub">${esc(selWallet.label || shortAddr(selWallet.address))} could not be read on any chain: no figure, not zero</div>`
      + `<div class="notes">${notesHtml.join(' ')}</div><div class="muted">${esc(items.length)} items shown</div></div>`;
  }
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
    return `<label class="chip" style="--accent:${esc(accentOf(c))}"><input type="checkbox" data-chip="${esc(c.key)}"${on ? ' checked' : ''}> ${esc(c.label)}${c.testnet === true ? ' <span class="badge warn">TESTNET</span>' : ''}</label>`;
  }).join('');
  const walletOptsHtml = (payload.wallets || []).map(w =>
    `<option value="${esc(w.key)}"${sel.wallet === w.key ? ' selected' : ''}>${esc(w.label || shortAddr(w.address))}${w.aliases && w.aliases.length ? ' (' + esc(w.aliases.join(', ')) + ')' : ''}</option>`).join('');
  const sortOptsHtml = Object.keys(SORTS).map(k => `<option value="${esc(k)}"${sel.sort === k ? ' selected' : ''}>${esc(k)}</option>`).join('');
  return `<div class="controls">${chipsHtml}<label>Wallet <select data-wallet><option value="">All wallets</option>${walletOptsHtml}</select></label>`
    + `<label>Sort <select data-sortsel>${sortOptsHtml}</select></label><button type="button" data-refresh>Refresh</button></div>`;
}

function breakdownHtml(payload, items, sel) {
  let by;
  if (isUnfiltered(payload, sel) && payload.breakdown) {
    const clean = o => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => isNum(v)));
    by = {
      chain: clean(payload.breakdown.byChain), wallet: clean(payload.breakdown.byWallet), protocol: clean(payload.breakdown.byProtocol),
      feesChain: payload.breakdown.feesByChain, feesWallet: payload.breakdown.feesByWallet,
    };
  } else by = breakdownFor(items);
  const total = Object.values(by.chain).reduce((a, b) => a + b, 0);
  const unknownKeys = new Set((payload.wallets || []).filter(w => w.holdingsUnknown).map(w => w.key));
  const feeCellHtml = (fmap, k) => {
    if (!fmap) return '';
    const v = fmap[k];
    return `<td class="num">${v === null ? 'no figure' : esc(isNum(v) ? 'fees ' + usd(v) : v === undefined ? 'fees ' + usd(0) : '-')}</td>`;
  };
  const sectionHtml = (title, map, label, extraRowsHtml, flagUnknown, fmap) => {
    const rowsHtml = Object.entries(map).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
      const unknown = flagUnknown === true && unknownKeys.has(k);
      const badgeHtml = unknown ? ' <span class="badge warn">tokens unknown (discovery failed)</span>' : '';
      const atLeastHtml = unknown ? 'at least ' : '';
      return `<tr><td>${esc(label(k))}${badgeHtml}</td><td class="num">${atLeastHtml}${esc(usd(v))}</td><td class="num">${esc(pct(v, total))}</td>${feeCellHtml(fmap, k)}</tr>`;
    }).join('');
    const emptyHtml = rowsHtml || extraRowsHtml ? '' : '<tr><td class="muted">none</td></tr>';
    return `<section class="agg-sec half"><h2>${esc(title)}</h2><table><tbody>${rowsHtml}${extraRowsHtml}${emptyHtml}</tbody></table></section>`;
  };
  const downRowsHtml = (payload.chains || []).filter(c => c.testnet !== true && (c.status === 'down' || c.status === 'loading')).map(c => `<tr><td>${esc(c.label)}</td><td class="num muted">${esc(c.status)}, no figure</td><td></td><td class="num">no figure</td></tr>`).join('');
  const walletLabel = k => { const w = (payload.wallets || []).find(x => x.key === k); return w ? (w.label || shortAddr(w.address)) : shortAddr(k); };
  const chainHtml = sectionHtml('By chain', by.chain, k => chainOf(payload, k).label, downRowsHtml, false, by.feesChain || {});
  const walletHtml = sectionHtml('By wallet', by.wallet, walletLabel, '', true, by.feesWallet || {});
  const protocolHtml = sectionHtml('By protocol', by.protocol, k => k, '');
  return `<div class="agg-breakdown">${chainHtml}${walletHtml}${protocolHtml}</div>`;
}

const HEADS = {
  lp: [['Protocol', 'protocol'], ['Pair', 'name'], ['Chain', 'chain'], ['Wallet', 'wallet'], ['', null], ['Value', 'value'], ['Fees / pending rewards', 'fees'], ['ROI', 'roi']],
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
  return bannersHtml(payload, sel) + tileHtml(payload, t, items, isFiltered(payload, sel), sel) + controlsHtml(payload, sel)
    + tableHtml('LP positions', HEADS.lp, lpOk, lpNo, lpRowHtml, payload, 8, { foot: totalsRowHtml(payload, t, sel), after: ratesHtml(payload, sel), always: unavailableWallet(payload, sel) !== null })
    + tableHtml('Tokens', HEADS.token, tkOk, tkNo, tokenRowHtml, payload, 7)
    + tableHtml('Staking', HEADS.staking, stOk, stNo, stakingRowHtml, payload, 7)
    + breakdownHtml(payload, items, sel)
    + testnetHtml(payload, sel)
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
  module.exports = { esc, usd, qty, pct, renderPage, filterItems, totalsFor, clientTotals, breakdownFor, ratesFor, ratesHtml, totalsRowHtml, sortItems, initialSelection, bannersHtml, testnetHtml, lpRowHtml, tokenRowHtml, stakingRowHtml };
}
