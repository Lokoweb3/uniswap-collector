# SPEC: smoke.js fail-fast, then `npm audit fix`

Two tasks, two separate commits in this order. HEAD at start is 2e6d414; `test/service-port.test.js` must not be touched. Never push, never add a remote, never `--force`.

---
## TASK 1: make `test/smoke.js` fail fast

### 1. Goal
`test/smoke.js` spawns the server and polls `/api/positions` for up to 6 minutes. If the server dies at once (for example `settings.json` is missing), the test should notice that the child exited, stop polling, and fail with a clear message instead of waiting the full 6 minutes.

### 2. Scope
In: `test/smoke.js` only (a small helper inside it is fine).
Out: `server.js`, `settings.js`, `test/smoke-lib.js`, other tests, the page and asset checks, timeouts for a healthy server.

### 3. Existing code to reuse
- `test/smoke.js`: `spawn(process.execPath, ["server.js", "--port=PORT"], { stdio: ["ignore", log, log] })` at line 43. Stdout and stderr both go to the fd opened on `test/.tmp/smoke-server.log` (git-ignored via `test/.tmp/`).
- `waitFor(url, ms, perRequestMs)` (lines 24-34) loops with `sleep(1000)`. The 6-min call is at line 47, with a failure message at line 48. The `finally` block (95-100) does SIGTERM, sleep 500, SIGKILL, `closeSync(log)`.
- `settings.js:44` throws `Error("<basename> is missing: copy settings.example.json to settings.json and fill it in (...)")` on ENOENT. This is an uncaught throw at require time, so node prints the stack to stderr (which lands in the log) and exits with code 1. The exact message text is `settings.json is missing`.

### 4. Design (assumptions stated)
- Attach `server.once("exit", (code, signal))` and `server.once("error")` right after spawn. Record `exited = { code, signal }`.
- `waitFor` gets an abort condition (for example an `isDead()` callback, or a Promise.race against the exit event) checked each iteration and during the sleep. The in-flight fetch already has a 3 s timeout, so also race the sleep against the exit event to react within about 1 s or less. When the child has exited, `waitFor` returns early with a distinct result, not plain `false`.
- On early exit, read the log file (`fs.readFileSync`, by path, not the open fd) and:
  - if it contains `settings.json is missing` (regex `/settings\.json is missing/`), fail with a message that includes the exact words `settings.json missing`, and the fix: `copy settings.example.json to settings.json and fill it in (or pass --data-dir)`, plus the log path;
  - otherwise fail with `server exited before answering (code=<code> signal=<signal>)` and the last ~20 lines (or 2 KB) of the log.
- The same exit check applies to the warm-up `waitFor` calls (lines 56-58) so a server that dies mid-run also fails fast.
- Exit with code 1 via the existing `main().catch` or `process.exit(1)`. Note `process.exit` inside `try` skips nothing important only if cleanup has run, so throw an Error and let `finally` clean up, rather than calling `process.exit` mid-`try`.
- Remove the exit listeners and the sleep timers on all paths. No timer or child may outlive the process.
- A normal healthy run behaves exactly as before: same output, same timeouts.

### 5. Constraints
CommonJS, no new dependencies, same style as the file. ESLint (`eslint .` is part of `npm test`) must pass. No change to env passed to the child.

### 6. Acceptance tests (Task 1)
1. With no `settings.json` (the current checkout), `time node test/smoke.js` exits non-zero in under 10 s (target: about 2 s).
2. Its stderr contains the literal `settings.json missing` and the fix instruction (copy `settings.example.json` to `settings.json`), and does NOT contain "within 6 min".
3. Simulated non-settings crash (for example run with a temporary `SMOKE_PORT` plus a deliberately failing server, or a stub via a temporary wrapper kept outside the repo) reports `code=`/`signal=` and the log tail, and exits non-zero in under 10 s. Verify the generic branch by temporarily pointing the child at a script that prints `boom` and exits 3, then revert it. The final diff must not contain that hook, unless it is a documented env override such as `SMOKE_SERVER_CMD` (see open question 1).
4. After a failed run, `pgrep -f "server.js --port=8799"` finds nothing, and `node` exits on its own (no hang) without needing a signal.
5. If a `settings.json` is present (copy of `settings.example.json` may not boot the full server; use the real dev settings if available), the smoke test's behaviour is unchanged: the server is polled, pages load, output matches the old format. If this cannot be run, state so in the commit message and the report.
6. `git diff --stat` for the commit shows only `test/smoke.js`; `test/service-port.test.js` is untouched.
7. `npm test` is run in full and the result recorded (pass/fail count per file, duration). Expected: `test/smoke.js` still fails (no settings.json) but fast, and is the only failure. Run time drops by about the 6 min that smoke used to burn. Record exact numbers.
8. Commit message describes the change and ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---
## TASK 2: `npm audit fix` (non-forced)

