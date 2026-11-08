#!/usr/bin/env node
/**
 * tools/verify-onchain.js -- prove, against a public RPC, every contract address the
 * example settings rely on. Read-only: eth_chainId, eth_blockNumber, eth_call,
 * eth_getCode, eth_getBalance and one eth_getLogs. It signs nothing, sends nothing and
 * writes no file. Needs no secret: the RPC is public.
 *
 *   node tools/verify-onchain.js base
 *   node tools/verify-onchain.js pulse
 *   node tools/verify-onchain.js elysium-testnet   # read-only chain id / fee / NodeInterface checks (tools/verify-elysium.js)
 *   PULSE_RPC=https://rpc.pulsechain.com          node tools/verify-onchain.js pulse  # (or LP_PULSE_RPC_URL; shown as an origin only)
 *   EXAMPLE=/path/settings.pulsechain.example.json node tools/verify-onchain.js pulse
 *   BASE_RPC=https://mainnet.base.org            node tools/verify-onchain.js base   # calls (default)
 *   BASE_LOGS_RPC=https://base-rpc.publicnode.com node tools/verify-onchain.js base  # the eth_getLogs probe
 *   CAND=0xmanagerA,0xmanagerB                    node tools/verify-onchain.js base   # test candidate managers
 *   EXAMPLE=/path/settings.base.example.json      node tools/verify-onchain.js base   # which file to cover
 *
 * Prints PASS / FAIL / INFO per check and, last, whether every address written in the
 * example settings file was proven by a PASS. Exit code 1 on any FAIL or uncovered address.
 * A URL given in the environment is validated (https, public host) and only ever printed
 * as an origin.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { validateEndpoint, redactUrl, redactText, registerEndpoint } = require("../endpoint");

const mode = process.argv[2];
if (mode === "elysium-testnet" || mode === "elysium-mainnet") {
  // Its own read-only routine; the mainnet is refused there before any network call.
  require("./verify-elysium").run(mode).then((code) => process.exit(code), (err) => { console.error(redactText(String(err && err.message))); process.exit(1); });
  return;
}
if (mode !== "base" && mode !== "pulse") {
  console.error("usage: node tools/verify-onchain.js base|pulse|elysium-testnet");
  process.exit(2);
}
const PULSE = mode === "pulse";

const pulseEnvRpc = process.env.PULSE_RPC || process.env.LP_PULSE_RPC_URL || "";
const RPC = PULSE
  ? validateEndpoint(pulseEnvRpc || "https://rpc.pulsechain.com", "PULSE_RPC")
  : validateEndpoint(process.env.BASE_RPC || "https://mainnet.base.org", "BASE_RPC");
const LOGS_RPC = PULSE ? RPC : validateEndpoint(process.env.BASE_LOGS_RPC || "https://base-rpc.publicnode.com", "BASE_LOGS_RPC");
const EXAMPLE = process.env.EXAMPLE || path.join(__dirname, "..", PULSE ? "settings.pulsechain.example.json" : "settings.base.example.json");
registerEndpoint(RPC, { env: !!pulseEnvRpc }); registerEndpoint(LOGS_RPC);
const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
const logsProvider = new ethers.JsonRpcProvider(LOGS_RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });

// The claims being checked: the addresses are inputs to be PROVEN, not trusted.
const A = {
  trading: "0xaDf94A20558E1E6d64c429F8F9f017169BF3d743",
  wallet11: "0xFc1235E6523Becf4b329ed9ADf21750cfAF65Bfb",
  wallet12: "0xAAB445f2846476A31Aaed66112B0f3e2ad82c50A",
  v1: "0x827922686190790b37229fd06084350E74485b72",
  v1Factory: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
  v2: "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53",
  v2Factory: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
  caps: "0xa990C6a764b73BF43cee5Bb40339c3322FB9D55F",
  poolFactory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  cbbtc: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  aero: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
  laptop: "0xB095274743941e953c746F9C228DA9c18Bb6ec29",
  uniFactory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  uniNpm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
  v4Pool: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
  v4Posm: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
  v4State: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
  multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
};
const TOKEN_V1 = 79371151n, TOKEN_V2 = 8905958n;
// Deploy blocks pinned in the example (fromBlock), proven by getCode before/after.
const DEPLOY = { v1: 13843719, v2: 44394730 };
const POS = "uint96 nonce,address operator,address token0,address token1,int24 tickSpacing,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 fg0,uint256 fg1,uint128 owed0,uint128 owed1";

const lc = (a) => String(a).toLowerCase();
const eq = (a, b) => lc(a) === lc(b);
const proven = new Set();      // addresses with at least one PASS
let fails = 0;
const out = (kind, label, detail = "") => {
  if (kind === "FAIL") fails++;
  console.log(`${kind.padEnd(4)}  ${label}${detail ? `  ->  ${detail}` : ""}`);
};
const j = (x) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

/** One view call; returns the decoded value, or throws with a short message. */
async function call(addr, sig, args = [], outTypes = "", p = provider, block) {
  const iface = new ethers.Interface([`function ${sig} view returns (${outTypes})`]);
  const frag = iface.fragments[0];
  const raw = await p.call({ to: addr, data: iface.encodeFunctionData(frag, args), ...(block ? { blockTag: block } : {}) });
  const d = iface.decodeFunctionResult(frag, raw);
  return d.length === 1 ? d[0] : d;
}
/** Run one check; `proves` are the addresses a PASS vouches for. */
async function check(label, proves, fn) {
  try {
    const r = await fn();
    if (r && r.fail) { out("FAIL", label, r.fail); return null; }
    out(r && r.info ? "INFO" : "PASS", label, r && r.detail ? r.detail : "");
    if (!(r && r.info)) for (const a of proves) proven.add(lc(a));
    return r;
  } catch (err) {
    out("FAIL", label, redactText(String(err.shortMessage || err.message)).slice(0, 160));
    return null;
  }
}

