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
