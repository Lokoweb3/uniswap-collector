// node test/claims-pipeline.test.js — the real path, end to end, against a fixed
// chain: background scanner -> claims store -> /api/claims -> card markup.
//
// server.js boots with its own temporary data directory and a settings.json whose
// only RPC is a local fake JSON-RPC in this process. Nothing reaches a real chain,
// the preview data or production. The fake chain holds four positions, one per
// claim state the card must tell apart:
//   #8240  complete: a collect, an add that realised fees (with a swap LATER in the
//          same block, so only the transaction-time price reconciles) and a withdrawal
//   #11989 complete with nothing realised: the one verified zero
//   #5555  a payout to someone other than the owner: undecodable, no figure
//   #7777  opened before the lookback floor: lookback reached, lifetime incomplete
// Then the server is restarted on the same data: nothing is counted twice.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { ethers } = require("ethers");
const u = require("../univ3");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PIPELINE_PORT || 8779);
const CHAIN_ID = 5042;
const HEAD = 5000;
const T0 = 1789000000;                         // block n has timestamp T0 + n (1 s blocks)
const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const POSM = "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b";
const SV = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const USDC = "0x3600000000000000000000000000000000000000";
const ARGUS = "0xece5ca8bf9220718e5727754026757512212cb3c";
const EURC = "0x89b50855aa3be2f677cd6303cec089b5f319d72a";
const OWNER = "0xb1cdc09b4c7f28365a8e7bfa2332af54f5462af5";
const STRANGER = "0x9999999999999999999999999999999999999999";
const ZERO = ethers.ZeroAddress;
const TOKENS = { [USDC]: ["USDC", 6], [ARGUS]: ["ARGUS", 18], [EURC]: ["EURC", 6] };

const coder = ethers.AbiCoder.defaultAbiCoder();
const pad = (a) => ethers.zeroPadValue(a, 32);
const hex = (n) => ethers.toQuantity(n);
const ML = ethers.id("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)");
const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const SWAP = ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const POOL_A = "0x" + "a1".repeat(32), POOL_E = "0x" + "e1".repeat(32);
const LO = -887200, HI = 887200;
// ~50 ARGUS per USDC at the add; a later swap in the same block moves it.
const P_TX = u.getSqrtRatioAtTick(315400), P_LATER = u.getSqrtRatioAtTick(316000);
const P_EURC = u.getSqrtRatioAtTick(-1400);

// ---- the fake chain ----------------------------------------------------------
const logs = [];            // every log, with blockNumber / transactionHash / index
const slot0 = [];           // { pool, fromBlock, sqrt }: price in force from a block on
let txn = 0;
function tx(block, entries) {
  const hash = ethers.id(`tx-${++txn}`);
  let idx = logs.filter((l) => l.blockNumber === block).reduce((m, l) => Math.max(m, l.index + 1), 0);
  for (const e of entries) logs.push({ ...e, blockNumber: block, transactionHash: hash, index: e.index ?? idx++ });
  return hash;
}
const mlog = (pool, tokenId, delta) => ({ address: PM, topics: [ML, pool, pad(POSM)],
  data: coder.encode(["int24", "int24", "int256", "bytes32"], [LO, HI, delta, pad(ethers.toBeHex(BigInt(tokenId)))]) });
const nft = (tokenId) => ({ address: POSM, topics: [TRANSFER, pad(ZERO), pad(OWNER), pad(ethers.toBeHex(BigInt(tokenId)))], data: "0x" });
const xfer = (token, from, to, v) => ({ address: token, topics: [TRANSFER, pad(from), pad(to)], data: pad(ethers.toBeHex(v)) });
const swapLog = (pool, sqrt) => ({ address: PM, topics: [SWAP, pool, pad(STRANGER)],
  data: coder.encode(["int128", "int128", "uint160", "uint128", "int24", "uint24"], [1n, -1n, sqrt, 1n, 0, 3000]) });
// What the pool takes for an add (rounded up) and pays for a removal (rounded down).
const { amountsFor } = require("../claims-store");
const need = (sqrt, L) => amountsFor(sqrt, LO, HI, L, true);
const pays = (sqrt, L) => amountsFor(sqrt, LO, HI, L, false);

slot0.push({ pool: POOL_A, fromBlock: 0, sqrt: P_TX });
slot0.push({ pool: POOL_E, fromBlock: 0, sqrt: P_EURC });
const L = 10n ** 15n;
const expect = { usdc: 0n, argus: 0n };

