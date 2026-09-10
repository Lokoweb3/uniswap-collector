// node test/strategy-track.test.js — record a proposal, score it against a stubbed position history, view it.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-track-"));
const owner = "0x0000000000000000000000000000000000000001";

// A stubbed /api/strategy/positions: one open position in ETH/LAPTOP that
// collected $40 (expected $30 -> beat), and nothing in ETH/PINK (avoid -> met).
const now = Date.now();
const openedAt = new Date(now - 2 * 86400000).toISOString();
const positions = [
  {
    wallet: "Main", walletAddress: owner, tokenId: "1", version: 3, pair: "ETH / LAPTOP",
    status: "open", openedAt, closedAt: null,
    collects: { usd: 40, count: 2 }, realizedFeeAprPct: 12.5, depositedUsd: 100,
    timeInRange: { pctInRange: 80.0, trackedHours: 48, flips: 1 },
    closed: null,
  },
];

// Stubbed /api/history: for the LAPTOP position (nftId "1", owner wallet) one
// collect falls inside the proposal window, one before it, and one is a v4
// position with the same number. Only the in-window v3 one should count.
const history = [
  { t: now - 2.5 * 86400000, nftId: "1", version: 3, walletAddress: owner, tokenId: "1", pair: "ETH / LAPTOP", usd: 40, principal: false }, // inside window
  { t: now - 5 * 86400000, nftId: "1", version: 3, walletAddress: owner, tokenId: "1", pair: "ETH / LAPTOP", usd: 100, principal: false }, // before window
  { t: now - 2.4 * 86400000, nftId: "1", version: 4, walletAddress: owner, tokenId: "v4-1", pair: "ETH / LAPTOP", usd: 999, principal: false }, // other version
];

const srv = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url.startsWith("/api/strategy/positions")) return res.end(JSON.stringify({ ok: true, positions }));
  if (req.url.startsWith("/api/history")) return res.end(JSON.stringify({ ok: true, rows: history }));
  res.end(JSON.stringify({ ok: true, positions: [] }));
});
srv.listen(0, "127.0.0.1", async () => {
  try {
    const port = srv.address().port;
    const track = require("../strategy-track").create({ cfg: {}, dir, port });

    // Validation
    assert.throws(() => track.record({ author: "", horizonDays: 7, items: [{ wallet: "Main", pair: "A/B", action: "hold" }] }), /author/);
    assert.throws(() => track.record({ author: "x", horizonDays: 0, items: [{ wallet: "Main", pair: "A/B", action: "hold" }] }), /horizonDays/);
    assert.throws(() => track.record({ author: "x", horizonDays: 7, items: [{ wallet: "Main", pair: "A/B", action: "yolo" }] }), /unknown action/);

    // Record a proposal; nothing is scored before its horizon.
    const rec = track.record({
      author: "test-agent", source: "api", horizonDays: 1, rationale: "test",
      items: [
        { wallet: "Main", pair: "LAPTOP / ETH", action: "hold", expected: { feesUsd: 30 } }, // pair order differs on purpose
        { wallet: "Main", pair: "ETH / PINK", action: "avoid" },
        { wallet: "Main", pair: "ETH / NOPE", action: "open", expected: { feesUsd: 10 } },
      ],
    });
    assert.strictEqual(rec.ok, true);
    assert.ok(rec.id);
    assert.strictEqual((await track.score()).scored, false, "not due yet");
    assert.strictEqual(track.view().summary.pending, 1);

    // Move the proposal into the past so it is due, then score it.
    const file = path.join(dir, "strategy-proposals.json");
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    rows[0].t = now - 3 * 86400000;
    fs.writeFileSync(file, JSON.stringify(rows));
    assert.strictEqual((await track.score()).scored, true, "the due proposal should be scored");

    const v = track.view();
    assert.strictEqual(v.proposals.length, 1);
    const p = v.proposals[0];
    const hold = p.items.find((i) => i.pair === "LAPTOP / ETH");
    const avoid = p.items.find((i) => i.pair === "ETH / PINK");
    const nope = p.items.find((i) => i.pair === "ETH / NOPE");
    assert.strictEqual(hold.verdict, "beat", "collected 40 vs expected 30 -> beat");
    assert.strictEqual(hold.delta.feesUsd, 10);
    assert.strictEqual(hold.note, null, "opened inside the window: no predates note");
    // Windowed collects: only the in-window v3 collect counts (40, not 140, not 1039).
    assert.strictEqual(hold.actuals.collectsUsd, 40, "only the in-window collect of the same version counts");
    assert.strictEqual(hold.actuals.lifetime.collectsUsd, 40, "lifetime keeps the position row's whole-life figure");
    // Fee APR over the 1-day window: 40 / 100 * (8760 / 24) * 100 = 14600.
    assert.strictEqual(hold.actuals.feeAprPct, 14600, "APR uses the window hours and windowed collects");
    assert.strictEqual(avoid.verdict, "met", "no position opened in ETH/PINK -> met");
    assert.strictEqual(nope.verdict, "no data");
    assert.strictEqual(p.outcome.score, 66.7, "2 of 3 items met or beat");
    assert.strictEqual(v.summary.scored, 1);
    assert.strictEqual(v.summary.byAuthor[0].author, "test-agent");
    assert.strictEqual(v.summary.byAuthor[0].avgScore, 66.7);

    // Scoring again is a no-op (never rescore).
    assert.strictEqual((await track.score()).scored, false, "already scored -> no change");

    console.log("strategy-track: record, validation, windowed scoring, view and no-rescore assertions passed");
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