### 1. Goal
Run `npm audit fix` (never `--force`) on its own commit to clear the audit findings: 13 vulnerabilities including critical proxy-addr (GHSA-jqcg-44mw-7w3h), high zod < 4.6.6 (GHSA-mrhx-c7xc-m3w5) and moderate qs.

### 2. Scope
In: `package-lock.json`, and `package.json` only if `npm audit fix` itself changes it. Out: any source change, `--force`, major-version bumps, manual edits of the lockfile, `overrides` changes (existing `tmp` override stays).

### 3. Existing code to reuse / examine
- `package.json`: deps `zod ^4.5.4`, `@modelcontextprotocol/sdk ^1.30.0`, `ethers`, `dotenv`, `solc`, `@anthropic-ai/sdk`; dev `eslint`. `proxy-addr` and `qs` are transitive through express (lockfile: proxy-addr 2.0.7 at line 1849, required by express).
- **Loopback decision sites (read in this audit):**
  - `server.js` is plain `http`, not express. It does NOT use proxy-addr. It reads `req.socket.remoteAddress` directly: `chatChannel()` at line 2007 compares against `["127.0.0.1","::1","::ffff:127.0.0.1"]`. Every other "localhost-only" endpoint (collect/arm at 2143-2260, `LP_ALLOW_REMOTE_COLLECT` at 2260, lines 2175-2506, 2745-2880) tests the bind address `HOST !== "127.0.0.1"` (`HOST = process.env.LP_BIND || "127.0.0.1"`, line 67), not the peer address. The Host-header guard is at 2095-2118.
  - `lp-gate.mjs:86-89` `clientIp()` takes the first `x-forwarded-for` entry, else `socket.remoteAddress`. Used for the login throttle only, not an authorisation decision; no proxy-addr.
  - `lp-mcp-remote.mjs` is express: `app.set("trust proxy", 1)` (line 308) and `req.ip` for the login throttle (lines 335-340). This is the only path through proxy-addr. It is used for rate-limiting keys, not for a loopback/authorisation decision.
  - `arm.js` and `csrf.js` rely on loopback by the comments; check by grep that they take no peer address from proxy-addr.
- **zod users:** only `lp-mcp.mjs` imports zod directly (about 40 uses, MCP tool schemas). `daykey.js` and the claims tests do not import it; `lp-mcp-remote.mjs` uses zod only via the MCP SDK. Note: `npm test -- <filter>` passes the filter to eslint (the script is `node test/run-all.js && eslint .`); to run one test file use `node test/run-all.js <filter>` (run-all.js takes the filter from `process.argv[2]`).

