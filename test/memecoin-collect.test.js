// node test/memecoin-collect.test.js — trigger logic and collector-output parsing with mocks.
const assert = require("assert");
const { cycleCounts, payloadIsStale, STALE_PAYLOAD_MS, memecoinPositions, pickTrigger, shouldRun, parseCollectorOutput, collectMessages, collectNotices, poolKeyFor } = require("../memecoin-collect");

// A skipped cycle (collector child still running) must not refresh the heartbeat; a real one does.
assert.strictEqual(cycleCounts({ skipped: true }), false, "skipped cycle leaves lastAt unchanged");
assert.strictEqual(cycleCounts({ skipped: false, at: 1 }), true, "real cycle stamps lastAt");
assert.strictEqual(cycleCounts(undefined), true, "legacy undefined result still stamps");

const positions = { ok: true, owner: "0x0000000000000000000000000000000000000001", ownerLabel: "Main", positions: [
  { tokenId: "1030190", nftId: "1030190", version: 3, pair: "WETH / USDG", feesUsd: 31 },
]};
const watch = { ok: true, wallets: [
  { ok: true, label: "Trading", address: "0x0000000000000000000000000000000000000012", positions: [
    { tokenId: "v4-2134854", nftId: "2134854", version: 4, pair: "ETH / LAPTOP", feesUsd: 25.5 },
    { tokenId: "v4-2151132", nftId: "2151132", version: 4, pair: "ETH / PINK", feesUsd: 4 },
  ]},
  { ok: true, label: "LP Rewards", address: "0x0000000000000000000000000000000000000013", positions: [
    { tokenId: "972362", nftId: "972362", version: 3, pair: "WETH / Index", feesUsd: 60 },
  ]},
]};

// 1. Without config.memecoins: v4 positions in the main wallet and the collected watched wallets count (Trading by name when the payload has no collector field).
let list = memecoinPositions({ positions, watch, memecoins: null });
assert.deepStrictEqual(list.map((p) => p.tokenId), ["2134854", "2151132"]);
assert.strictEqual(list[0].wallet, "Trading");

// 2. With config.memecoins: those ids (whichever wallet) plus the Trading wallet's v4 positions.
list = memecoinPositions({ positions, watch, memecoins: [{ tokenId: "2134854" }, { tokenId: "972362" }] });
assert.deepStrictEqual(list.map((p) => p.tokenId).sort(), ["2134854", "2151132", "972362"]);

// 3. Trigger = richest above threshold; none below.
list = memecoinPositions({ positions, watch, memecoins: null });
assert.strictEqual(pickTrigger(list, 20).tokenId, "2134854");
assert.strictEqual(pickTrigger(list, 30), null);

// 4. Interval gate.
const now = Date.now();
const trig = pickTrigger(list, 20);
assert.strictEqual(shouldRun({ trigger: trig, lastRunAt: null, minIntervalMinutes: 30, now }).run, true);
assert.strictEqual(shouldRun({ trigger: trig, lastRunAt: now - 10 * 60000, minIntervalMinutes: 30, now }).run, false);
assert.strictEqual(shouldRun({ trigger: trig, lastRunAt: now - 31 * 60000, minIntervalMinutes: 30, now }).run, true);
assert.strictEqual(shouldRun({ trigger: null, lastRunAt: null, minIntervalMinutes: 30, now }).run, false);

