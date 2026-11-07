// node test/collector-base-state.test.js -- state.json of the Base collect pass fails closed and is written atomically.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { TMP, cfgOf, enableMain, scene, pass } = require("./lib/base-scene"); // sets LP_DATA_DIR first
const L = require("../collector-base-logic");
const { hermeticEnv, hermeticCwd } = require("./lib/hermetic");

const mk = (prefix) => fs.mkdtempSync(path.join(TMP, prefix));
const stateOpts = (file) => ({ readState: () => L.readState(file), saveState: (s) => L.writeFileAtomic(file, L.serializeState(s)) });
const good = JSON.stringify({ version: 1, gasSpends: [] });

(async () => {
  // ---- readState: shape table
  {
    const dir = mk("rs-"); const f = path.join(dir, "state.json");
    const t = (text) => { fs.writeFileSync(f, text); return L.readState(f); };
    assert.ok(t(good).ok);
    assert.ok(t(JSON.stringify({ gasSpends: [{ t: 1, wei: "5" }] })).ok, "the pre-version shape is still readable");
    assert.ok(t(JSON.stringify({ version: 1, gasSpends: [{ t: 1, wei: "5", kind: "unknown", tx: null }] })).ok);
    for (const bad of ['{"version":1,"gasSpends":[', "[]", '{"gasSpends":"x"}', "null", '{"gasSpends":[{"t":"1","wei":"5"}]}', '{"gasSpends":[{"t":1,"wei":"abc"}]}', '{"gasSpends":[{"t":1,"wei":"-5"}]}',
      '{"gasSpends":[{"t":1,"wei":5}]}', '{"gasSpends":[null]}', '{"version":2,"gasSpends":[]}', ""]) {
      const r = t(bad);
      assert.ok(!r.ok && r.kind === "corrupt", `corrupt: ${bad}`);
    }
    fs.rmSync(f);
    const m = L.readState(f);
    assert.ok(!m.ok && m.kind === "missing" && m.file === f);
    fs.mkdirSync(f);
    assert.ok(L.readState(f).kind === "corrupt", "a directory in its place is unreadable");
  }

  // ---- 14. corrupt state: collect sends nothing and leaves the file alone; simulate prints the line and decisions
  {
    const variants = [["truncated", '{"version":1,"gasSpends":['], ["array", "[]"], ["string", '{"gasSpends":"x"}'], ["wei abc", '{"gasSpends":[{"t":1,"wei":"abc"}]}'], ["negative", '{"gasSpends":[{"t":1,"wei":"-1"}]}']];
    for (const [name, text] of variants) {
      const f = path.join(mk("corrupt-"), "state.json");
      fs.writeFileSync(f, text);
      const w = scene();
      const r = await pass(w, { cfg: cfgOf(enableMain), extra: stateOpts(f) });
      assert.strictEqual(r.signer.sent.length, 0, name); assert.strictEqual(r.res.aborted, true, name);
      assert.ok(/STATE UNREADABLE \(.*\): today's budget is treated as spent; no transaction sent/.test(r.text) && r.text.includes(f), r.text);
      assert.strictEqual(r.signerCalls(), 0); assert.strictEqual(w.estimates.length, 0, "nothing was even estimated");
      assert.strictEqual(fs.readFileSync(f, "utf8"), text, "the file is untouched");
      assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ["state.json"]);
      const ws = scene();
      const sim = await pass(ws, { cfg: cfgOf(enableMain), mode: "simulate", extra: stateOpts(f) });
      assert.ok(/STATE UNREADABLE/.test(sim.text) && sim.signer.sent.length === 0 && !sim.res.aborted, sim.text);
      assert.strictEqual(sim.res.wouldCollect, 2);
      assert.ok(sim.lines.filter((l) => l.startsWith("#")).every((l) => /\(would be refused: state unreadable\)/.test(l)), sim.text);
      assert.strictEqual(fs.readFileSync(f, "utf8"), text);
    }
    // a directory in place of the file
    const dir = mk("dirstate-"); const f = path.join(dir, "state.json"); fs.mkdirSync(f);
    const r = await pass(scene(), { cfg: cfgOf(enableMain), extra: stateOpts(f) });
    assert.strictEqual(r.signer.sent.length, 0); assert.ok(r.res.aborted && /STATE UNREADABLE/.test(r.text));
    // chmod 000 (not meaningful as root)
    if (process.getuid && process.getuid() !== 0) {
      const f2 = path.join(mk("chmod-"), "state.json"); fs.writeFileSync(f2, good); fs.chmodSync(f2, 0o000);
      const r2 = await pass(scene(), { cfg: cfgOf(enableMain), extra: stateOpts(f2) });
      fs.chmodSync(f2, 0o600);
      assert.strictEqual(r2.signer.sent.length, 0); assert.ok(r2.res.aborted && /STATE UNREADABLE/.test(r2.text), r2.text);
    }
  }

  // ---- 15. missing state: nothing sent, nothing created; --init-state creates it once
  {
    const dir = mk("missing-"); const f = path.join(dir, "state.json");
    const r = await pass(scene(), { cfg: cfgOf(enableMain), extra: stateOpts(f) });
    assert.strictEqual(r.signer.sent.length, 0); assert.strictEqual(r.res.aborted, true);
    assert.ok(r.text.includes(`STATE MISSING ${f}: refusing to send; create it once with: LP_DATA_DIR=${dir} node collector-base.js --init-state`), r.text);
    assert.ok(!fs.existsSync(f), "the run did not create it");
    const sim = await pass(scene(), { cfg: cfgOf(enableMain), mode: "simulate", extra: stateOpts(f) });
    assert.ok(/STATE MISSING/.test(sim.text) && /would be refused: state missing/.test(sim.text) && !fs.existsSync(f));

    const cli = () => spawnSync(process.execPath, [path.join(__dirname, "..", "collector-base.js"), "--init-state"], { cwd: hermeticCwd(), env: hermeticEnv({ LP_DATA_DIR: dir }), encoding: "utf8", timeout: 30000 });
    const a = cli();
    assert.strictEqual(a.status, 0, a.stdout + a.stderr); assert.ok(/created/.test(a.stdout));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, "utf8")), { version: 1, gasSpends: [] });
    assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
    const before = fs.readFileSync(f); const mtime = fs.statSync(f).mtimeMs;
    await new Promise((res) => setTimeout(res, 30));
    const b = cli();
    assert.strictEqual(b.status, 0, b.stdout + b.stderr); assert.ok(/already exists/.test(b.stdout));
    assert.ok(before.equals(fs.readFileSync(f)) && fs.statSync(f).mtimeMs === mtime, "a second call changes nothing");
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => /tmp/.test(n)), [], "no tmp left behind");
    // an existing (even corrupt) file is never overwritten by --init-state
    fs.writeFileSync(f, "junk");
    const c = cli(); assert.ok(/already exists/.test(c.stdout)); assert.strictEqual(fs.readFileSync(f, "utf8"), "junk");
    // with the fresh file a normal run sends and persists
    fs.writeFileSync(f, good);
    const ok = await pass(scene(), { cfg: cfgOf(enableMain), extra: stateOpts(f) });
    assert.strictEqual(ok.signer.sent.length, 2, ok.text);
    const disk = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.strictEqual(disk.version, 1); assert.strictEqual(disk.gasSpends.length, 2); assert.ok(disk.gasSpends.every((e) => e.kind === "settled"));
  }

  // ---- 16. atomic write
  {
    const dir = mk("atomic-"); const f = path.join(dir, "state.json");
    fs.writeFileSync(f, "before");
    const order = [];
    const spy = (name) => (...a) => { order.push(name); return fs[name](...a); };
    const fsm = { openSync: spy("openSync"), writeFileSync: spy("writeFileSync"), fsyncSync: spy("fsyncSync"), closeSync: spy("closeSync"), renameSync: spy("renameSync"), rmSync: spy("rmSync") };
    L.writeFileAtomic(f, "after", fsm);
    assert.strictEqual(fs.readFileSync(f, "utf8"), "after");
    assert.ok(order.indexOf("writeFileSync") < order.indexOf("fsyncSync") && order.indexOf("fsyncSync") < order.indexOf("renameSync"), order.join(","));
    assert.deepStrictEqual(fs.readdirSync(dir), ["state.json"], "no tmp after a successful write");
    // S4: the directory is fsynced after the rename
    {
      const ev = [];
      const fd0 = fs.openSync;
      const spyFs = { ...fsm, openSync: (p, ...a) => { const fd = fd0(p, ...a); ev.push(["open", p, fd]); return fd; }, renameSync: (...a) => { ev.push(["rename"]); return fs.renameSync(...a); }, fsyncSync: (fd) => { ev.push(["fsync", fd]); return fs.fsyncSync(fd); } };
      L.writeFileAtomic(f, "d", spyFs);
      const dirOpen = ev.find((e) => e[0] === "open" && e[1] === dir);
      assert.ok(dirOpen, "the directory is opened");
      assert.ok(ev.indexOf(dirOpen) > ev.findIndex((e) => e[0] === "rename"), "after the rename");
      assert.ok(ev.some((e) => e[0] === "fsync" && e[1] === dirOpen[2]), "and fsynced");
      // unsupported on this filesystem: ignored; a real I/O error: thrown
      for (const code of ["EISDIR", "EINVAL", "EPERM"]) {
        L.writeFileAtomic(f, "e", { ...fsm, fsyncSync: (fd) => { if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error(code), { code }); return fs.fsyncSync(fd); } });
        assert.strictEqual(fs.readFileSync(f, "utf8"), "e");
      }
      assert.throws(() => L.writeFileAtomic(f, "f", { ...fsm, fsyncSync: (fd) => { if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("EIO"), { code: "EIO" }); return fs.fsyncSync(fd); } }), /EIO/);
      assert.deepStrictEqual(fs.readdirSync(dir), ["state.json"]);
    }
    assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
    // rename fails: the target is byte-identical and the tmp is gone
    fs.writeFileSync(f, "before");
    const failing = { ...fsm, renameSync: () => { throw new Error("EXDEV"); } };
    assert.throws(() => L.writeFileAtomic(f, "after", failing), /EXDEV/);
    assert.strictEqual(fs.readFileSync(f, "utf8"), "before"); assert.deepStrictEqual(fs.readdirSync(dir), ["state.json"]);
    // the tmp lives in the same directory as the target
    const seen = [];
    L.writeFileAtomic(f, "x", { ...fsm, openSync: (p, ...a) => { seen.push(p); return fs.openSync(p, ...a); } });
    assert.strictEqual(path.dirname(seen[0]), dir); assert.ok(seen[0].endsWith(".tmp"));
    // pruning on write: entries older than 7 days are dropped
    const now = Date.now();
    const text = L.serializeState({ gasSpends: [{ t: now - 8 * 86400_000, wei: "1" }, { t: now - 3600_000, wei: "2" }] }, now);
    assert.deepStrictEqual(JSON.parse(text).gasSpends.map((e) => e.wei), ["2"]);
  }
  // ---- R3: the saved file keeps an entry older than 24 h but younger than 7 days (and an old unknown one)
  {
    const f = path.join(mk("keep-"), "state.json");
    const now = Date.now();
    const old = { t: now - 3 * 86400_000, wei: "5", kind: "settled", tx: null };
    const unk = { t: now - 20 * 86400_000, wei: "9", kind: "unknown", tx: null };
    const gone = { t: now - 20 * 86400_000, wei: "9", kind: "settled", tx: null };
    fs.writeFileSync(f, JSON.stringify({ version: 1, gasSpends: [old, unk, gone] }));
    const r = await pass(scene(), { cfg: cfgOf(enableMain), extra: stateOpts(f) });
    assert.strictEqual(r.signer.sent.length, 2, r.text);
    const disk = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.ok(disk.gasSpends.some((e) => e.wei === "5" && e.t === old.t), "3-day-old entry kept");
    assert.ok(disk.gasSpends.some((e) => e.wei === "9" && e.kind === "unknown"), "old unknown entry kept");
    assert.ok(!disk.gasSpends.some((e) => e.t === gone.t && e.kind === "settled"), "20-day-old settled entry pruned");
    assert.strictEqual(disk.gasSpends.length, 4);
  }
  console.log("collector-base-state tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
