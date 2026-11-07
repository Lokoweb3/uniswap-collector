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
