// node test/task4-review-fixes.test.js -- review fixes for the Base instance work:
// wallet.html loads (no duplicate top-level const), status helpers set text not markup,
// no-tx instances refuse arm/unlock/collect and refuse to start without LP_READONLY,
// env endpoint URLs are redacted whatever their charset.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawn, spawnSync } = require("child_process");
const { hermeticEnv, hermeticCwd, PRELOAD } = require("./lib/hermetic");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "wallet.html"), "utf8");
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

// A DOM stand-in where every property is another stand-in: enough for the scripts to run their setup.
function stub() {
  const fn = function () { return stub(); };
  return new Proxy(fn, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : k === "length" ? 0 : k === "options" ? [] : stub()),
    set: () => true,
    apply: () => stub(),
    construct: () => stub(),
  });
}

// ---- 1. every inline script loads, in order, in ONE context ---------------------------------
{
  assert.ok(inline.length >= 8, "found the inline scripts");
  const sandbox = {
    document: stub(), window: null, navigator: stub(), location: { hash: "", hostname: "127.0.0.1", search: "" }, localStorage: stub(),
    fetch: () => Promise.reject(new Error("offline")), setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, clearInterval() {},
    console, ethers: stub(), URLSearchParams, QR: stub(), addEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.window.ethereum = undefined;
  const ctx = vm.createContext(sandbox);
  inline.forEach((src, i) => {
    let script;
    assert.doesNotThrow(() => { script = new vm.Script(src, { filename: `wallet.html#script${i}` }); }, `script ${i} compiles`);
    try { script.runInContext(ctx); } catch (e) {
      assert.ok(!(e instanceof SyntaxError) && !/already been declared/.test(String(e.message)), `script ${i} must not throw at load: ${e.message}`);
    }
  });
}

// ---- 2. status helpers: text by default, markup only through statusHtml ---------------------
{
  const evil = '<img src=x onerror=alert(1)>';
  const helpers = html.split("\n").filter((l) => /^\s*const status = \(/.test(l));
  assert.ok(helpers.length >= 4, "found the status helpers");
  for (const line of helpers) {
    assert.ok(!/innerHTML/.test(line), `status helper has no innerHTML: ${line.slice(0, 80)}`);
    const made = [];
    const target = { replaceChildren: (s) => made.push(s), innerHTML: null };
    const g = {
      document: { createElement: (t) => ({ tag: t, className: "", textContent: "" }) },
      $: () => target, q: () => target,
    };
    const code = line.replace(/^\s*const status =/, "status =");
    const status = vm.runInNewContext(`var status; ${code}; status`, g);
    status(...(/\(el,/.test(line) ? ["x", evil, "bad"] : [evil, "bad"]));
    assert.strictEqual(target.innerHTML, null, "innerHTML untouched");
    assert.strictEqual(made.length, 1);
    assert.strictEqual(made[0].tag, "span");
    assert.strictEqual(made[0].textContent, evil, "the revert text is kept as text");
  }
  const sh = html.match(/function showStatus\(el, msg, type\) \{[\s\S]*?\n\}/)[0];
  assert.ok(/textContent = msg/.test(sh) && !/innerHTML/.test(sh), "showStatus sets text");
  assert.ok(/function showStatusHtml/.test(html));
  // No status call interpolates raw error text into markup-mode helpers.
  for (const l of html.split("\n")) if (/statusHtml\(/.test(l) && !/const statusHtml/.test(l)) {
    assert.ok(!/\$\{(m|e\.\w+|j\.error|data\.error|ctx\.error)\}/.test(l), `statusHtml has no raw error: ${l.trim().slice(0, 90)}`);
    assert.ok(!/\$\{[\w.]*explorer\}|\$\{tx\.hash\}/.test(l), `statusHtml escapes explorer and hash: ${l.trim().slice(0, 90)}`);
    assert.ok(!/\$\{short\(/.test(l), `statusHtml escapes short(): ${l.trim().slice(0, 90)}`);
  }
}

// ---- 3. server: no-tx without read-only does not start; no-tx read-only refuses arm ---------
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lp-t4fix-"));
  try {
    const example = fs.readFileSync(path.join(ROOT, "settings.base.example.json"), "utf8");
    fs.writeFileSync(path.join(tmp, "settings.json"), example);
    const env = hermeticEnv({ LP_DATA_DIR: "", HOME: tmp, LP_BIND: "127.0.0.1", LP_ROUTER_CHAINS: "" });   // no LP_READONLY: the server must refuse
    const args = ["--require", PRELOAD, "--require", path.join(__dirname, "fixtures", "stub-network.js"), path.join(ROOT, "server.js"), `--data-dir=${tmp}`, "--port=0", "--no-loops", "--no-services"];
    const r = spawnSync(process.execPath, args, { cwd: hermeticCwd(), env, encoding: "utf8", timeout: 30000 });
    assert.strictEqual(r.status, 1, `refuses to start: ${r.stdout}${r.stderr}`.slice(0, 300));
    assert.ok(/LP_READONLY/.test(r.stderr), "says why");
    // The gate itself, statically: the arm/unlock/collect refusal covers NO_TX as well as READONLY.
    const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    assert.ok(/if \(\(READONLY \|\| NO_TX\) && \(url\.pathname === "\/api\/unlock"/.test(src));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  // ---- 4. endpoint redaction for env URLs ---------------------------------------------------
  const { registerEndpoint, redactText } = require("../endpoint");
  registerEndpoint("https://env.example/v1/ab.cd.ef.gh.ij?token=abcd&name=short&other=has.dots.here!", { env: true });
  for (const s of ["abcd", "has.dots.here!", "ab.cd.ef.gh.ij"]) assert.ok(!redactText(`x ${s} y`).includes(s), `env secret ${s} redacted`);
  assert.strictEqual(redactText("name=short"), "name=short", "a short non-secret query value stays");
  registerEndpoint("https://env2.example/ethereum/mainnet-k.e.y!", { env: true });
  assert.ok(!redactText("mainnet-k.e.y!").includes("k.e.y"));
  registerEndpoint("https://rpc.ankr.com/ethereum/public.word", { hostile: 1 });
  assert.strictEqual(redactText("the ethereum chain and public.word"), "the ethereum chain and public.word", "settings-file URL rules unchanged");

  // ---- 5. approvals fallback symbol is sanitised --------------------------------------------
  assert.ok(/String\(await c\.symbol\(\)\)\.replace\(\/\[\^A-Za-z0-9 \._\$\+-\]\/g, ''\)\.slice\(0, 16\)/.test(fs.readFileSync(path.join(ROOT, "approvals.js"), "utf8")));
  console.log("task 4 review fixes passed");
})().catch((e) => { console.error(e); process.exit(1); });
