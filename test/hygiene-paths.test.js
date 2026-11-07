// node test/hygiene-paths.test.js — no hard-coded old-home paths; footer lists
// collect-enabled wallets; /api/watch rows carry `collect`. Starts no process
// other than throwaway bash/node children in temp dirs.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { execFileSync, spawnSync } = require("child_process");
const { filesNaming } = require("./lib/tracked-files");
const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hygiene-"));
try {
const OLD = "home/steve" + "n"; // spelled in two parts so this file does not match itself

// 1. nothing in the tree names the old home
{
  assert.deepStrictEqual(filesNaming(ROOT, OLD), []);
}

// 2. backup-ledgers.sh default DATA_DIRS (only the assignment line is executed)
const line = (f, re) => fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").find((l) => re.test(l));
for (const f of ["backup-ledgers.sh", "restart-dashboard.sh"]) execFileSync("bash", ["-n", path.join(ROOT, f)]);
const evalVar = (assign, name, env) => execFileSync("bash", ["-c", `PWD=/work; ${assign}; printf %s "$${name}"`],
  { env: { PATH: process.env.PATH, ...env } }).toString();
{
  const a = line("backup-ledgers.sh", /^DATA_DIRS=/);
  const d = evalVar(a, "DATA_DIRS", { HOME: tmp });
  assert.strictEqual(d, `/work ${tmp}/arc-data`);
  assert.ok(!/\/home\//.test(d));
  assert.strictEqual(evalVar(a, "DATA_DIRS", { HOME: tmp, LP_ARC_DATA_DIR: tmp + "/x" }), `/work ${tmp}/x`);
  assert.strictEqual(evalVar(a, "DATA_DIRS", { HOME: tmp, LP_BACKUP_DATA_DIRS: "/q" }), "/q");
}
// 3. restart-dashboard.sh default DATA (assignment line only; nothing is started)
{
  const a = line("restart-dashboard.sh", /^DATA=/);
  assert.strictEqual(evalVar(a, "DATA", { HOME: tmp }), `${tmp}/arc-data`);
  assert.strictEqual(evalVar(a, "DATA", { HOME: tmp, LP_ARC_DATA_DIR: "/z" }), "/z");
}
// 4. tools resolve defaults through tools/_paths.js; --settings still overrides
{
  const P = require("../tools/_paths");
  assert.strictEqual(P.arcSettingsPath({}, "/h"), "/h/arc-data/settings.json");
  assert.strictEqual(P.arcSettingsPath({ LP_ARC_DATA_DIR: "/d" }, "/h"), "/d/settings.json");
  assert.strictEqual(P.arcSettingsPath({ LP_ARC_SETTINGS: "/s.json", LP_ARC_DATA_DIR: "/d" }, "/h"), "/s.json");
  assert.strictEqual(P.rhSettingsPath({}), path.join(ROOT, "settings.json"));
  assert.strictEqual(P.rhSettingsPath({ LP_RH_SETTINGS: "/r.json" }), "/r.json");
  for (const t of ["swap-routes", "deploy-vault-arc", "verify-arc-vault", "propose-collector-settings",
    "rehearse-arc-vault-replace", "apply-vault-settings", "recover-stranded"]) {
    const src = fs.readFileSync(path.join(ROOT, "tools", t + ".js"), "utf8");
    assert.ok(/require\("\.\/_paths"\)\.arcSettingsPath\(\)/.test(src), t + " uses the shared default");
    if (t !== "verify-arc-vault" && t !== "rehearse-arc-vault-replace")
      assert.ok(/arg\("settings", require/.test(src), t + ": --settings= still overrides");
  }
}
// 6. footer note
{
  const src = fs.readFileSync(path.join(ROOT, "dashboard.js"), "utf8");
  const from = src.indexOf("function watchCollectNote(");
  const body = src.slice(from, src.indexOf("\n}\n", from) + 3);
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(src.match(/^const esc = .*$/m)[0] + "\n" + src.match(/^const shortA = .*$/m)[0] + "\n" + body + "\nthis.f = watchCollectNote;", ctx);
  const n = ctx.f([{ label: "A", collect: true }, { label: "B" }, { label: "C", collect: true }]);
  assert.ok(/Collect-enabled[^.]*: A, C\./.test(n) && /Read-only: B\./.test(n));
  assert.ok(!n.includes("never collected from"));
  assert.ok(ctx.f([{ label: "A" }, { label: "B" }]).includes("read-only and never collected from"));
  const x = ctx.f([{ label: "<b>", collect: true }]);
  assert.ok(x.includes("&lt;b&gt;") && !x.includes("<b>"));
}
// 7. watch.readWallets carries a boolean collect (child, temp data dir)
{
  const dd = path.join(tmp, "data"); fs.mkdirSync(dd);
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, "settings.example.json"), "utf8"));
  s.wallets.watched = [{ address: "0x" + "11".repeat(20), label: "A", collect: true }, { address: "0x" + "22".repeat(20), label: "B" }];
  fs.writeFileSync(path.join(dd, "settings.json"), JSON.stringify(s));
  const out = execFileSync(process.execPath, ["-e", `
    const W = require(${JSON.stringify(path.join(ROOT, "watch.js"))});
    const w = W.create({ cfg: { ownerAddress: ${JSON.stringify(s.wallets.main.address)}, contracts: {} } });
    const r = w.readWallets();
    console.log(JSON.stringify({ r, k: W.keepLastGood(r[0], null, "x", 1, 1).collect }));`],
  { env: { PATH: process.env.PATH, LP_DATA_DIR: dd } });
  const { r, k } = JSON.parse(out);
  assert.deepStrictEqual(r.map((w) => w.collect), [true, false]);
  assert.strictEqual(k, true);
}
// 8. MCP description
assert.ok(!fs.readFileSync(path.join(ROOT, "lp-mcp.mjs"), "utf8").includes("never collected from"));
// 9. explicit-settings requirement for write tools
{
  const P = require("../tools/_paths");
  assert.strictEqual(P.explicitArcSettings([], {}), false);
  assert.strictEqual(P.explicitArcSettings(["--apply"], {}), false);
  assert.strictEqual(P.explicitArcSettings(["--settings=/x"], {}), true);
  assert.strictEqual(P.explicitArcSettings([], { LP_ARC_SETTINGS: "/x" }), true);
  assert.strictEqual(P.explicitArcSettings([], { LP_ARC_DATA_DIR: "/d" }), true);
  // spawn with a temp HOME, write flag, nothing explicit: refused, nothing written, no network reached
  const home = path.join(tmp, "home9"); fs.mkdirSync(path.join(home, "arc-data"), { recursive: true });
  for (const [tool, flag] of [["apply-vault-settings", "--apply"], ["propose-collector-settings", "--apply"],
    ["recover-stranded", "--execute"], ["deploy-vault-arc", "--execute"]]) {
    const r = spawnSync(process.execPath, [path.join(ROOT, "tools", tool + ".js"), flag],
      { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8", timeout: 20000 });
    assert.ok(r.status !== 0 && r.status !== null, tool + " must exit non-zero");
    assert.ok(r.stderr.includes("pass --settings= (or LP_ARC_SETTINGS) explicitly to write; default would be " + home + "/arc-data/settings.json"), tool + ": " + r.stderr);
  }
  assert.deepStrictEqual(fs.readdirSync(path.join(home, "arc-data")), []);
}
// 10. restart-dashboard.sh guard (only the guard block is evaluated; nothing is killed or started)
{
  const src = fs.readFileSync(path.join(ROOT, "restart-dashboard.sh"), "utf8");
  const guard = src.slice(src.indexOf("# GUARD-BEGIN"), src.indexOf("# GUARD-END"));
  assert.ok(guard && src.indexOf("# GUARD-END") < src.indexOf("kill "));
  const home = path.join(tmp, "home10"); const live = path.join(home, "uniswap-collector"); const dev = path.join(tmp, "dev");
  fs.mkdirSync(live, { recursive: true }); fs.mkdirSync(dev);
  const run = (here, env) => spawnSync("bash", ["-c", `set -euo pipefail; HERE=${JSON.stringify(here)}; ${guard}\necho ok`],
    { env: { PATH: process.env.PATH, HOME: home, ...env }, encoding: "utf8" });
  assert.strictEqual(run(dev, {}).status, 3);
  assert.ok(run(dev, {}).stderr.includes("refusing"));
  assert.strictEqual(run(live, {}).stdout.trim(), "ok");
  assert.strictEqual(run(dev, { LP_RESTART_ALLOW_DEFAULT: "1" }).stdout.trim(), "ok");
  assert.strictEqual(run(dev, { DATA: "/x" }).stdout.trim(), "ok");
  assert.strictEqual(run(dev, { LP_ARC_DATA_DIR: "/x" }).stdout.trim(), "ok");
}
// 11. backup-ledgers.sh: a glob character in a data dir path is taken literally
{
  const src = fs.readFileSync(path.join(ROOT, "backup-ledgers.sh"), "utf8");
  const from = src.indexOf("ARGS=()"), to = src.indexOf("FILES=(");
  const loop = src.slice(from, to);
  assert.ok(loop.includes('read -r -a DIRS') && loop.includes('${f#"$d"/}'));
  const d = path.join(tmp, "g[x]*"), other = path.join(tmp, "gx-decoy");
  fs.mkdirSync(d); fs.mkdirSync(other);
  fs.writeFileSync(path.join(d, "a.json"), "{}"); fs.writeFileSync(path.join(other, "a.json"), "{}");
  const out = execFileSync("bash", ["-c", `log(){ echo "$*" >&2; }; NAMES=(a.json); DATA_DIRS=${JSON.stringify(d + " /nonexistent-q")}\n${loop}\nprintf '%s\\n' "$COUNT" "${"$"}{ARGS[@]}"`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n");
  assert.deepStrictEqual(out.slice(0, 4), ["1", "-C", tmp, "g[x]*/a.json"]);
}
console.log("hygiene-paths: all assertions passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