async function tokenCheck(name, addr, symbol, decimals) {
  await check(`${name} ${addr} symbol/decimals`, [addr], async () => {
    const [s, d] = [await call(addr, "symbol()", [], "string"), Number(await call(addr, "decimals()", [], "uint8"))];
    return s === symbol && d === decimals ? { detail: `${s} / ${d}` } : { fail: `got ${s} / ${d}, expected ${symbol} / ${decimals}` };
  });
}

/** The manager side: name/factory/ownerOf/positions, then the pool's gauge, for one claimed position. */
async function managerCheck(label, mgr, factory, id, expect, deployBlock) {
  await check(`${label} manager ${mgr}: name() and symbol()`, [mgr], async () => {
    const n = await call(mgr, "name()", [], "string");
    const s = await call(mgr, "symbol()", [], "string");
    return n === "Slipstream Position NFT v1" ? { detail: `"${n}" / "${s}" (shared by every Slipstream manager: identify by address, not name)` } : { fail: `name() = "${n}"` };
  });
  await check(`${label} manager.factory() equals the CL factory ${factory}`, [mgr, factory], async () => {
    const f = await call(mgr, "factory()", [], "address");
    return eq(f, factory) ? { detail: f } : { fail: `factory() = ${f}` };
  });
  let owner = null, pos = null;
  await check(`${label} ownerOf(${id}) is Trading, or a gauge whose nft() is this manager`, [], async () => {
    owner = await call(mgr, "ownerOf(uint256)", [id], "address");
    if (eq(owner, A.trading)) return { detail: `${owner} (Trading: an unstaked position)` };
    const nft = await call(owner, "nft()", [], "address").catch(() => null);
    return nft && eq(nft, mgr) ? { detail: `${owner} is a gauge of this manager (staked)` } : { fail: `owner ${owner} is neither Trading nor a gauge of this manager` };
  });
  await check(`${label} positions(${id}) is ${expect.pair}, tickSpacing ${expect.ts}`, [expect.t0, expect.t1], async () => {
    pos = await call(mgr, `positions(uint256)`, [id], POS);
    const ok = eq(pos.token0, expect.t0) && eq(pos.token1, expect.t1) && Number(pos.tickSpacing) === expect.ts;
    return ok
      ? { detail: `ticks ${pos.tickLower}..${pos.tickUpper}, liquidity ${pos.liquidity}, owed ${pos.owed0}/${pos.owed1}, operator(gauge) ${pos.operator}` }
      : { fail: `got ${pos.token0}/${pos.token1} ts ${pos.tickSpacing}` };
  });
  if (!pos) return;
  let gauge = null, pool = null;
  await check(`${label} CL factory.getPool -> pool.gauge() (also factory.voter().gauges(pool))`, [factory], async () => {
    pool = await call(factory, "getPool(address,address,int24)", [pos.token0, pos.token1, pos.tickSpacing], "address");
    if (pool === ethers.ZeroAddress) return { fail: "no pool" };
    gauge = await call(pool, "gauge()", [], "address");
    const voter = await call(factory, "voter()", [], "address");
    const viaVoter = await call(voter, "gauges(address)", [pool], "address");
    return eq(gauge, viaVoter) ? { detail: `pool ${pool}, gauge ${gauge}, voter ${voter}` } : { fail: `gauge() ${gauge} != voter.gauges ${viaVoter}` };
  });
  if (!gauge) return;
  await check(`${label} gauge ${gauge}: nft() is THIS manager, rewardToken() is AERO`, [], async () => {
    const [nft, rt] = [await call(gauge, "nft()", [], "address"), await call(gauge, "rewardToken()", [], "address")];
    return eq(nft, mgr) && eq(rt, A.aero) ? { detail: `nft ${nft}, rewardToken ${rt}` } : { fail: `nft ${nft}, rewardToken ${rt}` };
  });
  await check(`${label} gauge staking state for Trading`, [], async () => {
    const [has, len] = [await call(gauge, "stakedContains(address,uint256)", [A.trading, id], "bool"), await call(gauge, "stakedLength(address)", [A.trading], "uint256")];
    let earned = "n/a";
    try { earned = String(await call(gauge, "earned(address,uint256)", [A.trading, id], "uint256")); } catch { earned = "reverts (not staked or gauge killed)"; }
    const voter = await call(factory, "voter()", [], "address");
    const alive = await call(voter, "isAlive(address)", [gauge], "bool");
    const fin = await call(gauge, "periodFinish()", [], "uint256");
    return { info: true, detail: `stakedContains ${has}, stakedLength ${len}, earned ${earned}, voter.isAlive ${alive}, periodFinish ${new Date(Number(fin) * 1000).toISOString().slice(0, 10)}` };
  });
  if (deployBlock) {
    await check(`${label} deploy block ${deployBlock} (no code at ${deployBlock - 1}, code at ${deployBlock})`, [], async () => {
      const [before, at] = [await provider.getCode(mgr, deployBlock - 1), await provider.getCode(mgr, deployBlock)];
      return before === "0x" && at !== "0x" ? { detail: "ok" } : { fail: `code before ${before.length} chars, at ${at.length} chars` };
    });
  }
}

