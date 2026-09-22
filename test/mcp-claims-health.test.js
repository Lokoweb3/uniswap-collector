// node test/mcp-claims-health.test.js — the three tools added for the chain-derived
// claim history, token risk and the daily check.
//
// claimed_fees exists because `collects` counts only runs this collector made. Fees the
// wallet settled itself are absent there and present here, so the dashboard's own warning
// -- "a zero here is not a zero there" -- had no equivalent over MCP. The figure it returns
// is usually a SUBTOTAL: on the instance this was written against, 32 of 40 positions could
// not be reconstructed at all. So the test's real subject is not the number but the context
// travelling with it: state, stateLabel and coverage must reach the assistant, or $4.86 of
// priced records gets reported as lifetime earnings.
"use strict";
const assert = require("assert");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const CLAIMS = {
  ok: true,
  label: "Total claimed fees · All wallets · Open + closed",
  state: "partial",
  stateLabel: "Verified claimed so far — partial history",
  verifiedZero: false,
  tokens: [{ symbol: "USDG", amount: 41.755927 }, { symbol: "MEME", amount: 42.51958289 }],
  usd: {
    pricedSubtotal: 4.85663081893,
    pricedRecords: 4,
    unpricedRecords: 4,
    excluded: [{ tokenId: "1760002", reason: "no verified price of this claim's moment" }],
  },
  current: { usd: null, note: "a claimed token has no current price" },
  subtotals: { open: { records: 0 }, closed: { records: 8 }, other: { records: 0 } },
  positions: [
    { tokenId: "3010813", walletLabel: "Main", pair: "ETH / CASHCAT", status: "open",
      state: "unsupported", reason: "native-asset leg emits no log", records: 0, pricedSubtotal: 0, lastT: null },
  ],
  coverage: {
    positionsTotal: 40, positionsComplete: 7,
    partial: [{ tokenId: "1" }], unsupported: new Array(32).fill({ tokenId: "x" }), discovery: [1, 2, 3, 4],
    note: "Native-asset payouts emit no log and are not reconstructed.",
  },
};

const HEALTH = {
  ok: true, count: 4,
  tokens: [
    { address: "0xaa", symbol: "NET", level: "risk", label: "Risk", notes: ["transfer tax on"], powers: ["mint", "tax"], verified: true, holders: 10146, ageDays: 67.31 },
    { address: "0xbb", symbol: "DOG", level: "risk", label: "Risk", notes: ["mint function"], powers: ["mint"], verified: false, holders: 12, ageDays: 3 },
    { address: "0xcc", symbol: "MID", level: "caution", label: "Caution", notes: [], powers: [], verified: true, holders: 900, ageDays: 40 },
    { address: "0xdd", symbol: "USDG", level: "safe", label: "Safe", notes: [], powers: [], verified: true, holders: 5000, ageDays: 300 },
  ],
  byAddress: {},
};
for (const t of HEALTH.tokens) HEALTH.byAddress[t.address] = t;

const DAILY = { ok: true, text: "📋 Daily LP check — Sep 21\n🔐 Armed, 21h 8m left" };

(async () => {
  const server = http.createServer((q, r) => {
    const body = q.url.startsWith("/api/claims/total") ? CLAIMS
      : q.url.startsWith("/api/token-health") ? HEALTH
        : q.url.startsWith("/api/daily-check") ? DAILY
          : { ok: false, error: "unexpected route " + q.url };
    r.writeHead(200, { "content-type": "application/json" });
    r.end(JSON.stringify(body));
  });
  const port = await new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port)));
  process.env.LP_DASHBOARD_URL = `http://127.0.0.1:${port}`;

  const { createServer } = await import(`${path.join(ROOT, "lp-mcp.mjs")}?t=${Date.now()}`);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createServer().connect(s);
  const cl = new Client({ name: "t", version: "1" });
  await cl.connect(c);
  const call = async (name, args = {}) => (await cl.callTool({ name, arguments: args })).content[0].text;

  // ---- 1. all three are read tools: a read-only connector must still get them ----
  const readNames = Object.keys(createServer({ role: "read" })._registeredTools || {});
  for (const n of ["claimed_fees", "token_health", "daily_check"]) {
    assert.ok(readNames.includes(n), `${n} survives the read role (it changes nothing)`);
  }

  // ---- 2. claimed_fees carries the caveats, not just the number -----------------
  const cf = JSON.parse(await call("claimed_fees"));
  assert.strictEqual(cf.state, "partial", "the state travels with the figure");
  assert.match(cf.stateLabel, /partial history/, "and says so in words");
  assert.strictEqual(cf.usd.pricedSubtotal, 4.86, "the subtotal is rounded money");
  assert.strictEqual(cf.usd.unpricedRecords, 4, "and reports what it could not price");
  assert.strictEqual(cf.usd.excludedCount, 1, "with a count of what was excluded");
  assert.strictEqual(cf.coverage.positionsTotal, 40);
  assert.strictEqual(cf.coverage.positionsComplete, 7, "7 of 40 complete is the headline caveat");
  assert.strictEqual(cf.coverage.unsupportedCount, 32, "and 32 cannot be reconstructed at all");
  assert.match(cf.coverage.note, /no log/, "the note explaining why comes too");
  assert.strictEqual(cf.current.usd, null, "a missing current-price figure stays null, never 0");

  // The long lists are behind a flag, so the default answer stays readable.
  assert.strictEqual(cf.positions, undefined, "per-position rows are opt-in");
  assert.strictEqual(cf.coverage.unsupported, undefined, "so are the coverage lists");
  const cfp = JSON.parse(await call("claimed_fees", { positions: true }));
  assert.strictEqual(cfp.positions.length, 1, "positions:true returns the rows");
  assert.strictEqual(cfp.coverage.unsupported.length, 32, "and the coverage lists");
  assert.match(cfp.positions[0].reason, /no log/, "each row keeps the reason it is unsupported");

  // ---- 3. token_health defaults to what is worth reading ------------------------
  const th = JSON.parse(await call("token_health"));
  assert.deepStrictEqual(th.levels, { risk: 2, caution: 1, safe: 1 }, "every level is counted");
  assert.strictEqual(th.tokens.length, 3, "but only the tokens above safe are listed");
  assert.ok(!th.tokens.some((t) => t.level === "safe"), "no safe token in the default list");
  assert.strictEqual(JSON.parse(await call("token_health", { all: true })).tokens.length, 4, "all:true lists every token");
  const one = JSON.parse(await call("token_health", { symbol: "net" }));
  assert.strictEqual(one[0].symbol, "NET", "symbol lookup is case-insensitive");
  assert.deepStrictEqual(one[0].notes, ["transfer tax on"], "and carries what was found");
  assert.strictEqual(JSON.parse(await call("token_health", { address: "0xBB" }))?.symbol, "DOG",
    "address lookup is case-insensitive too");
  // A miss is a stated miss, not an empty list that reads as "nothing wrong".
  const miss = JSON.parse(await call("token_health", { symbol: "NOPE" }));
  assert.strictEqual(miss.found, false, "an unknown token says so");
  assert.strictEqual(miss.checked, 4, "and says how many were checked");

  // ---- 4. daily_check is passed through as text ---------------------------------
  const dc = await call("daily_check");
  assert.match(dc, /Daily LP check/, "the report comes back as its own text");
  assert.match(dc, /Armed, 21h 8m left/, "including the arm window");

  await new Promise((done) => server.close(done));
  console.log("mcp claims/health/daily: claimed_fees carries state and coverage with its subtotal, token_health defaults to the tokens above safe, daily_check passes its text through");
})().catch((e) => { console.error(e); process.exit(1); });
