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
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
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
  "function getL1Fee(bytes) view returns (uint256)",
  // sweep (additive): ERC-20, Uniswap v3 pool / quoter / SwapRouter02, ERC-6551 registry and account
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)",
  "function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
  "function factory() view returns (address)",
  "function token1() view returns (address)",
  "function observe(uint32[]) view returns (int56[],uint160[])",
  "function account(address,bytes32,uint256,address,uint256) view returns (address)",
  "function token() view returns (uint256,address,uint256)",
  "function owner() view returns (address)",
];
const iface = new ethers.Interface([...new Set(SIGS)]);
const lc = (a) => String(a).toLowerCase();
const ORACLE = "0x420000000000000000000000000000000000000f";

function revert(msg = "reverted") { const e = new Error(msg); e.code = "CALL_EXCEPTION"; e.shortMessage = msg; return e; }

/** A world: handlers by address, code by address, a head, and logs. */
function world({ head = 1_000_000 } = {}) {
  const w = {
    head, chainId: 8453n, feeData: { maxFeePerGas: 100_000_000n, gasPrice: 50_000_000n, maxPriorityFeePerGas: 1_000_000n }, gasEstimate: 150_000n,
    block: { baseFeePerGas: 30_000_000n }, l1Fee: 0n, ethBalance: 10n ** 18n, nonce: 7, receipts: [], receiptCalls: [], latestNonce: null, nonceCalls: [], broadcasts: [], onBroadcast: null, handlers: {}, code: {}, logs: [], calls: [], estimates: [], logCalls: [], failLogs: null, hangLogs: false,
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
      // The write-side reads a collector needs. Nothing here sends: a test's fake signer records what it was asked to send.
      async getNetwork() { return { chainId: w.chainId }; },
      async getFeeData() { return w.feeData; },
      async estimateGas(tx) {
        const d = iface.parseTransaction({ data: tx.data });
        w.estimates.push({ to: lc(tx.to), name: d.name, from: tx.from ? lc(tx.from) : null });
        if (typeof w.gasEstimate === "function") return w.gasEstimate(tx);
        return w.gasEstimate;
      },
      // OP-stack fee reads and the receipt lookups of the Base collect pass (all read-only).
      async getBlock() { return typeof w.block === "function" ? w.block() : w.block; },
      // "pending" is w.nonce; "latest" is w.latestNonce (defaults to w.nonce). A number or a function; an Error is thrown.
      async getTransactionCount(addr, tag) {
        w.nonceCalls.push(tag);
        const v = tag === "latest" && w.latestNonce !== null ? w.latestNonce : w.nonce;
        const n = typeof v === "function" ? v(tag) : v;
        if (n instanceof Error) throw n;
        return n;
      },
      // Records the raw bytes; the test (or the fake signer) decides what the network answers. Default: accepted, mined at once.
      async broadcastTransaction(raw) {
        w.broadcasts.push(raw);
        if (w.onBroadcast) return w.onBroadcast(raw);
        if (typeof w.nonce === "number") w.nonce++;
        return { hash: ethers.Transaction.from(raw).hash, wait: async () => ({ status: 1, gasUsed: 120_000n, gasPrice: 50_000_000n }) };
      },
      async getTransactionReceipt(hash) {
        w.receiptCalls.push(hash);
        const r = typeof w.receipts === "function" ? w.receipts(hash, w.receiptCalls.length) : w.receipts[w.receiptCalls.length - 1];
        if (r instanceof Error) throw r;
        return r || null;
      },
      async getCode(a) { return w.code[lc(a)] || "0x"; },
      async getBalance() { return typeof w.ethBalance === "function" ? w.ethBalance() : w.ethBalance; },
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
  w.on(ORACLE, "getL1Fee", () => [typeof w.l1Fee === "function" ? w.l1Fee() : w.l1Fee]);
  return w;
}

module.exports = { world, revert, iface };
