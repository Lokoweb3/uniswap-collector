// A network-free PulseChain for the v2 LP reader, the wallet tool and the server tests: ERC-20s, PulseX-style
// pairs and factories, a MasterChef farm and Multicall3, answered from memory. `runner` is what the readers
// are given as their provider (call / getCode / getBalance); `rpc(method, params)` is the same world behind
// JSON-RPC, for a spawned server. Everything is a view: there is no way to change the world through it.
"use strict";
const { ethers } = require("ethers");

const MC = "0xcA11bde05977b3631167028862bE2a173976CA11";
const SIGS = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function getPair(address,address) view returns (address)",
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
  "function poolLength() view returns (uint256)",
  "function poolInfo(uint256) view returns (address lpToken, uint256 allocPoint, uint256 lastRewardTime, uint256 accIncPerShare)",
  "function userInfo(uint256,address) view returns (uint256 amount, uint256 rewardDebt)",
  "function pendingInc(uint256,address) view returns (uint256)",
  "function inc() view returns (address)",
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)",
];
const iface = new ethers.Interface(SIGS);
const lc = (a) => String(a).toLowerCase();
const revert = (msg = "reverted") => { const e = new Error(msg); e.code = "CALL_EXCEPTION"; e.shortMessage = msg; return e; };
const units = (n, d) => ethers.parseUnits(String(n), d);

