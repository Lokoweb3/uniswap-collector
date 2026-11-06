// A network-free contract runner for the Slipstream reader tests. It decodes every
// call with one merged interface and answers from handlers registered per address:
// handlers return the function's outputs as an array (or throw to revert).
"use strict";
const { ethers } = require("ethers");

const SIGS = [
  "function balanceOf(address) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
  "function getPool(address,address,int24) view returns (address)",
  "function getPool(address,address,bool) view returns (address)",
  "function getPool(address,address,uint24) view returns (address)",
  "function voter() view returns (address)",
  "function isAlive(address) view returns (bool)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)",
  "function gauge() view returns (address)",
  "function nft() view returns (address)",
  "function rewardToken() view returns (address)",
  "function stakedValues(address) view returns (uint256[])",
  "function stakedContains(address,uint256) view returns (bool)",
  "function earned(address,uint256) view returns (uint256)",
  "function token0() view returns (address)",
  "function getReserves() view returns (uint256,uint256,uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];
const iface = new ethers.Interface([...new Set(SIGS)]);
const lc = (a) => String(a).toLowerCase();

function revert(msg = "reverted") { const e = new Error(msg); e.code = "CALL_EXCEPTION"; e.shortMessage = msg; return e; }

/** A world: handlers by address, code by address, a head, and logs. */
function world({ head = 1_000_000 } = {}) {
  const w = {
    head, handlers: {}, code: {}, logs: [], calls: [], logCalls: [], failLogs: null, hangLogs: false,
    on(addr, name, fn) { (w.handlers[lc(addr)] = w.handlers[lc(addr)] || {})[name] = fn; return w; },
    contract(addr, code = "0x6080") { w.code[lc(addr)] = code; return w; },
    /** the provider-like runner the readers are given */
    runner: {
      async call(tx) {
        const d = iface.parseTransaction({ data: tx.data });
        w.calls.push({ to: lc(tx.to), name: d.name, args: d.args.map((x) => (typeof x === "bigint" ? x : x)) });
        const h = (w.handlers[lc(tx.to)] || {})[d.name];
        if (!h) throw revert(`no handler ${lc(tx.to)}.${d.name}`);
        const res = await h(...d.args, tx);
        return iface.encodeFunctionResult(d.fragment, res);
      },
      async getCode(a) { return w.code[lc(a)] || "0x"; },
      async getBlockNumber() { return w.head; },
      async getLogs(f) {
        w.logCalls.push({ fromBlock: Number(f.fromBlock), toBlock: Number(f.toBlock), topics: f.topics, address: f.address });
        if (w.hangLogs) return new Promise(() => {}); // an RPC that never answers
        if (w.failLogs) throw new Error(typeof w.failLogs === "string" ? w.failLogs : "range too large");
        return w.logs.filter((l) => {
          if (f.address && lc(l.address) !== lc(f.address)) return false;
          if (l.blockNumber < Number(f.fromBlock) || l.blockNumber > Number(f.toBlock)) return false;
          return (f.topics || []).every((t, i) => t == null || lc(l.topics[i]) === lc(t));
        });
      },
    },
    /** a Transfer(from,to,id) log of `address` at `block` */
    transfer(address, from, to, id, block) {
      w.logs.push({
        address, blockNumber: block,
        topics: [ethers.id("Transfer(address,address,uint256)"), ethers.zeroPadValue(from, 32), ethers.zeroPadValue(to, 32), ethers.zeroPadValue(ethers.toBeHex(id), 32)],
      });
      return w;
    },
    callsTo(addr, name) { return w.calls.filter((c) => c.to === lc(addr) && (!name || c.name === name)); },
  };
  return w;
}

module.exports = { world, revert, iface };
