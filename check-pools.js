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

// A scout row is usable only when every field the verdict depends on is present and numeric;
// a missing one would otherwise turn into NaN averages and a wrong verdict.
const NUM_FIELDS = ["bestAprPct", "bestTvl", "ownAprPct"];
function validRow(row) {
  if (!row || typeof row !== "object") return false;
  if (row.tokenId == null || typeof row.t !== "string" || typeof row.bestSibling !== "string") return false;
  return NUM_FIELDS.every(k => Number.isFinite(Number(row[k])));
}
function normalizeRow(row) {
  const out = { ...row, beats: !!row.beats };
  for (const k of NUM_FIELDS) out[k] = Number(row[k]);
  return out;
}

async function main() {
  const data = await get("http://127.0.0.1:8787/api/strategy/scout?days=3");
  const rawRows = Array.isArray(data?.rows) ? data.rows : [];
  const rows = rawRows.filter(validRow).map(normalizeRow);
  const skipped = rawRows.length - rows.length;
  if (skipped) console.warn(`Skipped ${skipped} malformed scout row(s) of ${rawRows.length}`);
  if (!rows.length) { console.log("No usable scout rows in the last 3 days."); return; }

  const byPos = new Map();
  for (const row of rows) {
    if (!byPos.has(row.tokenId)) byPos.set(row.tokenId, []);
    byPos.get(row.tokenId).push(row);
  }

  console.log("\n══════════════════════════════════════════════════");
  console.log(" Pool validation — last 3 days");
  console.log("══════════════════════════════════════════════════\n");

  for (const [tokenId, posRows] of byPos) {
    posRows.sort((a, b) => a.t.localeCompare(b.t));
    const latest = posRows[posRows.length - 1];

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

    console.log(`Position: ${latest.pair} #${tokenId} (${latest.wallet})`);
    console.log(`Current APR: ${Math.round(latest.ownAprPct)}%`);
    console.log(`─────────────────────────────────────────────────`);

    const siblingList = [...siblings.values()]
      .map(s => ({
        ...s,
        avgApr: Math.round(s.aprs.reduce((a,b)=>a+b,0)/s.aprs.length),
        maxApr: Math.round(Math.max(...s.aprs)),
        avgTvl: Math.round(s.tvls.reduce((a,b)=>a+b,0)/s.tvls.length),
        maxTvl: Math.round(Math.max(...s.tvls)),
        consistency: Math.round(s.beatCount/s.totalCount*100),
      }))
      .sort((a, b) => b.avgApr - a.avgApr);

    for (const s of siblingList) {
      const tvlOk  = s.avgTvl >= MIN_TVL;
      const aprOk  = s.avgApr > latest.ownAprPct * 1.5;
      const consOk = s.consistency >= 50;
      const verdict = tvlOk && aprOk && consOk ? "✅ MOVE CANDIDATE"
                    : !tvlOk                   ? "❌ TVL TOO LOW"
                    : !aprOk                   ? "⚪ NOT BETTER ENOUGH"
                    :                            "🟡 INCONSISTENT";
      console.log(`\n  ${s.name}`);
      console.log(`    APR  avg:${s.avgApr}% max:${s.maxApr}%`);
      console.log(`    TVL  avg:${tvlLabel(s.avgTvl)} max:${tvlLabel(s.maxTvl)}`);
      console.log(`    Beats yours: ${s.consistency}% of readings`);
      console.log(`    ${verdict}`);
    }
    console.log("\n");
  }
}

main().catch(e => console.error("Error:", e.message));
