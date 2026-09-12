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
  // 5b. an 08:50 run today is not the 09:00 run; the check also still fires at 10:30, once per day
  for (const f of [stateFile + ".b2", stateFile + ".b3"]) { try { fs.unlinkSync(f); } catch {} } // no state from an earlier run
  const b2 = create({ transport: async (t) => { sent.push(t); return true; }, stateFile: stateFile + ".b2", now: () => clock, log: { error() {} } });
  clock = new Date("2026-09-07T10:30:00").getTime();
  out = await b2.check({ payload: { positions: [] }, ops: run("2026-09-07T08:50:00", "collected 1 position"), unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 1); assert.match(out[0], /No collect run seen today/);
  out = await b2.check({ payload: { positions: [] }, ops: run("2026-09-07T08:50:00", "collected 1 position"), unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 0, "once per day");
  const b3 = create({ transport: async (t) => { sent.push(t); return true; }, stateFile: stateFile + ".b3", now: () => clock, log: { error() {} } });
  out = await b3.check({ payload: { positions: [] }, ops: run("2026-09-07T09:00:05", "collected 1 position"), unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 0, "the 09:00 run happened");
  try { fs.unlinkSync(stateFile + ".b2"); fs.unlinkSync(stateFile + ".b3"); } catch {}
  clock = new Date("2026-09-07T09:35:00").getTime(); // back to where the earlier instances left off

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
  out = await c2.check({ payload: { positions: [] }, unlock: { armed: true }, keepalive: true, treasury: { enabled: true, pct: 15, balanceUsdg: 150, consecutiveFailures: 3, withdrawAlertUsdg: 100 } });
  assert.strictEqual(out.length, 2, "balance + pct change expected"); assert.ok(out.some(m => /150.00 USDG/.test(m))); assert.ok(out.some(m => /10% → 15%/.test(m)));
  out = await c2.check({ payload: { positions: [] }, unlock: { armed: true }, keepalive: true, treasury: { enabled: true, pct: 15, balanceUsdg: 150, consecutiveFailures: 3, withdrawAlertUsdg: 100 } });
  assert.strictEqual(out.length, 0, "no repeats within the window");
  // default level is 1000 USDG: 150 without an explicit level stays quiet (fresh state file)
  const c2b = create({ transport: async () => true, stateFile: stateFile + ".t3", now: () => clock, log: { error() {} }, chatId: "main", treasuryChatId: "vault" });
  out = await c2b.check({ payload: { positions: [] }, unlock: { armed: true }, keepalive: true, treasury: { enabled: true, pct: 15, balanceUsdg: 150, consecutiveFailures: 0 } });
  assert.ok(!out.some(m => /Time to withdraw/.test(m)), "150 USDG is under the 1000 default");
  // fallback: treasury chat refuses, main chat gets it
  const routed2 = [];
  const c3 = create({ transport: async (t, to) => { routed2.push(to); return to !== "vault"; }, stateFile: stateFile + ".t2", now: () => clock, log: { error() {} }, chatId: "main", treasuryChatId: "vault" });
  out = await c3.check({ payload: { positions: [] }, unlock: { armed: true }, keepalive: true, treasury: { enabled: true, pct: 10, balanceUsdg: 500, consecutiveFailures: 0, withdrawAlertUsdg: 100 } });
  assert.deepStrictEqual(routed2, ["vault", "main"]);
  for (const f of [stateFile + ".t", stateFile + ".t2", stateFile + ".t3"]) { try { fs.unlinkSync(f); } catch {} }

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
  // main wallet out of range alongside a watched one: main prefixed with its label; ids never collide.
  // The watched one flapped back out 10 min after "back in range", so its pool cool-down holds
  // that alert until the window has passed (one message per pool per window).
  clock += 10 * 60 * 1000;
  out = await w.check({ payload: mainPayload(false), watched: [lpr(false, 1.3), trading], unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 1);
  assert.ok(out.some((m) => /^🔴 Main · WETH \/ USDG #1030190 is out of range/.test(m)), "main wallet alert with owner label");
  assert.deepStrictEqual(Object.keys(w.state.outSince).sort(), ["0x0000000000000000000000000000000000000013:972362", "1030190"]);
  clock += 25 * 60 * 1000;
  out = await w.check({ payload: mainPayload(false), watched: [lpr(false, 1.3), trading], unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.length, 1, "the held alert goes out once its pool's window has passed");
  assert.match(out[0], /^🔴 LP Rewards · WETH \/ Index #972362 is out of range \(price above/);

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

  // 8d. background loop watchdog: stale once, recovered once
  const c4 = create({ transport: async (t) => { sent.push(t); return true; }, stateFile: stateFile + ".l", now: () => clock, log: { error() {} } });
  out = await c4.check({ payload: { positions: [] }, unlock: { armed: true }, keepalive: true, loops: { guardian: { label: "memecoin guardian", ageMin: 25, staleAfterMin: 10, stale: true } } });
  assert.strictEqual(out.length, 1); assert.match(out[0], /memecoin guardian has not reported for 25 min/);
  out = await c4.check({ payload: { positions: [] }, unlock: { armed: true }, keepalive: true, loops: { guardian: { label: "memecoin guardian", ageMin: 35, staleAfterMin: 10, stale: true } } });
  assert.strictEqual(out.length, 0, "stale loop must not repeat");
  clock += 60000;
  out = await c4.check({ payload: { positions: [] }, unlock: { armed: true }, keepalive: true, loops: { guardian: { label: "memecoin guardian", ageMin: 1, staleAfterMin: 10, stale: false } } });
  assert.strictEqual(out.length, 1); assert.match(out[0], /reporting again/);
  try { fs.unlinkSync(stateFile + ".l"); } catch {}

  // 8. no transport, no token => disabled and silent
  const c = create({ token: null, chatId: null, stateFile: stateFile + ".c", now: () => clock });
  assert.strictEqual(c.enabled, false);
  assert.deepStrictEqual(await c.check({ payload: { positions: [pos(false)] }, keepalive: true }), []);

  // 9. One cool-down per pool, shared by every source (guardian, collect summary, range check).
  const P = "v4:0xpool", Q = "v3:0xother";
  const before = sent.length;
  assert.strictEqual(await a.sendPool(P, "🛡️ guardian says something", { source: "guardian" }), true);
  clock += 5 * 60 * 1000;
  assert.strictEqual(await a.sendPool(P, "💰 Collected $9 from the same pool", { source: "collect" }), false, "held: the guardian spoke about this pool 5 min ago");
  assert.strictEqual(a.state.held[P], 1);
  assert.strictEqual(await a.sendPool(Q, "💰 Collected $9 from another pool", { source: "collect" }), true, "another pool is not affected");
  assert.strictEqual(await a.sendPool(P, "🚨 DUMP ALERT same pool", { source: "guardian", urgent: true }), true, "urgent bypasses the window");
  clock += 31 * 60 * 1000;
  assert.strictEqual(await a.sendPool(P, "💰 Collected $12 from the same pool", { source: "collect" }), true, "window over");
  assert.strictEqual(a.state.held[P], undefined, "held count clears once a message goes through");
  assert.strictEqual(sent.length - before, 4);
  // The range check shares it: a collect summary just went out for the pool, so the
  // out-of-range alert is held and sent on a later tick once the window has passed.
  const poolPos = (inRange) => ({ ...pos(inRange, inRange ? 0.5 : 1.3), tokenId: "77", nftId: "77", pool: { key: "v4:0xshared" } });
  assert.strictEqual(await a.sendPool("v4:0xshared", "💰 Collected $30 from WETH / USDG", { source: "collect" }), true);
  clock += 2 * 60 * 1000;
  out = await a.check({ payload: { positions: [poolPos(false)] }, ops: run("2026-09-07T09:00:05", "collected 1 position"), unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.filter((m) => /#77 is out of range/.test(m)).length, 0, "held by the collect summary's cool-down");
  clock += 40 * 60 * 1000;
  out = await a.check({ payload: { positions: [poolPos(false)] }, ops: run("2026-09-07T09:00:05", "collected 1 position"), unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.filter((m) => /#77 is out of range/.test(m)).length, 1, "sent once the window passed");
  clock += 10 * 60 * 1000;
  out = await a.check({ payload: { positions: [poolPos(false)] }, ops: run("2026-09-07T09:00:05", "collected 1 position"), unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.filter((m) => /#77 is out of range/.test(m)).length, 0, "not repeated");
  // Back in range closes the episode: it goes out even inside the window.
  clock += 5 * 60 * 1000;
  out = await a.check({ payload: { positions: [poolPos(true)] }, ops: run("2026-09-07T09:00:05", "collected 1 position"), unlock: { armed: true }, keepalive: true });
  assert.strictEqual(out.filter((m) => /#77 is back in range/.test(m)).length, 1);
  assert.strictEqual(require("../alerts").poolKeyOf({ pool: { key: "v3:0xabc" } }), "v3:0xabc");
  assert.strictEqual(require("../alerts").poolKeyOf({ tokenId: "v4-123" }), "pos:123");
  assert.strictEqual(require("../alerts").poolKeyOf({ tokenId: "123", walletAddress: "0xABC" }), "pos:0xabc:123");
  assert.strictEqual(require("../alerts").poolKeyOf({ tokenId: "123" }, "0xdef:"), "pos:0xdef:123");
  assert.strictEqual(require("../alerts").poolKeyOf({ tokenId: "v4-9", version: 4, poolAddress: "0xABCD" }), "v4:0xabcd");
  assert.strictEqual(require("../alerts").poolKeyOf({ poolKey: "v4:0xdef", nftId: "1" }), "v4:0xdef");

  // 9b. A non-numeric pool cool-down falls back to 30 min instead of NaN (which would disable it).
  const bad = create({ transport: async () => true, stateFile: stateFile + ".p", now: () => clock, log: { error() {} }, poolCooldownMs: "soon" });
  assert.strictEqual(bad.poolWindow, 30 * 60 * 1000);
  assert.strictEqual(create({ transport: async () => true, stateFile: stateFile + ".p", now: () => clock, log: { error() {} }, poolCooldownMs: 0 }).poolWindow, 30 * 60 * 1000);
  try { fs.unlinkSync(stateFile + ".p"); } catch {}

  // 9c. A state file from before `pool`/`held` existed (or with them nulled) still loads: the tables are recreated.
  fs.writeFileSync(stateFile + ".old", JSON.stringify({ sent: { x: 1 }, outSince: null, lastTick: 5 }));
  const old = create({ transport: async () => true, stateFile: stateFile + ".old", now: () => clock, log: { error() {} } });
  assert.strictEqual(await old.sendPool("v3:0xold", "first", { source: "t" }), true);
  assert.strictEqual(await old.sendPool("v3:0xold", "second", { source: "t" }), false, "held by the cool-down, no TypeError");
  out = await old.check({ payload: { positions: [pos(false, 1.2)] }, unlock: { armed: true }, keepalive: true });
  assert.ok(Array.isArray(out));
  try { fs.unlinkSync(stateFile + ".old"); } catch {}

  // 9d. A state file that cannot be written (here: its directory is a file) is logged, not swallowed, and check() still runs.
  const saveErrs = [];
  const unwritable = create({ transport: async () => true, stateFile: path.join(stateFile + ".old", "state.json"), now: () => clock, log: { error: (m) => saveErrs.push(m) } });
  fs.writeFileSync(stateFile + ".old", "not a directory");
  assert.strictEqual(await unwritable.sendPool("v3:0xsave", "hello", { source: "t" }), true);
  assert.ok(saveErrs.some((m) => /could not save/.test(m)), "save failure is logged");
  try { fs.unlinkSync(stateFile + ".old"); } catch {}

  // 10. A rejected fetch (DNS, timeout) is a failed delivery, not an exception: check() still finishes.
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error("getaddrinfo ENOTFOUND api.telegram.org"); };
  const errs = [];
  const n = create({ token: "t", chatId: "1", stateFile: stateFile + ".n", now: () => clock, log: { error: (m) => errs.push(m) } });
  assert.strictEqual(await n.send("hello"), false);
  clock += 24 * 3600 * 1000;
  out = await n.check({ payload: { positions: [pos(false, 1.2)] }, unlock: { armed: true }, keepalive: true });
  assert.deepStrictEqual(out, [], "nothing delivered, nothing thrown");
  assert.ok(errs.some((m) => /deliver error/.test(m)));
  global.fetch = realFetch;

  for (const f of [stateFile, stateFile + ".b", stateFile + ".c", stateFile + ".n"]) { try { fs.unlinkSync(f); } catch {} }
  console.log(`alerts: ${sent.length} messages produced across 10 scenarios, all assertions passed`);
  for (const m of sent) console.log("  -", m.slice(0, 90));
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
