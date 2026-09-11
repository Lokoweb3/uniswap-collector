/**
 * settings.js — the one source of configuration: settings.json.
 *
 * Sections (see settings.example.json):
 *   chain      rpcUrl, chainId, explorer
 *   wallets    main { address, label }, watched [ { address, label, collect } ]
 *   tokens     USDG, WETH (each address written once), usdReferenceFeeTier
 *   contracts  Uniswap v3 / v4 / v2 addresses (weth comes from tokens.WETH)
 *   collector  sweepDestination, thresholds, sweep, tokenIds, denylist, v4Collect, swapFeeTierOverrides
 *   vault      nft, tba, implementation, tokenId, feeSplitPct, feeSplitMax, withdrawAlertUsdg
 *   risk       memecoins [ rule blocks ], defaults, discovery, autoCollect, sell
 *   alerts     telegramChat (group), fallbackChat (personal), treasuryChat, dailySummary
 *   dashboard  port, collectMode
 *   portfolio, staking
 *
 * Secrets never live here: TELEGRAM_TOKEN, BLOCKSCOUT_API_KEY and the chat
 * provider keys stay in .env; the operator key stays in its keystore.
 *
 * load() returns the flat object the modules were written against (rpcUrl,
 * contracts, thresholds, memecoins, treasuryTBA, ...), derived from the
 * sections, so every module reads one file through one function. read()
 * returns the sections as written; save(mutate) edits them in place.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "settings.json");
const EXAMPLE = path.join(__dirname, "settings.example.json");

function read(file = FILE) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`${path.basename(file)} is missing: copy settings.example.json to settings.json and fill it in (node tools/migrate-settings.js converts an old config.json + wallets.json)`);
    throw err;
  }
  return JSON.parse(text);
}

const strip = (o) => { // drop "_..." comment keys from a section copy
  if (Array.isArray(o)) return o.map(strip);
  if (!o || typeof o !== "object") return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) if (!k.startsWith("_")) out[k] = strip(v);
  return out;
};

/** The flat configuration the modules use, from the sectioned file. */
function toLegacy(raw) {
  const s = strip(raw);
  const chain = s.chain || {}, wallets = s.wallets || {}, tokens = s.tokens || {}, col = s.collector || {}, vault = s.vault || {}, risk = s.risk || {}, al = s.alerts || {};
  const main = wallets.main && typeof wallets.main === "object" ? wallets.main : { address: wallets.main, label: "Main" };
  const cfg = {
    rpcUrl: chain.rpcUrl,
    chainId: chain.chainId,
    explorer: chain.explorer || "https://robinhoodchain.blockscout.com",
    ownerAddress: main.address,
    ownerLabel: main.label || "Main",
    sweepDestination: col.sweepDestination || main.address,
    contracts: { ...(s.contracts || {}), weth: tokens.WETH || (s.contracts || {}).weth },
    thresholds: col.thresholds || {},
    sweep: col.sweep || {},
    tokenIds: col.tokenIds || [],
    denylist: col.denylist || [],
    v4Collect: col.v4Collect || {},
    swapFeeTierOverrides: col.swapFeeTierOverrides || {},
    usdReference: { stable: tokens.USDG, feeTier: tokens.usdReferenceFeeTier ?? 100 },
    tokens,
    dashboard: s.dashboard || {},
    portfolio: s.portfolio || {},
    staking: s.staking || {},
    watchWallets: wallets.watched || [],
    wallets: { ownerLabel: main.label || "Main", list: wallets.watched || [] },
    treasuryTBA: vault.tba || null,
    treasuryNFT: vault.nft || null,
    treasuryImplementation: vault.implementation || null,
    treasuryTokenId: vault.tokenId ?? 1,
    feeSplitPct: vault.feeSplitPct ?? 10,
    feeSplitMax: vault.feeSplitMax ?? 20,
    treasuryWithdrawAlertUsdg: vault.withdrawAlertUsdg ?? 1000,
    memecoins: risk.memecoins || [],
    memecoinDefaults: risk.defaults || {},
    memecoinDiscovery: risk.discovery !== false,
    memecoinCollect: risk.autoCollect || {},
    memecoinSell: risk.sell || {},
    dailySummary: al.dailySummary || {},
    launchScanner: s.launchScanner || {},
    alerts: { telegramChat: al.telegramChat || "", fallbackChat: al.fallbackChat || "", treasuryChat: al.treasuryChat || "" },
  };
  return cfg;
}

