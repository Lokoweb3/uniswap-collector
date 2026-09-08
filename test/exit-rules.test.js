// node test/exit-rules.test.js — exit rules with mock positions, history and close module.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { create, pairsMatch } = require("../exit-rules");

const tmp = (n) => path.join(os.tmpdir(), `exit-rules-test-${process.pid}-${n}.json`);
const H = 3600 * 1000;

function harness({ closeModule, overrides = {}, rules, signer = {} } = {}) {
  const sent = [];
  const alerts = { send: async (t) => { sent.push(t); return true; } };
  const cfg = {
    exitRules: rules || [
      { type: "priceDropPct1h", threshold: 30, pairs: ["LAPTOP/ETH", "PINK/ETH"], action: "alert" },
      { type: "priceDropPct1h", threshold: 50, pairs: ["LAPTOP/ETH", "PINK/ETH"], action: "close" },
      { type: "outOfRange", durationMinutes: 120, pairs: ["LAPTOP/ETH", "PINK/ETH"], action: "close" },
      { type: "tvlDrop", threshold: 50, pairs: ["*"], action: "alert" },
    ],
    exitRuleOverrides: overrides,
  };
  let clock = new Date("2026-09-08T10:00:00Z").getTime();
  let main = { owner: "0xMAIN", ownerLabel: "Main", positions: [] };
  let watched = [];
  const stateFile = tmp("state-" + Math.random()), logFile = tmp("log-" + Math.random());
  const er = create({
    provider: {}, cfg, alerts, log: { log() {}, error() {} },
    getPositions: () => main, getWatched: () => watched,
    now: () => clock, closeModule, signerFactory: async () => signer, stateFile, logFile,
  });
  return {
    er, sent, cfg, logFile,
    tick: (ms) => { clock += ms; },
    setMain: (p) => { main = { ...main, positions: p }; },
    setWatched: (w) => { watched = w; },
    cleanup: () => { for (const f of [stateFile, logFile]) { try { fs.unlinkSync(f); } catch {} } },
  };
}

// ETH / LAPTOP: token0 = ETH (quote), price = LAPTOP per ETH, so a rising number is the coin falling.
const laptop = (priceLaptopPerEth, inRange = true, tvl = 20000) => ({
  tokenId: "2134854", nftId: "2134854", version: 4, pair: "ETH / LAPTOP", symbol0: "ETH", symbol1: "LAPTOP",
  inRange, priceCurrent: priceLaptopPerEth, valueUsd: 1700, pool: { tvl },
});
const pink = (priceEthPerPink, inRange = true) => ({
  tokenId: "2151132", nftId: "2151132", version: 4, pair: "PINK / ETH", symbol0: "PINK", symbol1: "ETH",
  inRange, priceCurrent: priceEthPerPink, valueUsd: 190, pool: { tvl: 70000 },
});
const trading = (positions) => [{ ok: true, label: "Trading", address: "0xTRADING", positions }];

