# REPORT: lp-dashboard swarm runs on Base (base 980b6e5 → e521641)

Two runs: (1) hermetic tests, Base Claim fees button, Base auto-collect, fee-total investigation; (2) the auto-collect security fix round and Base v4 id pinning. Dev repo, local master, never pushed, no remote added.

## Commits
| Commit | What | Reviewer (final) | Security (final) |
|---|---|---|---|
| dd92feb | Hermetic tests: hygiene scan uses tracked files; server-spawning tests get scrubbed env, temp HOME/cwd, no-network preload | APPROVE WITH FIXES (Lows) | PASS WITH FIXES (Lows) |
| 956bb20 + fc3b8f9 | Claim fees button on Aerodrome cards, signed in the browser wallet; GET /api/claim-fees/target; manager allowlist, chain pinned at send, frame headers | APPROVE | PASS WITH FIXES (Low/Info) |
| 2952263 | Base auto-collect for collect:true wallets (ships collect:false) | APPROVE WITH FIXES | **FAIL** (uncapped signed fees, reverted gas uncounted) |
| f0c24ab | Auto-collect fix: hard-capped type-2 fees (tip 0.01 gwei), gasLimit ceiling 500000, worst-case accounting incl. reverts and 2× L1 fee, fail-closed atomic state.json (`--init-state`), wait timeout 120 s, passphrase cleared from env | APPROVE WITH FIXES (Lows) | PASS WITH FIXES (Lows only; replaces the FAIL) |
| e521641 | Pinned v4 ids per wallet (ownerOf-verified), visible warning when v4 discovery is incomplete | APPROVE WITH FIXES (2 missing tests) | PASS WITH FIXES (1 Low) |

fc3b8f9 is deployed on live (2026-11-07). f0c24ab and e521641 are not.

## Findings
- **Fee total ($36.59, later ~$57) is real, not a bug:** almost all from #8905958 USDC/LAPTOP (0.8% tier). The earlier "about $3" estimate was wrong.
- **Trading's 6 Base v4 NFTs** (PositionManager 0x7C5f…bDc): 3065177, 3048672, 3045696, 3041082, 3038319, 3038281, all USDC/LAPTOP, all closed (liquidity 0, $0). Found by a Multicall3 ownerOf scan because public RPCs and Blockscout refused log scans.

## Tests
- run-all: 123 files, 122 pass; smoke.js fails only because the dev copy has no settings.json. eslint clean.
- Robinhood collector golden test passes; collector.js, collector-logic.js, run-collector.sh unchanged by f0c24ab/e521641.
- Not run: manual Rabby check of the Claim button (reject without sending).

## Left to do
- **Deploy f0c24ab + e521641** (user OK needed). Run `LP_DATA_DIR=$HOME/base-data node collector-base.js --init-state` once, or the Base pass refuses to send and logs "base pass failed". Optional: `"v4Ids": [3065177, 3048672, 3045696, 3041082, 3038281, 3038319]` under `wallets.main` in ~/base-data/settings.json.
- **Auto-collect Lows (fail closed):** run-start settlement trusts unchecked receipts; a failed state save after reservation doesn't stop the run; crashed-run `reserved` entries count only 24 h; hashless/dropped entries never settle and can block collection until state.json is edited; bad optional state fields or a hashless send crash the run; README L1 formula; exact-manager pre-sign check.
- **v4 pinning Lows:** denylist adjustment subtracts unverified ids; missing tests (pins changing between refreshes, redaction before truncation); discovery.error in /api/watch not redacted.
- **Earlier Lows:** wallet.html lacks frame headers; 12 s target cache skips re-checks; spawn-audit gaps in hermetic tests.
- **Housekeeping:** four leftover agent polling loops (PIDs 304775, 487687, 513076, 542279; `pgrep -f` matches itself). Kill was denied to the agent; the user decides.
- **Before enabling auto-collect:** setApprovalForAll(operator 0x8B65…b9dF, true) from Trading on both Aerodrome managers, verify, then set `wallets.main.collect` true. The approval lets the operator move those NFTs.

## Cost
Not tracked precisely: about 33 agent runs, ~1.6M+ subagent tokens across both runs.

---

