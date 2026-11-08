// Shared scene for the Base sweep tests: a mocked Base with the two managers, the four sweep tokens, their Uniswap v3 pools, the
// router and quoter, ERC-20 balances/allowances and a signer that "mines" every broadcast against that state. No network, no real key.
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const B = require("./base-scene"); // sets LP_DATA_DIR first
const u = require("../../univ3");
const SL = require("../../collector-base-sweep-logic");
const L = require("../../collector-base-logic");
const { world, revert, iface: chainIface } = require("../fixtures/mock-chain");

const { OP, OWNER, MGR_A, MGR_B, TMP, operatorKey, cfgOf, enableMain } = B;
const { USDC, ROUTER, QUOTER, FACTORY, ROUTES } = SL;
const WETH = ROUTES.WETH.token, CBBTC = ROUTES.cbBTC.token, LAPTOP = ROUTES.LAPTOP.token;
const OTHER = "0x940181a94A35A4569E4529A3CDfB74e38FD98631"; // a token with no route (AERO)
const NEW_OWNER = "0x00000000000000000000000000000000000000b1";
const lc = (a) => String(a).toLowerCase();
const E18 = 10n ** 18n;
const PRICE = { WETH: 2000, cbBTC: 60000, LAPTOP: 0.05 };
const CAP = { WETH: 18, cbBTC: 8, LAPTOP: 18 };
const COLLECT_T = ethers.id("Collect(uint256,address,uint256,uint256)");
const TRANSFER_T = ethers.id("Transfer(address,address,uint256)");
const coder = ethers.AbiCoder.defaultAbiCoder();
const pad = (a) => ethers.zeroPadValue(a, 32);
const VAULT = { tba: ethers.getAddress("0x00000000000000000000000000000000000b7a01"), nft: ethers.getAddress("0x00000000000000000000000000000000000b7a02"), impl: ethers.getAddress("0x00000000000000000000000000000000000b7a03"), reg: ethers.getAddress("0x000000006551c19487814612e58FE06813775758") };

/** sqrtPriceX96 and tick for `usd` USDC per whole token of the route. */
function priceOf(route, usd) {
  const raw = (usd * 1e6) / 10 ** route.decimals; // raw USDC per raw token
  const t0 = BigInt(route.token) < BigInt(USDC);
  const tick = Math.round(Math.log(t0 ? raw : 1 / raw) / Math.log(1.0001));
  return { tick, sqrt: u.getSqrtRatioAtTick(tick) };
}

/**
 * positions: [{ id, mgr, t0, t1, a0, a1 }]  (the fees each collect pays out)
 * o.price {WETH,cbBTC,LAPTOP} USD, o.impactBps default quote impact (10), o.poolUsdc, o.liquidity, o.twapOffset
 */
