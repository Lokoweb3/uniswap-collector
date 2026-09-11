// node test/memecoin-collect.test.js — trigger logic and collector-output parsing with mocks.
const assert = require("assert");
const { memecoinPositions, pickTrigger, shouldRun, parseCollectorOutput, collectMessages, collectNotices, poolKeyFor } = require("../memecoin-collect");

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