// #8240
tx(4000, [nft(8240), mlog(POOL_A, 8240, L), xfer(USDC, OWNER, PM, need(P_TX, L).amount0), xfer(ARGUS, OWNER, PM, need(P_TX, L).amount1)]);
tx(4200, [mlog(POOL_A, 8240, 0n), xfer(USDC, PM, OWNER, 5_000000n), xfer(ARGUS, PM, OWNER, 100n * 10n ** 18n)]);
expect.usdc += 5_000000n; expect.argus += 100n * 10n ** 18n;
// the add realises 700 USDC-units of fees, netted against the deposit
tx(4300, [mlog(POOL_A, 8240, L), xfer(USDC, OWNER, PM, need(P_TX, L).amount0 - 700n), xfer(ARGUS, OWNER, PM, need(P_TX, L).amount1)]);
tx(4300, [swapLog(POOL_A, P_LATER)]);                       // later in the same block
slot0.push({ pool: POOL_A, fromBlock: 4300, sqrt: P_LATER }); // end-of-block state differs
expect.usdc += 700n;
tx(4400, [mlog(POOL_A, 8240, -L), xfer(USDC, PM, OWNER, pays(P_LATER, L).amount0 + 2_000000n), xfer(ARGUS, PM, OWNER, pays(P_LATER, L).amount1 + 5n * 10n ** 18n)]);
expect.usdc += 2_000000n; expect.argus += 5n * 10n ** 18n;
// #11989: opened, nothing since
tx(4100, [nft(11989), mlog(POOL_E, 11989, L)]);
// #5555: its payout goes to someone else
tx(4050, [nft(5555), mlog(POOL_A, 5555, L)]);
tx(4500, [mlog(POOL_A, 5555, 0n), xfer(USDC, PM, STRANGER, 9_000000n)]);
// #8888: a pool whose price cannot be read at all, so its claim has no pool price;
// the price log holds a mis-scaled row (ARGUS off by 1e12) for that hour
const POOL_X = "0x" + "c3".repeat(32);
tx(3500, [nft(8888), mlog(POOL_X, 8888, L)]);
tx(4700, [mlog(POOL_X, 8888, 0n), xfer(USDC, PM, OWNER, 2_000000n), xfer(ARGUS, PM, OWNER, 10n * 10n ** 18n)]);
// #6250: opened, collected, fully withdrawn: closed (liquidity zero, still ours)
tx(3600, [nft(6250), mlog(POOL_A, 6250, L), xfer(USDC, OWNER, PM, need(P_TX, L).amount0), xfer(ARGUS, OWNER, PM, need(P_TX, L).amount1)]);
tx(3700, [mlog(POOL_A, 6250, 0n), xfer(USDC, PM, OWNER, 3_000000n), xfer(ARGUS, PM, OWNER, 20n * 10n ** 18n)]);
tx(3800, [mlog(POOL_A, 6250, -L), xfer(USDC, PM, OWNER, pays(P_TX, L).amount0 + 1_000000n), xfer(ARGUS, PM, OWNER, pays(P_TX, L).amount1)]);
// #4444: withdrawn with a fee, then burned
tx(3650, [nft(4444), mlog(POOL_A, 4444, L), xfer(USDC, OWNER, PM, need(P_TX, L).amount0), xfer(ARGUS, OWNER, PM, need(P_TX, L).amount1)]);
tx(3750, [mlog(POOL_A, 4444, -L), xfer(USDC, PM, OWNER, pays(P_TX, L).amount0 + 400000n), xfer(ARGUS, PM, OWNER, pays(P_TX, L).amount1)]);
tx(3760, [{ address: POSM, topics: [TRANSFER, pad(OWNER), pad(ZERO), pad(ethers.toBeHex(4444n))], data: "0x" }]);
// #3333: ours for a while, then sent to NEW_OWNER, who collects afterwards
const NEW_OWNER = "0x7777777777777777777777777777777777777777";
tx(3620, [nft(3333), mlog(POOL_A, 3333, L), xfer(USDC, OWNER, PM, need(P_TX, L).amount0), xfer(ARGUS, OWNER, PM, need(P_TX, L).amount1)]);
tx(3630, [mlog(POOL_A, 3333, 0n), xfer(USDC, PM, OWNER, 600000n)]);
tx(3640, [{ address: POSM, topics: [TRANSFER, pad(OWNER), pad(NEW_OWNER), pad(ethers.toBeHex(3333n))], data: "0x" }]);
tx(3660, [mlog(POOL_A, 3333, 0n), xfer(USDC, PM, NEW_OWNER, 9_900000n)]);
// #7777: opened long before the lookback floor
tx(1000, [nft(7777), mlog(POOL_A, 7777, L)]);
tx(4600, [mlog(POOL_A, 7777, 0n), xfer(USDC, PM, OWNER, 1_000000n)]);

