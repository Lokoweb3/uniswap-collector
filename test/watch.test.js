// node test/watch.test.js — a watched wallet whose rebuild fails keeps its last good view.
const assert = require("assert");
const { keepLastGood } = require("../watch");
const w = { address: "0xabc", label: "Trading" };
const good = { ...w, ok: true, positions: [{ tokenId: "1" }], holdings: { tokens: [{ symbol: "Bucket", amount: 5 }] }, totals: { walletUsd: 10 } };
// First failure: the good row survives, marked stale with the previous build time and the error.
const r = keepLastGood(w, good, "server response 403 Forbidden", 2000, 1000);
assert.strictEqual(r.ok, true); assert.strictEqual(r.stale, true); assert.strictEqual(r.staleSince, 1000); assert.strictEqual(r.staleError, "server response 403 Forbidden");
assert.deepStrictEqual(r.positions, good.positions); assert.deepStrictEqual(r.holdings, good.holdings);
// A second failure keeps the original staleSince.
const r2 = keepLastGood(w, r, "server response 429", 3000, 2500);
assert.strictEqual(r2.staleSince, 1000);
// Nothing good to keep: the empty failed row, as before.
assert.deepStrictEqual(keepLastGood(w, null, "boom", 1, 1), { ...w, ok: false, error: "boom", positions: [], closed: 0, errors: [], totals: null });
assert.deepStrictEqual(keepLastGood(w, { ...w, ok: false }, "boom", 1, 1).ok, false);
console.log("watch: keep-last-good rows for failed wallet rebuilds — all assertions passed");