### 4. Constraints
- Use only `npm audit fix` (no `--force`, no `--legacy-peer-deps` tricks). Run from the project folder; `npm ci` state is the baseline.
- If `npm audit fix` cannot fix an item without `--force`, leave it and list it; do not escalate.
- Exact semver-compatible bumps only; the lockfile diff is the source of truth.
- No secrets in the commit; verify `.env`, `.env.*`, `settings.json` are ignored (they are, per `.gitignore`) before committing.
- Commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### 5. Acceptance tests (Task 2)
1. Before: save `npm audit` output (summary counts by severity; expect 13 total, 1 critical proxy-addr, zod high, qs moderate) in the report.
2. `npm audit fix` runs without `--force`; its exit status and output are recorded.
3. After: `npm audit` summary recorded. proxy-addr, zod and qs advisories are gone, or each remaining item is listed with the reason (needs a semver-major or `--force`).
4. `git diff --stat` shows only `package-lock.json` (and `package.json` only if npm changed it). Every `name old -> new` version change from the lockfile diff is listed exactly.
5. Security (a), loopback: after the change, a test or script shows that `::ffff:127.0.0.1`, `::1` and `127.0.0.1` are treated as loopback and a non-loopback address (for example `192.0.2.1`, `::ffff:192.0.2.1`, `::ffff:7f00:1` is acceptable as loopback form only if the code already accepts it) are not, at each site:
   - `server.js` `chatChannel` (reads `socket.remoteAddress`; independent of proxy-addr, so confirm by grep that `proxy-addr` is not required anywhere in first-party code and state the finding);
   - `lp-gate.mjs` `clientIp`;
   - `lp-mcp-remote.mjs` `req.ip` under `trust proxy 1`: with a request from a loopback proxy carrying `X-Forwarded-For: 203.0.113.9`, `req.ip` is `203.0.113.9`; with a direct request, `req.ip` is the socket address; an IPv4-mapped spoof in XFF does not make `req.ip` loopback unless the real peer is trusted. The check can use the new proxy-addr directly: `proxyaddr(req, 1)` or `proxyaddr.compile`.
   - `LP_ALLOW_REMOTE_COLLECT`, and arm and collect endpoints, still refuse when `HOST !== "127.0.0.1"` and the env var is not `1` (existing tests such as `test/host-guard.test.js`, `test/arm-salt.test.js`, `test/csrf.test.js` must pass unchanged).
   The report states for each site whether the check goes through proxy-addr (express `req.ip` / trust proxy) or reads `socket.remoteAddress` directly.
6. Security (b), zod: old and new zod versions recorded; the changelog / release notes between them are read and any behavioural change relevant to schemas used in `lp-mcp.mjs`, `daykey.js` and the two tests is noted (parsing, coercion, defaults, error shape, `.strict`/`.passthrough`, `z.object` unknown-key handling, JSON-schema output the MCP SDK derives). If the bump is patch/minor within 4.x, expect none; state this explicitly. Also check that `@modelcontextprotocol/sdk` peer range for zod still holds (`npm ls zod` shows a single, deduped version with no `invalid`).
7. `npm ls` reports no `ERR!`/invalid/missing for the touched packages. `node -e "require('zod'); import('express')"`-style load of `lp-mcp.mjs` and `lp-mcp-remote.mjs` imports succeeds (`node --check`, or an import with a stub; do not start servers bound to external interfaces).
8. Full `npm test` is run after the change and the result recorded and compared with the Task 1 result: same set of failures (only `test/smoke.js`), no new failures; `eslint .` clean.
9. Commit contains only the files in item 4, message lists the version changes, ends with the required Co-Authored-By line, no push.

---
## Open questions
1. Task 1 test 3 (generic-crash branch): is a documented env override for the server command (for example `SMOKE_SERVER_CMD`) acceptable? Assumption: no new override; verify temporarily and revert.
2. `smoke.js` also needs Windows Chrome (`CHROME`); with no settings.json the check at line 37 runs first. Assumption: Chrome is present here (the failure currently is the 6-min timeout, so it must be). If Chrome were absent, the settings message would not be reached. Should the settings check run before the Chrome check? Assumption: leave order unchanged.
3. If `npm audit fix` leaves some of the 13 unresolved without `--force`, is partial a pass? Assumption: yes, with a list of leftovers and their required action.
4. `lp-mcp-remote.mjs` `trust proxy 1` with a fixed hop count: not changed here (out of scope); noted for follow-up if the proxy-addr advisory still affects it after the bump.
5. Environment note: this spec-writing agent had no shell, so it could not run `npm audit`, read git status, or commit. SPEC.md is written but NOT committed; the caller must commit it (it is a new file; `.gitignore` excludes `.env*`, `settings.json`, `test/.tmp/`) or ignore it as the conventions allow.