const SLOT0 = ethers.id("getSlot0(bytes32)").slice(0, 10);
const OWNER_OF = ethers.id("ownerOf(uint256)").slice(0, 10);
const posmIface = new ethers.Interface(require("../univ4").POSM_ABI);
const NEXT_ID = ethers.id("nextTokenId()").slice(0, 10);
const POOL_OF = { 8240: POOL_A, 5555: POOL_A, 7777: POOL_A, 6250: POOL_A, 4444: POOL_A, 3333: POOL_A, 8888: POOL_X, 11989: POOL_E };
const KEY_OF = (id) => POOL_OF[id] === POOL_E ? [USDC, EURC, 500, 10, ZERO] : [USDC, ARGUS, 3000, 60, ZERO];
const INFO = (BigInt(HI & 0xffffff) << 32n) | (BigInt(LO & 0xffffff) << 8n);
const NOT_MINTED = "0x08c379a0" + coder.encode(["string"], ["NOT_MINTED"]).slice(2);
const burnedAt = (id, at) => logs.some((x) => x.address === POSM && x.topics.length === 4 && BigInt(x.topics[3]).toString() === id && x.topics[2] === pad(ZERO) && x.blockNumber <= at);
const liqAt = (id, at) => logs.filter((x) => x.address === PM && x.topics[0] === ML && x.blockNumber <= at)
  .map((x) => coder.decode(["int24", "int24", "int256", "bytes32"], x.data)).filter((d) => BigInt(d[3]).toString() === id)
  .reduce((a, d) => a + d[2], 0n);
class Revert extends Error { constructor(data) { super("execution reverted: NOT_MINTED"); this.data = data; } }
const iface = new ethers.Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function name() view returns (string)"]);
const rpcLog = (l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: hex(l.blockNumber),
  transactionHash: l.transactionHash, transactionIndex: "0x0", blockHash: ethers.id(`block-${l.blockNumber}`), logIndex: hex(l.index), removed: false });
const block = (n) => ({ number: hex(n), hash: ethers.id(`block-${n}`), parentHash: ethers.id(`block-${n - 1}`), timestamp: hex(T0 + n),
  nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: ZERO, extraData: "0x",
  baseFeePerGas: "0x1", transactions: [], stateRoot: ethers.ZeroHash, receiptsRoot: ethers.ZeroHash, logsBloom: "0x" + "00".repeat(256) });
const blockNum = (t) => (t === "latest" || t == null ? HEAD : Number(t));
function call({ to, data }, tag) {
  const addr = String(to).toLowerCase();
  if (addr === SV && data.startsWith(SLOT0)) {
    const pool = "0x" + data.slice(10, 74);
    const at = blockNum(tag);
    const hit = slot0.filter((s) => s.pool === pool && s.fromBlock <= at).pop();
    if (!hit) throw new Error("execution reverted");
    return coder.encode(["uint160", "int24", "uint24", "uint24"], [hit.sqrt, 0, 0, 0]);
  }
  if (addr === POSM && data.startsWith(NEXT_ID)) {
    // ids are issued in sequence on a real manager; here: one past the largest minted by `tag`
    const at = blockNum(tag);
    const ids = logs.filter((x) => x.address === POSM && x.topics.length === 4 && x.topics[1] === pad(ZERO) && x.blockNumber <= at).map((x) => BigInt(x.topics[3]));
    return coder.encode(["uint256"], [ids.reduce((m, v) => (v > m ? v : m), 0n) + 1n]);
  }
  if (addr === POSM && !data.startsWith(OWNER_OF)) {
    const f = posmIface.parseTransaction({ data });
    const id = f.args[0].toString(), at = blockNum(tag);
    if (f.name === "getPoolAndPositionInfo") {
      if (burnedAt(id, at) || !POOL_OF[id]) return posmIface.encodeFunctionResult(f.name, [[ZERO, ZERO, 0, 0, ZERO], 0n]);
      return posmIface.encodeFunctionResult(f.name, [KEY_OF(id), INFO]);
    }
    if (f.name === "getPositionLiquidity") return posmIface.encodeFunctionResult(f.name, [liqAt(id, at)]);
    throw new Error("execution reverted");
  }
  if (addr === POSM && data.startsWith(OWNER_OF)) {
    const id = BigInt("0x" + data.slice(10)).toString();
    const at = blockNum(tag);
    if (burnedAt(id, at)) throw new Revert(NOT_MINTED);
    // the owner at `at`: replay the NFT transfers up to that block
    let who = null;
    for (const l of logs.filter((x) => x.address === POSM && x.topics[0] === TRANSFER && x.topics.length === 4 && BigInt(x.topics[3]).toString() === id && x.blockNumber <= at)
      .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)) who = "0x" + l.topics[2].slice(26);
    if (!who || who === ZERO) throw new Error("execution reverted");
    return coder.encode(["address"], [who]);
  }
  const t = TOKENS[addr];
  if (t) {
    const f = iface.getFunction(data.slice(0, 10));
    if (f && f.name === "symbol") return iface.encodeFunctionResult("symbol", [t[0]]);
    if (f && f.name === "name") return iface.encodeFunctionResult("name", [t[0]]);
    if (f && f.name === "decimals") return iface.encodeFunctionResult("decimals", [t[1]]);
  }
  throw new Error("execution reverted");
}
function answer(m, p) {
  switch (m) {
    case "eth_chainId": return hex(CHAIN_ID);
    case "net_version": return String(CHAIN_ID);
    case "eth_blockNumber": return hex(HEAD);
    case "eth_getBlockByNumber": { const n = blockNum(p[0]); return n > HEAD ? null : block(n); }
    case "eth_getLogs": {
      const f = p[0], from = blockNum(f.fromBlock), to = blockNum(f.toBlock);
      const want = f.address ? [].concat(f.address).map((a) => a.toLowerCase()) : null;
      return logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to && (!want || want.includes(l.address.toLowerCase())) &&
        (f.topics || []).every((t, i) => t == null || [].concat(t).map((x) => x.toLowerCase()).includes((l.topics[i] || "").toLowerCase()))).map(rpcLog);
    }
    case "eth_getTransactionReceipt": {
      const mine = logs.filter((l) => l.transactionHash === p[0]);
      if (!mine.length) return null;
      const b = mine[0].blockNumber;
      return { transactionHash: p[0], transactionIndex: "0x0", blockHash: ethers.id(`block-${b}`), blockNumber: hex(b),
        from: OWNER, to: POSM, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", contractAddress: null,
        logs: mine.map(rpcLog), logsBloom: "0x" + "00".repeat(256), status: "0x1", type: "0x2" };
    }
    case "eth_call": return call(p[0], p[1]);
    case "eth_getBalance": return "0x0";
    case "eth_getCode": return String(p[0]).toLowerCase() === POSM && blockNum(p[1]) >= 100 ? "0x6001" : "0x";
    case "eth_gasPrice": return "0x1";
    default: throw new Error(`method ${m} not supported by the fake chain`);
  }
}
const rpc = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const one = (r) => { try { return { jsonrpc: "2.0", id: r.id, result: answer(r.method, r.params || []) }; }
      catch (e) { return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: e.message, data: e.data || "0x" } }; } };
    const q = JSON.parse(body || "null");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
  });
});

