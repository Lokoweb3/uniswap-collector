// node test/staking-wallets.test.js — sNET staking for every watched wallet.
//
// The main wallet's ledger stays at tokens[token] (an older build can still read the
// file); the others live at wallets[address][token]. Mocked provider throughout: no
// network. The goldens in test/fixtures/staking/ were captured from the pre-change
// implementation (commit 1e8f919) on old-main-only.json, so "unchanged" is measured,
// not asserted from memory.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const FX = path.join(__dirname, "fixtures", "staking");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "stk-"));
process.env.LP_DATA_DIR = TMP;
process.env.LP_TZ = "UTC";
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const SNET = "0xb773ec2c326b7f98a5a83fc098825492f020a4c7";
const MAIN = "0x1111111111111111111111111111111111111111";
const A = ethers.getAddress("0x2222222222222222222222222222222222222222");
const B = ethers.getAddress("0x3333333333333333333333333333333333333333");
const DEAD = "0x000000000000000000000000000000000000dEaD";
const FILE = path.join(TMP, "snet-staking.json");
const NOW = 1800000000000;
const quiet = { log() {}, error() {} };
const staking = require("../staking");

const iface = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function index() view returns (uint256)",
  "event LogRebase(uint256 indexed epoch, uint256 rebaseAmount, uint256 index)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const E18 = 10n ** 18n;
const pad = (a) => ethers.zeroPadValue(a, 32).toLowerCase();

/**
 * A provider that answers only what staking.js asks. balances: address -> bigint;
 * transfers: [{from,to,value}]; rebases: [{block,index}]; failLogsFor: addresses whose
 * Transfer scans throw. `calls` counts every request, so "made no RPC call" is checkable.
 */
function mockProvider({ balances = {}, index = E18, transfers = [], rebases = [], failLogsFor = [] } = {}) {
  const p = {
    calls: 0, logQueries: [],
    async call(tx) {
      p.calls++;
      const d = iface.parseTransaction({ data: tx.data });
      if (d.name === "balanceOf") return iface.encodeFunctionResult("balanceOf", [balances[String(d.args[0]).toLowerCase()] || 0n]);
      if (d.name === "decimals") return iface.encodeFunctionResult("decimals", [18]);
      if (d.name === "symbol") return iface.encodeFunctionResult("symbol", ["sNET"]);
      if (d.name === "index") return iface.encodeFunctionResult("index", [index]);
      throw new Error("unexpected call " + d.name);
    },
    async getBlockNumber() { p.calls++; return 47000000; },
    async getBlock(n) { p.calls++; return { timestamp: 1700000000 + Number(n) }; },
    async getLogs(f) {
      p.calls++;
      p.logQueries.push(f.topics);
      const [t0, from, to] = f.topics;
      p.ranges = p.ranges || [];
      p.ranges.push([f.fromBlock, f.toBlock, t0 === iface.getEvent("LogRebase").topicHash ? "rebase" : "transfer"]);
      const inRange = (b) => b >= f.fromBlock && b <= f.toBlock;
      if (t0 === iface.getEvent("LogRebase").topicHash) {
        return rebases.filter((r) => inRange(r.block)).map((r) => ({ ...iface.encodeEventLog(iface.getEvent("LogRebase"), [r.block, 1n, r.index]), blockNumber: r.block, address: SNET }));
      }
      const who = String(from || to).toLowerCase();
      if (failLogsFor.some((a) => pad(a) === who)) throw new Error("logs unavailable");
      return transfers
        .filter((x) => inRange(x.block || 46000000))
        .filter((x) => (from ? pad(x.from) === from.toLowerCase() : true) && (to ? pad(x.to) === to.toLowerCase() : true))
        .map((x) => ({ blockNumber: x.block || 46000000, data: ethers.zeroPadValue(ethers.toBeHex(x.value), 32) }));
    },
  };
  return p;
}