# Round 4: auto-collect self-healing and v4 pinning leftovers (8db9320 → ccfec18)

| Commit | What | Reviewer (final) | Security (final) |
|---|---|---|---|
| bc52cba | Base auto-collect signs before recording; every entry has hash + nonce; run-start settlement by validated receipt (hash, from, to, block, 21000 ≤ gasUsed ≤ gasLimit) and nonce; stop on failed state save; strict readState; exact-manager pre-sign check; in-run receipts validated (Medium found and fixed: hostile RPC reporting gasUsed 0) | APPROVE | PASS WITH FIXES (Info/Low, non-blocking) |
| ccfec18 | v4: denylist subtracts only ownerOf-confirmed ids; departed pinned ids tombstoned; redaction before truncation; discovery.error redacted on /api/watch; the two missing tests | APPROVE | PASS |

- Orchestrator addition (approved on re-review): an entry whose receipt keeps failing checks is closed once at worst case after its nonce is used, so state.json never needs a hand edit.
- Assumptions: no by-nonce lookup (replaced/dropped entries close once at worst case); a pending nonce stays reserved with no expiry; a definite broadcast rejection stops the run (exit 1) and settles next run.
- Tests: 123/124 pass (smoke.js needs settings.json); eslint clean; collector-golden passes; Robinhood collector files byte-identical to 8db9320; npm audit 0.
- Live check: the live ~/base-data/state.json passes the new strict readState; simulate run left it unchanged.
- Open (non-blocking): optional fee floor at baseFee + tip; findByNonce replacement branch settles at original fee (unreachable today); revert without refetched receipt stays unknown (caps hold); a few optional tests; wallet.html frame headers; 12 s target cache; spawn-audit gaps.
- Before enabling auto-collect: setApprovalForAll(operator 0x8B65…b9dF, true) from Trading on both Aerodrome managers, verify, set wallets.main.collect true.
- Cost: about 16 subagent runs, not measured precisely.

---

# Round 5: cross-chain Portfolio page (e2b5ac0 → c6a709b)

| Commit | What |
|---|---|
| 030a621 | SPEC round 5, TASK P1 (36 acceptance tests) |
| 5c5f40e | Feature: router-served `/portfolio` + `/api/aggregate`, aggregate.js (4 parallel loopback GETs per chain, 8 s timeout, 4 s route wait, 30 s cache, 8 MiB / 5000-item caps, field whitelist), aggregate-view.js, aggregate.css, Portfolio link in the picker |
| 3642267 | Reviewer fixes (7): cap ordering, truncated totals, unreadable wallet not $0, live-shape fixtures used, vacuous tests, dead option, restored round-4 item 10 |
| c6a709b | Security fixes (5 Low): strict CSP on the page, per-round payload cache, mtime file cache, synthetic fixture ids, 400 on malformed Host |

- User decisions: stale chains counted (flagged, `staleUsd` separate); Host check on new routes only; priced pending gauge/farm rewards INCLUDED in the total (own `rewardsUsd` line; unpriced and killed-gauge rewards not counted; sNET rewards never added).
- Verdicts: reviewer APPROVE WITH FIXES → APPROVE WITH FIXES (optional Low, fixed). Security PASS WITH FIXES → PASS WITH FIXES (L1, L2 open, nothing above Low).
- Tests: 126/127 pass (smoke.js needs settings.json); eslint clean. server.js, dashboards and collector untouched.
- Deploy: fast-forward live, restart only the router on :8800 (`--chains=robinhood,arc,base`); verify `/portfolio` 200 and `/api/aggregate` ok.

## Left to do
1. holdings-unavailable flag: token discovery never succeeded for 2 Robinhood and 2 Base wallets, so those chains always show `partial` and the total `incomplete`. Reviewer recommends a per-wallet note instead (user decision).
2. L1: after an idle gap one response can show frozen ages and miss the 15-min stale flag if a chain takes >4 s (add TTL to the cache key).
3. L2: one real v4 pool id remains at test/fixtures/aggregate/live-shape-arc.json:51.
4. Squash 5c5f40e/3642267 (real-looking NFT ids in old fixtures) before any push.
5. SPEC acceptance test 1 still names the looser CSP; the shipped page and its test use the strict one.
6. Pre-existing: /api/vaults and the router 502 page echo internal error text.
- Cost: not measured; about 8 subagent runs.

