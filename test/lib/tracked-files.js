// Files that belong to the project: `git ls-files`, so git-ignored local files
// (.env, *.log, brain/, .claude/worktrees) never count. Falls back to a walk when
// git is missing or `root` is not a work tree.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Mirrors .gitignore (keep in step): directories and file patterns the fallback walk skips.
const SKIP_DIRS = ["node_modules", ".git", ".claude", "brain", "docs", "backups", "agent-memory", "test/.tmp", "tasks/output"];
const SKIP_FILES = [/\.log$/, /^\.env$/, /^\.env\./, /\.key$/, /\.pem$/, /^settings\.json$/, /^config\.json$/, /\.bak-/];

function walk(root) {
  const out = [];
  (function rec(rel) {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.includes(r) && e.name !== "node_modules" && e.name !== ".git") rec(r); }
      else if (!SKIP_FILES.some((re) => re.test(e.name))) out.push(r);
    }
  })("");
  return out;
}

/** Relative paths (forward slashes) of the tracked files under `root`. */
function trackedFiles(root) {
  try {
    const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    // `root` must itself be the work tree top: a plain subfolder of some other repo is not a checkout of this project.
    if (fs.realpathSync(top) !== fs.realpathSync(root)) throw new Error("not a work tree root");
    const raw = execFileSync("git", ["-C", root, "ls-files", "-z"], { maxBuffer: 256 * 1024 * 1024 });
    return raw.toString("utf8").split("\0").filter(Boolean);
  } catch {
    if (fs.existsSync(path.join(root, ".git"))) process.stderr.write(`tracked-files: git ls-files failed in ${root}; falling back to a directory walk\n`);
    return walk(root);
  }
}

/** Tracked files under `root` (not SPEC.md / REPORT.md, < 5 MB, not binary) whose text contains `needle`. */
function filesNaming(root, needle) {
  const hits = [];
  for (const rel of trackedFiles(root)) {
    if (["SPEC.md", "REPORT.md"].includes(path.basename(rel))) continue;
    const p = path.join(root, rel);
    let st; try { st = fs.statSync(p); } catch { continue; }   // tracked but deleted, or dangling
    if (!st.isFile() || st.size >= 5e6) continue;
    const t = fs.readFileSync(p);
    if (!t.includes(0) && t.toString("utf8").includes(needle)) hits.push(rel);
  }
  return hits;
}

module.exports = { trackedFiles, filesNaming, SKIP_DIRS, SKIP_FILES };
