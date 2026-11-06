# REPORT: lp-dashboard swarm run (SPEC tasks 1-5, plus two mid-run user changes)

**Task:** Implement SPEC.md tasks 1-5 in projects/lp-dashboard: login gate throttle, path hygiene, per-wallet sNET staking, read-only Base instance, read-only PulseChain instance. Two user changes mid-run: remove the claimed tile (Extra A) and fix the risk panel scope and claim owner (Extra B). Local master only, never pushed.

## What was done
- **Spec:** spec-writer produced SPEC.md (5 tasks, hard constraints H1-H6, acceptance tests). It had no shell, so no on-chain checks. A separate read-only research pass verified all Base and PulseChain addresses. Verification tables were filled in by the Task 4 and 5 implementers.
- **Task 1, gate throttle (b2badb5):** Shared login-throttle.mjs keys clients by the last trusted XFF hop, with TTL/LRU eviction and a global budget of 60 per 15 min. Reviewer: APPROVE WITH FIXES, then APPROVE. Security: PASS WITH FIXES (Medium parallel-request race, fixed), then PASS.
- **Task 2, path hygiene (1e8f919):** No hard-coded old-home paths. Write tools refuse --apply/--execute without an explicit settings path. restart-dashboard.sh refuses the default data dir unless run from the live folder or forced. Reviewer: APPROVE. Security: PASS WITH FIXES (Low items remain, see below).
- **Task 3, sNET per wallet (1aaffc3):** One snet-staking.json ledger tracks every watched wallet. Main-wallet data is unchanged (golden fixture deep-equal). /api/staking and the MCP tool gained an optional wallet filter. Reviewer: APPROVE. Security: PASS.
- **Task 4, Base read-only (bd4d653):** LP_READONLY=1 with no transaction routes (403) and the keystore never read. Two Slipstream managers are distinguished by address. Discovery falls back to pinned IDs, held-pool gauges and a bounded RPC log scan. Endpoint validation and URL redaction are in place. Reviewer: APPROVE after 30aadae. Security: PASS WITH FIXES x4 (two Mediums: approval flow live on read-only Base; unescaped revert text), closed by 30aadae. Real read of Trading 0xaDf9...d743 on Base: #79371151 WETH/cbBTC (~$271) and #8905958 USDC/LAPTOP (~$585), both in range, neither staked, no pending AERO; all Aerodrome gauges on the Voter report killed.
- **Extra A, remove claimed tile (e2fa0d1):** Reviewer: APPROVE. Security: PASS.
- **Extra B, risk panel scope and claim owner (fe6bba0):** Reviewer: APPROVE. Security: PASS.
- **30aadae, escaping hardening:** Escapes the remaining interpolations in Sell/Mint/Approve/audit/vault (an older XSS, live on Robinhood). Reviewer: APPROVE. Security: findings closed.
- **Task 5, PulseChain read-only (eb15ad4):** v2lp.js reads PulseX v1 and v2 pairs, validated against factory.getPair. Pricing is anchored to WPLS and bridged stables by address. Gap rule and counting rules applied. Farm adapter (MasterChef 0xB2Ca...d4) is view-only. Reviewer: APPROVE WITH FIXES x4; the last prescribed fix was applied without a separate re-approval. Security: PASS.

## Files changed
76 files, +7,624 / -406 since SPEC commit 2ac5c52.
- login-throttle.mjs (new), lp-gate.mjs, lp-mcp-remote.mjs: gate throttle.
- tools/_paths.js (new), backup-ledgers.sh, restart-dashboard.sh, tools/*.js: path hygiene and write-tool guards.
- staking.js, watch.js, server.js, lp-mcp.mjs: per-wallet sNET (the snet-staking.json ledger itself is git-ignored data).
- v2lp.js (new), pricing and valuation code: PulseX readers.
- chain-router.js (--chains), endpoint.js, slipstream.js, univ4.js, settings.base.example.json, settings.pulsechain.example.json, start-all.sh, stop-all.sh: Base and PulseChain instances.
- dashboard.html, dashboard.js, themes/*/dashboard.css: claimed tile removed; risk panel scope.
- wallet.html: escaping fixes.
- tools/verify-onchain.js (new), tools/verify-pulsechain-wallets.js (new): read-only verification.
- test/*.test.js (new suites for throttle, hygiene, staking, v2lp, pulse wiring, risk scope, wallet escape) and test/fixtures.

## Tests
- **Full suite** (`node test/run-all.js` + eslint): 108 files, 107 pass. The one failure is test/smoke.js ("settings.json missing"), expected in the dev copy. ESLint clean.
- **verify-onchain base:** all PASS, 15/15 example addresses proven.
- **verify-onchain pulse:** 25 PASS, 0 FAIL.
- **verify-pulsechain-wallets:** WPLS = $5.46e-6. Counted: Main no LP; Wallet 11 $0 (~$365 shown, 137 unpriced); Wallet 12 ~$15 (~$2,110 shown); Wallet 2 $0 (~$2 shown); Wallets 3 and 5 no LP. No farm stakes.

## Cost and time
Not measured precisely. About 40 agent runs, ~4.2 h wall clock for the orchestrator. No dollar figure recorded.

## Left to do / risks
1. **Not deployed.** Live /home/loko/uniswap-collector is untouched apart from two uncommitted hotfixes (claimed tile, risk scope) that e2fa0d1/fe6bba0 supersede: `git checkout dashboard.html dashboard.js`, then `git pull --ff-only` from this repo, `./stop-all.sh`, `npm ci`, tests, `./start-all.sh`. Never push to the live GitHub origin without asking.
2. **Base and PulseChain are opt-in:** copy the example settings into ~/base-data or ~/pulse-data, run verify-onchain, restart the router on :8800.
3. **Tailscale Funnel XFF** behaviour is unverified: send X-Forwarded-For through Funnel once and confirm the gate log shows the real IP.
4. **PulseChain totals are very conservative** (Wallet 12: ~$15 counted vs ~$2,110 shown). User decision: relax the 10% gap rule or treat bridged WETH as an anchor.
5. **Task 2 Lows:** restart-dashboard.sh with DATA set but PORT defaulted could kill whatever is on :8797; a profile-exported LP_ARC_DATA_DIR/LP_ARC_SETTINGS silently satisfies the write-tool guard; LP_BACKUP_DIR is unvalidated in the remote ssh command.
6. **Info:** CSV formula guard misses leading tab/CR; per-wallet staking backoff shared across tokens; Base partial scan off by default; Uniswap v4 on Base (6 Trading positions) unverified live.
7. **Temp dirs** /tmp/hygiene-26DgR5, -Blyq27, -pBdta3, -rY3x0i left from an early test run.
8. **Operator hardening** (revoke operator on wallets with no LP, short arm windows, separate Linux user) not part of this run.
9. **Process note:** one implementer's overbroad pkill killed its own shell; live services on 8787, 8800 and 8797 were verified still listening.