---

# Round 6: Portfolio follow-ups (5f3aefc → f7cbe99)

| Commit | What |
|---|---|
| 310344c | SPEC round 6 |
| 52e00db | holdings-unavailable becomes a per-wallet note (tokens unknown, never $0, "at least" on the wallet row); no longer makes a chain partial or the total incomplete |
| e9323a8 | Ages and the 15-minute stale flag computed at response time (rebuild at most once per LP_AGG_BUILD_MS, default 1000 ms, and exactly at the stale flip) |
| 6288da0 | Synthetic pool id in the arc fixture; fixture hygiene test |
| 02851a6 | README; SPEC round-5 test 1 states the shipped strict CSP |
| b911557 | Fixes: stronger hygiene scan (0x runs of 40+ hex, bare 64+ hex, labels, symbols), generic token symbols in fixtures, explicit view flag, router honors HOST, fixed error strings in vaultOf and /api/vaults |
| f7cbe99 | Review fixes: label scan on parsed JSON, ECONNRESET test, proxy 502 page shows only fixed text, sanitised err.name, stderr warning on non-loopback bind |

- Verdicts: round 6, reviewer APPROVE (two independent reviews), security PASS WITH FIXES (Lows → b911557). b911557, reviewer APPROVE WITH FIXES, security PASS WITH FIXES (→ f7cbe99). f7cbe99, reviewer APPROVE, security PASS.
- Tests (main session, f7cbe99): 127/128 pass (smoke.js needs settings.json); eslint clean; no stray servers.
- Live partial causes at the time: holdings-unavailable only (Robinhood 1-3 wallets, Arc 0-2, Base 2); Blockscout token discovery blocked.
- Deploy: router-only restart (chain-router.js, aggregate.js, aggregate-view.js) and a browser hard refresh.

## Left to do
- Optional tests: assert the 502 page text; assert reachable === true in the reset case.
- Optional: no loopback warning for 127.0.0.x and [::1] spellings.
- Before any push: the real arc pool id (prefix 0xebde8959) and real token symbols remain in history before 6288da0/b911557. A history rewrite needs user approval.
- Root cause for holdings-unavailable (Blockscout token discovery blocked) is not addressed.
- Cost: not measured; about 12 subagent runs, several cut off by forced hand-backs and resumed.

---

# Base sweep to USDC (3103487 → 4930f2a), ships disabled

- Step 0 (read-only, 2026-11-07): USDG is not on Base; user chose native USDC 0x8335…2913. Routes: WETH/USDC 500 and cbBTC/USDC 500 ~0% impact; LAPTOP/USDC 10000 ~1.2% under mid for $60. Allowlist: Uniswap SwapRouter02 0x2626…e481 + QuoterV2 0x3d4e…B76a only (no Slipstream cl2, no multihop). LOKOVault TBA 0x4941…340B exists only on Robinhood (owner Main); no Base vault, so the user chose 100% to the NFT owner with the vault split written but gated (hard-coded ERC-6551 registry, empty implementation allowlist).
- Commits: e6c8ba6 spec · 4273e36 implementation (collector-base-sweep*.js, tools/verify-base-sweep.js; every tx through sign-first reservations, nonce settlement and per-run/daily caps) · 587b2c9 review fixes · 4930f2a security fixes (block-tagged balances, two-run not-found rule, owner bound to configured owners, collect receipt re-verified, maxUnswappedValueUsdc, TWAP-bounded minOut).
- Verdicts: reviewer APPROVE WITH FIXES (applied); security PASS WITH FIXES → re-review PASS WITH FIXES (no path found that loses funds, double-pays or misdirects).
- Tests: 136/137 then (smoke.js only); eslint clean; npm audit 0; Robinhood collector files and pre-sweep tests byte-identical to 3103487.
- Open before enabling: MEDIUM, preflight doesn't apply maxUnswappedValueUsdc, so a large USDC/declined leg is collected then held on the operator. L-1 ledger duplicates / swap outRaw not re-checked; L-2 delivered without Transfer-log check when block-tagged reads fail; L-3 voided broadcast collect should be unattributed. Info: freeze VAULT_IMPLEMENTATIONS; redundant transfer target check.
- Enable steps (user): fix the Medium, deploy, `node tools/verify-base-sweep.js`, Rabby operator approval on both Aerodrome managers, `--init-state` for sweep-state.json, set wallets.main.collect + baseSweep.enabled, simulate, then a real run.
- Cost (approx tokens): ~1.2M across 9 stages.