function world({ chainId = 369, multicall = true } = {}) {
  const w = {
    chainId, ents: {}, native: {}, calls: [], sub: [], reverts: 0, blockNumber: 27_900_000,
    multicall, failCall: null,
    // starve(to, name, n): an aggregate3 sub-call fails (success:false) but the same plain eth_call works (a gas-starved sub-call).
    // netFail(to, name): a transport failure: success:false inside aggregate3, a non-revert error from a plain eth_call.
    starve: null, netFail: null,
    /** an ERC-20 */
    token(addr, symbol, decimals = 18, balances = {}) {
      w.ents[lc(addr)] = { kind: "token", symbol, decimals, supply: 0n, balances: new Map(Object.entries(balances).map(([k, v]) => [lc(k), v])) };
      return addr;
    },
    /** a pair of `factory`; reserves/supply/balances in raw units */
    pair(addr, factory, t0, t1, r0, r1, supply, balances = {}) {
      w.ents[lc(addr)] = { kind: "pair", symbol: "PLP", decimals: 18, factory, t0, t1, r0, r1, supply, balances: new Map(Object.entries(balances).map(([k, v]) => [lc(k), v])) };
      const f = w.ents[lc(factory)] || (w.ents[lc(factory)] = { kind: "factory", pairs: [] });
      f.pairs.push(addr);
      return addr;
    },
    factory(addr) { w.ents[lc(addr)] = w.ents[lc(addr)] || { kind: "factory", pairs: [] }; return addr; },
    /** a MasterChef: pools [lpToken], stakes { "<pid>:<wallet>": [amount, pending] } */
    farm(addr, inc, pools, stakes = {}) { w.ents[lc(addr)] = { kind: "farm", inc, pools, stakes }; return addr; },
    setBalance(token, wallet, v) { w.ents[lc(token)].balances.set(lc(wallet), v); },
  };

  function answer(to, name, args) {
    if (w.failCall && w.failCall(lc(to), name, args)) throw revert("injected failure");
    const e = w.ents[lc(to)];
    if (!e) throw revert(`no contract at ${to}`);
    if (e.kind === "token" || e.kind === "pair") {
      if (name === "symbol") return [e.symbol];
      if (name === "decimals") return [e.decimals];
      if (name === "balanceOf") return [e.balances.get(lc(args[0])) || 0n];
      if (name === "totalSupply") return [e.kind === "pair" ? e.supply : e.supply];
    }
    if (e.kind === "pair") {
      if (name === "factory") return [e.factory];
      if (name === "token0") return [e.t0];
      if (name === "token1") return [e.t1];
      if (name === "getReserves") return [e.r0, e.r1, 0];
    }
    if (e.kind === "factory") {
      if (name === "allPairsLength") return [BigInt(e.pairs.length)];
      if (name === "allPairs") { const p = e.pairs[Number(args[0])]; if (!p) throw revert("out of range"); return [p]; }
      if (name === "getPair") {
        const a = lc(args[0]), b = lc(args[1]);
        const hit = e.pairs.find((p) => { const x = w.ents[lc(p)]; return (lc(x.t0) === a && lc(x.t1) === b) || (lc(x.t0) === b && lc(x.t1) === a); });
        return [hit || ethers.ZeroAddress];
      }
    }
    if (e.kind === "farm") {
      if (name === "poolLength") return [BigInt(e.pools.length)];
      if (name === "poolInfo") { const lp = e.pools[Number(args[0])]; if (!lp) throw revert("bad pid"); return [lp, 100n, 0n, 0n]; }
      if (name === "userInfo") return [(e.stakes[`${args[0]}:${lc(args[1])}`] || [0n, 0n])[0], 0n];
      if (name === "pendingInc") return [(e.stakes[`${args[0]}:${lc(args[1])}`] || [0n, 0n])[1]];
      if (name === "inc") return [e.inc];
    }
    throw revert(`no ${name} on ${e.kind} ${to}`);
  }

  function ethCall(tx) {
    const to = lc(tx.to);
    const d = iface.parseTransaction({ data: tx.data });
    if (to === lc(MC)) {
      if (!w.multicall) throw revert("no multicall");
      w.calls.push({ to, name: "aggregate3", n: d.args[0].length });
      const res = d.args[0].map((c) => {
        const sd = iface.parseTransaction({ data: c.callData });
        w.sub.push({ to: lc(c.target), name: sd.name });
        if (w.starve && w.starve(lc(c.target), sd.name, d.args[0].length)) return { success: false, returnData: "0x" };
        if (w.netFail && w.netFail(lc(c.target), sd.name)) return { success: false, returnData: "0x" };
        if (!w.ents[lc(c.target)] && lc(c.target) !== lc(MC)) return { success: true, returnData: "0x" };   // an address with no code answers with empty data
        try { return { success: true, returnData: iface.encodeFunctionResult(sd.fragment, answer(c.target, sd.name, sd.args)) }; } catch (err) { if (!c.allowFailure) throw err; w.reverts++; return { success: false, returnData: "0x" }; }
      });
      return iface.encodeFunctionResult(d.fragment, [res]);
    }
    w.calls.push({ to, name: d.name, n: 1 });
    w.sub.push({ to, name: d.name });
    if (w.netFail && w.netFail(to, d.name)) throw new Error("ECONNRESET");
    if (!w.ents[to]) return "0x";
    return iface.encodeFunctionResult(d.fragment, answer(tx.to, d.name, d.args));
  }

  w.runner = {
    async call(tx) { return ethCall(tx); },
    async getCode(a) { return lc(a) === lc(MC) ? (w.multicall ? "0x6080" : "0x") : w.ents[lc(a)] ? "0x6080" : "0x"; },
    async getBalance(a) { return w.native[lc(a)] || 0n; },
    async getBlockNumber() { return w.blockNumber; },
    async getNetwork() { return { chainId: BigInt(w.chainId) }; },
  };
  /** the same world as JSON-RPC (one request) */
  w.rpc = (method, params = []) => {
    switch (method) {
      case "eth_chainId": return ethers.toQuantity(w.chainId);
      case "net_version": return String(w.chainId);
      case "eth_blockNumber": return ethers.toQuantity(w.blockNumber);
      case "eth_getBalance": return ethers.toQuantity(w.native[lc(params[0])] || 0n);
      case "eth_getCode": return lc(params[0]) === lc(MC) ? "0x6080" : w.ents[lc(params[0])] ? "0x6080" : "0x";
      case "eth_call": return ethCall(params[0]);
      case "eth_gasPrice": return "0x1";
      case "eth_getBlockByNumber": return { number: ethers.toQuantity(w.blockNumber), hash: ethers.ZeroHash, parentHash: ethers.ZeroHash, timestamp: ethers.toQuantity(Math.floor(Date.now() / 1000)), nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: "0x1", gasUsed: "0x0", miner: ethers.ZeroAddress, extraData: "0x", transactions: [] };
      case "eth_getLogs": return [];
      default: throw revert(`unsupported ${method}`);
    }
  };
  return w;
}

module.exports = { world, revert, iface, units, MC };
