/**
 * Watched wallets: read-only position views for extra addresses listed in
 * config.json `watchWallets`. Each entry is "0x..." or { address, label }.
 *
 * Kept deliberately separate from the owner's pipeline: no fee snapshots, no
 * PnL basis, no range log, no collector eligibility. Just what the chain says
 * right now about each wallet's open v3 and v4 positions, priced the same way
 * as the owner's. The list is re-read from config.json on every refresh, so
 * adding a wallet needs no restart.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const EXPLORER = "https://robinhoodchain.blockscout.com";
// Fee accrual ledger for watched positions: the last snapshot per position
// (to diff against) and hourly USD buckets per wallet, kept forever.
const ACCRUAL_FILE = path.join(__dirname, "watch-accrual.json");
const HOUR = 3600 * 1000;
const CONCURRENCY = 4;
const MAX_POSITIONS = 300; // a launchpad deployer wallet can own thousands; load the newest ones only
const tierLabel = (fee) => (fee == null ? "?" : `${+(Number(fee) / 10000).toFixed(3)}%`);

function create({ provider, npm, factory, cfg, u, v4, V4, priceSides, toFloat, getWethUsd, getPortfolio, getPrices, pools, getOperator, getBasis, getCollectEvents }) {
  // === performance-attribution === PnL vs HODL for watched positions.
  // v3: the shared liquidity ledger (getBasis) + collect events (getCollectEvents),
  // the same maths as the main wallet's cards. v4: no per-token liquidity events
  // on the position manager, so the basis is the amounts first observed here
  // (watch-pnl-basis.json), which is close to the mint for positions found
  // within minutes and is marked approximate.
  const PNL_BASIS_FILE = path.join(__dirname, "watch-pnl-basis.json");
  let pnlBasis = {};
  try {
    pnlBasis = JSON.parse(fs.readFileSync(PNL_BASIS_FILE, "utf8"));
  } catch {}
  function pnlFor({ version, id, p, a0, a1, f0, f1, usd0, usd1, valueUsd, feesUsd }) {
    const out = { pnlUsd: null, pnlPct: null, pnlSince: null, pnlApprox: false, pnlLegs: null, pnlSource: null };
    if (usd0 == null || usd1 == null) return out;
    const dec0 = p.token0.decimals, dec1 = p.token1.decimals;
    let depositedUsd = null, withdrawnUsd = 0, since = null, adds = null, approx = false, source = null;
    if (version !== 4 && getBasis) {
      const b = getBasis(id.toString());
      if (b) {
        depositedUsd = toFloat(b.dep0, dec0) * usd0 + toFloat(b.dep1, dec1) * usd1;
        withdrawnUsd = toFloat(b.wd0, dec0) * usd0 + toFloat(b.wd1, dec1) * usd1;
        since = b.firstT; adds = b.increases || null; source = b.source || "rpc";
        approx = b.liq !== p.liquidity;
      }
    }
    if (depositedUsd == null) {
      const key = `${version}-${id}`;
      if (!pnlBasis[key]) {
        pnlBasis[key] = { t: Date.now(), a0, a1 };
        try { fs.writeFileSync(PNL_BASIS_FILE, JSON.stringify(pnlBasis)); } catch {}
      }
      const b = pnlBasis[key];
      depositedUsd = b.a0 * usd0 + b.a1 * usd1;
      since = b.t; approx = true; source = "first-seen";
    }
    let collectedUsd = 0, collects = 0;
    for (const e of (getCollectEvents && version !== 4 ? getCollectEvents(id.toString()) : []) || []) {
      collectedUsd += toFloat(e.fee0, dec0) * usd0 + toFloat(e.fee1, dec1) * usd1;
      collects++;
    }
    if (!(depositedUsd > 0)) return out;
    const pnlUsd = (valueUsd || 0) + (feesUsd || 0) + collectedUsd + withdrawnUsd - depositedUsd;
    return {
      pnlUsd, pnlPct: (pnlUsd / depositedUsd) * 100, pnlSince: since, pnlApprox: approx, pnlSource: source,
      pnlLegs: { deposited: depositedUsd, adds, withdrawn: withdrawnUsd, collected: collectedUsd, collects, held: valueUsd || 0, uncollected: feesUsd || 0 },
    };
  }
  const discovery = new Map(); // address -> v4 discovery (own state file per wallet)
  let accrual = { last: {}, hours: {} }; // last[wallet:tokenId] = {t,f0,f1}; hours[wallet][hourMs] = usd
  try {
    accrual = { ...accrual, ...JSON.parse(fs.readFileSync(ACCRUAL_FILE, "utf8")) };
  } catch {}
  const saveAccrual = () => {
    try {
      fs.writeFileSync(ACCRUAL_FILE, JSON.stringify(accrual));
    } catch {}
  };

  /**
   * Fees earned since the previous snapshot of each position, valued at the
   * current prices, added to the wallet's hourly bucket. A drop in either fee
   * amount means a collect happened in between; that interval is skipped
   * rather than guessed.
   */
  function recordAccrual(address, positions) {
    const now = Date.now();
    const key = address.toLowerCase();
    const hourKey = String(Math.floor(now / HOUR) * HOUR);
    const seen = new Set();
    for (const p of positions) {
      const k = `${key}:${p.tokenId}`;
      seen.add(k);
      const prev = accrual.last[k];
      if (prev && p.feesOk && p.fee0 >= prev.f0 && p.fee1 >= prev.f1 && p.usd0 != null && p.usd1 != null) {
        const usd = (p.fee0 - prev.f0) * p.usd0 + (p.fee1 - prev.f1) * p.usd1;
        if (usd > 0) {
          accrual.hours[key] = accrual.hours[key] || {};
          accrual.hours[key][hourKey] = +(((accrual.hours[key][hourKey] || 0) + usd).toFixed(4));
          p.earnedSinceLast = usd;
        }
      }
      if (p.feesOk) accrual.last[k] = { t: now, f0: p.fee0, f1: p.fee1 };
    }
    for (const k of Object.keys(accrual.last)) if (k.startsWith(key + ":") && !seen.has(k)) delete accrual.last[k];
    saveAccrual();
  }

  const dayOf = (ms) => {
    const d = new Date(Number(ms));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  /** Earned summary for a wallet from its hourly buckets. */
  function earnedFor(address) {
    const h = accrual.hours[address.toLowerCase()] || {};
    const now = Date.now();
    const daily = {};
    let today = 0, d7 = 0, d30 = 0, all = 0, h24 = 0;
    const todayKey = dayOf(now);
    for (const [ms, usd] of Object.entries(h)) {
      const t = Number(ms);
      const day = dayOf(t);
      daily[day] = (daily[day] || 0) + usd;
      all += usd;
      if (day === todayKey) today += usd;
      if (now - t <= 24 * HOUR) h24 += usd;
      if (now - t <= 7 * 24 * HOUR) d7 += usd;
      if (now - t <= 30 * 24 * HOUR) d30 += usd;
    }
    const days = Object.keys(daily).sort();
    return {
      today, d7, d30, all, h24,
      since: days.length ? days[0] : null,
      daily: days.slice(-60).map((day) => ({ day, usd: +daily[day].toFixed(2) })),
    };
  }
  let latest = null;
  let inFlight = null;

  /** wallets.json (owner label + watched list) if present, else config.watchWallets. */
  function readWalletFile() {
    try {
      const w = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets.json"), "utf8"));
      return { ownerLabel: (w.owner && w.owner.label) || null, list: Array.isArray(w.watched) ? w.watched : [] };
    } catch {}
    try {
      return { ownerLabel: null, list: JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")).watchWallets || [] };
    } catch {
      return { ownerLabel: null, list: [] };
    }
  }
  function ownerLabel() {
    return readWalletFile().ownerLabel;
  }

  function readWallets() {
    const list = readWalletFile().list;
    const out = [];
    const seen = new Set();
    for (const w of list) {
      const o = typeof w === "string" ? { address: w } : w || {};
      if (!o.address || !ethers.isAddress(o.address)) continue;
      const address = ethers.getAddress(o.address);
      if (address.toLowerCase() === String(cfg.ownerAddress).toLowerCase() || seen.has(address)) continue;
      seen.add(address);
      out.push({ address, label: o.label ? String(o.label).slice(0, 40) : null, collect: !!o.collect });
    }
    return out;
  }

  function discoveryFor(address) {
    if (!V4) return null;
    let d = discovery.get(address);
    if (!d) {
      d = v4.createDiscovery({
        provider,
        posmAddress: cfg.contracts.v4.positionManager,
        owner: address,
        explorerApi: `${EXPLORER}/api`,
        stateFile: path.join(__dirname, `v4-positions-${address.toLowerCase()}.json`),
      });
      discovery.set(address, d);
    }
    return d;
  }

  async function loadWallet(w, wethUsd) {
    // The position readers take the owner from cfg (fee simulation, v4 ownerOf check).
    const wcfg = { ...cfg, ownerAddress: w.address, tokenIds: [], denylist: [] };
    const ids = await u.listTokenIds(npm, w.address, []);
    const disc = discoveryFor(w.address);
    const v4Ids = disc ? await disc.discover(20) : [];
    let work = [...ids.map((id) => ({ id, version: 3 })), ...v4Ids.map((id) => ({ id: BigInt(id), version: 4 }))];
    const known = work.length;
    // Newest first (ids are minted in order), then cap.
    work.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0));
    const truncated = work.length > MAX_POSITIONS ? work.length - MAX_POSITIONS : 0;
    work = work.slice(0, MAX_POSITIONS);
    const positions = [];
    const errors = [];
    let closed = 0;
    let cursor = 0;
    const seenPrices = {};

    async function one({ id, version }) {
      try {
        const p =
          version === 4
            ? await v4.loadPosition({ provider, posm: V4.posm, stateView: V4.stateView, cfg: wcfg }, id)
            : await u.loadPosition({ provider, npm, factory, cfg: wcfg }, id);
        if (p.gone) { if (disc) disc.forget(id); return; }
        if (p.closed) { closed++; return; }
        const { usd0, usd1 } = priceSides(p, wethUsd);
        // Native ETH (v4, address zero) is not an ERC-20; the wallet's ETH balance is read separately.
        if (usd0 != null && p.token0.address && p.token0.address !== ethers.ZeroAddress) seenPrices[p.token0.address.toLowerCase()] = usd0;
        if (usd1 != null && p.token1.address && p.token1.address !== ethers.ZeroAddress) seenPrices[p.token1.address.toLowerCase()] = usd1;
        const a0 = toFloat(p.amounts.amount0, p.token0.decimals);
        const a1 = toFloat(p.amounts.amount1, p.token1.decimals);
        const f0 = toFloat(p.fees.amount0, p.token0.decimals);
        const f1 = toFloat(p.fees.amount1, p.token1.decimals);
        const valueUsd = usd0 == null || usd1 == null ? null : a0 * usd0 + a1 * usd1;
        const feesUsd = usd0 == null || usd1 == null ? null : f0 * usd0 + f1 * usd1;
        const span = p.tickUpper - p.tickLower;
        const raw = (p.currentTick - p.tickLower) / span;
        const pnl = pnlFor({ version, id, p, a0, a1, f0, f1, usd0, usd1, valueUsd, feesUsd }); // === performance-attribution ===
        positions.push({
          ...pnl,
          tokenId: version === 4 ? `v4-${id}` : id.toString(),
          nftId: id.toString(),
          version,
          pair: `${p.token0.symbol} / ${p.token1.symbol}`,
          symbol0: p.token0.symbol,
          symbol1: p.token1.symbol,
          token0: p.token0.address, // ZeroAddress = native ETH in a v4 pool
          token1: p.token1.address,
          feeTier: p.feeTier,
          feeTierLabel: tierLabel(p.feeTier),
          hooks: p.hooks && p.hooks !== ethers.ZeroAddress ? p.hooks : null,
          inRange: p.inRange,
          poolAddress: p.poolAddress,
          pool: pools ? await pools.forPosition({ version, poolAddress: p.poolAddress, token0: p.token0.address, token1: p.token1.address, usd0, usd1, decimals0: p.token0.decimals, decimals1: p.token1.decimals, feePct: p.feeTier != null ? Number(p.feeTier) / 10000 : null, symbol0: p.token0.symbol, symbol1: p.token1.symbol }) : null,
          amount0: a0, amount1: a1, fee0: f0, fee1: f1, usd0, usd1,
          feesOk: p.fees.ok,
          valueUsd, feesUsd,
          priceCurrent: p.prices.current, priceLower: p.prices.lower, priceUpper: p.prices.upper,
          railPos: Math.max(0, Math.min(1, raw)),
          rawPos: raw,
          toUpperPct: (p.prices.upper / p.prices.current - 1) * 100,
          toLowerPct: (1 - p.prices.lower / p.prices.current) * 100,
          tickLower: p.tickLower, tickUpper: p.tickUpper, currentTick: p.currentTick,
        });
      } catch (err) {
        errors.push({ tokenId: version === 4 ? `v4-${id}` : id.toString(), error: err.shortMessage || err.message });
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (cursor < work.length) await one(work[cursor++]); }));
    positions.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
    recordAccrual(w.address, positions);
    const earned = earnedFor(w.address);

    // Collector approval state for wallets the collector should collect for.
    let collector = null;
    const operator = getOperator ? getOperator() : null;
    if (w.collect && operator) {
      const abi = ["function isApprovedForAll(address,address) view returns (bool)"];
      const v3ok = await new ethers.Contract(cfg.contracts.positionManager, abi, provider).isApprovedForAll(w.address, operator).catch(() => null);
      const v4ok = V4 ? await new ethers.Contract(cfg.contracts.v4.positionManager, abi, provider).isApprovedForAll(w.address, operator).catch(() => null) : null;
      collector = { enabled: true, v3: v3ok, v4: v4ok };
    } else if (w.collect) collector = { enabled: true, v3: null, v4: null };

    // Tokens sitting in the wallet itself, valued like the owner's portfolio.
    let holdings = null;
    const pf = getPortfolio && getPortfolio();
    if (pf) {
      try {
        const extra = Object.keys(seenPrices);
        holdings = await pf.holdingsOf(w.address, { wethUsd, extraTokens: extra, prices: { ...(getPrices ? getPrices() : {}), ...seenPrices } });
      } catch (err) {
        errors.push({ tokenId: "wallet", error: err.shortMessage || err.message });
      }
    }
    const liquidityUsd = positions.reduce((s, p) => s + (p.valueUsd || 0), 0);
    const feesUsd = positions.reduce((s, p) => s + (p.feesUsd || 0), 0);
    const walletUsd = holdings ? holdings.walletUsd : null;
    return {
      ...w, ok: true, positions, closed, errors, known, truncated, earned, collector,
      holdings: holdings
        ? { ok: holdings.ok, walletUsd, unpricedCount: holdings.unpricedCount, tokens: holdings.rows, tokenCount: holdings.rows.length }
        : null,
      totals: {
        count: positions.length,
        idle: positions.filter((p) => !p.inRange).length,
        liquidityUsd,
        feesUsd,
        walletUsd,
        totalUsd: liquidityUsd + feesUsd + (walletUsd || 0),
      },
    };
  }

  async function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const wallets = readWallets();
      if (pools) await pools.refresh().catch(() => {});
      const wethUsd = wallets.length ? await getWethUsd() : null;
      const out = [];
      for (const w of wallets) {
        try {
          out.push(await loadWallet(w, wethUsd));
        } catch (err) {
          out.push({ ...w, ok: false, error: err.shortMessage || err.message, positions: [], closed: 0, errors: [], totals: null });
        }
      }
      const sum = (k) => out.reduce((s, w) => s + ((w.totals && w.totals[k]) || 0), 0);
      const totals = { wallets: out.length, liquidityUsd: sum("liquidityUsd"), feesUsd: sum("feesUsd"), walletUsd: sum("walletUsd") };
      totals.totalUsd = totals.liquidityUsd + totals.feesUsd + totals.walletUsd;
      latest = {
        ok: true, at: Date.now(), wethUsd, explorer: EXPLORER, wallets: out, totals,
        positionManager: cfg.contracts.positionManager,
        positionManagerV4: V4 ? cfg.contracts.v4.positionManager : null,
      };
      return latest;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return { refresh, readWallets, ownerLabel, get latest() { return latest; }, get inFlight() { return !!inFlight; } };
}

module.exports = { create };
