// Preloaded into a spawned server (node --require): a small Base answered from memory behind ethers' JSON-RPC
// transport, with the two Aerodrome Slipstream positions of settings.base.example.json (#79371151 on aerodrome-v1,
// #8905958 on aerodrome-cl2), both unstaked and owned by the Trading wallet. Anything else reverts. fetch() always
// fails. No socket is opened. $STUB_LOGS_FAIL=1 makes eth_getLogs refuse (a discovery scan that cannot finish); $STUB_V4 adds v4 NFTs (below). Calls are appended to $STUB_LOG as JSON lines: { kind, method|host }.
"use strict";
const fs = require("fs");
const { ethers } = require("ethers");
const u = require("../../univ3");
const { world, revert, iface } = require("./mock-chain");

const WALLET = "0xaDf94A20558E1E6d64c429F8F9f017169BF3d743";
const MGR_A = "0x827922686190790b37229fd06084350E74485b72", MGR_B = "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53";
const FAC_A = "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A", FAC_B = "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef";
const WETH = "0x4200000000000000000000000000000000000006", USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const POOL_A = "0x70aCDF2Ad0bf2402C957154f944c19Ef4e1cbAE1", POOL_B = "0x99cf3E8bfB02c300312c53Aac5D0B082e3D5975C";
const GAUGE = "0x41b2126661C673C2beDd208cC72E85DC51a5320a", VOTER = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631", AERO_POOL = "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d", POOL_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const TICK = -200300, E18 = 10n ** 18n;
const note = (o) => { if (process.env.STUB_LOG) { try { fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(o) + "\n"); } catch { /* ignore */ } } };

const w = world({ head: 30_000_000 });
for (const [a, s, d] of [[WETH, "WETH", 18], [USDC, "USDC", 6], [AERO, "AERO", 18]]) w.on(a, "symbol", () => [s]).on(a, "decimals", () => [d]);
w.on(POOL_FACTORY, "getPool", () => [AERO_POOL]).on(AERO_POOL, "token0", () => [AERO]).on(AERO_POOL, "getReserves", () => [1000n * E18, 600n * 10n ** 6n, 0n]);
w.on(VOTER, "isAlive", () => [false]);
w.on(GAUGE, "nft", () => [MGR_A]).on(GAUGE, "rewardToken", () => [AERO]).on(GAUGE, "stakedValues", () => [[]]).on(GAUGE, "stakedContains", () => [false]);
const dex = (mgr, fac, pool, id, collect) => {
  w.contract(mgr).contract(pool);
  w.on(fac, "getPool", () => [pool]).on(fac, "voter", () => [VOTER]);
  w.on(pool, "slot0", () => [u.getSqrtRatioAtTick(TICK), BigInt(TICK), 0n, 1n, 1n, true]).on(pool, "gauge", () => [GAUGE]);
  w.on(mgr, "balanceOf", (o) => [String(o).toLowerCase() === WALLET.toLowerCase() ? 1n : 0n]).on(mgr, "tokenOfOwnerByIndex", () => [BigInt(id)]);
  w.on(mgr, "ownerOf", (x) => { if (BigInt(x) !== BigInt(id)) throw revert("nonexistent"); return [WALLET]; });
  w.on(mgr, "positions", () => [0n, ethers.ZeroAddress, WETH, USDC, 100n, BigInt(TICK - 700), BigInt(TICK + 700), 5n * 10n ** 15n, 0n, 0n, 0n, 0n]);
  w.on(mgr, "collect", () => collect);
};
dex(MGR_A, FAC_A, POOL_A, 79371151, [2n * 10n ** 15n, 5_000_000n]);
dex(MGR_B, FAC_B, POOL_B, 8905958, [3n * 10n ** 15n, 1_000_000n]);
w.contract(GAUGE);
// the Uniswap v3 manager on Base: the wallet holds nothing there
w.contract("0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1").on("0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1", "balanceOf", () => [0n]);

