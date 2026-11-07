// node test/tracked-files.test.js — the hygiene walk sees tracked files only; the fallback
// (no git work tree) skips what .gitignore ignores. Everything happens in temp dirs.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { trackedFiles, filesNaming } = require("./lib/tracked-files");

const NEEDLE = "home/steve" + "n";   // two parts, so this file does not match itself
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracked-"));
const put = (root, rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
try {
  // 1+2. a git repo: only tracked files count, even when ignored files hold the needle
  const repo = path.join(tmp, "repo"); fs.mkdirSync(repo);
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  git("init", "-q");
  put(repo, ".gitignore", ".env\nbrain/\n.claude/\n*.log\n");
  put(repo, "tracked.txt", "clean\n");
  git("add", ".gitignore", "tracked.txt");
  for (const f of [".env", "brain/note.md", ".claude/worktrees/x/y.js", "a.log"]) put(repo, f, `path /${NEEDLE}/x\n`);
  assert.deepStrictEqual(trackedFiles(repo).sort(), [".gitignore", "tracked.txt"]);
  assert.deepStrictEqual(filesNaming(repo, NEEDLE), [], "ignored files with the needle are not flagged");
  put(repo, "tracked.txt", `old /${NEEDLE}/y\n`);
  assert.deepStrictEqual(filesNaming(repo, NEEDLE), ["tracked.txt"], "a tracked file with the needle is flagged");
  put(repo, "SPEC.md", `${NEEDLE}\n`); git("add", "SPEC.md");
  put(repo, "bin.dat", `\0${NEEDLE}`); git("add", "bin.dat");
  assert.deepStrictEqual(filesNaming(repo, NEEDLE), ["tracked.txt"], "SPEC.md and binary files are excluded");
  fs.rmSync(path.join(repo, "tracked.txt"));
  assert.ok(trackedFiles(repo).includes("tracked.txt") && !filesNaming(repo, NEEDLE).length, "tracked but deleted: no crash");

  // 3. no .git: the fallback walk skips the ignored names
  const plain = path.join(tmp, "plain");
  for (const f of [".env", ".env.local", "brain/x.md", ".claude/z", "node_modules/m.js", "run.log", "docs/d.md", "test/.tmp/t", "tasks/output/o", "k.pem", "settings.json", "a.json.bak-1"]) put(plain, f, NEEDLE);
  put(plain, "src/a.js", `x ${NEEDLE}`);
  assert.deepStrictEqual(trackedFiles(plain), ["src/a.js"]);
  assert.deepStrictEqual(filesNaming(plain, NEEDLE), ["src/a.js"]);

  // 4. the real project folder is untouched by this test and is scanned clean
  const ROOT = path.join(__dirname, "..");
  assert.deepStrictEqual(filesNaming(ROOT, NEEDLE), []);
  console.log("tracked-files passed");
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
