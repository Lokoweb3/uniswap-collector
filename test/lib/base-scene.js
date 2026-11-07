// Shared scene for the Base collect tests: a mocked Base with two managers, a throwaway operator key, a fake signer.
// No network, no real key. Requiring this sets LP_DATA_DIR to a temp dir (removed on exit).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lp-base-collect-"));
process.env.LP_DATA_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });

const u = require("../../univ3");
const settings = require("../../settings");
const { runPass, MANAGER_ABI, makeReaders } = require("../../collector-base");
const { world, revert } = require("../fixtures/mock-chain");

const OWNER = "0xaDf94A20558E1E6d64c429F8F9f017169BF3d743", W11 = "0xFc1235E6523Becf4b329ed9ADf21750cfAF65Bfb";
const MGR_A = "0x827922686190790b37229fd06084350E74485b72", MGR_B = "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53";
const FAC_A = "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A", FAC_B = "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef";
const WETH = "0x4200000000000000000000000000000000000006", USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const POOL_A = "0x70aCDF2Ad0bf2402C957154f944c19Ef4e1cbAE1", POOL_B = "0x99cf3E8bfB02c300312c53Aac5D0B082e3D5975C";
const GAUGE = "0x41b2126661C673C2beDd208cC72E85DC51a5320a", VOTER = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5", AERO_POOL = "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d";
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631", POOL_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const ID_A = 79371151, ID_B = 8905958, TICK = -200300, E18 = 10n ** 18n;
const EVIL = "0x00000000000000000000000000000000000000ee";
const iface = new ethers.Interface(MANAGER_ABI);
const exampleRaw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "settings.base.example.json"), "utf8"));
const cfgOf = (mutate = () => {}, baseCollect) => {
  const raw = JSON.parse(JSON.stringify(exampleRaw));
  mutate(raw);
  if (baseCollect) raw.baseCollect = baseCollect;
  return settings.toLegacy(raw);
};
const enableMain = (r) => { r.wallets.main.collect = true; };

// the operator: a throwaway key, never the real one
const operatorKey = ethers.Wallet.createRandom();
const OP = operatorKey.address;

/** A mocked Base: two managers, one unstaked position each, owned by OWNER unless `o` says otherwise. */
function scene(o = {}) {
  const w = world();
  const approved = { [MGR_A]: true, [MGR_B]: true, ...(o.approved || {}) };
  const fees = { [MGR_A]: [2n * 10n ** 15n, 5_000_000n], [MGR_B]: [3n * 10n ** 15n, 1_000_000n], ...(o.fees || {}) };
  const ownerCalls = { [MGR_A]: 0, [MGR_B]: 0 };
  for (const [a, s, d] of [[WETH, "WETH", 18], [USDC, "USDC", 6], [AERO, "AERO", 18]]) w.on(a, "symbol", () => [s]).on(a, "decimals", () => [d]);
  w.on(POOL_FACTORY, "getPool", () => [AERO_POOL]).on(AERO_POOL, "token0", () => [AERO]).on(AERO_POOL, "getReserves", () => [1000n * E18, 600n * 10n ** 6n, 0n]);
  w.contract(GAUGE).contract(POOL_A).contract(POOL_B).contract(MGR_A).contract(MGR_B);
  const POS = (liq) => [0n, ethers.ZeroAddress, WETH, USDC, 100n, BigInt(TICK - 700), BigInt(TICK + 700), BigInt(liq), 0n, 0n, 0n, 0n];
  const dex = (mgr, fac, pool, id, holder) => {
    w.on(fac, "getPool", () => [pool]).on(fac, "voter", () => [VOTER]);
    w.on(pool, "slot0", () => [u.getSqrtRatioAtTick(TICK), BigInt(TICK), 0n, 1n, 1n, true]).on(pool, "gauge", () => [GAUGE]);
    w.on(mgr, "balanceOf", (who) => [who.toLowerCase() === OWNER.toLowerCase() && holder === OWNER ? 1n : 0n]).on(mgr, "tokenOfOwnerByIndex", () => [BigInt(id)]);
    w.on(mgr, "ownerOf", (x) => {
      if (BigInt(x) !== BigInt(id)) throw revert("nonexistent");
      ownerCalls[mgr]++;
      return [o.ownerAt ? o.ownerAt(mgr, ownerCalls[mgr]) : holder];
    });
    w.on(mgr, "positions", () => POS(5n * 10n ** 15n));
    w.on(mgr, "isApprovedForAll", (owner, op) => [approved[mgr] && op.toLowerCase() === OP.toLowerCase()]);
    w.on(mgr, "collect", (params, tx) => {
      // the owner's estimate (the reader) always works; the operator's simulation needs the approval
      if (tx && tx.from && tx.from.toLowerCase() === OP.toLowerCase() && !approved[mgr]) throw revert("Not approved");
      if (o.feesFail && mgr === MGR_A && tx && tx.from && tx.from.toLowerCase() !== OP.toLowerCase()) throw revert("collect failed");
      return fees[mgr];
    });
  };
  w.on(VOTER, "isAlive", () => [false]);
  w.on(GAUGE, "nft", () => [MGR_A]).on(GAUGE, "rewardToken", () => [AERO]).on(GAUGE, "stakedValues", () => [o.stakedA ? [BigInt(ID_A)] : []]);
  w.on(GAUGE, "stakedContains", () => [!!o.stakedA]).on(GAUGE, "earned", () => { throw revert("NA"); });
  dex(MGR_A, FAC_A, POOL_A, ID_A, o.stakedA ? GAUGE : OWNER);
  dex(MGR_B, FAC_B, POOL_B, ID_B, OWNER);
  if (o.chainId) w.chainId = o.chainId;
  if (o.gasEstimate !== undefined) w.gasEstimate = o.gasEstimate;
  if (o.feeData) w.feeData = o.feeData;
  return w;
}