const baseCfg = { ownerAddress: MAIN, staking: { tokens: [{ token: "0xb773ec2C326B7f98a5a83fc098825492F020a4c7" }] } };
const make = (provider, wallets = [], extra = {}) => staking.create({ provider, cfg: baseCfg, getPrice: null, getWallets: () => wallets, getOwnerLabel: () => "Main", log: quiet, ...extra });
const fresh = () => { try { fs.unlinkSync(FILE); } catch {} };
const at = (t, fn) => { const real = Date.now; Date.now = () => t; try { return fn(); } finally { Date.now = real; } };

// ---- 1. an old-format, main-only file reads exactly as the pre-change code did ----
{
  fs.copyFileSync(path.join(FX, "old-main-only.json"), FILE);
  const st = make(mockProvider());
  const got = JSON.parse(JSON.stringify(at(NOW, () => st.view())));
  const golden = JSON.parse(fs.readFileSync(path.join(FX, "old-view.golden.json"), "utf8"));
  assert.deepStrictEqual(got, golden, "view() on the old file is deep-equal to the HEAD implementation's output");
  assert.deepStrictEqual(Object.keys(got), ["ok", "at", "tokens"], "and has exactly the old keys");
  assert.strictEqual(got.tokens[0].principal, 150);
  assert.deepStrictEqual(st.viewAll(), [], "no watched wallets, no wallets list");
}

// ---- 2. sample() leaves the original samples byte-equal and adds no wallets key ----
{
  fs.copyFileSync(path.join(FX, "old-main-only.json"), FILE);
  const before = JSON.parse(fs.readFileSync(FILE, "utf8")).tokens[SNET].samples;
  const st = make(mockProvider({ balances: { [MAIN]: 170n * E18 }, index: 2n * E18 }));
  (async () => {
    await st.sample();
    const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
    assert.ok(saved.tokens[SNET].samples.length > before.length, "a new sample was appended");
    assert.strictEqual(JSON.stringify(saved.tokens[SNET].samples.slice(0, before.length)), JSON.stringify(before), "the original samples are a byte-equal prefix");
    assert.ok(!("wallets" in saved), "no wallets key is written when there are no other wallets");
    // The previous version's loader reads `tokens` only; that still works on the new file.
    assert.ok(Array.isArray(saved.tokens[SNET].samples));
    await rest();
  })().catch((e) => { console.error(e); process.exit(1); });
}