function sweepScene(o = {}) {
  const w = world();
  const S = { w, ev: [], bal: new Map(), allow: new Map(), mined: new Map(), owners: {}, pos: {}, quoteFor: {}, swapOut: {}, failNext: [], pools: {}, estimateFail: new Set(), mintedSwaps: 0, block: 4, hist: new Map() };
  const key = (t, a) => `${lc(t)}|${lc(a)}`;
  S.balance = (t, a) => S.bal.get(key(t, a)) || 0n;
  S.setBalance = (t, a, v) => { S.bal.set(key(t, a), BigInt(v)); return S; };
  S.add = (t, a, v) => S.setBalance(t, a, S.balance(t, a) + BigInt(v));
  S.allowance = (t, a, sp) => S.allow.get(`${key(t, a)}|${lc(sp)}`) || 0n;
  S.setAllowance = (t, a, sp, v) => { S.allow.set(`${key(t, a)}|${lc(sp)}`, BigInt(v)); return S; };

  const price = { ...PRICE, ...(o.price || {}) };
  for (const [sym, r] of Object.entries(ROUTES)) {
    const p = priceOf(r, price[sym]);
    S.pools[sym] = { route: r, tick: p.tick, sqrt: p.sqrt, liquidity: o.liquidity ?? 10n ** 15n, usdc: o.poolUsdc ?? 5_000_000n * 10n ** 6n, twapTick: p.tick, observeFails: false, feeActual: r.fee, factoryActual: FACTORY, token0Override: null };
    S.add(USDC, r.pool, S.pools[sym].usdc);
  }
  const mid = (sym, amountIn) => { const r = ROUTES[sym], t0 = BigInt(r.token) < BigInt(USDC) ? r.token : USDC; return SL.afterFee(SL.midOut({ sqrtPriceX96: S.pools[sym].sqrt, amountIn, tokenIn: r.token, token0: t0 }), r.fee); };
  S.mid = mid;
  S.quote = (sym, amountIn, impactBps = o.impactBps ?? 10) => (mid(sym, amountIn) * BigInt(10000 - impactBps)) / 10000n;
  const symOf = (token) => Object.keys(ROUTES).find((s) => lc(ROUTES[s].token) === lc(token));

  // ---- code and handlers
  for (const a of [ROUTER, QUOTER, FACTORY, USDC, OTHER, B.MGR_A, B.MGR_B, ...Object.values(ROUTES).flatMap((r) => [r.token, r.pool])]) w.contract(a);
  for (const t of [USDC, WETH, CBBTC, LAPTOP, OTHER]) {
    // balanceOf honours a numeric blockTag from the per-block snapshots taken around every mined tx (S.hist); no tag / a later tag = now.
    w.on(t, "balanceOf", (who, tx) => {
      const tag = tx && tx.blockTag !== undefined && tx.blockTag !== "latest" ? Number(tx.blockTag) : null;
      if (tag === null || !Number.isFinite(tag) || tag >= S.block + 1 || !S.hist.size) return [S.balance(t, who)];
      for (let b = tag; b >= 0; b--) if (S.hist.has(b)) return [S.hist.get(b).get(key(t, who)) || 0n];
      return [S.balance(t, who)];
    }).on(t, "allowance", (own, sp) => [S.allowance(t, own, sp)]);
    w.on(t, "decimals", () => [t === USDC ? (o.usdcDecimals ?? 6) : lc(t) === lc(CBBTC) ? 8 : 18]);
  }
  w.on(FACTORY, "getPool", (a, b, fee) => {
    const sym = symOf(lc(a) === lc(USDC) ? b : a);
    if (!sym || Number(fee) !== ROUTES[sym].fee) return [ethers.ZeroAddress];
    return [(o.getPool && o.getPool(sym)) || ROUTES[sym].pool];
  });
  for (const [sym, p] of Object.entries(S.pools)) {
    const a = p.route.pool, r = p.route;
    const [t0, t1] = BigInt(r.token) < BigInt(USDC) ? [r.token, USDC] : [USDC, r.token];
    w.on(a, "slot0", () => [p.sqrt, BigInt(p.tick), 0n, 100n, 100n, true]).on(a, "liquidity", () => [p.liquidity]).on(a, "fee", () => [p.feeActual]).on(a, "factory", () => [p.factoryActual]);
    w.on(a, "token0", () => [p.token0Override || t0]).on(a, "token1", () => [t1]);
    w.on(a, "observe", (ago) => { if (p.observeFails) throw revert("OLD"); return [[0n, BigInt(p.twapTick) * BigInt(ago[0])], [0n, 0n]]; });
  }
  w.on(QUOTER, "quoteExactInputSingle", (prm) => {
    const sym = symOf(prm[0]);
    if (!sym) throw revert("no pool");
    const q = S.quoteFor[sym] !== undefined ? (typeof S.quoteFor[sym] === "function" ? S.quoteFor[sym](prm[2]) : S.quoteFor[sym]) : S.quote(sym, prm[2]);
    return [q, 0n, 0n, 0n];
  });
  // positions
  S.addPosition = (p) => { S.pos[p.id] = { a0: 0n, a1: 0n, ...p }; S.owners[p.id] = p.owner || OWNER; return S; };
  for (const p of o.positions || []) S.addPosition(p);
  for (const mgr of [MGR_A, MGR_B]) {
    w.on(mgr, "ownerOf", (id) => { const p = S.pos[Number(id)]; if (!p || p.mgr !== mgr) throw revert("nonexistent"); return [S.owners[Number(id)]]; });
    w.on(mgr, "positions", (id) => { const p = S.pos[Number(id)]; if (!p) throw revert("nonexistent"); return [0n, ethers.ZeroAddress, p.t0, p.t1, 100n, 0n, 0n, 1n, 0n, 0n, 0n, 0n]; });
    w.on(mgr, "isApprovedForAll", () => [true]);
    w.on(mgr, "collect", (prm) => { const p = S.pos[Number(prm[0])]; if (!p) throw revert("nonexistent"); return [p.a0, p.a1]; });
  }
  w.gasEstimate = (tx) => {
    const d = chainIface.parseTransaction({ data: tx.data });
    if (S.estimateFail.has(d.name)) throw revert(`${d.name} would revert`);
    return { collect: 150_000n, approve: 50_000n, transfer: 60_000n, exactInputSingle: 200_000n }[d.name] || 100_000n;
  };
  w.receipts = (hash) => S.mined.get(hash) || null;

  // ---- the chain's reaction to a broadcast
  S.reveal = (hash) => { S.mined.set(hash, S.hidden.get(hash)); };
  S.txs = []; // every mined tx, decoded
  S.hooks = []; // fn(parsed, result) called after every mined tx took effect
  S.effect = (parsed) => { const r = S.rawEffect(parsed); for (const h of S.hooks) h(parsed, r); return r; };
  S.rawEffect = (parsed) => {
    const to = parsed.to, sel = parsed.data.slice(0, 10);
    const fail = S.failNext.findIndex((f) => f(parsed, sel));
    if (fail >= 0) { if (!S.failNext[fail].sticky) S.failNext.splice(fail, 1); return { status: 0, logs: [] }; }
    const logs = [];
    if (lc(to) === lc(MGR_A) || lc(to) === lc(MGR_B)) {
      const d = chainIface.parseTransaction({ data: parsed.data }); const prm = d.args[0]; const p = S.pos[Number(prm.tokenId)];
      if (!p || !p.mgr || lc(p.mgr) !== lc(to)) return { status: 0, logs };
      S.add(p.t0, prm.recipient, p.a0); S.add(p.t1, prm.recipient, p.a1);
      logs.push({ address: to, topics: [COLLECT_T, pad(ethers.toBeHex(prm.tokenId))], data: coder.encode(["address", "uint256", "uint256"], [prm.recipient, o.eventAmount0 ?? p.a0, o.eventAmount1 ?? p.a1]) });
      if (!o.keepFees) { p.a0 = 0n; p.a1 = 0n; }
      return { status: 1, logs: o.noCollectEvent ? [] : logs };
    }
    if (lc(to) === lc(ROUTER)) {
      const d = SL.ROUTER_IFACE.parseTransaction({ data: parsed.data }); const a = d.args[0]; const sym = symOf(a.tokenIn);
      if (S.balance(a.tokenIn, parsed.from) < a.amountIn || S.allowance(a.tokenIn, parsed.from, ROUTER) < a.amountIn) return { status: 0, logs };
      const out = S.swapOut[sym] !== undefined ? S.swapOut[sym] : S.quote(sym, a.amountIn);
      if (out < a.amountOutMinimum) return { status: 0, logs };
      S.add(a.tokenIn, parsed.from, -a.amountIn); S.setAllowance(a.tokenIn, parsed.from, ROUTER, S.allowance(a.tokenIn, parsed.from, ROUTER) - a.amountIn);
      S.add(USDC, a.recipient, out); S.add(USDC, S.pools[sym].route.pool, -out);
      if (!o.noSwapLog) logs.push({ address: USDC, topics: [TRANSFER_T, pad(S.pools[sym].route.pool), pad(a.recipient)], data: coder.encode(["uint256"], [out]) });
      return { status: 1, logs };
    }
    const d = SL.ERC20_IFACE.parseTransaction({ data: parsed.data });
    if (d.name === "approve") { S.setAllowance(to, parsed.from, d.args[0], d.args[1]); return { status: 1, logs }; }
    if (d.name === "transfer") {
      if (S.balance(to, parsed.from) < d.args[1] || S.stuckTo === lc(d.args[0])) return { status: 0, logs };
      if (!S.noBalanceMove) { S.add(to, parsed.from, -d.args[1]); S.add(to, d.args[0], d.args[1]); }
      logs.push({ address: to, topics: [TRANSFER_T, pad(parsed.from), pad(d.args[0])], data: coder.encode(["uint256"], [d.args[1]]) });
      return { status: 1, logs };
    }
    return { status: 0, logs };
  };

  /** A signer that signs with the throwaway key, "mines" through S.effect and records everything. */
  S.signer = (opt = {}) => {
    const s = { address: OP, signs: [], sent: [], getCalls: 0 };
    s.signTransaction = async (tx) => {
      S.ev.push({ k: "sign" });
      if (opt.maxSigns !== undefined && s.signs.length >= opt.maxSigns) throw new Error("CRASH: the process stopped before signing");
      s.signs.push(tx);
      const f = tx;
      return operatorKey.signTransaction({ type: 2, chainId: 8453n, nonce: f.nonce, to: f.to, data: f.data, value: f.value, gasLimit: f.gasLimit, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas });
    };
    w.onBroadcast = async (raw) => {
      const parsed = ethers.Transaction.from(raw);
      S.ev.push({ k: "broadcast", hash: parsed.hash });
      if (opt.broadcastError && opt.broadcastError(parsed)) throw new Error("rpc down");
      if (typeof w.nonce === "number") w.nonce++;
      s.sent.push({ from: parsed.from, to: parsed.to, data: parsed.data, value: parsed.value, nonce: parsed.nonce, gasLimit: parsed.gasLimit, maxFeePerGas: parsed.maxFeePerGas, maxPriorityFeePerGas: parsed.maxPriorityFeePerGas, hash: parsed.hash });
      if (opt.neverMined && opt.neverMined(parsed)) return { hash: parsed.hash, wait: () => new Promise(() => {}) }; // accepted by the node, not mined
      const prev = new Map(S.bal);
      const { status, logs } = S.effect(parsed);
      const bn = ++S.block; S.hist.set(bn - 1, prev); S.hist.set(bn, new Map(S.bal));
      const rc = { hash: parsed.hash, from: parsed.from, to: parsed.to, blockNumber: bn, status, gasUsed: (parsed.gasLimit * 4n) / 5n, gasPrice: 50_000_000n, logs };
      S.mined.set(parsed.hash, rc);
      S.txs.push({ ...s.sent[s.sent.length - 1], status });
      if (opt.revertNoReceipt && opt.revertNoReceipt(parsed)) { // the wait fails revert-class and the receipt cannot be found now; S.mined gets it when S.reveal(hash) runs
        S.mined.delete(parsed.hash); S.hidden = S.hidden || new Map(); S.hidden.set(parsed.hash, rc);
        return { hash: parsed.hash, wait: async () => { const e = new Error("execution reverted"); e.code = "CALL_EXCEPTION"; throw e; } };
      }
      if (opt.dropReceipt && opt.dropReceipt(parsed)) return { hash: parsed.hash, wait: () => new Promise(() => {}) }; // mined, but the process never saw it
      return { hash: parsed.hash, wait: async () => (opt.receiptTweak ? opt.receiptTweak(rc, parsed) || rc : rc) };
    };
    return s;
  };
  /** Mocked ERC-6551 vault. v overrides: accountResult, tbaCode(false), chainId, nftBound, tokenId, tbaOwner, nftOwner, revertAccount, revertToken, revertOwner. Returns the baseSweep.vault block. */
  S.vault = (v = {}) => {
    const cfg = { tba: VAULT.tba, nft: VAULT.nft, tokenId: 7, implementation: VAULT.impl, registry: VAULT.reg, salt: ethers.ZeroHash, expectedOwner: OWNER, splitPct: 10, maxSplitPct: 20, ...(v.cfg || {}) };
    w.contract(VAULT.reg).contract(VAULT.nft);
    // The allowlist is a frozen empty constant in code; tests that need a verifiable vault inject the mock implementation through the
    // vaultImplementations dependency of the pass (v.allowImpl === false injects an empty list). SL.VAULT_IMPLEMENTATIONS is never mutated.
    S.vaultImplementations = v.allowImpl !== false ? [VAULT.impl] : [];
    if (v.tbaCode !== false) w.contract(VAULT.tba);
    w.on(VAULT.reg, "account", () => { if (v.revertAccount) throw revert("account"); return [v.accountResult || VAULT.tba]; });
    w.on(VAULT.tba, "token", () => { if (v.revertToken) throw revert("token"); return [BigInt(v.chainId ?? 8453), v.nftBound || VAULT.nft, BigInt(v.tokenId ?? 7)]; });
    w.on(VAULT.tba, "owner", () => { if (v.revertOwner) throw revert("owner"); return [v.tbaOwner || OWNER]; });
    w.on(VAULT.nft, "ownerOf", () => [v.nftOwner || OWNER]);
    return cfg;
  };
  S.state = { gasSpends: [] };
  S.notes = [];
  S.noteFail = false;

  // ---- the ledger file (real atomic writer) and a fault hook
  S.dir = fs.mkdtempSync(path.join(TMP, "sweep-"));
  S.file = path.join(S.dir, "sweep-state.json");
  S.saves = 0; S.failSaveAt = null; S.reads = 0; S.exists = 0;
  S.io = {
    exists: () => { S.exists++; return fs.existsSync(S.file); },
    read: () => { S.reads++; return SL.readSweepState(S.file); },
    save: (ledger) => {
      S.saves++;
      if (S.failSaveAt && S.failSaveAt(S.saves, ledger)) throw new Error("disk full");
      L.writeFileAtomic(S.file, SL.serializeSweepState(ledger));
      S.ev.push({ k: "ledger", pending: ledger.jobs.flatMap((j) => [j.pending, ...j.legs.map((l) => l.pending)]).filter(Boolean).map((p) => p.tx) });
    },
  };
  S.init = () => SL.initSweepStateFile(S.file);
  S.ledger = () => JSON.parse(fs.readFileSync(S.file, "utf8"));

  S.readers = () => {
    const out = {};
    for (const [name, mgr] of [["aerodrome-v1", MGR_A], ["aerodrome-cl2", MGR_B]]) {
      out[name] = { positionsOf: async () => ({ errors: [], positions: Object.values(S.pos).filter((p) => p.mgr === mgr && (p.a0 > 0n || p.a1 > 0n)).map((p) => ({ nftId: p.id, pair: `${p.pairName || "X / Y"}`, feesUsd: o.feesUsd ?? 50, usd0: "usd0" in o ? o.usd0 : 1, usd1: "usd1" in o ? o.usd1 : 1, staked: false, feesOk: true })) }) };
    }
    return out;
  };

  /** One pass of the collector over this scene. opts: sweep (baseSweep overrides), mode, signer, extra (runPass deps), baseCollect. */
  S.run = async (opts = {}) => {
    const swCfg = opts.sweep === null ? undefined : { enabled: true, ...(opts.sweep || {}) };
    const cfg = cfgOf((raw) => { enableMain(raw); if (swCfg) raw.baseSweep = { ...(raw.baseSweep || {}), ...swCfg }; if (opts.raw) opts.raw(raw); }, opts.baseCollect);
    const signer = opts.signer || S.lastSigner || S.signer();
    S.lastSigner = signer;
    const events = S.ev;
    const extra = {
      readers: S.readers(), sweepIo: opts.noIo ? null : S.io, now: () => Date.now(),
      notify: opts.noNotify ? undefined : async (t) => { S.notes.push(t); if (S.noteFail) throw new Error("telegram down"); },
      saveState: (st) => { events.push({ k: "state", txs: st.gasSpends.map((e) => `${e.tx}:${e.kind}`) }); if (S.failStateAt && S.failStateAt(st)) throw new Error("state disk full"); },
      ...(S.vaultImplementations ? { vaultImplementations: S.vaultImplementations } : {}),
      ...(opts.extra || {}),
    };
    const r = await B.pass(S.w, { cfg, mode: opts.mode || "collect", signer, state: S.state, extra, ethUsd: 2000 });
    S.last = r;
    return r;
  };
  S.snap = () => JSON.stringify(S.ledger());
  return S;
}