/**
 * A fake operator signer: signs with the throwaway key and records what it signed (`signs`). It never broadcasts: the
 * mocked provider does (`w.broadcasts`), answering as the options say. `sent` lists the transactions that were broadcast.
 *   failFirst / sendError  the broadcast rejects (first one only / every one)
 *   status, gasUsed, wait  what the receipt says
 *   signTweak(tx)          alters the fields handed to the key (a signer that signs something else)
 *   broadcastResult(raw, hash)  replaces the broadcast answer (undefined, {}, other hash ...)
 *   key                    the wallet that signs (default: the operator's throwaway key)
 *   log                    shared call log: "sign" and "broadcast" are pushed in order
 */
function fakeSigner(w, { failFirst = false, status = 1, gasUsed = 120_000n, wait = null, sendError = null, signTweak = null, broadcastResult = null, log = null, key = operatorKey } = {}) {
  const s = { address: OP, sent: [], signs: [], failures: 0 };
  s.signTransaction = async (tx) => {
    if (log) log.push("sign");
    s.signs.push(tx);
    const f = signTweak ? signTweak({ ...tx }) : tx;
    return key.signTransaction({ type: 2, chainId: 8453n, nonce: f.nonce, to: f.to, data: f.data, value: f.value, gasLimit: f.gasLimit, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas });
  };
  w.onBroadcast = async (raw) => {
    if (log) log.push("broadcast");
    if (failFirst && s.failures === 0) { s.failures++; throw new Error("nonce too low"); }
    if (sendError) throw sendError;
    const parsed = ethers.Transaction.from(raw);
    if (broadcastResult) return broadcastResult(raw, parsed.hash);
    if (typeof w.nonce === "number") w.nonce++;
    s.sent.push({ from: parsed.from, to: parsed.to, data: parsed.data, value: parsed.value, chainId: parsed.chainId, type: parsed.type, nonce: parsed.nonce, gasLimit: parsed.gasLimit, maxFeePerGas: parsed.maxFeePerGas, maxPriorityFeePerGas: parsed.maxPriorityFeePerGas, raw });
    // Receipts are filled up to a well-formed one (hash, from, to, block) unless the test sets those keys itself.
    const fill = (rc) => (rc && typeof rc === "object" ? { hash: parsed.hash, from: parsed.from, to: parsed.to, blockNumber: 5, ...rc } : rc);
    const waitFn = wait || (async () => ({ status, gasUsed, gasPrice: 50_000_000n }));
    return { hash: parsed.hash, wait: async (...a) => {
      try { return fill(await waitFn(...a)); } catch (err) { if (err && err.receipt) err.receipt = fill(err.receipt); throw err; }
    } };
  };
  return s;
}

async function pass(w, { cfg, mode = "collect", signer = fakeSigner(w), state = { gasSpends: [] }, getSigner, operatorAddress = OP, ethUsd = 2000, extra = {} } = {}) {
  const lines = [];
  const saved = [];
  const readers = makeReaders({ cfg, provider: w.runner, dataDir: fs.mkdtempSync(path.join(TMP, "d-")), log: (l) => lines.push(l) });
  global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "text/html" }, json: async () => { throw new SyntaxError("html"); } });
  let signerCalls = 0;
  const res = await runPass({
    cfg, mode, provider: w.runner, operatorAddress, readers, state, saveState: (s) => saved.push(JSON.parse(JSON.stringify(s))),
    getSigner: getSigner || (async () => { signerCalls++; return signer; }), getEthUsd: async () => ethUsd, log: (l) => lines.push(l), now: () => Date.now(), sleep: async () => {}, ...extra,
  });
  return { res, lines, text: lines.join("\n"), signer, saved, state, signerCalls: () => signerCalls };
}

module.exports = { TICK, TMP, OWNER, W11, MGR_A, MGR_B, FAC_A, FAC_B, WETH, USDC, ID_A, ID_B, EVIL, E18, OP, operatorKey, iface, exampleRaw, cfgOf, enableMain, scene, fakeSigner, pass };
