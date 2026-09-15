/* Read-only panels: one fixed baseline per visit; refreshes never consume unseen changes. */
(() => {
  "use strict";
  const analytics = location.pathname.replace(/\/+$/, "") === "/analytics";
  const key = "lp:insights:last-visit:v1";
  let baseline = null;
  try { baseline = Number(localStorage.getItem(key)) || null; } catch {}
  const since = baseline || Date.now() - 86400000;
  const $ = id => document.getElementById(id);
  const node = (tag, text) => { const el = document.createElement(tag); if (text != null) el.textContent = text; return el; };
  const num = n => typeof n === "number" && Number.isFinite(n);
  const usd = n => num(n) ? n.toLocaleString(undefined, { style: "currency", currency: "USD" }) : "Unavailable";
  const pct = n => num(n) ? n.toFixed(1) + "%" : "Unavailable";
  let busy = false, latestAt = null;
  async function load() {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch("/api/insights?since=" + since, { cache: "no-store", signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error("unavailable");
      const d = await response.json();
      if (!d.ok) throw new Error("unavailable");
      latestAt = d.at;
      const fresh = d.freshness;
      $("insightsfresh").textContent = (fresh.stale ? "Stale observations" : "Latest observations") +
        (fresh.positionsAt ? " · " + new Date(fresh.positionsAt).toLocaleString() : " · positions not loaded") +
        (fresh.unpricedTokens == null ? " · main-wallet price coverage unknown" : fresh.unpricedTokens ? ` · ${fresh.unpricedTokens} unpriced main-wallet tokens` : " · main-wallet tokens priced") +
        (!fresh.watchAt || d.at - fresh.watchAt > 10 * 60000 ? " · watched-wallet observations unavailable or stale" : "");
      $("attentionitems").replaceChildren();
      for (const item of d.attention) {
        const card = node("article"); card.className = "insightcard";
        const a = node("a", item.title);
        a.href = item.href.startsWith("/") && !item.href.startsWith("//") ? item.href : "/";
        card.append(a, node("p", item.detail)); $("attentionitems").append(card);
      }
      if (!d.attention.length) $("attentionitems").append(node("p", "No attention items in the latest observations."));
      $("visitsince").textContent = (baseline && baseline === d.since ? "Since " : "Last 24 hours · no recent saved visit · since ") + new Date(d.since).toLocaleString() + ". Visit history stays in this browser.";
      $("visitchanges").replaceChildren(...d.changes.map(text => node("li", text)));
      $("weekscope").textContent = `${d.scope} · ${d.timezone}`;
      $("weekstatus").textContent = "Estimates from recorded history · updated " + new Date(d.at).toLocaleTimeString();
      $("weeknote").textContent = d.notes;
      const table = node("table"); table.className = "etable";
      const head = node("thead"), hr = node("tr");
      for (const label of ["Metric", ...d.weeks.map(w => w.label), "Change"]) { const th = node("th", label); th.scope = "col"; hr.append(th); }
      head.append(hr); table.append(head);
      const body = node("tbody");
      const metrics = [
        ["Value observation coverage", "coveragePct", pct, " pp"],
        ["Measured fees (estimate)", "feesUsd", usd], ["Recorded gas cost", "gasUsd", usd],
        ["Time in range (observed)", "timeInRangePct", pct, " pp"],
        ["Observed position-hours", "observedPositionHours", n => num(n) ? n.toFixed(1) : "Unavailable"],
        ["Wallet value change", "valueChangeUsd", usd], ["Recorded external transfers (net)", "recordedTransfersUsd", usd],
        ["Result after recorded transfers (estimate)", "resultUsd", usd],
        ["Return on starting value (estimate)", "returnPct", pct, " pp"],
      ];
      for (const [label, field, format, suffix] of metrics) {
        const row = node("tr"), title = node("th", label); title.scope = "row"; row.append(title);
        for (const week of d.weeks) row.append(node("td", format(week[field])));
        const a = d.weeks[0][field], b = d.weeks[1][field];
        row.append(node("td", num(a) && num(b) ? suffix ? (b - a).toFixed(1) + suffix : format(b - a) : "Unavailable"));
        body.append(row);
      }
      table.append(body); $("weektable").replaceChildren(table);
    } catch {
      $("insightsfresh").textContent = "Insights unavailable · existing observations may be stale. Retry with Refresh.";
      $("weekstatus").textContent = "Weekly comparison unavailable · any displayed figures are from the previous update.";
    } finally { busy = false; }
  }
  // Save on leaving/hiding the rendered page, not every background refresh.
  const save = () => { if (!analytics && latestAt) try { localStorage.setItem(key, String(latestAt)); } catch {} };
  window.addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", () => { if (document.hidden) save(); else load(); });
  $("reload").addEventListener("click", load);
  load(); setInterval(() => { if (!document.hidden) load(); }, 60000);
})();
