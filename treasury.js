/**
 * LOKOVault fee split, shared by the collector, the server and the alerts.
 *
 * settings.json: treasuryTBA (the vault's token-bound account, null = off),
 * feeSplitPct (default 10), feeSplitMax (hard cap, default 20). After a
 * wallet's collected fees are swapped to the sweep target (USDG), the split
 * goes to the TBA and the rest to the wallet. Every split, including a
 * failed TBA transfer (the wallet then receives everything), is appended to
 * fee-split-ledger.json.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const LEDGER_FILE = path.join(__dirname, "fee-split-ledger.json");

/**
 * The split percentage actually in force: the NFT contract's feeSplitPct()
 * (what the vault page's slider sets) when treasuryNFT is deployed, else
 * settings.json. Always capped by feeSplitMax.
 */
// Last value read from each NFT: a failed read (a throttled RPC) keeps reporting the
// percentage that is actually in force instead of falling back to settings.json,
// which made the split "change" 20% -> 10% -> 20% in the alerts on every 403.
const lastOnChain = new Map(); // nft address (lower) -> { pct, at }
async function effectiveSettings(cfg, provider) {
  const s = settings(cfg);
  if (cfg.treasuryNFT && ethers.isAddress(cfg.treasuryNFT) && provider) {
    const key = String(cfg.treasuryNFT).toLowerCase();
    try {
      const nft = new ethers.Contract(cfg.treasuryNFT, ["function feeSplitPct() view returns (uint256)"], provider);
      const onChain = Number(await nft.feeSplitPct());
      s.pct = Math.max(0, Math.min(s.max, onChain));
      s.pctSource = "on-chain";
      lastOnChain.set(key, { pct: s.pct, at: Date.now() });
    } catch {
      const cached = lastOnChain.get(key);
      if (cached) { s.pct = cached.pct; s.pctSource = "on-chain (cached)"; s.pctReadAt = cached.at; }
      else s.pctSource = "config";
    }
    s.enabled = !!s.tba && s.pct > 0;
  } else s.pctSource = "config";
  return s;
}

function settings(cfg) {
  const max = Math.max(0, Math.min(100, Number(cfg.feeSplitMax ?? 20)));
  const pct = Math.max(0, Math.min(max, Number(cfg.feeSplitPct ?? 10)));
  const tba = cfg.treasuryTBA && ethers.isAddress(cfg.treasuryTBA) ? ethers.getAddress(cfg.treasuryTBA) : null;
  return { tba, pct, max, enabled: !!tba && pct > 0 };
}

/** Integer split of a raw token amount (bigint) at pct percent. */
function split(amountRaw, pct) {
  const bp = BigInt(Math.round(pct * 100)); // hundredths of a percent
  const toVault = (amountRaw * bp) / 10000n;
  return { toVault, toOwner: amountRaw - toVault };
}

function readLedger() {
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function appendLedger(entry) {
  const rows = readLedger();
  rows.push(entry);
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(rows, null, 1));
}

/** Number of most recent consecutive entries whose TBA transfer failed. */
function consecutiveFailures() {
  let n = 0;
  for (const r of readLedger().reverse()) {
    if (r.status === "failed") n++;
    else break;
  }
  return n;
}

/** Summary for the dashboard / analytics: totals, by month, last entries. */
function summary() {
  const rows = readLedger();
  const byMonth = {};
  let total = 0, failed = 0;
  for (const r of rows) {
    if (r.status === "failed") { failed++; continue; }
    total += Number(r.splitUsdg) || 0;
    const m = String(r.timestamp).slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + (Number(r.splitUsdg) || 0);
  }
  return { count: rows.length, failed, totalSplitUsdg: +total.toFixed(2), byMonth, recent: rows.slice(-20).reverse() };
}

module.exports = { settings, effectiveSettings, split, readLedger, appendLedger, consecutiveFailures, summary, LEDGER_FILE };