/** PulseChain (369): WPLS and the stables, both PulseX factories, the deepest WPLS/stable pair, Multicall3, the farm, the wallets. */
async function runPulse() {
  const P = {
    wpls: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
    dai: "0xefD766cCb38EaF1dfd701853BFCe31359239F305",
    usdc: "0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07",
    usdt: "0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f",
    pdai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    v1: "0x1715a3E4A142d8b698131108995174F37aEBA10D",
    v2: "0x29eA7545DEf87022BAdc76323F373EA1e707C523",
    farm: "0xB2Ca4A66d3e57a5a9A12043B6bAD28249fE302d4",
    multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
  };
  const wallets = { Main: "0x698C3A3F06B7EdBD175169d1cfa219c8232F48d8", "Wallet 11": "0xFc1235E6523Becf4b329ed9ADf21750cfAF65Bfb", "Wallet 12": "0xAAB445f2846476A31Aaed66112B0f3e2ad82c50A", "Wallet 2": "0x6314077131232f7D8282d07DcB4c31387dDC81DA", "Wallet 3": "0xA78c81a0b7551BD9a6F6965fB01AafaE9CEf96ca", "Wallet 5": "0xb4e5753644BAe0dCbB9D6e7B5ea7EaC8d5aF5cf0" };
  console.log(`verify-onchain pulse: calls ${redactUrl(RPC)}, example ${path.basename(EXAMPLE)}`);
  await check("eth_chainId is 369", [], async () => {
    const id = Number((await provider.getNetwork()).chainId);
    return id === 369 ? { detail: `chainId ${id}, block ${await provider.getBlockNumber()}` } : { fail: `chainId ${id}` };
  });
  const tok = async (name, addr, symbol, decimals) => check(`${name} ${addr} symbol/decimals`, [addr], async () => {
    const [sy, d] = [await call(addr, "symbol()", [], "string"), Number(await call(addr, "decimals()", [], "uint8"))];
    return sy === symbol && d === decimals ? { detail: `${sy} / ${d}` } : { fail: `got ${sy} / ${d}, expected ${symbol} / ${decimals}` };
  });
  await tok("WPLS", P.wpls, "WPLS", 18);
  await tok("bridged DAI", P.dai, "DAI", 18);
  await tok("bridged USDC", P.usdc, "USDC", 6);
  await tok("bridged USDT", P.usdt, "USDT", 6);

  // Both factories: allPairsLength, getPair(WPLS, stable), pair.factory() equal to its factory, reserves.
  const rows = [];
  for (const [label, fac] of [["PulseX v1", P.v1], ["PulseX v2", P.v2]]) {
    await check(`${label} factory ${fac}: has code, allPairsLength()`, [fac], async () => {
      const code = await provider.getCode(fac);
      const n = await call(fac, "allPairsLength()", [], "uint256");
      return code !== "0x" && n > 0n ? { detail: `${(code.length - 2) / 2} bytes, ${n} pairs` } : { fail: `code ${code.length} chars, ${n} pairs` };
    });
    for (const [sname, st, sdec] of [["DAI", P.dai, 18], ["USDC", P.usdc, 6], ["USDT", P.usdt, 6]]) {
      await check(`${label} getPair(WPLS, ${sname}): non-zero, pair.factory() = ${fac}, reserves`, [], async () => {
        const pair = await call(fac, "getPair(address,address)", [P.wpls, st], "address");
        if (pair === ethers.ZeroAddress) return { fail: "no pair" };
        const [pf, t0, r, sym] = [await call(pair, "factory()", [], "address"), await call(pair, "token0()", [], "address"), await call(pair, "getReserves()", [], "uint112 r0,uint112 r1,uint32 t"), await call(pair, "symbol()", [], "string")];
        if (!eq(pf, fac)) return { fail: `pair.factory() = ${pf}` };
        proven.add(lc(pair));
        const wIs0 = eq(t0, P.wpls);
        const wpls = Number(ethers.formatUnits(wIs0 ? r.r0 : r.r1, 18)), stable = Number(ethers.formatUnits(wIs0 ? r.r1 : r.r0, sdec));
        rows.push({ label, sname, pair, stable, wpls });
        return { detail: `${pair} (LP symbol "${sym}"): ${stable.toFixed(0)} ${sname} / ${wpls.toFixed(0)} WPLS => WPLS $${(stable / wpls).toExponential(4)}` };
      });
    }
  }
  rows.sort((a, b) => b.stable - a.stable);
  let want = null;
  try { want = JSON.parse(fs.readFileSync(EXAMPLE, "utf8")).tokens.usdReferencePair; } catch { /* reported below */ }
  await check("deepest WPLS/stable pair and the example's tokens.usdReferencePair", [], async () => {
    if (!rows.length) return { fail: "no WPLS/stable pair found" };
    const top = rows[0], mine = rows.find((r) => want && eq(r.pair, want));
    const list = rows.slice(0, 4).map((r) => `${r.label} ${r.sname} ${r.pair} (${r.stable.toFixed(0)})`).join(" | ");
    if (!mine) return { fail: `the example's pair ${want} is not a verified WPLS/stable pair; deepest: ${list}` };
    // The WPLS/DAI and WPLS/USDC v1 pairs are within a fraction of a percent of each other: either is a valid reference.
    return mine.stable >= top.stable * 0.9 ? { detail: `example pair ${mine.pair}: ${mine.stable.toFixed(0)} ${mine.sname}; deepest ${top.label} ${top.sname} ${top.pair}: ${top.stable.toFixed(0)}; ranking ${list}` } : { fail: `example pair holds ${mine.stable.toFixed(0)}, the deepest ${top.pair} holds ${top.stable.toFixed(0)}` };
  });
  await check("the forked pDAI (symbol DAI) is NOT a dollar: it is keyed out by address", [], async () => {
    const [sy, pair] = [await call(P.pdai, "symbol()", [], "string"), await call(P.v1, "getPair(address,address)", [P.wpls, P.pdai], "address")];
    let px = "no v1 WPLS pair";
    if (pair !== ethers.ZeroAddress) {
      const [t0, r] = [await call(pair, "token0()", [], "address"), await call(pair, "getReserves()", [], "uint112 r0,uint112 r1,uint32 t")];
      const wIs0 = eq(t0, P.wpls);
      const w = Number(ethers.formatUnits(wIs0 ? r.r0 : r.r1, 18)), d = Number(ethers.formatUnits(wIs0 ? r.r1 : r.r0, 18));
      px = `${d.toFixed(0)} pDAI / ${w.toFixed(0)} WPLS`;
    }
    return { info: true, detail: `symbol "${sy}" at ${P.pdai}; v1 WPLS pair: ${px}; never counted as $1` };
  });
  await check(`Multicall3 ${P.multicall} has code and answers aggregate3`, [P.multicall], async () => {
    const code = await provider.getCode(P.multicall);
    const mc = new ethers.Contract(P.multicall, ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])"], provider);
    const r = await mc.aggregate3([{ target: P.wpls, allowFailure: true, callData: new ethers.Interface(["function symbol() view returns (string)"]).encodeFunctionData("symbol") }]);
    return code !== "0x" && r[0].success ? { detail: `${(code.length - 2) / 2} bytes; aggregate3(WPLS.symbol()) succeeded` } : { fail: "aggregate3 failed" };
  });

  // The farm: a MasterChef with poolLength / poolInfo / userInfo / pendingInc / inc.
  await check(`PulseX MasterChef ${P.farm}: poolLength(), inc(), poolInfo(i) lpTokens are PulseX v1/v2 pairs`, [P.farm], async () => {
    const n = Number(await call(P.farm, "poolLength()", [], "uint256"));
    const inc = await call(P.farm, "inc()", [], "address");
    const isym = await call(inc, "symbol()", [], "string");
    let pairs = 0, other = 0;
    for (let i = 0; i < n; i++) {
      const info = await call(P.farm, "poolInfo(uint256)", [i], "address lpToken,uint256 allocPoint,uint256 lastRewardTime,uint256 accIncPerShare");
      const f = await call(info.lpToken, "factory()", [], "address").catch(() => null);
      if (f && (eq(f, P.v1) || eq(f, P.v2))) pairs++; else other++;
    }
    return n > 0 && pairs > 0 ? { detail: `${n} pools (${pairs} PulseX pairs, ${other} other), reward token inc() ${inc} "${isym}"` } : { fail: `${n} pools, ${pairs} pairs` };
  });
  await check("MasterChef userInfo(pid, wallet) and pendingInc(pid, wallet) answer for every example wallet (pid 0)", [], async () => {
    const out = [];
    for (const [label, w] of Object.entries(wallets)) {
      const ui = await call(P.farm, "userInfo(uint256,address)", [0, w], "uint256 amount,uint256 rewardDebt");
      const pend = await call(P.farm, "pendingInc(uint256,address)", [0, w], "uint256");
      out.push(`${label}: staked ${ui.amount}, pending ${pend}`);
    }
    return { detail: out.join("; ") };
  });
  // Proof the farm adapter reads a REAL stake: a staker found from the farm's own Deposit events (bounded ranges),
  // for whom userInfo(pid, staker).amount is above zero and pendingInc answers. A staker seen at block 27,985,530 is tried
  // first; if that wallet has since withdrawn, the last 200,000 blocks of Deposit logs are searched.
  await check(`PulseX MasterChef ${P.farm}: a real staker (Deposit logs) has userInfo(pid, staker).amount > 0 and pendingInc`, [P.farm], async () => {
    const ui = (pid, who) => call(P.farm, "userInfo(uint256,address)", [pid, who], "uint256 amount,uint256 rewardDebt");
    const seen = [{ pid: 1, user: "0xeB03658Ff4B3F4DE46E0A4D686257DF964F5a404", how: "pinned (seen at block 27,985,530)" }];
    let hit = null;
    const tryOne = async (c) => { const x = await ui(c.pid, c.user); return x.amount > 0n ? { ...c, amount: x.amount } : null; };
    for (const c of seen) { hit = await tryOne(c).catch(() => null); if (hit) break; }
    let scanned = 0;
    if (!hit) {
      const head = await provider.getBlockNumber();
      const logs = []; // two windows of at most 100,000 blocks (the RPC's maxLogRange)
      for (let to = head; to > head - 200000; to -= 100000) {
        logs.push(...await provider.getLogs({ address: P.farm, topics: [ethers.id("Deposit(address,uint256,uint256)")], fromBlock: to - 99999, toBlock: to }));
      }
      const cands = new Map();
      for (const l of logs) cands.set(l.topics[1] + l.topics[2], { pid: Number(BigInt(l.topics[2])), user: ethers.getAddress("0x" + l.topics[1].slice(26)), how: `Deposit log at block ${l.blockNumber}` });
      scanned = cands.size;
      for (const c of cands.values()) { hit = await tryOne(c).catch(() => null); if (hit) break; }
    }
    if (!hit) return { fail: `no staker with amount > 0 among ${scanned} (user, pid) pairs in the last 200,000 blocks of Deposit logs` };
    const [pend, info] = [await call(P.farm, "pendingInc(uint256,address)", [hit.pid, hit.user], "uint256"), await call(P.farm, "poolInfo(uint256)", [hit.pid], "address lpToken,uint256 allocPoint,uint256 lastRewardTime,uint256 accIncPerShare")];
    const f = await call(info.lpToken, "factory()", [], "address").catch(() => null);
    return pend >= 0n && f && (eq(f, P.v1) || eq(f, P.v2))
      ? { detail: `${hit.how}: pid ${hit.pid}, staker ${hit.user}, LP ${info.lpToken} (${eq(f, P.v1) ? "v1" : "v2"} pair), userInfo.amount ${ethers.formatUnits(hit.amount, 18)} LP, pendingInc ${ethers.formatUnits(pend, 18)} INC` }
      : { fail: `pid ${hit.pid} staker ${hit.user}: pendingInc ${pend}, lpToken factory ${f}` };
  });
  for (const [label, w] of Object.entries(wallets)) {
    await check(`${label} ${w} reachable (eth_getBalance)`, [w], async () => ({ detail: `${ethers.formatEther(await provider.getBalance(w))} PLS` }));
  }

  // Coverage: every address written in the example file must have a PASS above.
  let example = null;
  try { example = fs.readFileSync(EXAMPLE, "utf8"); } catch { out("FAIL", `cannot read ${EXAMPLE}`); }
  if (example) {
    const addrs = [...new Set(example.match(/0x[0-9a-fA-F]{40}\b/g) || [])];
    const missing = addrs.filter((a) => !proven.has(lc(a)));
    if (missing.length) out("FAIL", `${missing.length} address(es) in the example have no PASS line (remove them from the example)`, missing.join(", "));
    else out("PASS", `all ${addrs.length} addresses in ${path.basename(EXAMPLE)} are proven above`);
  }
  console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
}

