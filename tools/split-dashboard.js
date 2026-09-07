#!/usr/bin/env node
/**
 * Split dashboard.html into a thin HTML shell + dashboard.css + dashboard.js.
 *
 * Moves the contents of the single inline <style>…</style> block into
 * dashboard.css and the single inline <script>…</script> block (the big one at
 * the end of the body; external <script src=…> tags stay) into dashboard.js,
 * replacing them with `<link rel="stylesheet" href="/dashboard.css">` and
 * `<script src="/dashboard.js"></script>`. Everything else is preserved byte
 * for byte. Idempotent: running it on an already split file is a no-op, so it
 * can be re-run after any merge that lands changes in dashboard.html's inline
 * blocks (e.g. git merge of a branch that still has the inline version).
 *
 *   node tools/split-dashboard.js            # split in place
 *   node tools/split-dashboard.js --check    # exit 1 if a split is pending
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HTML = path.join(ROOT, "dashboard.html");
const CSS = path.join(ROOT, "dashboard.css");
const JS = path.join(ROOT, "dashboard.js");
const CSS_TAG = '<link rel="stylesheet" href="/dashboard.css">';
const JS_TAG = '<script src="/dashboard.js"></script>';

function split(html) {
  let out = html;
  let css = null, js = null;

  // At most one inline <style> block is expected.
  const styles = [...out.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  if (styles.length > 1) throw new Error(`expected at most one <style> block, found ${styles.length}`);
  if (styles.length === 1) {
    css = styles[0][1].replace(/^\n/, "");
    out = out.replace(styles[0][0], CSS_TAG);
  }

  // At most one inline <script> (no src attribute) is expected.
  const scripts = [...out.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length > 1) throw new Error(`expected at most one inline <script> block, found ${scripts.length}`);
  if (scripts.length === 1) {
    js = scripts[0][1].replace(/^\n/, "");
    out = out.replace(scripts[0][0], JS_TAG);
  }
  return { html: out, css, js };
}

function main() {
  const check = process.argv.includes("--check");
  const html = fs.readFileSync(HTML, "utf8");
  const r = split(html);
  const pending = r.css != null || r.js != null;
  if (check) {
    console.log(pending ? "dashboard.html still has inline blocks; run tools/split-dashboard.js" : "dashboard.html is split");
    process.exit(pending ? 1 : 0);
  }
  if (!pending) {
    console.log("nothing to do: dashboard.html has no inline <style>/<script> blocks");
    return;
  }
  if (r.css != null) fs.writeFileSync(CSS, r.css);
  if (r.js != null) fs.writeFileSync(JS, r.js);
  fs.writeFileSync(HTML, r.html);
  const lines = (s) => s.split("\n").length;
  console.log(
    `split: dashboard.html ${lines(html)} -> ${lines(r.html)} lines` +
      (r.css != null ? `, dashboard.css ${lines(r.css)} lines` : "") +
      (r.js != null ? `, dashboard.js ${lines(r.js)} lines` : "")
  );
}

if (require.main === module) main();
module.exports = { split };
