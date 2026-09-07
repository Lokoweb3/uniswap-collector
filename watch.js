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
const CONCURRENCY = 4;
const MAX_POSITIONS = 300; // a launchpad deployer wallet can own thousands; load the newest ones only
const tierLabel = (fee) => (fee == null ? "?" : `${+(Number(fee) / 10000).toFixed(3)}%`);

function create({ provider, npm, factory, cfg, u, v4, V4, priceSides, toFloat, getWethUsd, getPortfolio, getPrices }) {
  const discovery = new Map(); // address -> v4 discovery (own state file per wallet)
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
      out.push({ address, label: o.label ? String(o.label).slice(0, 40) : null });
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
        positions.push({
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
      ...w, ok: true, positions, closed, errors, known, truncated,
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

  return { refresh, readWallets, ownerLabel, get latest() { return latest; } };
}

module.exports = { create };