// ---- the server under test ----------------------------------------------------
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claims-pipeline-"));
function writeSettings(rpcPort) {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, "settings.example.json"), "utf8"));
  s.chain = { rpcUrl: `http://127.0.0.1:${rpcPort}`, chainId: CHAIN_ID, explorer: "", blockscout: "", rpcBatch: false,
    nativeCurrency: { symbol: "USDC", decimals: 18 } };
  s.wallets = { main: { address: OWNER, label: "Main" }, watched: [] };
  s.tokens = { USDG: USDC, WETH: USDC, usdReferenceFeeTier: 100 };
  s.numeraire = { symbol: "USDC", address: USDC, decimals: 6, usdRate: 1, nativeSameAsErc20: true };
  s.contracts = { ...s.contracts, v4: { ...(s.contracts.v4 || {}), poolManager: PM, positionManager: POSM, stateView: SV } };
  s.alerts = { telegramChat: "", fallbackChat: "", treasuryChat: "", dailySummary: {} };
  s.dashboard = { ...(s.dashboard || {}), port: PORT + 1 };           // never the main port: no loops
  fs.writeFileSync(path.join(DIR, "settings.json"), JSON.stringify(s, null, 1));
  // The positions the scanner tracks, persisted as the dashboard would after a card render.
  const meta = { token0: USDC, token1: ARGUS, owner: OWNER };
  fs.writeFileSync(path.join(DIR, "claims.json"), JSON.stringify({ v: 1, scopes: { [`${CHAIN_ID}:${POSM}`]: {
    events: {}, tokens: {}, decoder: require("../claims-store").DECODER,
    meta: { 8240: meta, 5555: meta, 7777: meta, 8888: meta, 11989: { token0: USDC, token1: EURC, owner: OWNER } } } } }));
  const hour = String(Math.floor(((T0 + 4700) * 1000) / 3600000) * 3600000);
  fs.writeFileSync(path.join(DIR, "price-log.json"), JSON.stringify({ hours: { [hour]: { eth: 1, [USDC]: 1, [ARGUS]: 2.8e-14 } } }));
}
function startServer() {
  const env = { ...process.env, TELEGRAM_TOKEN: "", TELEGRAM_CHAT_ID: "", LP_BLOCKSCOUT_KEY: "", LP_READONLY: "1",
    LP_CLAIM_SCAN_DELAY_MS: "0", LP_REGISTRY_DELAY_MS: "0", LP_CLAIM_PAUSE_MS: "5", LP_CLAIM_CHUNK: "500", LP_CLAIM_LOOKBACK_DAYS: "0.02" };
  const log = fs.openSync(path.join(DIR, "server.log"), "a");
  return spawn(process.execPath, ["server.js", `--data-dir=${DIR}`, `--port=${PORT}`, "--no-loops", "--no-services", "--claim-scan"],
    { cwd: ROOT, env, stdio: ["ignore", log, log] });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(p) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
  return r.json();
}
const claims = (id) => get(`/api/claims?tokenId=${id}&chainId=${CHAIN_ID}&manager=${POSM}`);
async function settled() {
  // until every position has its final state and the scanner has nothing pending
  for (let i = 0; i < 240; i++) {
    try {
      const all = await Promise.all([8240, 11989, 5555, 7777, 8888].map(claims));
      const s = all[0].scanner;
      if (s && s.pending === 0 && s.idle && all.every((a) => a.state && a.state !== "scanning" && a.state !== "not-scanned")) return all;
    } catch {}
    await sleep(500);
  }
  throw new Error(`the scan did not settle; see ${path.join(DIR, "server.log")}`);
}
const stop = (child) => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); });

