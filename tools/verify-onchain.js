#!/usr/bin/env node
/**
 * tools/verify-onchain.js -- prove, against a public RPC, every contract address the
 * example settings rely on. Read-only: eth_chainId, eth_blockNumber, eth_call,
 * eth_getCode, eth_getBalance and one eth_getLogs. It signs nothing, sends nothing and
 * writes no file. Needs no secret: the RPC is public.
 *
 *   node tools/verify-onchain.js base
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
if (mode !== "base") {
  console.error("usage: node tools/verify-onchain.js base");
  process.exit(2);
}

const RPC = validateEndpoint(process.env.BASE_RPC || "https://mainnet.base.org", "BASE_RPC");
const LOGS_RPC = validateEndpoint(process.env.BASE_LOGS_RPC || "https://base-rpc.publicnode.com", "BASE_LOGS_RPC");
const EXAMPLE = process.env.EXAMPLE || path.join(__dirname, "..", "settings.base.example.json");
registerEndpoint(RPC); registerEndpoint(LOGS_RPC);
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

(async () => {
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
