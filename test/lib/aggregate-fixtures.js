// Builders for the cross-chain Portfolio tests. Every address is fake (0x000...nnn), every label is
// "Main" / "Wallet N", nothing here is a real wallet. Shapes follow what the instances answer
// (see test/fixtures/aggregate/live-shape-*.json for sanitised copies of the real ones).
"use strict";

const addr = (n) => "0x" + n.toString(16).padStart(40, "0");
const AT = 1794000000000;

/** A Uniswap-style position card. */
const lp = (id, extra = {}) => ({
  tokenId: String(id), nftId: String(id).replace(/^v4-/, ""), version: String(id).startsWith("v4-") ? 4 : 3,
  pair: "WETH / USDC", symbol0: "WETH", symbol1: "USDC", inRange: true, poolAddress: addr(9000 + Number(String(id).replace(/\D/g, ""))),
  valueUsd: 100, feesUsd: 1, feesOk: true, ...extra,
});
/** An `external` entry (other DEX): Aerodrome-style by default. */
const ext = (protocol, id, extra = {}) => ({
  protocol, tokenId: `${protocol}-${id}`, nftId: String(id), version: protocol, staked: false, gauge: null, gaugeKilled: false,
  rewards: null, pair: "AERO / USDC", symbol0: "AERO", symbol1: "USDC", inRange: true, valueUsd: 100, feesUsd: 0, feesOk: true, ...extra,
});
const reward = (usd, extra = {}) => ({ token: addr(7777), symbol: "AERO", amount: 5, usd, priceUsd: 2.5, ...extra });
const tok = (symbol, usd, extra = {}) => ({
  symbol, address: extra.native ? null : addr(100 + symbol.length * 7 + (symbol.charCodeAt(0) % 50)), native: false,
  amount: usd === null ? 1 : usd / 2, price: usd === null ? null : 2, usd, thin: false, ...extra,
});
const row = (symbol, wallet, price, extra = {}) => ({
  symbol, address: extra.native ? null : addr(100 + symbol.length * 7 + (symbol.charCodeAt(0) % 50)), native: false,
  wallet, pools: 0, fees: 0, price, walletUsd: price === null ? null : wallet * price, usd: price === null ? null : wallet * price,
  total: wallet, thin: false, source: "wallet", ...extra,
});

const positions = (owner, over = {}) => ({
  ok: true, at: AT, owner, ownerLabel: "Main", wethUsd: 2000, positions: [], external: [], closed: [], errors: [], notes: [], warnings: [], ...over,
});
const walletRow = (address, label, over = {}) => ({
  address, label, collect: false, ok: true, positions: [], external: [], closed: 0, errors: [], notes: [],
  holdings: { ok: true, walletUsd: 0, unpricedCount: 0, unscaled: [], tokens: [], tokenCount: 0 },
  totals: { count: 0, idle: 0, liquidityUsd: 0, uncountedUsd: 0, feesUsd: 0, rewardsUsd: 0, walletUsd: 0, totalUsd: 0 }, ...over,
});
const watch = (wallets = [], over = {}) => ({ ok: true, at: AT, wethUsd: 2000, wallets, totals: {}, refreshing: false, ...over });
const portfolio = (owner, rows = [], over = {}) => ({ ok: true, at: AT, owner, rows, totals: {}, partial: false, unpriced: [], series: [{ t: 1, total: 1 }], ...over });
const staking = (tokens = [], over = {}) => ({ ok: true, at: AT, tokens, wallets: [], ...over });
const stakeTok = (address, balance, usd, over = {}) => ({
  token: address, symbol: "sNET", label: "NET staking", underlying: addr(4040), balance, principal: balance, price: usd === null ? null : usd / balance, usd,
  rewards: { today: 0.1, d7: 0.7, d30: 3, total: 9, totalUsd: 90, d7Usd: 7, d30Usd: 30 }, aprPct: 12.5, daily: [{ x: 1 }], events: [{ y: 1 }], series: [{ z: 1 }], ...over,
});

/** Secrets the instances really put in /api/positions. They must never get out. */
const SECRET = {
  operator: addr(0xdead), rpcKey: "KEY-should-never-leak-123", keystore: "/home/x/keystore.json",
};
const withSecrets = (p) => ({
  ...p,
  operator: SECRET.operator, operatorGas: { eth: 1, symbol: "ETH", low: false }, unlock: { armed: true, until: 99 },
  ops: { lastRun: { t: "x", failures: [`rpc https://rpc.example/v2/${SECRET.rpcKey} failed`] } }, loops: { guardian: { label: "g" } }, alerts: { telegram: true },
  explorer: "https://explorer.example", rpc: `https://rpc.example/${SECRET.rpcKey}`, keystorePath: SECRET.keystore,
  errors: [`could not reach https://rpc.example/${SECRET.rpcKey}`], warnings: [{ message: `rpc https://rpc.example/${SECRET.rpcKey}` }],
  claimed: { status: "x" }, pnlUsd: 5, spark: [1], px: [1],
});

module.exports = { addr, AT, lp, ext, reward, tok, row, positions, walletRow, watch, portfolio, staking, stakeTok, SECRET, withSecrets };