// 5. Parser over a realistic two-owner run (format of collector.js log lines).
const out = `
[2026-09-07T17:52:40.000Z] === mode=full chainId=4663 ===
[2026-09-07T17:52:41.000Z] Owners in this run: Main, Trading
[2026-09-07T17:52:41.100Z] --- Main (0x0000000000000000000000000000000000000001) ---
[2026-09-07T17:52:45.000Z] #1030190 WETH/USDG 0.01%  0.001992 WETH + 4.970916 USDG  ≈ 0.004 WETH
[2026-09-07T17:52:50.000Z] collect #1030190 -> 0x943cfa8815f0e1d9085e710298c1ca6d60a6a4ed8f88db52d0cf97e09788322a
[2026-09-07T17:52:56.000Z]   confirmed in block 56974743, gas 0.000059 ETH
[2026-09-07T17:53:04.000Z] swap 0.001992 WETH -> USDG (quote 4.92, min 4.85) -> 0xbcfb1f004c90fedab4804e8cd32dc7918f3a4da2ab4e3d4ed018a3958456660d
[2026-09-07T17:53:10.000Z] treasury split 0.99 USDG (10%) -> LOKOVault TBA 0x0000000000000000000000000000000000000021 -> 0x1111111111111111111111111111111111111111111111111111111111111111
[2026-09-07T17:53:12.000Z] send 8.91 USDG -> 0x0000000000000000000000000000000000000001 -> 0x2222222222222222222222222222222222222222222222222222222222222222
[2026-09-07T17:53:15.000Z] === Main: done ===
[2026-09-07T17:53:15.100Z] --- Trading (0x0000000000000000000000000000000000000012) ---
[2026-09-07T17:53:20.000Z] v4 #2134854 ETH/LAPTOP 5%  0.01 ETH + 12000 LAPTOP  ≈ 0.02 WETH
[2026-09-07T17:53:22.000Z] collect v4 #2134854 -> 0x3333333333333333333333333333333333333333333333333333333333333333
[2026-09-07T17:53:30.000Z]   ! swap failed for LAPTOP: execution reverted
[2026-09-07T17:53:35.000Z] treasury split 2.50 USDG (10%) -> LOKOVault TBA 0x0000000000000000000000000000000000000021 -> 0x4444444444444444444444444444444444444444444444444444444444444444
[2026-09-07T17:53:40.000Z] send 22.50 USDG -> 0x0000000000000000000000000000000000000012 -> 0x5555555555555555555555555555555555555555555555555555555555555555
[2026-09-07T17:53:41.000Z] === Trading: done ===
[2026-09-07T17:53:41.000Z] === done ===`;
const parsed = parseCollectorOutput(out);
assert.strictEqual(parsed.locked, false);
assert.strictEqual(parsed.owners.length, 2);
assert.deepStrictEqual(parsed.collected.map((c) => [c.tokenId, c.version, c.wallet, c.pair]), [["1030190", 3, "Main", "WETH/USDG"], ["2134854", 4, "Trading", "ETH/LAPTOP"]]);
assert.strictEqual(parsed.splits.length, 2);
assert.strictEqual(parsed.owners[0].splitUsdg, 0.99);
assert.strictEqual(parsed.owners[0].ownerUsdg, 8.91);
assert.strictEqual(parsed.owners[1].ownerUsdg, 22.5);
assert.strictEqual(parsed.failures.length, 1);
assert.match(parsed.failures[0].line, /swap failed/);
const msgs = collectMessages(parsed, trig);
assert.strictEqual(msgs.length, 2);
assert.match(msgs[0], /Collected \$9\.90 from WETH\/USDG .*10% → vault, \$0\.99.*Main/);
assert.match(msgs[1], /Collected \$25\.00 from ETH\/LAPTOP .*Trading/);
// Each notice names its position so the shared per-pool cool-down can key on the pool.
const notices = collectNotices(parsed, trig);
assert.strictEqual(notices.length, 2); assert.strictEqual(notices[0].text, msgs[0]); assert.strictEqual(typeof notices[1].tokenId, "string");
assert.strictEqual(poolKeyFor([{ tokenId: "2134854", poolKey: "v4:0xpool" }], "v4-2134854"), "v4:0xpool");
assert.strictEqual(poolKeyFor([{ tokenId: "2134854", poolKey: null }], "2134854"), "pos:2134854");

// 6. Locked run.
const locked = parseCollectorOutput("2026-09-07T09:00:01-04:00 locked, skipping full run. Run ./unlock.sh to arm it.");
assert.strictEqual(locked.locked, true);
assert.strictEqual(locked.collected.length, 0);

console.log("memecoin-collect: trigger logic and collector-output parsing assertions passed");

// ---- stale payload (TASK-61): a 31-minute-old build is not a basis for a collect ----
{
  const now = 1_800_000_000_000;
  assert.equal(payloadIsStale({ ok: true, at: now - 31 * 60000 }, now), true, "31 min old payload is stale");
  assert.equal(payloadIsStale({ ok: true, at: now - 29 * 60000 }, now), false, "29 min old payload is fresh");
  assert.equal(payloadIsStale({ ok: true }, now), false, "a payload without a build time is not judged");
  assert.equal(STALE_PAYLOAD_MS, 30 * 60000);
  assert.equal(cycleCounts({ skipped: "stale" }), false, "a stale skip does not stamp the heartbeat");
}
console.log("memecoin-collect: stale payload skip assertions passed");

// ---- TASK-86: the collector timeout kills the whole process group and frees the lock. ----
// An owned wrapper shaped like run-collector.sh (TERM trap, flock on fd 9 inherited by a
// foreground node child) is started from a temp dir with a 1 s timeout; afterwards no
// child is alive, the lock is free, and the promise settled with timedOut.
(async () => {
  const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-collect86-"));
  fs.writeFileSync(path.join(dir, "child.cjs"), `require("fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`);
  fs.writeFileSync(path.join(dir, "run-collector.sh"), `#!/usr/bin/env bash
trap 'echo term-deferred' TERM
exec 9>"${dir}/.collector.lock"
flock -n 9 || exit 1
node "${dir}/child.cjs" "${dir}/child.pid"
`);
  fs.chmodSync(path.join(dir, "run-collector.sh"), 0o755);
  process.env.LP_COLLECTOR_TIMEOUT_MS = "1000";
  delete require.cache[require.resolve("../memecoin-collect")];
  const mc = require("../memecoin-collect").create({ dir, codeDir: dir, log: () => {} });
  const started = Date.now();
  const r = await mc._runCollector();
  assert.equal(r.timedOut, true, "the run timed out");
  assert.ok(Date.now() - started < 60000, "settled without waiting for the 30 s SIGKILL fallback of a hung close");
  await new Promise((res) => setTimeout(res, 300));
  const childPid = Number(fs.readFileSync(path.join(dir, "child.pid"), "utf8"));
  let alive = true; try { process.kill(childPid, 0); } catch { alive = false; }
  assert.equal(alive, false, "the node grandchild is dead after the group signal");
  const lock = cp.spawnSync("flock", ["-n", path.join(dir, ".collector.lock"), "true"]);
  assert.equal(lock.status, 0, "the collector lock is free for the next run");
  delete process.env.LP_COLLECTOR_TIMEOUT_MS;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("memecoin-collect: timeout kills the collector's process group and frees the lock");
})().catch((e) => { console.error(e); process.exitCode = 1; });
