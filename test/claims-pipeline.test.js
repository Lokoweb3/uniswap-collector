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
// #7777: opened long before the lookback floor
tx(1000, [nft(7777), mlog(POOL_A, 7777, L)]);
tx(4600, [mlog(POOL_A, 7777, 0n), xfer(USDC, PM, OWNER, 1_000000n)]);

const SLOT0 = ethers.id("getSlot0(bytes32)").slice(0, 10);
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
    case "eth_getCode": return "0x";
    case "eth_gasPrice": return "0x1";
    default: throw new Error(`method ${m} not supported by the fake chain`);
  }
}
const rpc = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const one = (r) => { try { return { jsonrpc: "2.0", id: r.id, result: answer(r.method, r.params || []) }; }
      catch (e) { return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: e.message, data: "0x" } }; } };
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
    LP_CLAIM_SCAN_DELAY_MS: "0", LP_CLAIM_PAUSE_MS: "5", LP_CLAIM_CHUNK: "500", LP_CLAIM_LOOKBACK_DAYS: "0.02" };
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
    console.log("claims pipeline: scanner -> store -> /api/claims -> card: complete, verified zero, undecodable and lookback-limited histories stay distinct; a restart counts nothing twice");
  } finally {
    await stop(server).catch(() => {});
    rpc.close();
    if (!process.exitCode) fs.rmSync(DIR, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); console.error(`server log: ${path.join(DIR, "server.log")}`); process.exitCode = 1; rpc.close(); });