// The card, lifted from dashboard.js the way the other UI tests do.
function cardFns() {
  const src = fs.readFileSync(path.join(ROOT, "dashboard.js"), "utf8");
  const constOf = (name) => {
    const f = src.indexOf(`\nconst ${name} =`);
    if (f < 0) return null;
    // up to the end of the statement: brackets balanced and a line ending in ";"
    let depth = 0, quote = null;
    for (let i = f + 1; i < src.length; i++) {
      const c = src[i];
      if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
      if (c === "'" || c === '"' || c === "`") quote = c;
      else if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (c === ";" && depth === 0) return src.slice(f, i + 1) + "\n";
    }
    return null;
  };
  const bodyOf = (name) => { const f = src.indexOf(`\nfunction ${name}(`); return f < 0 ? constOf(name) : src.slice(f, src.indexOf("\n}\n", f) + 3); };
  // Every top-level function the card functions call, found by name, so the test
  // follows dashboard.js as it changes rather than a hand-kept list.
  const all = new Set([...src.matchAll(/\nfunction ([A-Za-z_$][\w$]*)\(/g), ...src.matchAll(/\nconst ([A-Za-z_$][\w$]*) =/g)].map((m) => m[1]));
  all.delete("esc");                          // taken from its own line below
  const need = new Set(), queue = ["claimPanelHtml", "claimedMetric"];
  while (queue.length) {
    const n = queue.pop();
    if (need.has(n)) continue;
    const body = bodyOf(n);
    assert.ok(body, `${n} missing from dashboard.js`);
    need.add(n);
    for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) if (m[1] !== n && all.has(m[1]) && !need.has(m[1])) queue.push(m[1]);
  }
  const escLine = src.match(/^const esc = .*$/m)[0];
  const stubs = {
    usd: "const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });",
    amount: "const amount = (n) => String(n);",
    linkify: "const linkify = (s) => esc(s);",
    EXPLORER: "const EXPLORER = '';",
  };
  return new Function(`${escLine}
    ${Object.entries(stubs).filter(([k]) => !need.has(k)).map(([, v]) => v).join("\n")}
    ${[...need].map(bodyOf).join("\n")}
    return { claimedMetric, claimPanelHtml };`)();
}