---

# Portfolio fee totals (branch worktree-agent-afe4e6be413177e2c, 3103487 → c10cce6)

| Commit | What |
|---|---|
| e9cb989 | Spec: fee totals and earning rate (26 acceptance tests) |
| b2f8357 | Totals row under the LP table (counted fees, counted rewards, uncounted fees), fee columns in By chain / By wallet, measured earning rate (main-wallet dailyUsd, watched earned.perHour × 24; "rate unknown" otherwise; per week labelled ×7 extrapolated) |
| c10cce6 | Review fixes: unpriced rewards show "(unpriced)" not "$0.00"; down/loading chains listed as "rate unknown (chain down)" in rate sources |

- Verdicts: reviewer APPROVE WITH FIXES → APPROVE; security PASS (no findings; info I1 tiny rate shows $0.00/day, I2 all-uncounted wallet shows fees $0.00, I3 chain-down placeholders drop out under a wallet filter).
- Tests: aggregate-fees, aggregate, aggregate-view, aggregate-router, aggregate-fixtures, portfolio-partial pass; eslint clean. Full suite to be confirmed after merge into master.
- Deploy: router-only (aggregate.js, aggregate-view.js, aggregate.css).
- Left: optional full snapshot test for the old breakdown columns (the implementer's report claimed it, but it is not in the commit); "(chain down or loading)" wording; mixed priced/unpriced reward test; info notes I1-I3; spec test 26 (manual live check).

- Merged into master as 3aac9e3 (SPEC sections kept side by side). Full suite on merged master: 137/138 (smoke.js only); eslint clean.

---

# Base sweep fix round (85d311a → 93d7351)

| Commit | What |
|---|---|
| 638de14 | maxUnswappedValueUsdc enforced in preflight ("fees stay in the NFT"); readSweepState rejects duplicate collect.tx / leg tokens; outRaw capped at the swap receipt, every swap hash recorded; Transfer-log proof when block-tagged reads fail; a lost broadcast collect becomes unattributed (blocks new collects); VAULT_IMPLEMENTATIONS frozen with a test hook; redundant transfer-target check removed |
| 93d7351 | Proceeds cache keyed on swap hashes; swap hashes unique ledger-wide and never equal to a collect.tx; unswapped delivery capped at run time or held; no-mid legs valued at amount × own USD price, else refused; recovery needs a balance proof or Transfer log; receipts missing to/from refused; removed logs skipped; vault implementations fail closed; SPEC D3/D9/D10 and test 22 updated |

- Verdicts: 638de14 reviewer APPROVE WITH FIXES, security PASS WITH FIXES (4 Low) → 93d7351 reviewer APPROVE, security PASS WITH FIXES (2 Low, 3 Info; no Critical/High/Medium).
- Tests (main session, 93d7351): 138/139 pass (smoke.js needs settings.json); eslint clean; Robinhood collector files and golden test unchanged since 85d311a.
- Left: L-1 readSweepState doesn't validate job.priceUsd/token0/token1 (tampered ledger could slip a no-mid leg under the cap; still bounded by the Collect receipt and the verified owner). L-2 pending op:"swap" hash not in the uniqueness set; recovery doesn't check a new hash against other legs (double credit within one run, bounded by operator USDC; next run flags the ledger corrupt). Info: skip removed logs in swapOut/Collect parse, pin tokenDecimals on the job, prefer the log proof over the balance-fall proof. Reviewer nits: README.md:975 wording; a balance-fall-only test; stale comment/regex in the security test.
- Behaviour notes: a position with an unpriced token is refused before collect (spot-price cap is best effort); a lost collect blocks new collects until resolved.

---

# Base sweep hardening round (4a2b63a → 08afeee)

| Commit | What |
|---|---|
| 68bc662 | Ledger validation (token0/token1 distinct and matching positions(), leg tokens among them, priceUsd null or finite ≥ 0, tokenDecimals pinned); pending op:"swap" hashes in the ledger-wide uniqueness set, hash-collision check before recovery credits; removed logs skipped; Transfer log required as proof when logs are present; reviewer nits; new collector-base-sweep-hardening.test.js; SPEC D3/D9/D10 |
| 08afeee | Reviewer's 5 fixes; M-1 (older code) a duplicate job.id could reuse another job's cached Collect check and pay the same fees twice: now a corrupt ledger, cache keyed by manager:tokenId:collect.tx; hold when live decimals differ from pinned; empty logs on USDC/route tokens never count as proof |

- Verdicts: 68bc662 reviewer APPROVE WITH FIXES, security PASS WITH FIXES (M-1 Medium, L-1..L-3 Low). 08afeee reviewer APPROVE, security PASS.
- Tests (main session, 08afeee): 139/140 pass (smoke.js needs settings.json); eslint clean; Robinhood collector files and golden test unchanged since 4a2b63a. v4-pinned.test.js failed once under load in an agent's chunked run and passed alone.
- Left: security L-1 (older code) pruned-job receipt replay: a tampered ledger could point at a real older operator receipt from a pruned job (bounded by operator balance, paid only to a verified owner). Suggested fix: swap receipt blockNumber ≥ the job's collect block, plus a retired-hash list. Reviewer nit: when both decimals and price are missing, only one hold reason is listed. Info: verifyAgainstCollect checks to/from only when present; duplicate pending transfer hashes unchecked (under-delivery only); fee-on-transfer tokens now held when logs are present (fails closed).
- Process: two of the implementer's test chunks went past the tool's 120 s default and were backgrounded by the harness; both finished and were read. 08afeee ran fully in the foreground.

---

# Base sweep retired-hash round (5ab1444 → 242d3ca)

| Commit | What |
|---|---|
| 37d26c1 | Security L-1 (pruned-job receipt replay): new `retired` block in sweep-state (hashes cap 2000 with a FIFO floor; collectBlock per manager:tokenId cap 10000; malformed = corrupt). Swap/transfer receipts must be at or after the job's verified collect block; a collect must be newer than the position's retired high-water; retired hashes refused as proof. Both hold reasons listed when decimals and price are both missing |
| 242d3ca | Review fixes: ledger blocks above the chain head refused; replay refusals mark the leg unattributed (blocks new collects); collects older than COLLECT_MAX_AGE_BLOCKS 1,166,400 (~27 d) refused; known-block entries evicted first; canonical tokenId; transfer hashes unique across legs with a full collision check in recovery; a leg holds at 99 transfers (cap 100); first-review fixes 2 and 4 |

- Verdicts: 37d26c1 reviewer APPROVE WITH FIXES, security PASS WITH FIXES (M-1, M-2, L-1..L-5; all fixed in 242d3ca). 242d3ca reviewer APPROVE WITH FIXES, security PASS WITH FIXES (Low-1, Low-2; not applied, fix budget used). No fail-open found.
- Tests: eslint clean; 140/140 (implementer; v4-pinned passes alone). Robinhood collector files and golden test unchanged since 5ab1444.

## Left to do
1. Decision: the age rule is fatal, so a leg D8 keeps held (NFT sold or gauge-staked) turns unattributed at ~day 27 and halts all collects. Options: make it a plain hold (fatal only for replay), or document it in D8/D10 with a test. Either way, a warning from ~day 20.
2. The recovery fatal path drops the mined hash (collector-base-sweep.js ~801); put p.tx in the reason.
3. README doesn't yet describe the new refusals (head check, age limit, transfer hold, throwing saves).
4. An RPC failure at start is reported as kind "corrupt"; fix the wording.
5. The head check has no slack for a lagging RPC; allow ~64 blocks.
6. Pruning trusts the ledger's finishedAt and the local clock; validate finishedAt and require chain age (security Low-2).
7. Residual: anyone who can write sweep-state.json can reset terminal legs (the deferred operator-guard item).