(async () => {
  // pair matching
  assert.ok(pairsMatch(["LAPTOP/ETH"], "ETH / LAPTOP"));
  assert.ok(pairsMatch(["laptop / eth"], "LAPTOP/ETH"));
  assert.ok(pairsMatch(["*"], "WETH / USDG"));
  assert.ok(!pairsMatch(["LAPTOP/ETH"], "PINK / ETH"));

  // 1. price drop alert fires once per episode; close rule not executed while override disabled
  {
    const h = harness({ closeModule: { closeV4: async () => { throw new Error("must not be called"); } } });
    h.setWatched(trading([laptop(1000000)]));
    await h.er.evaluate();                          // baseline sample
    h.tick(H); h.setWatched(trading([laptop(1500000)])); // LAPTOP per ETH up 50% => coin fell 33%
    let out = await h.er.evaluate();
    assert.strictEqual(out.length, 1, "one alert expected"); assert.match(out[0], /ETH \/ LAPTOP dropped 33% in 1h — exit rule \(alert\)/);
    h.tick(5 * 60 * 1000); h.setWatched(trading([laptop(1500000)]));
    out = await h.er.evaluate();
    assert.strictEqual(out.length, 0, "no repeat within the episode");
    // 55% drop: alert already fired; close rule (50%) fires but override disabled => not executed
    h.tick(H); h.setWatched(trading([laptop(1000000)])); await h.er.evaluate(); // recovered: alert episode clears, new baseline sampled
    h.tick(H); h.setWatched(trading([laptop(2300000)])); // coin fell 56.5% vs 1h ago
    out = await h.er.evaluate();
    assert.ok(out.some((m) => /exit rule \(close, not executed: auto-close is off/.test(m)), "close degraded to alert when disabled: " + out.join(" | "));
    h.cleanup();
  }

  // 2. override enabled + close module present + armed => closes once, logs, second trigger does not close again
  {
    let calls = 0;
    const closeModule = { closeV4: async ({ tokenId, owner }) => { calls++; assert.strictEqual(tokenId, "2134854"); assert.strictEqual(owner, "0xTRADING"); return { hash: "0xabc123def456", recovered: "0.41 ETH + 1.2M LAPTOP" }; } };
    const h = harness({ closeModule, overrides: { "2134854": { enabled: true } } });
    h.setWatched(trading([laptop(1000000)]));
    await h.er.evaluate();
    h.tick(H); h.setWatched(trading([laptop(2500000)])); // -60%
    let out = await h.er.evaluate();
    assert.strictEqual(calls, 0, "first sighting of the trigger must not close (needs confirmation)");
    assert.ok(!out.some((m) => /Auto-closed/.test(m)), "no close message on the unconfirmed first sighting (the alert rule may still fire)");
    h.tick(5 * 60 * 1000); h.setWatched(trading([laptop(2450000)])); // still down, price agrees within 10%
    out = await h.er.evaluate();
    assert.strictEqual(calls, 1, "close executed once, on the confirmed second sighting");
    assert.ok(out.some((m) => /Auto-closed ETH \/ LAPTOP — dropped 5[0-9]% in 1h/.test(m)), out.join(" | "));
    const log = JSON.parse(fs.readFileSync(h.logFile, "utf8"));
    assert.strictEqual(log.length, 1); assert.strictEqual(log[0].txHash, "0xabc123def456"); assert.strictEqual(log[0].rule, "priceDropPct1h");
    // out-of-range close rule later must not close again
    h.tick(3 * H); h.setWatched(trading([laptop(2500000, false)]));
    await h.er.evaluate();
    h.tick(3 * H); h.setWatched(trading([laptop(2500000, false)]));
    const out2 = await h.er.evaluate();
    assert.strictEqual(calls, 1, "no second close");
    assert.ok(out2.some((m) => /already closed by a rule/.test(m)), out2.join(" | "));
    h.cleanup();
  }

  // 2b. a close that throws is not marked closed: it retries after the cool-down and succeeds
  {
    let calls = 0;
    const closeModule = { closeV4: async () => { calls++; if (calls === 1) throw new Error("nonce too low"); return { hash: "0xretry" }; } };
    const h = harness({ closeModule, overrides: { "2134854": { enabled: true } } });
    const M = 5 * 60 * 1000;
    const step = async (price) => { h.setWatched(trading([laptop(price)])); const o = await h.er.evaluate(); h.tick(M); return o; };
    for (let i = 0; i < 12; i++) await step(1000000);       // an hour of samples at the entry price
    let out = await step(2500000);                           // crash: first sighting (alert only)
    assert.strictEqual(calls, 0);
    out = await step(2500000);                               // confirmed -> attempt 1 throws
    assert.strictEqual(calls, 1); assert.ok(out.some((m) => /auto-close FAILED.*Will retry/.test(m)), out.join(" | "));
    await step(2500000); await step(2500000);                // inside the 15-min cool-down: no retry
    assert.strictEqual(calls, 1, "no retry inside the cool-down");
    let closedMsg = false;
    for (let i = 0; i < 4 && calls < 2; i++) { out = await step(2500000); if (out.some((m) => /Auto-closed/.test(m))) closedMsg = true; }
    assert.strictEqual(calls, 2, "retried after the cool-down"); assert.ok(closedMsg, "close reported");
    h.cleanup();
  }

  // 3. out of range for 120 min: watched position uses its own clock; close degrades to alert without a module
  {
    const h = harness({ closeModule: null, overrides: { "2151132": { enabled: true } } });
    h.setWatched(trading([pink(0.0000008, false)]));
    await h.er.evaluate();
    h.tick(60 * 60 * 1000); await h.er.evaluate();      // 60 min: nothing
    h.tick(61 * 60 * 1000);
    const out = await h.er.evaluate();                    // 121 min
    assert.strictEqual(out.length, 1); assert.match(out[0], /out of range for 121 min — exit rule \(close, not executed: close module unavailable\)/);
    // back in range clears the episode
    h.tick(5 * 60 * 1000); h.setWatched(trading([pink(0.0000008, true)]));
    assert.strictEqual((await h.er.evaluate()).length, 0);
    h.cleanup();
  }

  // 4. locked collector: close wanted, module present, enabled, but no signer => alert says locked
  {
    const h = harness({ closeModule: { closeV4: async () => ({ hash: "0x1" }) }, overrides: { "2134854": { enabled: true } }, signer: null });
    h.setWatched(trading([laptop(1000000)]));
    await h.er.evaluate();
    h.tick(H); h.setWatched(trading([laptop(2500000)]));
    const out = await h.er.evaluate();
    assert.ok(out.some((m) => /collector is locked/.test(m)), out.join(" | "));
    h.cleanup();
  }

  // 5. TVL drop applies to every pair ("*"), including the main wallet, and main-wallet out-of-range uses the range log
  {
    const h = harness({ closeModule: null });
    h.setMain([{ tokenId: "1030190", nftId: "1030190", version: 3, pair: "WETH / USDG", symbol0: "WETH", symbol1: "USDG", inRange: true, priceCurrent: 2500, pool: { tvl: 30000000 }, range: null }]);
    await h.er.evaluate();
    h.tick(2 * H);
    h.setMain([{ tokenId: "1030190", nftId: "1030190", version: 3, pair: "WETH / USDG", symbol0: "WETH", symbol1: "USDG", inRange: true, priceCurrent: 2500, pool: { tvl: 12000000 }, range: null }]);
    const out = await h.er.evaluate();
    assert.strictEqual(out.length, 1); assert.match(out[0], /WETH \/ USDG pool liquidity down 60% from its 24h high/);
    h.cleanup();
  }

  // 6. per-position threshold override (alert at 20% instead of 30%)
  {
    const h = harness({ closeModule: null, overrides: { "2151132": { priceDropPct1h: 20 } } });
    h.setWatched(trading([pink(0.0000010)]));
    await h.er.evaluate();
    h.tick(H); h.setWatched(trading([pink(0.00000075)])); // ETH per PINK down 25% => coin fell 25%
    const out = await h.er.evaluate();
    assert.strictEqual(out.length, 1); assert.match(out[0], /PINK \/ ETH dropped 25% in 1h/);
    h.cleanup();
  }

  // 7. setOverride writes config.json and view() reflects it
  {
    const cfgPath = tmp("cfg-" + Math.random());
    fs.writeFileSync(cfgPath, JSON.stringify({ exitRules: [], exitRuleOverrides: {} }));
    const h = harness({ closeModule: null });
    const next = h.er.setOverride(cfgPath, "2134854", { enabled: true, outOfRangeMinutes: "90", tvlDropPct: null });
    assert.deepStrictEqual(next, { enabled: true, outOfRangeMinutes: 90 });
    assert.strictEqual(JSON.parse(fs.readFileSync(cfgPath, "utf8")).exitRuleOverrides["2134854"].outOfRangeMinutes, 90);
    fs.unlinkSync(cfgPath); h.cleanup();
  }

  console.log("exit-rules: 7 scenarios passed (pair matching, alert once per episode, close once with log, disabled/missing-module/locked degrade to alerts, TVL drop, threshold override, config write)");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