/** The sectioned file from an old config.json (+ wallets.json), for tools/migrate-settings.js. */
function fromLegacy(c, w = null, chats = {}) {
  const pick = (o, keys) => { const out = {}; for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k]; return out; };
  const contracts = strip(c.contracts || {});
  const weth = contracts.weth; delete contracts.weth;
  const memecoins = (c.memecoins || []).map(strip);
  return {
    _comment: "LP dashboard + collector settings. One file: edit here, restart the dashboard (./start-all.sh). Secrets (TELEGRAM_TOKEN, BLOCKSCOUT_API_KEY, chat provider keys) live in .env only. settings.example.json is the template.",
    chain: { rpcUrl: c.rpcUrl, chainId: c.chainId, explorer: "https://robinhoodchain.blockscout.com" },
    wallets: {
      _comment: "main: the collector's own wallet (positions read, fees swept back to it). watched: extra wallets shown read-only; collect: true makes the collector also collect that wallet's positions (after it approves the operator on the v3/v4 position managers, Wallet page > Approvals) and deliver the swept fees back to that same wallet.",
      main: { address: c.ownerAddress, label: (w && w.owner && w.owner.label) || "Main" },
      watched: (w && Array.isArray(w.watched) ? w.watched : c.watchWallets || []).map((x) => pick(x, ["address", "label", "collect"])),
    },
    tokens: {
      _comment: "Each token address written once. USDG is the sweep target and the USD reference; WETH the wrapped native token. usdReferenceFeeTier: the v3 WETH/USDG pool tier used for USD pricing.",
      USDG: c.usdReference && c.usdReference.stable,
      WETH: weth,
      usdReferenceFeeTier: (c.usdReference && c.usdReference.feeTier) ?? 100,
    },
    contracts: { _comment: "Uniswap v3 (positionManager, factory, swapRouter02, quoterV2), v4 (positionManager, stateView, poolManager, universalRouter, quoter, permit2, pricingHooks) and v2Factory on Robinhood Chain.", ...contracts },
    collector: {
      _comment: "sweepDestination: where the main wallet's swept fees go (default the main wallet). thresholds: minWethPerPosition (collect when a position's fees are worth this much), maxGasPriceGwei, dailyGasCapEth, slippageBps, maxSwapValueWeth, minOperatorGasBalanceEth. sweep: enabled, target/targetToken/targetFeeTier (USDG), keepGasReserveEth (floor kept on the operator), gasTargetEth (float refilled from the sweep). tokenIds pins positions, denylist skips them, v4Collect covers v4 positions.",
      sweepDestination: c.sweepDestination,
      thresholds: strip(c.thresholds || {}),
      sweep: strip(c.sweep || {}),
      tokenIds: c.tokenIds || [],
      denylist: c.denylist || [],
      v4Collect: strip(c.v4Collect || {}),
      swapFeeTierOverrides: strip(c.swapFeeTierOverrides || {}),
    },
    vault: {
      _comment: "LOKOVault fee split: after each wallet's fees are swapped to USDG, feeSplitPct % goes to the vault's token-bound account (tba) and the rest to the wallet. tba null = split off. feeSplitMax caps the percentage; the NFT's own feeSplitPct() wins when it exposes one. withdrawAlertUsdg: Telegram reminder level.",
      nft: c.treasuryNFT || null, tba: c.treasuryTBA || null, implementation: c.treasuryImplementation || null, tokenId: c.treasuryTokenId ?? 1,
      feeSplitPct: c.feeSplitPct ?? 10, feeSplitMax: c.feeSplitMax ?? 20, withdrawAlertUsdg: c.treasuryWithdrawAlertUsdg ?? 1000,
    },
    risk: {
      _comment: "Risk guardian: every open position of every wallet is watched (v4 every 60 s, v3 every 5 min). memecoins: positions with their own rule block {tokenId, pair, alertPct, closePct, outOfRangeMinutes, tvlDropPct, feeFloorPerHour, collectedTargetUsd, autoClose, alertOnly, entryPrice}; every other position is discovered and uses defaults. alertOnly: true never closes. autoCollect: run the collector once a memecoin position holds minUsd of fees (at most every minIntervalMinutes). sell: sell fee tokens with no v3 route in their v4 pool (minUsd, maxImpactPct, hold list, confirm = ask on Telegram first).",
      memecoins,
      defaults: strip(c.memecoinDefaults || {}),
      discovery: c.memecoinDiscovery !== false,
      autoCollect: strip(c.memecoinCollect || {}),
      sell: strip(c.memecoinSell || {}),
    },
    alerts: {
      _comment: "Telegram chat ids (the bot token stays in .env as TELEGRAM_TOKEN). telegramChat: the group for position alerts; fallbackChat: your personal chat (used when the group is unset or refuses); treasuryChat: vault messages (default the group). dailySummary: the 08:00 line-up.",
      telegramChat: chats.group || "", fallbackChat: chats.main || "", treasuryChat: chats.treasury || "",
      dailySummary: strip(c.dailySummary || {}),
    },
    launchScanner: strip(c.launchScanner || {}),
    dashboard: strip(c.dashboard || {}),
    portfolio: strip(c.portfolio || {}),
    staking: strip(c.staking || {}),
  };
}

let cache = null, cacheMtime = 0;
/** The flat configuration; re-read when settings.json changes. */
function load({ file = FILE, fresh = false } = {}) {
  if (file === FILE && !fresh) {
    try {
      const m = fs.statSync(FILE).mtimeMs;
      if (cache && m === cacheMtime) return cache;
      cache = toLegacy(read(FILE)); cacheMtime = m;
      return cache;
    } catch (err) { if (err.code !== "ENOENT") throw err; }
  }
  return toLegacy(read(file));
}

/** { ownerLabel, list: [ { address, label, collect } ] } — what wallets.json used to hold. */
function wallets() {
  try { return load().wallets; } catch { return { ownerLabel: null, list: [] }; }
}

/** Edit settings.json in place: mutate(sections) then write. Returns the new flat configuration. */
function save(mutate, file = FILE) {
  const raw = read(file);
  mutate(raw);
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
  cache = null;
  return toLegacy(raw);
}

module.exports = { FILE, EXAMPLE, read, load, wallets, save, toLegacy, fromLegacy };
