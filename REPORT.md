# Swarm report — smoke fail-fast and npm audit fix

Date: 2026-11-05. Base commit: `c125275`. Nothing pushed; no remote added.

## Starting point

`npm test` failed 47 of 96 files because `node_modules` was missing (`Cannot find module 'ethers'`).
After `npm ci`, two files still failed, neither a product bug:

- `test/service-port.test.js` read `.env` unconditionally in an optional check → `ENOENT` in a checkout without `.env`.
- `test/smoke.js` waited the full 6 minutes for `/api/positions` although the server had already exited with
  "settings.json is missing".

## Commits

| Commit | Stage | Change |
|---|---|---|
| `2e6d414` | quick fix (main session) | service-port test skips the scanner check when there is no `.env` |
| `5e0c4b5` | spec-writer | `SPEC.md` for the two tasks below |
| `0da4113` | implementer, task 1 | `test/smoke.js` watches the child and fails as soon as it exits |
| `88b5200` | implementer, task 2 | `npm audit fix` (no `--force`); only `package-lock.json` changed |
| `61e622b` | implementer, security fix 1 | smoke.js redacts secrets in the server-log tail it prints; SPEC zod note corrected |
| `c48e19a` | implementer, security fix 2 | redaction also covers API keys in RPC URL paths, `proapi_`/`sk-` keys and Bearer tokens; reads the last 64 KB, redacts, then trims |

Each commit was checked for `.env`, `.env.*` and `settings.json` being ignored.

## Task 1 — smoke.js fails fast

- With no `settings.json`: fails in 1.25 s with
  `smoke: settings.json missing: copy settings.example.json to settings.json and fill it in (or pass --data-dir); server log: …`.
- Other early exits report exit code / signal and the redacted log tail (tested with a temporary crash hook, since removed).
- No `server.js --port=8799` process or timer is left behind.
- Normal path verified with a temporary copy of `settings.example.json`, since deleted.

## Task 2 — npm audit fix

Before: 13 vulnerabilities (1 critical, 4 high, 8 moderate). After: 3 moderate, all one `minimatch`
advisory (GHSA-g3hv-75wg-m249) via eslint, dev-only; `npm audit --omit=dev` reports 0. Clearing it needs
`--force` (eslint → 9.x), not done.

| Package | Old | New |
|---|---|---|
| @hono/node-server | 2.1.1 | 2.1.6 |
| @modelcontextprotocol/sdk | 1.30.0 | 1.32.2 |
| body-parser | 2.3.0 | 2.4.0 |
| eslint | 10.10.0 | 10.14.0 |
| fast-uri | 3.1.7 | 3.1.9 |
| follow-redirects | 1.16.0 | 1.16.2 |
| hono | 4.13.5 | 4.13.16 |
| ip-address | 10.7.0 | 10.7.6 |
| proxy-addr | 2.0.7 | 2.0.8 |
| qs | 6.16.0 | 6.17.1 |
| zod | 4.5.4 | 4.6.7 |

## Tests

After every commit: 95 of 96 files pass; the only failure is `smoke.js`, expected in this checkout without
`settings.json` (it now fails in about a second). Suite time ~85 s. eslint clean (run separately, since
`npm test` skips it when a test file fails).

## Reviews

- **Reviewer, task 1:** APPROVE. Optional nit (remove listeners after the kill, not before) not applied.
- **Reviewer, task 2:** APPROVE WITH FIXES — the fixes asked only for evidence, supplied by the security review.
  MCP SDK 1.30.0 → 1.32.2 diff showed additions only; MCP and OAuth tests pass.
- **Security-reviewer:** PASS WITH FIXES on three passes; two rounds of fixes applied; last pass had only optional Low items.

### (a) proxy-addr and the loopback checks — PASS

- No project code calls proxy-addr. The chat handler (`server.js:2007`) compares `req.socket.remoteAddress`
  to exactly `127.0.0.1`, `::1`, `::ffff:127.0.0.1`. Collect, arm, unlock, lock and `LP_ALLOW_REMOTE_COLLECT`
  check the server's bound address. Host/Origin guards check headers.
- `lp-gate.mjs:86-89` uses the first X-Forwarded-For entry or the socket address, for login rate limiting only.
- The only proxy-addr path is `lp-mcp-remote.mjs:308` (`trust proxy 1`), where `req.ip` is only a rate-limit key
  and the server listens on 127.0.0.1. With a hop count, Express uses its own check, so the patched code is not reached.
- By code reading, proxy-addr 2.0.8 still treats 127.0.0.1, ::ffff:127.0.0.1 and ::1 as loopback and rejects
  192.0.2.1 / ::ffff:192.0.2.1 (not executed).
- host-guard, arm-salt, csrf, gate-chain-cookie, oauth-scope and tasks-route tests pass.

### (b) zod 4.5.4 → 4.6.7 — PASS, with a caveat

- Only `lp-mcp.mjs` imports zod (`lp-mcp-remote.mjs` through it and the SDK). Schemas use only basic types and
  checks (string, number, boolean, enum, array, object, optional, describe, int, positive, min, max, regex);
  no coerce, default, strict, passthrough, refine, transform or string formats.
- The zod changelog and GHSA-mrhx-c7xc-m3w5 details were **not** read (no web access in the review). Evidence is
  the passing MCP tests (including tool listing) and a single deduplicated zod.

## Left open

1. **Gate login rate limit bypass (Medium, pre-existing).** `lp-gate.mjs` keys on the first X-Forwarded-For entry,
   which the client controls: rotating it gives unlimited password guesses, and 5,000 distinct values trigger
   `fails.clear()`, wiping all lockouts. Fix: use the last entry and trust it only from loopback, add a global
   failure limit, expire entries instead of clearing.
2. `trust proxy 1` in `lp-mcp-remote.mjs` assumes the tunnel sets X-Forwarded-For (Low).
3. MCP SDK DNS-rebinding protection is off with no allowed hosts; the bearer token covers it.
4. Any loopback client, including traffic via `tailscale serve`, is fully trusted — safe only if the whole tailnet is.
5. `minimatch` via eslint: needs `--force` or a later eslint.
6. Optional smoke.js hardening: mask `wss://` URLs; bound the bot-token pattern to `\b\d{6,12}:`; use the byte
   count from `readSync`; an unescaped `@` in a password partly leaks; `key=value` outside URLs is not masked.
7. To run one test file use `node test/run-all.js <filter>`; `npm test -- <filter>` passes the filter to eslint
   and runs the whole suite.

## Process notes

- The report stage could not write this file (its Write was refused for subagents); the main session wrote it
  from the stage's findings.
- Implementers briefly edited `server.js` to test crash and masking paths and restored it; git shows it unchanged.
- Cost: the orchestrated run took about 39 minutes; per-stage token costs were not recorded.
