const http = require("http");
const MIN_TVL = 200_000;

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        // A 4xx/5xx body is an error page, not scout data: say so instead of a cryptic JSON parse failure.
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} from ${url}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch(e) { reject(new Error(`JSON parse ${url}: ${e.message}`)); }
      });
    }).on("error", reject);
  });
}

function tvlLabel(tvl) {
  return tvl >= 1_000_000 ? `$${(tvl/1_000_000).toFixed(1)}M`
       : tvl >= 1_000     ? `$${(tvl/1_000).toFixed(0)}K`
       : `$${Math.round(tvl)}`;
}

// A scout row is usable only when every field the verdict depends on is present and already a
// finite number: no coercion, because Number(null), Number("") and Number(false) are all 0 and
// would let a broken row through as a 0 % / $0 reading.
const NUM_FIELDS = ["bestAprPct", "bestTvl", "ownAprPct"];
const STR_FIELDS = ["t", "bestSibling", "pair", "wallet"];
function validRow(row) {
  if (!row || typeof row !== "object") return false;
  if (row.tokenId == null) return false;
  if (!STR_FIELDS.every(k => typeof row[k] === "string" && row[k].length > 0)) return false;
  return NUM_FIELDS.every(k => typeof row[k] === "number" && Number.isFinite(row[k]));
}
function normalizeRow(row) {
  return { ...row, beats: !!row.beats };
}

async function main() {
  const data = await get("http://127.0.0.1:8787/api/strategy/scout?days=3");
  const rawRows = Array.isArray(data?.rows) ? data.rows : [];
  const rows = rawRows.filter(validRow).map(normalizeRow);
  const skipped = rawRows.length - rows.length;
  if (skipped) console.warn(`Skipped ${skipped} malformed scout row(s) of ${rawRows.length}`);
  if (!rows.length) { console.log("No usable scout rows in the last 3 days."); return; }

  // One group per position, not per id: a v3 and a v4 position can share a tokenId and two
  // wallets can hold the same id, so the key carries the wallet and the version (when the row has one).
  const posKey = row => `${row.wallet}:${row.version ?? "?"}:${row.tokenId}`;
  const byPos = new Map();
  for (const row of rows) {
    const k = posKey(row);
    if (!byPos.has(k)) byPos.set(k, []);
    byPos.get(k).push(row);
  }

  console.log("\n══════════════════════════════════════════════════");
  console.log(" Pool validation — last 3 days");
  console.log("══════════════════════════════════════════════════\n");

  for (const posRows of byPos.values()) {
    posRows.sort((a, b) => a.t.localeCompare(b.t));
    const latest = posRows[posRows.length - 1];
    const tokenId = latest.tokenId;

    const siblings = new Map();
    for (const row of posRows) {
      const key = row.bestSibling;
      if (!siblings.has(key)) siblings.set(key, { name: key, aprs: [], tvls: [], beatCount: 0, totalCount: 0 });
      const s = siblings.get(key);
      s.aprs.push(row.bestAprPct);
      s.tvls.push(row.bestTvl);
      s.totalCount++;
      if (row.beats) s.beatCount++;
    }

    // The position's own APR over the whole window, not the single latest reading: one outlier
    // reading must not flip every sibling's verdict.
    const ownAvgApr = posRows.reduce((a, r) => a + r.ownAprPct, 0) / posRows.length;
    console.log(`Position: ${latest.pair} #${tokenId} (${latest.wallet})`);
    console.log(`Current APR: ${Math.round(latest.ownAprPct)}% (3-day avg ${Math.round(ownAvgApr)}%)`);
    console.log(`─────────────────────────────────────────────────`);

    // Comparisons use the unrounded values (49.5 % must not pass a 50 % bar); rounding is for display only.
    const siblingList = [...siblings.values()]
      .map(s => ({
        ...s,
        avgApr: s.aprs.reduce((a,b)=>a+b,0)/s.aprs.length,
        maxApr: Math.max(...s.aprs),
        avgTvl: s.tvls.reduce((a,b)=>a+b,0)/s.tvls.length,
        maxTvl: Math.max(...s.tvls),
        consistency: s.beatCount/s.totalCount*100,
      }))
      .sort((a, b) => b.avgApr - a.avgApr);

    for (const s of siblingList) {
      const tvlOk  = s.avgTvl >= MIN_TVL;
      const aprOk  = s.avgApr > ownAvgApr * 1.5;
      const consOk = s.consistency >= 50;
      const verdict = tvlOk && aprOk && consOk ? "✅ MOVE CANDIDATE"
                    : !tvlOk                   ? "❌ TVL TOO LOW"
                    : !aprOk                   ? "⚪ NOT BETTER ENOUGH"
                    :                            "🟡 INCONSISTENT";
      console.log(`\n  ${s.name}`);
      console.log(`    APR  avg:${Math.round(s.avgApr)}% max:${Math.round(s.maxApr)}%`);
      console.log(`    TVL  avg:${tvlLabel(s.avgTvl)} max:${tvlLabel(s.maxTvl)}`);
      console.log(`    Beats yours: ${Math.round(s.consistency)}% of readings`);
      console.log(`    ${verdict}`);
    }
    console.log("\n");
  }
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