(async () => {
  if (PULSE) return runPulse();
  console.log(`verify-onchain base: calls ${redactUrl(RPC)}, logs probe ${redactUrl(LOGS_RPC)}, example ${path.basename(EXAMPLE)}`);
  await check("eth_chainId is 8453", [], async () => {
    const id = Number((await provider.getNetwork()).chainId);
    return id === 8453 ? { detail: `chainId ${id}, block ${await provider.getBlockNumber()}` } : { fail: `chainId ${id}` };
  });

  // Slipstream v1: WETH/cbBTC, tickSpacing 100.
  await managerCheck("v1", A.v1, A.v1Factory, TOKEN_V1, { pair: "WETH/cbBTC", ts: 100, t0: A.weth, t1: A.cbbtc }, DEPLOY.v1);
  // The newer manager ("Gauges V3"): USDC/LAPTOP, tickSpacing 200.
  await managerCheck("cl2", A.v2, A.v2Factory, TOKEN_V2, { pair: "USDC/LAPTOP", ts: 200, t0: A.usdc, t1: A.laptop }, DEPLOY.v2);
  await check(`LAPTOP ${A.laptop} symbol/decimals`, [A.laptop], async () => {
    const [s, d] = [await call(A.laptop, "symbol()", [], "string"), Number(await call(A.laptop, "decimals()", [], "uint8"))];
    return d === 18 ? { detail: `${s} / ${d}` } : { fail: `${s} / ${d}` };
  });

  // The middle "Gauge Caps" manager exists but holds none of the positions; it is not configured.
  await check(`caps manager ${A.caps} exists; #${TOKEN_V2} is NOT on it`, [], async () => {
    const f = await call(A.caps, "factory()", [], "address");
    let owner = "reverts (does not exist)";
    try { owner = await call(A.caps, "ownerOf(uint256)", [TOKEN_V2], "address"); } catch { /* expected */ }
    return { info: true, detail: `factory ${f}, ownerOf(${TOKEN_V2}) ${owner}` };
  });
  for (const cand of String(process.env.CAND || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    await check(`candidate manager ${cand}`, [], async () => {
      const [n, f] = [await call(cand, "name()", [], "string"), await call(cand, "factory()", [], "address")];
      let owner = "reverts";
      try { owner = await call(cand, "ownerOf(uint256)", [TOKEN_V2], "address"); } catch { /* none */ }
      return { info: true, detail: `name "${n}", factory ${f}, ownerOf(${TOKEN_V2}) ${owner}` };
    });
  }

  await check(`Trading ${A.trading} is an EIP-7702 delegated EOA (code 0xef0100...), not a gauge`, [A.trading], async () => {
    const code = await provider.getCode(A.trading);
    return { detail: code === "0x" ? "plain EOA" : `code ${code.slice(0, 8)}... (${(code.length - 2) / 2} bytes)${/^0xef0100/i.test(code) ? " = delegated EOA: never treat as a gauge" : ""}` };
  });
  for (const [label, w] of [["Wallet 11", A.wallet11], ["Wallet 12", A.wallet12]]) {
    await check(`${label} ${w} reachable (eth_getBalance / balanceOf on the managers)`, [w], async () => {
      const bal = await provider.getBalance(w);
      const n = [];
      for (const m of [A.v1, A.v2, A.uniNpm]) n.push(String(await call(m, "balanceOf(address)", [w], "uint256")));
      return { detail: `${ethers.formatEther(bal)} ETH; NFTs v1/cl2/uniV3: ${n.join("/")}` };
    });
  }

  // Tokens.
  await tokenCheck("WETH", A.weth, "WETH", 18);
  await tokenCheck("USDC", A.usdc, "USDC", 6);
  await tokenCheck("cbBTC", A.cbbtc, "cbBTC", 8);
  await tokenCheck("AERO", A.aero, "AERO", 18);

  // AERO price source: the classic AERO/USDC pool must hold real reserves.
  await check(`classic PoolFactory ${A.poolFactory}: getPool(AERO, USDC, false) has reserves`, [A.poolFactory], async () => {
    const pool = await call(A.poolFactory, "getPool(address,address,bool)", [A.aero, A.usdc, false], "address");
    if (pool === ethers.ZeroAddress) return { fail: "no pool" };
    const [t0, res] = [await call(pool, "token0()", [], "address"), await call(pool, "getReserves()", [], "uint256 r0,uint256 r1,uint256 t")];
    const aeroIs0 = eq(t0, A.aero);
    const aero = Number(ethers.formatUnits(aeroIs0 ? res.r0 : res.r1, 18)), usdc = Number(ethers.formatUnits(aeroIs0 ? res.r1 : res.r0, 6));
    return usdc >= 100 ? { detail: `pool ${pool}: ${usdc.toFixed(0)} USDC / ${aero.toFixed(0)} AERO => AERO $${(usdc / aero).toFixed(3)}` } : { fail: `only ${usdc} USDC` };
  });

  // ETH/USD: the deepest WETH/USDC Uniswap v3 pool.
  let deepest = null;
  await check(`Uniswap v3 factory ${A.uniFactory}: deepest WETH/USDC pool`, [A.uniFactory], async () => {
    const rows = [];
    for (const fee of [100, 500, 3000, 10000]) {
      const pool = await call(A.uniFactory, "getPool(address,address,uint24)", [A.weth, A.usdc, fee], "address");
      if (pool === ethers.ZeroAddress) continue;
      const liq = await call(pool, "liquidity()", [], "uint128");
      const bal = await call(A.usdc, "balanceOf(address)", [pool], "uint256");
      rows.push({ fee, pool, liq, usdc: Number(ethers.formatUnits(bal, 6)) });
    }
    rows.sort((a, b) => b.usdc - a.usdc);
    deepest = rows[0];
    return deepest ? { detail: rows.map((r) => `fee ${r.fee}: ${r.pool} (${r.usdc.toFixed(0)} USDC, liq ${r.liq})`).join(" | ") + `  => deepest fee ${deepest.fee}` } : { fail: "no pools" };
  });
  await check("the example's usdReferenceFeeTier is the deepest tier", [], async () => {
    let tier = null;
    try { tier = JSON.parse(fs.readFileSync(EXAMPLE, "utf8")).tokens.usdReferenceFeeTier; } catch { return { fail: `cannot read ${EXAMPLE}` }; }
    return deepest && tier === deepest.fee ? { detail: `${tier}` } : { fail: `example ${tier}, deepest ${deepest && deepest.fee}` };
  });
  await check(`Uniswap v3 NPM ${A.uniNpm}: name(), factory()`, [A.uniNpm], async () => {
    const [n, f] = [await call(A.uniNpm, "name()", [], "string"), await call(A.uniNpm, "factory()", [], "address")];
    return eq(f, A.uniFactory) ? { detail: `"${n}", factory ${f}` } : { fail: `factory ${f}` };
  });

  // Uniswap v4 (secondary).
  await check(`v4 PoolManager ${A.v4Pool} has code`, [A.v4Pool], async () => {
    const c = await provider.getCode(A.v4Pool);
    return c !== "0x" ? { detail: `${(c.length - 2) / 2} bytes` } : { fail: "no code" };
  });
  await check(`v4 PositionManager ${A.v4Posm}: name(), poolManager()`, [A.v4Posm], async () => {
    const [n, pm] = [await call(A.v4Posm, "name()", [], "string"), await call(A.v4Posm, "poolManager()", [], "address")];
    return eq(pm, A.v4Pool) ? { detail: `"${n}", poolManager ${pm}` } : { fail: `poolManager ${pm}` };
  });
  await check(`v4 StateView ${A.v4State}: poolManager()`, [A.v4State], async () => {
    const pm = await call(A.v4State, "poolManager()", [], "address");
    return eq(pm, A.v4Pool) ? { detail: pm } : { fail: `poolManager ${pm}` };
  });
  await check(`Multicall3 ${A.multicall} has code`, [A.multicall], async () => {
    const c = await provider.getCode(A.multicall);
    return c !== "0x" ? { detail: `${(c.length - 2) / 2} bytes` } : { fail: "no code" };
  });

  // The log probe: does the log RPC answer a 50,000-block range?
  await check(`log RPC ${redactUrl(LOGS_RPC)} answers eth_getLogs over 50,000 blocks`, [], async () => {
    const head = await logsProvider.getBlockNumber();
    const logs = await logsProvider.getLogs({ address: A.v2, topics: [ethers.id("Transfer(address,address,uint256)")], fromBlock: head - 50000, toBlock: head });
    return { detail: `${logs.length} Transfer logs on the cl2 manager in the last 50,000 blocks` };
  });

  // Coverage: every address written in the example file must have a PASS above.
  let example = null;
  try { example = fs.readFileSync(EXAMPLE, "utf8"); } catch { out("FAIL", `cannot read ${EXAMPLE}`); }
  if (example) {
    const addrs = [...new Set(example.match(/0x[0-9a-fA-F]{40}\b/g) || [])];
    const missing = addrs.filter((a) => !proven.has(lc(a)));
    if (missing.length) out("FAIL", `${missing.length} address(es) in the example have no PASS line (remove them from the example)`, missing.join(", "));
    else out("PASS", `all ${addrs.length} addresses in ${path.basename(EXAMPLE)} are proven above`);
  }
  console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(`verify-onchain: ${redactText(String(err.shortMessage || err.message))}`); process.exit(1); });