// Optional Uniswap v4 on the Base example (the wallet's NFTs), switched on by $STUB_V4 = JSON
//   { "balance": 6, "owned": [1, 2], "foreign": { "22": "0x..." }, "ownedBy": { "0xlowercase": [3] }, "balances": { "0xlowercase": 3 } }
// balance = what balanceOf(wallet) answers on the v4 PositionManager (balances: other owners, default 0); owned = ids whose ownerOf is the wallet (each an open
// ETH/USDC position with liquidity); foreign = ids owned by another address; ownedBy = ids owned by the given other wallets; any other id reverts NOT_MINTED.
// Without $STUB_V4 the manager is unknown and nothing here is reachable.
const V4_CFG = process.env.STUB_V4 ? JSON.parse(process.env.STUB_V4) : null;
const V4_POSM = "0x7C5f5A4bBd8fD63184577525326123B519429bDc", V4_VIEW = "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71";
const v4iface = new ethers.Interface([
  "function ownerOf(uint256) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function getPositionLiquidity(uint256) view returns (uint128)",
  "function getPoolAndPositionInfo(uint256) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint256 info)",
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getFeeGrowthInside(bytes32,int24,int24) view returns (uint256, uint256)",
  "function getPositionInfo(bytes32,address,int24,int24,bytes32) view returns (uint128, uint256, uint256)",
]);
if (V4_CFG) w.contract(V4_POSM);
function v4Call(to, data) {
  const d = v4iface.parseTransaction({ data });
  const A = (...r) => v4iface.encodeFunctionResult(d.fragment, r);
  const id = d.args[0];
  note({ kind: "v4", name: d.name, id: String(id) });
  if (String(to).toLowerCase() === V4_VIEW.toLowerCase()) {
    if (d.name === "getSlot0") return A(u.getSqrtRatioAtTick(TICK), BigInt(TICK), 0n, 500n);
    if (d.name === "getFeeGrowthInside") return A(0n, 0n);
    return A(1n, 0n, 0n);
  }
  switch (d.name) {
    case "balanceOf": return A(BigInt(String(id).toLowerCase() === WALLET.toLowerCase() ? V4_CFG.balance : (V4_CFG.balances || {})[String(id).toLowerCase()] || 0));
    case "isApprovedForAll": return A(false);
    case "ownerOf": {
      if ((V4_CFG.owned || []).map(Number).includes(Number(id))) return A(WALLET);
      const f = (V4_CFG.foreign || {})[String(id)];
      if (f) return A(f);
      for (const [who, list] of Object.entries(V4_CFG.ownedBy || {})) if (list.map(Number).includes(Number(id))) return A(ethers.getAddress(who));
      const err = new Error("execution reverted"); err.data = ethers.concat(["0x08c379a0", ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["NOT_MINTED"])]); err.rpc = true; throw err;
    }
    case "getPositionLiquidity": return A(10n ** 12n);
    default: {
      const lo = TICK - 700, hi = TICK + 700;
      const packed = (BigInt(hi) & 0xffffffn) << 32n | (BigInt(lo) & 0xffffffn) << 8n;
      return A([ethers.ZeroAddress, USDC, 500, 10, ethers.ZeroAddress], packed);
    }
  }
}

const hex = (n) => "0x" + BigInt(n).toString(16);
async function answer(req) {
  const { method, params } = req;
  note({ kind: "rpc", method });
  try {
    switch (method) {
      case "eth_chainId": return hex(8453);
      case "net_version": return "8453";
      case "eth_blockNumber": return hex(w.head);
      case "eth_getCode": return await w.runner.getCode(params[0]);
      case "eth_getLogs": if (process.env.STUB_LOGS_FAIL) throw revert("range too large"); return [];
      case "eth_call": {
        const tx = params[0];
        if (V4_CFG && [V4_POSM, V4_VIEW].some((a) => a.toLowerCase() === String(tx.to).toLowerCase())) return v4Call(tx.to, tx.data || tx.input);
        const d = iface.parseTransaction({ data: tx.data || tx.input });
        if (!d) throw revert("unknown selector");
        return await w.runner.call({ to: tx.to, data: tx.data || tx.input });
      }
      default: throw revert(`unsupported ${method}`);
    }
  } catch (e) { const err = new Error("execution reverted"); err.rpc = true; err.data = e.data; throw err; }
}
const dispatch = async (req) => {
  try { return { jsonrpc: "2.0", id: req.id, result: await answer(req) }; }
  catch (e) { return { jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted", data: (e && e.data) || "0x" } }; }
};
ethers.FetchRequest.registerGetUrl(async (req) => {
  const body = JSON.parse(Buffer.from(req.body || new Uint8Array()).toString("utf8") || "null");
  const out = Array.isArray(body) ? await Promise.all(body.map(dispatch)) : await dispatch(body);
  return { statusCode: 200, statusMessage: "OK", headers: { "content-type": "application/json" }, body: Uint8Array.from(Buffer.from(JSON.stringify(out))) };
});
// $STUB_LOGS_ERR = text: every getLogs on any provider throws a plain Error with exactly that text (a secret-bearing
// message that discovery records as lastError).
if (process.env.STUB_LOGS_ERR) ethers.AbstractProvider.prototype.getLogs = async function () { throw new Error(process.env.STUB_LOGS_ERR); };
global.fetch = async (url) => { note({ kind: "fetch", host: new URL(String(url)).host }); throw new Error("fetch failed"); };
