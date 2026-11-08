// node test/collector-base-sweep-gating.test.js -- acceptance 1, 2, 3 and 6: the sweep ships off, refuses to start on a wrong target or a
// missing/corrupt ledger, and nothing in settings can add a router, pool, route, token or recipient. Mocked chain, no network.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const X = require("./lib/sweep-scene");
const settings = require("../settings");
const { hermeticEnv, hermeticCwd } = require("./lib/hermetic");

const { sweepScene, defaultPositions, decodeSent, OWNER, OP, USDC, LAPTOP, WETH, SL, lc } = X;
const mk = (o = {}, init = true) => { const S = sweepScene({ positions: defaultPositions(), ...o }); if (init) S.init(); return S; };

(async () => {
  // ---- 1. the example ships off, and every non-true value behaves exactly like today
  {
    assert.strictEqual(X.exampleRaw.baseSweep.enabled, false);
    assert.strictEqual(X.exampleRaw.baseSweep.vault.tba, null);
    assert.strictEqual(X.exampleRaw.baseSweep.vault.splitPct, 0);
    assert.strictEqual(settings.toLegacy(X.exampleRaw).baseSweep.enabled, false, "baseSweep is carried by settings.js");
    assert.ok(!("_comment" in settings.toLegacy(X.exampleRaw).baseSweep));
    // sweep.enabled is only the boolean true
    for (const v of [undefined, "true", 1, false, null, "yes", [true]]) assert.strictEqual(SL.config({ enabled: v }).enabled, false, String(v));
    assert.strictEqual(SL.config({ enabled: true }).enabled, true);

    let baseline = null;
    for (const [name, sweep] of [["absent", null], ['"true"', { enabled: "true" }], ["1", { enabled: 1 }], ["false", { enabled: false }]]) {
      const S = mk({}, false); // no sweep-state.json on disk
      const r = await S.run({ sweep });
      assert.strictEqual(S.reads, 0, `${name}: the sweep ledger is never read`); assert.strictEqual(S.saves, 0, `${name}: nor written`); assert.strictEqual(S.exists, 1, "only its existence is asked");
      assert.strictEqual(r.signer.sent.length, 2, `${name}: today's two collects`);
      for (const t of decodeSent(r.signer)) { assert.strictEqual(t.name, "collect"); assert.strictEqual(t.args[0].recipient, OWNER, `${name}: the recipient is the owner`); }
      assert.strictEqual(r.lines.filter((l) => /^sweep: disabled/.test(l)).length, 1, `${name}: exactly one disabled line`);
      assert.ok(r.lines.includes("sweep: disabled (baseSweep.enabled is not true)"));
      assert.ok(!fs.existsSync(S.file));
      assert.deepStrictEqual(r.state.gasSpends.map((e) => Object.keys(e).includes("op")), [false, false], "no op field on plain collects");
      assert.ok(!r.res.sweep && !r.lines.some((l) => /base sweep/.test(l)));
      if (baseline === null) baseline = r.text; else assert.strictEqual(r.text, baseline, `${name}: the log is identical to the key-absent run`);
    }
    // with no ledger IO at all (the wiring existing callers have): the same text again
    const S0 = mk({}, false); const r0 = await S0.run({ sweep: null, noIo: true });
    assert.strictEqual(r0.text, baseline);
    // a leftover ledger file with the flag off is only looked at by the recovery code, never written when it has no open leg
    const S1 = mk(); const before = fs.readFileSync(S1.file, "utf8");
    const r1 = await S1.run({ sweep: { enabled: false } });
    assert.strictEqual(S1.saves, 0); assert.strictEqual(fs.readFileSync(S1.file, "utf8"), before, "an empty ledger is left untouched"); assert.strictEqual(r1.signer.sent.length, 2);
    assert.ok(r1.lines.includes("sweep: disabled (baseSweep.enabled is not true)"));
  }

  // ---- 2. a wrong target or wrong USDC decimals refuses to start; tokens.USDG is never consulted
  {
    for (const [name, sweep, scene] of [
      ["other target", { targetToken: "0x00000000000000000000000000000000000000ee" }, {}],
      ["a non-address target", { targetToken: "usdc" }, {}],
      ["USDC decimals 18", {}, { usdcDecimals: 18 }],
    ]) {
      const S = mk(scene);
      const r = await S.run({ sweep });
      assert.strictEqual(r.signer.sent.length, 0, `${name}: nothing sent`); assert.strictEqual(r.signerCalls(), 0, `${name}: no signer`);
      assert.strictEqual(r.res.aborted, true, name); assert.strictEqual(S.w.estimates.length, 0, `${name}: nothing was estimated`);
      assert.ok(/SWEEP REFUSED: /.test(r.text) && /refuses to start/.test(r.text), r.text);
      assert.strictEqual(S.saves, 0, `${name}: nothing written`);
      assert.strictEqual(require("../collector-base").exitCodeOf(r.res), 1);
    }
    const ok = mk();
    const good = await ok.run({});
    const alias = mk();
    const viaAlias = await alias.run({ raw: (raw) => { raw.tokens.USDG = "0x00000000000000000000000000000000000000ee"; } });
    assert.strictEqual(viaAlias.text, good.text, "tokens.USDG changes nothing");
    assert.ok(good.lines.some((l) => /tokens\.USDG alias is not consulted/.test(l)));
    assert.strictEqual(viaAlias.signer.sent.length, good.signer.sent.length);
    // the explicit key spelled correctly (any case) is accepted
    const lower = mk(); const rl = await lower.run({ sweep: { targetToken: USDC.toLowerCase() } });
    assert.strictEqual(rl.res.aborted, false, rl.text);
  }

  // ---- 3. the ledger: missing / corrupt -> nothing; --init-state creates it once and never overwrites
  {
    const S = sweepScene({ positions: defaultPositions() }); // no init
    const r = await S.run({});
    assert.strictEqual(r.signer.sent.length, 0); assert.strictEqual(r.res.aborted, true); assert.strictEqual(r.signerCalls(), 0);
    assert.ok(r.text.includes(`sweep-state.json is missing`) && r.text.includes(`LP_DATA_DIR=${S.dir} node collector-base.js --init-state`), r.text);
    assert.ok(!fs.existsSync(S.file), "the run did not create it"); assert.strictEqual(S.w.estimates.length, 0);
    const sim = await S.run({ mode: "simulate" });
    assert.ok(/SWEEP REFUSED/.test(sim.text) && !fs.existsSync(S.file) && sim.signer.sent.length === 0);

    for (const text of ['{"version":1,"jobs":[', "[]", '{"version":2,"jobs":[]}', '{"version":1,"jobs":"x"}', '{"version":1,"jobs":[{"id":"a"}]}', ""]) {
      const C = sweepScene({ positions: defaultPositions() });
      fs.writeFileSync(C.file, text);
      const rc = await C.run({});
      assert.strictEqual(rc.signer.sent.length, 0, text); assert.strictEqual(rc.res.aborted, true); assert.strictEqual(C.w.estimates.length, 0, "no collect was even estimated");
      assert.ok(/sweep-state\.json is unreadable/.test(rc.text) && rc.text.includes("refusing everything"), rc.text);
      assert.strictEqual(fs.readFileSync(C.file, "utf8"), text, "the corrupt file is untouched");
    }
    const dirAsFile = sweepScene({ positions: defaultPositions() }); fs.mkdirSync(dirAsFile.file);
    assert.strictEqual((await dirAsFile.run({})).signer.sent.length, 0);

    // the CLI: both files, once, never overwritten
    const dir = fs.mkdtempSync(path.join(X.TMP, "init-"));
    const cli = () => spawnSync(process.execPath, [path.join(__dirname, "..", "collector-base.js"), "--init-state"], { cwd: hermeticCwd(), env: hermeticEnv({ LP_DATA_DIR: dir }), encoding: "utf8", timeout: 30000 });
    const a = cli(); assert.strictEqual(a.status, 0, a.stdout + a.stderr);
    const f = path.join(dir, "sweep-state.json");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, "utf8")), { version: 1, jobs: [] }); assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
    assert.ok(/created .*sweep-state\.json/.test(a.stdout) && fs.existsSync(path.join(dir, "state.json")));
    fs.writeFileSync(f, '{"version":1,"jobs":[]}\n');
    const before = fs.readFileSync(f); await new Promise((res) => setTimeout(res, 30));
    const b = cli(); assert.ok(/sweep-state\.json already exists/.test(b.stdout), b.stdout); assert.ok(before.equals(fs.readFileSync(f)));
    fs.writeFileSync(f, "junk"); cli(); assert.strictEqual(fs.readFileSync(f, "utf8"), "junk", "even a corrupt file is never overwritten");
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => /tmp/.test(n)), []);
  }

  // ---- 6. nothing in settings adds a router, quoter, pool, route, token or recipient; a route can only be disabled
  {
    const evil = "0x00000000000000000000000000000000000000ee";
    const cfg = SL.config({ enabled: true, router: evil, quoter: evil, factory: evil, recipient: evil, owner: evil, tokens: [evil],
      routes: { WETH: { enabled: true, pool: evil, fee: 100, router: evil, token: evil }, SHIB: { enabled: true, pool: evil, token: evil, fee: 3000 }, LAPTOP: { enabled: false } } });
    assert.strictEqual(cfg.routes.WETH, true); assert.strictEqual(cfg.routes.LAPTOP, false); assert.ok(!("SHIB" in cfg.routes));
    assert.ok(!JSON.stringify(cfg).toLowerCase().includes(evil), "the evil address is nowhere in the effective config");
    assert.strictEqual(SL.routeFor(cfg, evil), null); assert.strictEqual(SL.routeFor(cfg, LAPTOP), null, "LAPTOP disabled");
    assert.strictEqual(SL.routeFor(cfg, WETH).pool, SL.ROUTES.WETH.pool, "the pool is the code constant");
    assert.throws(() => { SL.ROUTES.WETH.pool = evil; }, TypeError, "the table is frozen");
    assert.strictEqual(Object.isFrozen(SL.ROUTES), true);

    // a full run with the evil keys: the constants are used, the evil address never appears in any tx or read
    const S = mk();
    const r = await S.run({ sweep: { router: evil, quoter: evil, recipient: evil, routes: { WETH: { enabled: true, pool: evil, token: evil, fee: 1 }, cbBTC: { pool: evil } }, vault: { tba: null } } });
    assert.strictEqual(r.res.aborted, false, r.text);
    const sent = decodeSent(r.signer);
    assert.ok(sent.some((t) => t.name === "exactInputSingle" && lc(t.to) === lc(SL.ROUTER)));
    assert.ok(sent.every((t) => !t.data.toLowerCase().includes(evil.slice(2)) && lc(t.to) !== evil));
    assert.ok(S.w.calls.every((c) => c.to !== evil) && !r.text.toLowerCase().includes(evil));

    // routes.LAPTOP.enabled=false: LAPTOP goes unswapped to the owner
    const L2 = sweepScene({ positions: [{ id: X.ID_A, mgr: X.MGR_A, t0: LAPTOP, t1: USDC, a0: 1000n * X.E18, a1: 0n }] }); L2.init();
    const off = await L2.run({ sweep: { routes: { LAPTOP: { enabled: false } } } });
    const t = decodeSent(off.signer);
    assert.ok(!t.some((x) => x.name === "exactInputSingle" || x.name === "approve"), "no approve, no swap");
    const tr = t.find((x) => x.name === "transfer");
    assert.ok(tr && lc(tr.to) === lc(LAPTOP) && tr.args[0] === OWNER && tr.args[1] === 1000n * X.E18, "LAPTOP delivered unswapped to the owner");
    assert.ok(/LAPTOP .* delivered unswapped: LAPTOP route is disabled in settings/.test(off.text), off.text);
    assert.strictEqual(L2.balance(LAPTOP, OP), 0n); assert.strictEqual(L2.balance(LAPTOP, OWNER), 1000n * X.E18);
  }
  console.log("collector-base-sweep-gating tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