/** The standard single-position scene: #79371151 on manager A holding WETH + USDC fees; #8905958 on B with cbBTC + USDC. */
const ID_A = B.ID_A, ID_B = B.ID_B;
const defaultPositions = () => [
  { id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: 2n * E18 / 100n, a1: 5_000_000n, pairName: "WETH / USDC" },
  { id: ID_B, mgr: MGR_B, t0: CBBTC, t1: USDC, a0: 100_000n, a1: 1_000_000n, pairName: "cbBTC / USDC" },
];

/** The decoded transactions a signer sent: [{ to, name, args, op }] where name is collect / approve / transfer / exactInputSingle. */
function decodeSent(signer) {
  return signer.sent.map((t) => {
    let name, args;
    if (lc(t.to) === lc(ROUTER)) { name = "exactInputSingle"; args = SL.ROUTER_IFACE.parseTransaction({ data: t.data }).args; }
    else if (lc(t.to) === lc(MGR_A) || lc(t.to) === lc(MGR_B)) { name = "collect"; args = chainIface.parseTransaction({ data: t.data }).args; }
    else { const d = SL.ERC20_IFACE.parseTransaction({ data: t.data }); name = d.name; args = d.args; }
    return { ...t, name, args };
  });
}

/** Which function a mined tx called (collect / approve / transfer / exactInputSingle). */
const kindOf = (parsed) => (lc(parsed.to) === lc(ROUTER) ? "exactInputSingle" : lc(parsed.to) === lc(MGR_A) || lc(parsed.to) === lc(MGR_B) ? "collect" : SL.ERC20_IFACE.parseTransaction({ data: parsed.data }).name);

module.exports = { ...B, VAULT, kindOf, sweepScene, defaultPositions, decodeSent, priceOf, USDC, ROUTER, QUOTER, FACTORY, ROUTES, WETH, CBBTC, LAPTOP, OTHER, NEW_OWNER, E18, SL, L, lc };
