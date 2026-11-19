// mint-watch.js: a wallet's nonce moving triggers one rescan now and one confirming rescan on
// the next tick; first sight is a baseline; a failed read triggers nothing and is logged once.
const assert = require("assert");
const { create } = require("../mint-watch");

(async () => {
  const nonces = { "0xaaa": 5, "0xbbb": 9 };
  let fail = false;
  const provider = { getTransactionCount: async (a) => { if (fail) throw new Error("429"); return nonces[a.toLowerCase()]; } };
  const jobs = [], logs = [];
  let list = [{ address: "0xAAA", label: "Main", main: true }, { address: "0xBBB", label: "Trading" }];
  const w = create({ provider, wallets: () => list, onChange: async (j) => { jobs.push(j); }, log: (m) => logs.push(m) });

  assert.strictEqual(await w.tick(), null, "first sight is the baseline");
  assert.strictEqual(await w.tick(), null, "nothing moved");

  nonces["0xbbb"] = 10; // the Trading wallet mints
  let j = await w.tick();
  assert.deepStrictEqual([j.main, j.watched, j.confirm], [false, true, false]);
  assert.deepStrictEqual(j.wallets.map((x) => x.label), ["Trading"]);
  j = await w.tick();
  assert.deepStrictEqual([j.main, j.watched, j.confirm], [false, true, true], "one confirming rescan on the next tick");
  assert.strictEqual(await w.tick(), null, "then quiet");
  assert.strictEqual(jobs.length, 2);

  // main moves while a watched follow-up is pending: the follow-up covers both
  nonces["0xbbb"] = 11; await w.tick();
  nonces["0xaaa"] = 6; j = await w.tick();
  assert.deepStrictEqual([j.main, j.watched], [true, false]);
  j = await w.tick();
  assert.deepStrictEqual([j.main, j.watched, j.confirm], [true, true, true]);

  // a failed read: no rescan, one log line, and the change is still seen afterwards
  fail = true; nonces["0xaaa"] = 7;
  assert.strictEqual(await w.tick(), null); assert.strictEqual(await w.tick(), null);
  assert.strictEqual(logs.filter((m) => /cannot read/.test(m)).length, 1);
  fail = false;
  j = await w.tick();
  assert.ok(j && j.main, "the change made during the outage is picked up");
  await w.tick();

  // a wallet added later starts from its own baseline; a failing rescan does not throw
  list = [...list, { address: "0xCCC", label: "New" }]; nonces["0xccc"] = 3;
  assert.strictEqual(await w.tick(), null);
  const bad = create({ provider, wallets: () => list, onChange: async () => { throw new Error("boom"); }, log: (m) => logs.push(m) });
  await bad.tick(); nonces["0xccc"] = 4;
  assert.ok(await bad.tick());
  assert.ok(logs.some((m) => /rescan failed: boom/.test(m)));
  console.log("mint-watch: all assertions passed");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