async function rest() {
  // ---- 3. three wallets: A holds sNET, B holds none, main unchanged ----------------
  {
    fresh();
    const prov = mockProvider({ balances: { [MAIN]: 50n * E18, [A.toLowerCase()]: 100n * E18 }, index: 3n * E18,
      transfers: [{ from: ethers.ZeroAddress, to: MAIN, value: 50n * E18 }, { from: ethers.ZeroAddress, to: A, value: 100n * E18 }], rebases: [] });
    const st = make(prov, [{ address: A, label: "Wallet A" }, { address: B, label: "Wallet B" }, { address: MAIN, label: "dup of main" }]);
    await st.sample();
    const s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    assert.strictEqual(s.wallets[A.toLowerCase()][SNET].samples[0].bal, 100, "A's balance is sampled");
    assert.strictEqual(s.wallets[A.toLowerCase()][SNET].samples[0].index, (3n * E18).toString(), "with the index");
    assert.ok(!s.wallets[B.toLowerCase()], "B (zero balance, no entry) gets no ledger");
    assert.strictEqual(s.tokens[SNET].samples[0].bal, 50, "main is at tokens[token], unchanged in place");
    assert.strictEqual(Object.keys(s.wallets).length, 1, "and the main address listed again is not a second ledger");
    // 4. principal from the wallet's own Transfer logs; main's numbers are its own
    const va = st.view({ wallet: A }).tokens[0];
    assert.strictEqual(va.principal, 100, "A's principal is its own 1:1 in-transfers");
    assert.strictEqual(st.view().tokens[0].principal, 50, "main's principal is not touched by A's logs");
    assert.ok(prov.logQueries.some((q) => q[2] === pad(A)) && prov.logQueries.some((q) => q[1] === pad(A)), "log filters use A's own padded address topic");
    assert.deepStrictEqual(st.view({ wallet: "wallet a" }).wallet, { address: A, label: "Wallet A" }, "a label resolves, case-insensitively");
    assert.strictEqual(st.view({ wallet: DEAD }), null, "an unconfigured address resolves to nothing");
    assert.deepStrictEqual(st.viewAll().map((w) => [w.label, w.tokens.length]), [["Wallet A", 1], ["Wallet B", 0]], "viewAll lists configured wallets only");
  }

  // ---- 4. principal 100, balance 103 at the later index -> rewards 3 ----------------
  {
    fresh();
    const prov = mockProvider({ balances: { [A.toLowerCase()]: 103n * E18 }, index: 1030000000000000000n,
      transfers: [{ from: ethers.ZeroAddress, to: A, value: 100n * E18, block: 46500000 }],
      rebases: [{ block: 46600000, index: 1010000000000000000n }, { block: 46700000, index: 1020000000000000000n }] });
    const st = make(prov, [{ address: A, label: "Wallet A" }]);
    await st.sample();
    const t = st.view({ wallet: A }).tokens[0];
    assert.strictEqual(t.principal, 100, "principal 100");
    assert.ok(Math.abs(t.rewards.total - 3) < 1e-9, `total rewards 3 (got ${t.rewards.total})`);
    assert.strictEqual(st.view().tokens[0].balance, 0, "main is its own zero balance, not A's");
    assert.strictEqual(st.view().tokens[0].principal, 0, "and its own principal");
  }

  // ---- 5. rebase vs stake on a watched wallet, same rule as main ---------------------
  {
    fresh();
    const mk = (extra = {}) => [
      { t: NOW - 4 * 3600000, bal: 100, index: "1000000000000000000", price: 1 },
      { t: NOW - 3 * 3600000, bal: 101, index: "1010000000000000000", price: 1 }, // matches the index: a reward of 1
      { t: NOW - 2 * 3600000, bal: 151, index: "1010000000000000000", price: 1 }, // +50 at the same index: a stake, skipped
      { t: NOW - 1 * 3600000, bal: 152.51, index: "1020100000000000000", price: 1, ...extra }, // 151 * 1.01 = 152.51: matches the index again
    ];
    const entry = { samples: mk(), symbol: "sNET", label: "sNET staking", underlying: null, principal: 100, principalAt: NOW, backfilledAt: NOW };
    fs.writeFileSync(FILE, JSON.stringify({ tokens: { [SNET]: JSON.parse(JSON.stringify(entry)) }, wallets: { [A.toLowerCase()]: { [SNET]: entry } } }));
    const st = make(mockProvider(), [{ address: A, label: "Wallet A" }]);
    const va = at(NOW, () => st.view({ wallet: A }).tokens[0]);
    const vm = at(NOW, () => st.view().tokens[0]);
    assert.strictEqual(va.events.length, 2, "the 1-token rebase and the index-matching last step are rewards; the +50 stake is not");
    assert.strictEqual(va.events[0].amount, 1);
    assert.ok(!va.events.some((e) => e.amount === 50), "a jump that does not match the index is skipped");
    assert.deepStrictEqual(va.events, vm.events, "A follows exactly the rule main follows");
  }

  // ---- 6. backfill once; a getLogs failure for A stops neither B nor main ------------
  {
    fresh();
    const prov = mockProvider({ balances: { [MAIN]: 10n * E18, [A.toLowerCase()]: 20n * E18, [B.toLowerCase()]: 30n * E18 }, index: 2n * E18,
      transfers: [{ from: ethers.ZeroAddress, to: B, value: 30n * E18, block: 46500000 }],
      rebases: [{ block: 46600000, index: 1500000000000000000n }], failLogsFor: [A] });
    const st = make(prov, [{ address: A, label: "Wallet A" }, { address: B, label: "Wallet B" }]);
    await st.sample();
    let s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    assert.ok(!(s.wallets && s.wallets[A.toLowerCase()] && s.wallets[A.toLowerCase()][SNET].backfilledAt), "A's failed backfill is not marked done");
    assert.ok(!(s.wallets && s.wallets[A.toLowerCase()]), "and leaves no entry for A at all");
    assert.ok(s.wallets[B.toLowerCase()][SNET].backfilledAt, "B was still sampled and backfilled");
    assert.ok(s.tokens[SNET].backfilledAt, "main was still sampled and backfilled");
    const bAt = s.wallets[B.toLowerCase()][SNET].backfilledAt;
    const rebaseScans = () => prov.logQueries.filter((q) => q.length === 1).length;
    const n = rebaseScans();
    await st.sample();
    s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    assert.strictEqual(s.wallets[B.toLowerCase()][SNET].backfilledAt, bAt, "B's backfill is not repeated");
    assert.strictEqual(rebaseScans() - n, 0, "main and B are not rebuilt again (A is retried, and fails again before reaching the rebase scan)");
  }

  // ---- 6b. getLogs bounds: chunking, one shared LogRebase scan, backoff, atomic save, corrupt file ----
  {
    fresh();
    const C = ethers.getAddress("0x4444444444444444444444444444444444444444");
    const prov = mockProvider({ balances: { [MAIN]: 10n * E18, [A.toLowerCase()]: 20n * E18, [B.toLowerCase()]: 30n * E18, [C.toLowerCase()]: 5n * E18 }, index: 2n * E18,
      transfers: [{ from: ethers.ZeroAddress, to: A, value: 20n * E18, block: 46100000 }, { from: ethers.ZeroAddress, to: B, value: 30n * E18, block: 46200000 }, { from: ethers.ZeroAddress, to: MAIN, value: 10n * E18, block: 46300000 }],
      rebases: [{ block: 46600000, index: 1500000000000000000n }, { block: 46700000, index: 1600000000000000000n }], failLogsFor: [C] });
    const st = make(prov, [{ address: A, label: "A" }, { address: B, label: "B" }, { address: C, label: "C" }], { maxLogRange: 1000000 });
    await st.sample();
    assert.ok(prov.ranges.every(([a, b]) => b - a + 1 <= 1000000), "no getLogs range exceeds maxLogRange");
    assert.ok(prov.ranges.some(([a, b]) => b - a + 1 === 1000000), "and full-size chunks are used");
    const rebaseScans = prov.ranges.filter((r) => r[2] === "rebase");
    assert.strictEqual(rebaseScans.length, 3, "one LogRebase scan (3 chunks of 1M over 45M..47M) for main, A and B together");
    const s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    assert.strictEqual(s.wallets[A.toLowerCase()][SNET].samples.length, s.wallets[B.toLowerCase()][SNET].samples.length, "wallets share the same rebase history");
    assert.ok(!(s.wallets[C.toLowerCase()]), "C failed and left nothing");
    // backoff: C is not retried straight away
    const before = prov.calls;
    await st.sample();
    const cScans = prov.logQueries.filter((q) => q[1] === pad(C) || q[2] === pad(C)).length;
    assert.strictEqual(cScans, 1, "C's transfer scan (failing at its first call) are not repeated within the backoff hour");
    const real = Date.now; Date.now = () => real() + 3700 * 1000;
    try { await st.sample(); } finally { Date.now = real; }
    assert.ok(prov.logQueries.filter((q) => q[1] === pad(C) || q[2] === pad(C)).length > cScans, "after an hour C is retried");
    assert.ok(before > 0);
    // atomic save: no temp file left behind, one write per sample
    assert.ok(!fs.readdirSync(TMP).some((f) => f.endsWith(".tmp")), "no .tmp left");
    // a corrupt file is set aside, not overwritten
    fs.writeFileSync(FILE, "{ not json");
    const st2 = make(mockProvider({ balances: { [MAIN]: 10n * E18 } }));
    assert.ok(fs.readdirSync(TMP).some((f) => /^snet-staking\.json\.corrupt-\d+$/.test(f)), "bad file renamed to .corrupt-<ts>");
    assert.strictEqual(fs.readFileSync(path.join(TMP, fs.readdirSync(TMP).find((f) => f.includes(".corrupt-"))), "utf8"), "{ not json", "with its contents intact");
    assert.deepStrictEqual(st2.view().tokens, [], "and starts empty");
    for (const f of fs.readdirSync(TMP)) if (f.includes(".corrupt-")) fs.unlinkSync(path.join(TMP, f));
  }

  // ---- 6c. saves: once per sample, after the run ----
  {
    fresh();
    const real = fs.writeFileSync; let writes = 0;
    fs.writeFileSync = function (f, ...a) { if (String(f).includes("snet-staking.json")) writes++; return real.call(this, f, ...a); };
    try {
      const st = make(mockProvider({ balances: { [MAIN]: 10n * E18, [A.toLowerCase()]: 20n * E18 }, index: 2n * E18 }), [{ address: A, label: "A" }]);
      await st.sample();
      assert.ok(writes <= 3, `main + A + end: bounded writes (got ${writes})`);
      writes = 0;
      await st.sample();
      assert.strictEqual(writes, 1, "a steady-state sample saves once, not per wallet/token");
    } finally { fs.writeFileSync = real; }
  }

  // ---- 6e. review fixes: principal backoff, single-flight, maxLogRange floor, corrupt ledger never overwritten, tmp cleanup ----
  {
    // principal scan failing for a watched wallet is not repeated on every sample
    fresh();
    const sample0 = { t: NOW - 7200000, block: 1, bal: 20, index: (2n * E18).toString(), price: null };
    fs.writeFileSync(FILE, JSON.stringify({ tokens: {}, wallets: { [A.toLowerCase()]: { [SNET]: { samples: [sample0], backfilledAt: 1 } } } }));
    const prov = mockProvider({ balances: { [A.toLowerCase()]: 20n * E18 }, index: 2n * E18, failLogsFor: [A] });
    const st = make(prov, [{ address: A, label: "A" }]);
    await st.sample();
    const n1 = prov.logQueries.filter((q) => q[1] === pad(A) || q[2] === pad(A)).length;
    assert.ok(n1 >= 1, "the failing principal scan ran once");
    await st.sample(); await st.sample();
    assert.strictEqual(prov.logQueries.filter((q) => q[1] === pad(A) || q[2] === pad(A)).length, n1, "and is backed off, not rescanned every sample");
    // single-flight
    fresh();
    const p2 = mockProvider({ balances: { [MAIN]: 10n * E18 }, index: 2n * E18 });
    const st2 = make(p2);
    const a = st2.sample(), b = st2.sample();
    assert.strictEqual(a, b, "a second sample() while one runs returns the same promise");
    await a;
    const c = st2.sample();
    assert.notStrictEqual(c, a, "after it settles a new run starts");
    await c;
    // maxLogRange floor
    fresh();
    const p3 = mockProvider({ balances: { [MAIN]: 10n * E18 }, index: 2n * E18, rebases: [] });
    await make(p3, [], { maxLogRange: 5 }).sample();
    assert.ok(p3.ranges.length && p3.ranges.every(([x, y]) => y - x + 1 <= 1000), "maxLogRange 5 is clamped to 1000, no smaller");
    assert.ok(p3.ranges.some(([x, y]) => y - x + 1 === 1000), "chunks are 1000 blocks");
    // a corrupt ledger that cannot be set aside is never overwritten
    fresh();
    fs.writeFileSync(FILE, "{ not json");
    const realRename = fs.renameSync;
    fs.renameSync = function (f, ...r) { if (String(f) === FILE) throw new Error("EPERM"); return realRename.call(this, f, ...r); };
    try {
      const st4 = make(mockProvider({ balances: { [MAIN]: 10n * E18 }, index: 2n * E18 }));
      await st4.sample();
    } finally { fs.renameSync = realRename; }
    assert.strictEqual(fs.readFileSync(FILE, "utf8"), "{ not json", "the unread original survives byte for byte");
    assert.ok(!fs.readdirSync(TMP).some((f) => f.endsWith(".tmp")), "and no tmp was left");
    fs.unlinkSync(FILE);
    // a failed save removes its tmp file
    const realW = fs.writeFileSync;
    fs.writeFileSync = function (f, ...r) { if (String(f).endsWith(".tmp")) { realW.call(this, f, "partial"); throw new Error("ENOSPC"); } return realW.call(this, f, ...r); };
    try { await make(mockProvider({ balances: { [MAIN]: 10n * E18 }, index: 2n * E18 })).sample(); } finally { fs.writeFileSync = realW; }
    assert.ok(!fs.readdirSync(TMP).some((f) => f.endsWith(".tmp")), "a failed save unlinks its tmp file");
    fresh();
  }

  // ---- 6d. duplicate labels resolve to nothing ----
  {
    const st = make(mockProvider(), [{ address: A, label: "Dup" }, { address: B, label: "dup" }]);
    assert.strictEqual(st.resolve("dup"), null, "a label shared by two wallets is refused");
    assert.strictEqual(st.resolve(A).address, A, "but each address still resolves");
  }

  // ---- 7. /api/staking: lifted from server.js, run against the real module -----------
  {
    const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    const from = src.indexOf('  if (url.pathname === "/api/staking") {');
    assert.ok(from >= 0, "the /api/staking route is gone from server.js");
    const end = src.indexOf('\n  if (url.pathname === "/api/watch")', from);
    const body = src.slice(from, end);
    fresh();
    const prov = mockProvider({ balances: { [MAIN]: 50n * E18, [A.toLowerCase()]: 100n * E18 }, index: 2n * E18,
      transfers: [{ from: ethers.ZeroAddress, to: MAIN, value: 50n * E18 }, { from: ethers.ZeroAddress, to: A, value: 100n * E18 }] });
    const st = make(prov, [{ address: A, label: "Wallet A" }]);
    await st.sample();
    const route = new Function("url", "res", "staking", body + "\n return null;");
    const hit = (qs) => {
      const res = { status: null, body: null, setHeader() {}, writeHead(c) { this.status = c; }, end(b) { this.body = JSON.parse(b); } };
      route(new URL("http://x/api/staking" + qs), res, st);
      return res;
    };
    const base = hit("");
    assert.strictEqual(base.status, 200);
    for (const k of ["ok", "at", "tokens"]) assert.ok(k in base.body, `today's key ${k} is still present`);
    assert.deepStrictEqual(base.body.tokens, st.view().tokens.map((t) => JSON.parse(JSON.stringify(t))), "tokens are main's, identical");
    assert.strictEqual(base.body.wallets[0].address, A, "wallets is additive");
    assert.strictEqual(hit("?wallet=" + A).body.tokens[0].balance, 100, "?wallet=<address> returns A's tokens");
    assert.strictEqual(hit("?wallet=Wallet%20A").body.tokens[0].balance, 100, "?wallet=<label> works");
    assert.strictEqual(hit("?wallet=" + A.toLowerCase()).body.wallet.label, "Wallet A", "lower-case address works");
    const calls = prov.calls;
    for (const q of [DEAD, "zzz", "", "0x12"]) {
      const r = hit("?wallet=" + q);
      assert.strictEqual(r.status, 400, `?wallet=${q} is refused`);
      assert.strictEqual(r.body.ok, false);
    }
    assert.strictEqual(prov.calls, calls, "refused wallets caused no RPC call");
    assert.ok(!/\bsample\b|getLogs|balanceOf/.test(body), "the route reads the cached view; it never touches the chain itself");
  }

  // ---- 8. MCP staking tool -------------------------------------------------------------
  {
    const http = require("http");
    const golden = fs.readFileSync(path.join(FX, "old-mcp.golden.json"), "utf8").trim();
    const view = JSON.parse(fs.readFileSync(path.join(FX, "old-view.golden.json"), "utf8"));
    const wTok = JSON.parse(JSON.stringify(view.tokens));
    wTok[0].balance = 7.5;
    const seen = [];
    const server = http.createServer((q, r) => {
      seen.push(q.url);
      const u = new URL(q.url, "http://x");
      let body = view, code = 200;
      if (u.searchParams.has("wallet")) {
        const w = u.searchParams.get("wallet");
        if (w === "Wallet A") body = { ok: true, at: 1, wallet: { address: A, label: "Wallet A" }, tokens: wTok };
        else { code = 400; body = { ok: false, error: "unknown wallet" }; }
      } else if (u.searchParams.get("_with") === "wallets") body = view;
      r.writeHead(code, { "content-type": "application/json" });
      r.end(JSON.stringify(mcpMode.on && !u.searchParams.has("wallet") ? { ...view, wallets: [{ address: A, label: "Wallet A", tokens: wTok }] } : body));
    });
    const mcpMode = { on: false };
    const port = await new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port)));
    process.env.LP_DASHBOARD_URL = `http://127.0.0.1:${port}`;
    const { createServer } = await import(`${path.join(ROOT, "lp-mcp.mjs")}?t=${Date.now()}`);
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer().connect(s);
    const cl = new Client({ name: "t", version: "1" });
    await cl.connect(c);
    const call = async (args) => cl.callTool({ name: "staking", arguments: args });
    const tool = (await cl.listTools()).tools.find((t) => t.name === "staking");
    assert.ok(!(tool.inputSchema.required || []).includes("wallet"), "wallet is optional in the schema");
    assert.ok(tool.inputSchema.properties.wallet, "and exists");

    const def = await call({});
    assert.strictEqual(def.content[0].text, golden, "no argument, no extra wallets: byte-identical to the pre-change output");
    mcpMode.on = true;
    const withW = JSON.parse((await call({})).content[0].text);
    assert.deepStrictEqual(withW.tokens, JSON.parse(golden).tokens, "tokens keep their shape and rounding");
    assert.deepStrictEqual(withW.wallets.map((w) => [w.label, w.address, w.tokens[0].balance]), [["Wallet A", A, 7.5]], "wallets is additive");
    const one = JSON.parse((await call({ wallet: "Wallet A" })).content[0].text);
    assert.deepStrictEqual(one.wallet, { address: A, label: "Wallet A" });
    assert.strictEqual(one.tokens[0].balance, 7.5, "with wallet: that wallet's data");
    assert.ok(seen.some((u) => u.includes("wallet=Wallet%20A")), "the wallet is URL-encoded into the query");
    const bad = await call({ wallet: "nobody" });
    assert.strictEqual(bad.isError, true, "an unknown wallet is an error result, not a crash");
    assert.match(bad.content[0].text, /Unknown wallet/);
    server.close();
  }

  // ---- 9. dashboard: scope picks the wallet; all = rows, no merged APR; tax labels ----
  {
    const src = fs.readFileSync(path.join(ROOT, "dashboard.js"), "utf8");
    const slice = (name, next) => { const a = src.indexOf(name); assert.ok(a >= 0, name + " missing"); return src.slice(a, src.indexOf(next, a)); };
    const code = slice("function stakingPart(", "/** Income events") + "\n" + slice("function incomeEvents(", "let treasuryD");
    const tok = (bal, apr, label = "sNET staking") => ({ label, symbol: "sNET", balance: bal, principal: bal - 1, price: 1, usd: bal, since: NOW, aprPct: apr,
      rewards: { today: 0.1, d7: 0.5, d30: 1, total: 1, totalUsd: 1, d7Usd: 0.5, d30Usd: 1 }, daily: [{ day: "2026-11-05", amount: 0.1, usd: 0.1, approx: false }],
      events: [{ t: NOW - 1000, amount: 0.1, usd: 0.1, approx: false }] });
    const D = { ok: true, tokens: [tok(50, 11)], wallets: [{ address: A, label: "Wallet A", tokens: [tok(100, 22)] }, { address: B, label: "Wallet B", tokens: [] }] };
    const run = (scope, page = "dashboard") => {
      const els = {}; const el = (k) => (els[k] = els[k] || { hidden: true, innerHTML: "", textContent: "" });
      const f = new Function("$", "pfScope", "ownerLabel", "stakingD", "usd", "amount", "price", "esc", "dayLabel", "historyRows", "PAGE", "pref",
        code + "; return { renderStaking, incomeEvents };");
      const api = f((k) => el(k), () => scope, () => "Main", D, (n) => (n == null ? "—" : "$" + Number(n).toFixed(2)), (n) => String(+Number(n).toFixed(4)), (n) => n, (x) => String(x), (d) => d, [], page, (k) => (k === "staking:scope" ? scope : null));
      api.renderStaking();
      return { els, events: api.incomeEvents() };
    };
    const a = run(A.toLowerCase());
    assert.ok(a.els["#stakestats"].innerHTML.includes("Wallet A") && a.els["#stakestats"].innerHTML.includes("<b>100 sNET</b>"), "scope = A renders A's data");
    assert.ok(!a.els["#stakestats"].innerHTML.includes("<b>50 sNET</b>") && !/Main/.test(a.els["#staketable"].innerHTML), "and none of main's");
    assert.deepStrictEqual(a.events.map((e) => e.wallet).sort(), ["Main", "Wallet A"], "tax rows carry each wallet's own label, whatever the scope");
    const all = run("all");
    assert.strictEqual((all.els["#staketable"].innerHTML.match(/<tr><td class="l">(Main|Wallet A)<\/td>/g) || []).length, 2, "all: one row per wallet that stakes (B holds none)");
    assert.ok(/Subtotal/.test(all.els["#staketable"].innerHTML), "with a subtotal row");
    assert.ok(!/33%|16%|APR<\/b> realised/.test(all.els["#stakestats"].innerHTML + all.els["#staketable"].innerHTML.replace(/<td>(11|22)%<\/td>/g, "")), "no merged APR: only each wallet's own");
    assert.deepStrictEqual(all.events.map((e) => e.wallet).sort(), ["Main", "Wallet A"], "tax rows are labelled per wallet");
    // Analytics: the picker is never filled there; a stale invisible choice must not shape the export, and the panel has a visible control of its own.
    const an = run(A.toLowerCase(), "analytics");
    assert.deepStrictEqual(an.events.map((e) => e.wallet).sort(), ["Main", "Wallet A"], "scope = A: incomeEvents still includes main's rewards");
    assert.strictEqual(an.els["#stakescope"].hidden, false, "the Analytics staking panel shows its own scope control");
    assert.ok(an.els["#stakescope"].innerHTML.includes(A.toLowerCase()) && an.els["#stakescope"].value === A.toLowerCase(), "which is filled from the staking data and carries the scope");
    assert.ok(an.els["#stakestats"].innerHTML.includes("<b>100 sNET</b>"), "and drives the panel");
    assert.strictEqual(run("all").els["#stakescope"].hidden, true, "off Analytics the page picker rules and the panel control stays hidden");
    const own = run("owner");
    assert.deepStrictEqual(own.events.map((e) => e.wallet).sort(), ["Main", "Wallet A"], "owner scope: the export still has every wallet");
    assert.ok(own.els["#stakestats"].innerHTML.includes("<b>50 sNET</b>"));
    // a stale pref on Analytics never hides the panel
    const stale = run("0x4444444444444444444444444444444444444444", "analytics");
    assert.strictEqual(stale.els["#stakesec"].hidden, false, "analytics + a pref for an unconfigured address: the panel stays");
    assert.strictEqual(stale.els["#stakescope"].hidden, false, "and so does its control");
    assert.strictEqual((stale.els["#staketable"].innerHTML.match(/<tr><td class="l">(Main|Wallet A)<\/td>/g) || []).length, 2, "showing all wallets");
    assert.strictEqual(stale.els["#stakescope"].value, "all");
    const none = run("0x4444444444444444444444444444444444444444");
    assert.strictEqual(none.els["#stakesec"].hidden, true, "a wallet that stakes nothing hides the panel rather than showing someone else's");
  }

  // ---- 10. backup-ledgers.sh already carries snet-staking.json, and nothing new ------
  {
    const sh = fs.readFileSync(path.join(ROOT, "backup-ledgers.sh"), "utf8");
    assert.ok(/\bsnet-staking\.json\b/.test(sh), "the one ledger file is in the backup list");
    assert.ok(!/snet-staking-/.test(sh), "no per-wallet file name was introduced");
    assert.ok(!fs.readdirSync(TMP).some((f) => /^snet-staking.+\.json$/.test(f)), "and none was written");
  }

  console.log("staking-wallets: ok");
}