async function main() {
  await new Promise((r) => rpc.listen(0, "127.0.0.1", r));
  writeSettings(rpc.address().port);
  let server = startServer();
  try {
    const [a, z, bad, old, noPool] = await settled();

    // #8240: complete, every event decoded, fees at the transaction-time price
    assert.strictEqual(a.state, "complete", JSON.stringify(a).slice(0, 300));
    assert.strictEqual(a.verifiedZero, false);
    assert.deepStrictEqual(a.rows.map((r) => r.kind), ["collect", "increase", "withdrawal"]);
    assert.strictEqual(a.summary.raw0, expect.usdc.toString(), "USDC fees: collect + the add's netted fee + the withdrawal's excess");
    assert.strictEqual(a.summary.raw1, expect.argus.toString());
    assert.ok(a.rows.every((r) => r.priceSrc === "block"), "each claim is valued at its own transaction's pool price");
    assert.deepStrictEqual(a.rows.map((r) => r.priceT), [4200, 4300, 4400].map((b) => (T0 + b) * 1000), "and says when that price was observed");
    assert.deepStrictEqual(a.rows.map((r) => r.logIndex), [0, 0, 0]);
    const rowSum = a.rows.reduce((s, r) => s + r.usd, 0);
    assert.ok(Math.abs(rowSum - a.summary.usd) < 0.01, `row values add up to the card total (${rowSum} vs ${a.summary.usd})`);
    assert.deepStrictEqual(a.summary.priceSources, { block: 3, pricelog: 0, today: 0, none: 0 });
    assert.strictEqual(a.coverage.coversOpening, true);
    assert.strictEqual(a.coverage.openedBlock, 4000);

    // #11989: the only verified zero
    assert.strictEqual(z.state, "complete");
    assert.strictEqual(z.verifiedZero, true);
    assert.strictEqual(z.rows.length, 0);
    assert.strictEqual(z.summary.usd, 0);

    // #5555: a payout that cannot be attributed withholds the figure
    assert.strictEqual(bad.state, "undecodable");
    assert.strictEqual(bad.verifiedZero, false);
    assert.match(bad.reason, /cannot be attributed/);
    assert.strictEqual(bad.summary.usd, undefined, "no figure for an undecodable history");

    // #7777: floor reached, lifetime incomplete
    assert.strictEqual(old.state, "lookback-reached");
    assert.strictEqual(old.verifiedZero, false);
    assert.match(old.reason, /lookback/);
    assert.strictEqual(old.rows.length, 1);
    assert.strictEqual(old.coverage.reachedLookbackFloor, true);
    assert.strictEqual(old.coverage.coversOpening, false);

    // #8888: no pool price at the claim, and the only log row is mis-scaled: it is
    // refused, the claim stays unvalued, and the total says why instead of ~$2
    assert.strictEqual(noPool.state, "complete");
    assert.strictEqual(noPool.rows.length, 1);
    assert.strictEqual(noPool.rows[0].priceSrc, null, "a mis-scaled price-log row is not used");
    assert.strictEqual(noPool.summary.usd, null);
    assert.ok(noPool.summary.usdMissing, "and the missing total is explained");
    assert.deepStrictEqual(noPool.summary.priceSources, { block: 0, pricelog: 0, today: 0, none: 1 });
    assert.match(fs.readFileSync(path.join(DIR, "server.log"), "utf8"), /price-log row for .* rejected/);

    // ---- position history: every position the wallet held, with its status ----
    let hist = null;
    for (let i = 0; i < 240 && !hist; i++) {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/positions/history?wallet=${OWNER}`);
      const d = await r.json();
      if (r.status === 200 && d.ok && d.positions.length >= 8 && d.positions.every((p) => p.claimed && p.claimed.state !== "not-scanned")) hist = d;
      else await sleep(500);
    }
    assert.ok(hist, "the position history loads");
    const byId = Object.fromEntries(hist.positions.map((p) => [p.tokenId, p]));
    assert.deepStrictEqual(hist.counts, { open: 5, closed: 1, burned: 1, transferred: 1, unavailable: 0, all: 8 }, JSON.stringify(hist.counts));
    assert.strictEqual(byId[6250].status, "closed");
    assert.deepStrictEqual([byId[6250].closedAt.block, byId[6250].closedAt.verified, byId[6250].closedAt.t], [3800, true, (T0 + 3800) * 1000]);
    assert.strictEqual(byId[6250].unsettledFees.state, "none");
    assert.strictEqual(byId[6250].claimed.state, "complete");
    assert.strictEqual(byId[6250].claimed.raw0, "4000000", "collect + the withdrawal's excess; the withdrawn principal is not a fee");
    assert.strictEqual(byId[4444].status, "burned");
    assert.strictEqual(byId[4444].burnedAt.block, 3760);
    assert.strictEqual(byId[4444].closedAt.block, 3750);
    assert.strictEqual(byId[4444].claimed.raw0, "400000");
    assert.strictEqual(byId[3333].status, "transferred", "a transferred position is not called closed");
    assert.strictEqual(byId[3333].transferredAt.to, NEW_OWNER);
    assert.strictEqual(byId[3333].currentOwner, NEW_OWNER);
    assert.strictEqual(byId[3333].claimed.raw0, "600000", "the new owner's later collect is not this wallet's");
    assert.strictEqual(byId[3333].claimed.count, 1);
    assert.strictEqual(byId[8240].status, "open");
    assert.strictEqual(byId[8240].pair, "USDC / ARGUS");
    assert.ok(byId[8240].key.startsWith(`${CHAIN_ID}:${POSM}:8240:`));
    assert.strictEqual(hist.wallets[0].discovery.complete, true, "discovery reached the manager's deployment");

    // ---- income: capital in and out, fees, and an honest rate ---------------------
    const inc = byId[8240].income;
    assert.deepStrictEqual(inc.missing, [], JSON.stringify(inc));
    assert.strictEqual(inc.capitalEvents, 3, "the mint deposit, the add and the withdrawal are capital movements");
    assert.ok(inc.depositedUsd > 0 && inc.withdrawnUsd > 0, JSON.stringify(inc));
    assert.ok(inc.twaCapitalUsd > 0, "capital is time-weighted over the position's life");
    assert.ok(Math.abs(inc.claimedUsd - a.summary.usd) < 1e-6, "claimed fees are the same figure the card shows");
    assert.ok(inc.onCapitalPct > 0, "fees as a share of the capital that was working");
    // an open position is measured to now, so its rate annualises from a real span
    assert.ok(inc.days > 0);
    const expectRate = inc.onCapitalPct * (365 / inc.days);
    assert.ok(Math.abs(inc.feeRatePct - expectRate) / expectRate < 1e-3,
      `the rate is the share of capital annualised over the actual days: ${inc.feeRatePct} vs ${expectRate}`);
    // a position that only ever received its deposit: capital, no fees, no invented rate
    const zinc = byId[11989].income;
    assert.strictEqual(zinc.capitalEvents, 1);
    assert.ok(zinc.depositedUsd > 0);
    assert.strictEqual(zinc.claimedUsd, 0);
    assert.strictEqual(zinc.feesUsd, 0);
    assert.strictEqual(zinc.onCapitalPct, 0);
    // a closed position stops earning at its closure, and its uncollected fees are zero
    const cinc = byId[6250].income;
    assert.strictEqual(cinc.uncollectedUsd, 0);
    // it lived 200 blocks (200 s): annualising that would read as a five-figure rate
    assert.ok(cinc.days < 1, `${cinc.days}`);
    assert.strictEqual(cinc.feeRatePct, null, "a rate is not annualised from under a day");
    assert.match(cinc.annualNote, /too short to annualise/);
    assert.ok(cinc.onCapitalPct > 0, "the plain share of capital is still given");
    assert.ok(byId[6250].income.closedT > 0 && byId[6250].income.closedT <= byId[6250].closedAt.t);
    // capital is never counted as income
    assert.ok(byId[6250].income.depositedUsd > byId[6250].income.claimedUsd);

    // ---- total claimed fees ------------------------------------------------------
    const total = await get(`/api/claims/total?wallet=${OWNER}`);
    assert.strictEqual(total.ok, true, JSON.stringify(total).slice(0, 300));
    assert.strictEqual(total.label, "Total claimed fees · Main · Open + closed");
    assert.strictEqual(total.state, "partial", "an undecodable and a lookback-limited position keep the total partial");
    assert.strictEqual(total.stateLabel, "Verified claimed so far — partial history");
    assert.strictEqual(total.verifiedZero, false);
    const usdcTotal = total.tokens.find((t) => t.address === USDC);
    // 8240 (7,000,700) + 7777 (1,000,000) + 8888 (2,000,000) + 6250 (4,000,000) + 4444 (400,000) + 3333 (600,000)
    assert.strictEqual(usdcTotal.raw, String(7_000700 + 1_000000 + 2_000000 + 4_000000 + 400000 + 600000), JSON.stringify(total.tokens));
    const argusTotal = total.tokens.find((t) => t.address === ARGUS);
    assert.strictEqual(argusTotal.raw, (105n * 10n ** 18n + 10n * 10n ** 18n + 20n * 10n ** 18n).toString());
    assert.ok(total.coverage.unsupported.some((x) => x.tokenId === "5555" && x.state === "undecodable"), "the undecodable position is listed and excluded");
    assert.ok(total.coverage.partial.some((x) => x.tokenId === "7777" && x.state === "lookback-reached"));
    assert.ok(!total.rows.some((r) => r.tokenId === "5555"), "and none of its rows are counted");
    // the aggregate reconciles to its positions and its rows
    const sumRows = (addr) => total.rows.reduce((a, r) => a + BigInt(r.tokens.find((t) => t.address === addr).raw), 0n).toString();
    assert.strictEqual(sumRows(USDC), usdcTotal.raw);
    const sumPos = total.positions.filter((p) => p.included).reduce((a, p) => a + BigInt((p.tokens.find((t) => t.address === USDC) || { raw: "0" }).raw), 0n).toString();
    assert.strictEqual(sumPos, usdcTotal.raw);
    const subs = total.subtotals;
    assert.strictEqual(BigInt(subs.open.tokens.find((t) => t.address === USDC).raw) + BigInt(subs.closed.tokens.find((t) => t.address === USDC).raw)
      + BigInt(subs.other.tokens.find((t) => t.address === USDC).raw), BigInt(usdcTotal.raw));
    assert.strictEqual(subs.closed.tokens.find((t) => t.address === USDC).raw, "4000000");
    assert.strictEqual(subs.other.tokens.find((t) => t.address === USDC).raw, "1000000", "burned 400,000 + transferred 600,000");
    // #8888 has no historical price: a priced subtotal, never a full historical total
    assert.strictEqual(total.usd.historical, null);
    assert.strictEqual(total.usd.unpricedRecords, 1);
    assert.ok(total.usd.excluded.some((x) => x.tokenId === "8888"));
    const pricedRows = total.rows.filter((r) => r.usd != null).reduce((a, r) => a + r.usd, 0);
    assert.ok(Math.abs(pricedRows - total.usd.pricedSubtotal) < 1e-6, "the priced subtotal is the sum of the priced rows");
    assert.ok(total.rows.every((r) => r.recipient === OWNER), "every counted settlement was paid to this wallet");
    assert.deepStrictEqual([...new Set(total.rows.map((r) => r.kind))].sort(), ["collect", "increase", "withdrawal"]);

    // closed only: one complete position, fully priced
    const closedOnly = await get(`/api/claims/total?wallet=${OWNER}&status=closed`);
    assert.strictEqual(closedOnly.state, "complete");
    assert.strictEqual(closedOnly.stateLabel, "Verified claimed — complete history");
    assert.strictEqual(closedOnly.label, "Total claimed fees · Main · Closed");
    assert.strictEqual(closedOnly.tokens.find((t) => t.address === USDC).raw, "4000000");
    assert.ok(closedOnly.usd.historical > 0);
    assert.strictEqual(closedOnly.positions.length, 1);
    // a date range narrows the settlements, not the coverage
    const dated = await get(`/api/claims/total?wallet=${OWNER}&status=closed&from=${(T0 + 3750) * 1000}`);
    assert.strictEqual(dated.tokens.find((t) => t.address === USDC).raw, "1000000", "only the withdrawal's fee is after the start");
    assert.strictEqual(dated.rows.length, 1);
    // bad input is refused
    assert.strictEqual((await get(`/api/claims/total?wallet=0x0000000000000000000000000000000000000001`)).ok, false);
    assert.strictEqual((await get(`/api/claims/total?status=bogus`)).ok, false);
    // the per-position panel reads the wallet's own rows
    const t3333 = await get(`/api/claims?tokenId=3333&chainId=${CHAIN_ID}&manager=${POSM}&wallet=${OWNER}`);
    assert.strictEqual(t3333.rows.length, 1);
    assert.strictEqual(t3333.rows[0].recipient, OWNER);
    assert.strictEqual(t3333.state, "complete");

    // the card, from the same answers
    const card = cardFns();
    const tile = (d, id) => card.claimedMetric({ nftId: String(id), claimed: { ...d.summary, scope: d.scope } }, `u${id}`);
    assert.ok(tile(a, 8240).includes(`$${a.summary.usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`), "the tile shows the API's total");
    assert.ok(!/complete history/i.test(tile(old, 7777)), "a lookback-limited history is never called complete");
    assert.ok(!/\$0\.00/.test(tile(old, 7777)), "a lookback-limited history is never a zero");
    assert.ok(/\$0\.00/.test(tile(z, 11989)) && /verified/i.test(tile(z, 11989)), "the verified zero is drawn as one");
    const badTile = card.claimedMetric({ nftId: "5555", claimed: { ...bad.summary, scope: bad.scope } }, "u5555");
    assert.ok(!/\$\d/.test(badTile), `no dollar figure for an undecodable history: ${badTile}`);
    const panel = card.claimPanelHtml(a);
    assert.ok(/add \(fees netted\)/.test(panel) && /withdrawal/.test(panel), "the panel names each action");
    assert.ok(!/never had fees collected/.test(card.claimPanelHtml(old)), "and never calls a partial history empty");

    // restart on the same data: nothing added, nothing counted twice
    const before = JSON.parse(fs.readFileSync(path.join(DIR, "claims.json"), "utf8")).scopes[`${CHAIN_ID}:${POSM}`];
    await stop(server);
    server = startServer();
    const [a2, z2, bad2, old2] = await settled();
    const after = JSON.parse(fs.readFileSync(path.join(DIR, "claims.json"), "utf8")).scopes[`${CHAIN_ID}:${POSM}`];
    assert.deepStrictEqual(Object.keys(after.events).sort(), Object.keys(before.events).sort(), "a restart adds no records");
    assert.strictEqual(a2.summary.raw0, a.summary.raw0);
    assert.strictEqual(a2.summary.usd, a.summary.usd);
    assert.strictEqual(z2.verifiedZero, true);
    assert.strictEqual(bad2.state, "undecodable");
    assert.strictEqual(old2.state, "lookback-reached");
    const total2 = await get(`/api/claims/total?wallet=${OWNER}`);
    assert.deepStrictEqual(total2.tokens, total.tokens, "a restart does not change the aggregate");
    assert.strictEqual(total2.rows.length, total.rows.length);
    console.log("claims pipeline: scanner -> store -> /api/claims -> card: complete, verified zero, undecodable and lookback-limited histories stay distinct; a restart counts nothing twice");
  } finally {
    await stop(server).catch(() => {});
    rpc.close();
    if (!process.exitCode) fs.rmSync(DIR, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); console.error(`server log: ${path.join(DIR, "server.log")}`); process.exitCode = 1; rpc.close(); });
