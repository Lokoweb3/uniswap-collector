// node test/alerts.test.js — exercises every alert condition with a mock transport.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { create } = require("../alerts");

const stateFile = path.join(os.tmpdir(), `alerts-test-${process.pid}.json`);
let clock = new Date("2026-09-07T08:40:00").getTime(); // 08:40 local
const sent = [];
const a = create({ transport: async (t) => { sent.push(t); return true; }, stateFile, now: () => clock, log: { error() {} } });

const pos = (inRange, rawPos = 0.5) => ({ tokenId: "1030190", nftId: "1030190", pair: "WETH / USDG", inRange, rawPos, valueUsd: 2114, feesUsd: 8 });
const run = (t, result, mode = "full") => ({ lastRun: { t, mode, result } });

(async () => {
  // 1. locked collector before the run (08:40), and no position problems.
  let out = await a.check({ payload: { positions: [pos(true)] }, ops: run("2026-09-06T09:00:04", "collected 1 position"), unlock: { armed: false }, keepalive: true });
  assert.strictEqual(out.length, 1, "locked warning expected"); assert.match(out[0], /locked/);
  // same tick again: deduplicated
  out = await a.check({ payload: { positions: [pos(true)] }, ops: run("2026-09-06T09:00:04", "collected 1 position"), unlock: { armed: false }, keepalive: true });
  assert.strictEqual(out.length, 0, "locked warning must not repeat the same day");

  // 2. position goes out of range
  clock += 10 * 60 * 1000;
  out = await a.check({ payload: { positions: [pos(false, 1.2)] }, ops: run("2026-09-06T09:00:04", "collected 1 position"), unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 1); assert.match(out[0], /out of range.*above/);
  // still out: no repeat
  clock += 10 * 60 * 1000;
  out = await a.check({ payload: { positions: [pos(false, 1.2)] }, ops: run("2026-09-06T09:00:04", "collected 1 position"), unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 0);
  // back in range
  clock += 10 * 60 * 1000;
  out = await a.check({ payload: { positions: [pos(true)] }, ops: run("2026-09-06T09:00:04", "collected 1 position"), unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 1); assert.match(out[0], /back in range/);

  // 3. failed 09:00 collect (new run stamp)
  clock = new Date("2026-09-07T09:12:00").getTime();
  out = await a.check({ payload: { positions: [pos(true)] }, ops: run("2026-09-07T09:00:05", "collected 0 positions, 1 failed"), unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 1); assert.match(out[0], /❌ Collect run/);

  // 4. run skipped because locked
  out = await a.check({ payload: { positions: [pos(true)] }, ops: run("2026-09-07T09:00:06", "locked — skipped", "collect"), unlock: { armed: false }, keepalive: true });
  assert.strictEqual(out.length, 1); assert.match(out[0], /🔒 Collect run.*locked/);

  // 5. missed run: 09:35 with yesterday's run as the latest
  const b = create({ transport: async (t) => { sent.push(t); return true; }, stateFile: stateFile + ".b", now: () => clock, log: { error() {} } });
  clock = new Date("2026-09-07T09:35:00").getTime();
  out = await b.check({ payload: { positions: [] }, ops: run("2026-09-06T09:00:04", "collected 1 position"), unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 1); assert.match(out[0], /No collect run seen today/);

  // 6. keepalive gone
  out = await b.check({ payload: { positions: [] }, ops: run("2026-09-06T09:00:04", "collected 1 position"), unlock: { armed: true }, keepalive: false });
  assert.strictEqual(out.length, 1); assert.match(out[0], /keepalive session is not running/);

  // 7. outage detected on the next tick after a 2h gap
  clock += 2 * 3600 * 1000;
  out = await b.check({ payload: { positions: [] }, ops: run("2026-09-06T09:00:04", "collected 1 position"), unlock: { armed: true }, keepalive: true });
  assert.ok(out.some((m) => /Dashboard was down for about 120 min/.test(m)), "outage alert expected");

  // 8b. arm window lost at a restart
  out = await b.check({ payload: { positions: [] }, ops: run("2026-09-06T09:00:04", "collected 1 position"), unlock: { armed: false, lost: true, until: clock + 3 * 86400000 }, keepalive: true });
  assert.strictEqual(out.length, 1); assert.match(out[0], /arm window .* was lost/);
  out = await b.check({ payload: { positions: [] }, ops: run("2026-09-06T09:00:04", "collected 1 position"), unlock: { armed: false, lost: true, until: clock + 3 * 86400000 }, keepalive: true });
  assert.strictEqual(out.length, 0, "lost-window alert must not repeat");

  // 8c. treasury: 3 consecutive failures, balance over the threshold, split change; routed to the treasury chat
  const routed = [];
  const c2 = create({ transport: async (t, to) => { routed.push([to, t]); return true; }, stateFile: stateFile + ".t", now: () => clock, log: { error() {} }, chatId: "main", treasuryChatId: "vault" });
  out = await c2.check({ payload: { positions: [] }, unlock: { armed: true }, keepalive: true, treasury: { enabled: true, pct: 10, balanceUsdg: 12, consecutiveFailures: 3 } });
  assert.strictEqual(out.length, 1); assert.match(out[0], /failed 3 times/); assert.strictEqual(routed[routed.length - 1][0], "vault");
  out = await c2.check({ payload: { positions: [] }, unlock: { armed: true }, keepalive: true, treasury: { enabled: true, pct: 15, balanceUsdg: 150, consecutiveFailures: 3 } });
  assert.strictEqual(out.length, 2, "balance + pct change expected"); assert.ok(out.some(m => /150.00 USDG/.test(m))); assert.ok(out.some(m => /10% → 15%/.test(m)));
  out = await c2.check({ payload: { positions: [] }, unlock: { armed: true }, keepalive: true, treasury: { enabled: true, pct: 15, balanceUsdg: 150, consecutiveFailures: 3 } });
  assert.strictEqual(out.length, 0, "no repeats within the window");
  // fallback: treasury chat refuses, main chat gets it
  const routed2 = [];
  const c3 = create({ transport: async (t, to) => { routed2.push(to); return to !== "vault"; }, stateFile: stateFile + ".t2", now: () => clock, log: { error() {} }, chatId: "main", treasuryChatId: "vault" });
  out = await c3.check({ payload: { positions: [] }, unlock: { armed: true }, keepalive: true, treasury: { enabled: true, pct: 10, balanceUsdg: 500, consecutiveFailures: 0 } });
  assert.deepStrictEqual(routed2, ["vault", "main"]);
  for (const f of [stateFile + ".t", stateFile + ".t2"]) { try { fs.unlinkSync(f); } catch {} }

  // 9. watched wallets: a position leaves and re-enters range, prefixed with the wallet label, no repeats;
  //    the main wallet's own alerts are unchanged (same keys as before) and carry the owner label.
  const w = create({ transport: async (t) => { sent.push(t); return true; }, stateFile: stateFile + ".w", now: () => clock, log: { error() {} } });
  const lpr = (inRange, rawPos = 0.5) => ({ label: "LP Rewards", address: "0x0000000000000000000000000000000000000013", ok: true, positions: [{ tokenId: "972362", nftId: "972362", pair: "WETH / Index", inRange, rawPos, valueUsd: 3262, feesUsd: 1.4 }] });
  const trading = { label: "Trading", address: "0x0000000000000000000000000000000000000012", ok: true, positions: [] };
  const mainPayload = (inRange) => ({ ownerLabel: "Main", positions: [pos(inRange)] });
  out = await w.check({ payload: mainPayload(true), watched: [lpr(true), trading], unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 0, "everything in range: silent");
  clock += 10 * 60 * 1000;
  out = await w.check({ payload: mainPayload(true), watched: [lpr(false, 0.1), trading], unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 1); assert.match(out[0], /^🔴 LP Rewards · WETH \/ Index #972362 is out of range \(price below/);
  clock += 10 * 60 * 1000;
  out = await w.check({ payload: mainPayload(true), watched: [lpr(false, 0.1), trading], unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 0, "still out: no repeat");
  // a transient load failure of that wallet must not reset its state
  out = await w.check({ payload: mainPayload(true), watched: [{ ...lpr(false, 0.1), ok: false, positions: [] }, trading], unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 0);
  clock += 10 * 60 * 1000;
  out = await w.check({ payload: mainPayload(true), watched: [lpr(false, 0.1), trading], unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 0);
  clock += 10 * 60 * 1000;
  out = await w.check({ payload: mainPayload(true), watched: [lpr(true), trading], unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 1); assert.match(out[0], /^🟢 LP Rewards · WETH \/ Index #972362 is back in range after 0\.5 h/);
  // main wallet out of range alongside a watched one: two messages, main prefixed with its label; ids never collide
  clock += 10 * 60 * 1000;
  out = await w.check({ payload: mainPayload(false), watched: [lpr(false, 1.3), trading], unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 2);
  assert.ok(out.some((m) => /^🔴 Main · WETH \/ USDG #1030190 is out of range/.test(m)), "main wallet alert with owner label");
  assert.ok(out.some((m) => /^🔴 LP Rewards · WETH \/ Index #972362 is out of range \(price above/.test(m)));
  assert.deepStrictEqual(Object.keys(w.state.outSince).sort(), ["0x0000000000000000000000000000000000000013:972362", "1030190"]);

  // 10. a run with failures in two wallets: one message naming both
  clock = new Date("2026-09-08T09:12:00").getTime();
  out = await w.check({ payload: mainPayload(true), watched: [lpr(true), trading], unlock: { armed: true }, keepalive: true,
    ops: { lastRun: { t: "2026-09-08T09:00:01.000Z", mode: "full", result: "collected 2 positions, 3 failed", failures: [{ wallet: "Trading", count: 1 }, { wallet: "LP Rewards", count: 2 }] } } });
  const fail = out.filter((m) => /❌ Collect run/.test(m));
  assert.strictEqual(fail.length, 1, "exactly one run-failure message");
  assert.match(fail[0], /Wallets with failures: Trading \(1\), LP Rewards \(2\)\./);
  // The rest are the two positions coming back in range and the outage notice from the clock jump.
  assert.ok(out.filter((m) => !/❌ Collect run/.test(m)).every((m) => /back in range|Dashboard was down/.test(m)));
  // same run seen again: no repeat
  out = await w.check({ payload: mainPayload(true), watched: [lpr(true), trading], unlock: { armed: true }, keepalive: true,
    ops: { lastRun: { t: "2026-09-08T09:00:01.000Z", mode: "full", result: "collected 2 positions, 3 failed", failures: [{ wallet: "Trading", count: 1 }, { wallet: "LP Rewards", count: 2 }] } } });
  assert.strictEqual(out.length, 0);
  try { fs.unlinkSync(stateFile + ".w"); } catch {}

  // 8. no transport, no token => disabled and silent
  const c = create({ token: undefined, chatId: undefined, stateFile: stateFile + ".c", now: () => clock });
  assert.strictEqual(c.enabled, false);
  assert.deepStrictEqual(await c.check({ payload: { positions: [pos(false)] }, keepalive: true }), []);

  for (const f of [stateFile, stateFile + ".b", stateFile + ".c"]) { try { fs.unlinkSync(f); } catch {} }
  console.log(`alerts: ${sent.length} messages produced across 8 scenarios, all assertions passed`);
  for (const m of sent) console.log("  -", m.slice(0, 90));
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
