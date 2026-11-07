# SPEC (round 3): TASK 3-FIX (commit 1) and TASK B (commit 2)

Project: `/mnt/c/Swarm-Projects/projects/lp-dashboard` (DEV repo), Node CommonJS, local branch `master`, base HEAD `fc3b8f9`. Task 3 of the previous round (Base auto-collect) is commit `2952263`; its security review FAILED (1 HIGH, 1 MEDIUM, several LOW). This round fixes it (commit 1), then makes the Base dashboard find and warn about Uniswap v4 positions (commit 2). Both tasks are user-approved. Previous round history is condensed at the bottom.

Facts used throughout (verified in code at fc3b8f9):
- `collector-base.js` `runPass(deps)` sends with `signer.sendTransaction({to,data,value:0n,gasLimit: units*125/100, maxFeePerGas: feeData.maxFeePerGas ?? gasPrice, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0n})` (l.179-186), then `tx.wait()` (l.188) and only afterwards records `state.gasSpends`. `collector-base-logic.js` `effectiveGasPrice` = `min(maxFeePerGas, gasPrice)` (l.74), `capCheck` compares `maxGasPriceGwei` against that (l.108-121). State is read with `JSON.parse(readFileSync(STATE_FILE))`, any failure -> `{gasSpends: []}` (l.263) and written with plain `writeFileSync` (l.276).
- `run-collector.sh`: `set -euo pipefail` (l.10); the Base pass runs after `node collector.js` (l.94-95) so a non-zero exit of collector.js aborts before it (l.97-103); it is skipped when `LP_DATA_DIR` is set (`base_enabled`, l.39) or when the flock/locked branches exit early (l.61-64, 81-87). The key is handed over as an env prefix: `LP_KEYSTORE_PATH="$KEYSTORE" LP_KEYSTORE_PASS="$PASS" ... node collector-base.js` (l.100-101), so it sits in that process's initial environment (`/proc/<pid>/environ`, readable by the same user and root).
- `server.js` `startCollectRun()` (l.1948-1972) spawns `bash run-collector.sh collect|full` (mode from `dashboard.collectMode`) from `POST /api/collect` (l.2274-2288), with no `LP_DATA_DIR`, cwd = project dir. So the Collect button of the Robinhood dashboard also triggers the Base pass whenever `$LP_BASE_DATA_DIR|~/base-data/settings.json` exists. The Base server refuses that route (403, `READONLY || NO_TX`, l.2152).
- `univ4.js` `createDiscovery` (l.387-602): state file `v4-positions.json` (`dataPath`, per watched wallet `v4-positions-<addr>.json` via `watch.js` `discoveryFor` l.300-315); `discover()` returns `[...ids]`; `status` getter (l.588-597) = `{complete, scannedFrom, lastScanned, window, error, known}`; comment at l.577-578 and l.585-587: an empty list from an unfinished scan must never read like an empty wallet, `complete:false` means history is unread. `POSM_ABI` (l.24-29) has no `balanceOf`. There is NO pinning mechanism for v4 (v3 pins via `collector.tokenIds` -> `cfg.tokenIds`; Slipstream via `contracts.slipstream[].tokenIds`).
- `server.js` `buildPositions` l.1634 `V4.discovery.discover(20)`; l.1652-1654 `p.gone` -> `V4.discovery.forget`; `/api/positions` payload ends with `positions, external, closed, errors, notes` (l.1934-1938); `notes` come from `watch.externalOf` (l.1860-1862). Watched wallets: `watch.js` `loadWallet` (l.317-326) already returns `discovery: disc.status` per wallet in `/api/watch`. The page renders `d.notes` as faint grey lines in `#errors` (`dashboard.js` l.2183-2186), watched-wallet `errors`/`notes` in `walletIssues` (l.3804-3809).
- `settings.js`: `wallets.main` -> `cfg.ownerAddress`, `cfg.ownerCollect` (l.91, 146-148), watched list passed through raw as `cfg.watchWallets` and `cfg.wallets.list` (l.188-189); `save` side whitelists `["address","label","collect"]` (l.222-223).
- Test fixtures present: `test/fixtures/mock-chain.js` (`world()`, `.on(addr, fn, handler)`, `feeData`, `gasEstimate`, `estimates`, `calls`), `stub-base-network.js`, `no-network.js`, `test/lib/hermetic.js`, `test/collector-base.test.js` (`scene()`, `fakeSigner()`, `pass()`), `collector-base-logic.test.js`, `collector-base-readme.test.js`, `collector-golden.test.js` (+ `fixtures/collector-golden/{hashes.json,robinhood-simulate.txt,run-collector.json}`), `v4-discovery.test.js`, `v4-discovery-recovery.test.js`, `base-instance.test.js`, `settings.test.js`.

---

## GLOBAL CONSTRAINTS (both tasks)

G1. One commit per task, in order: commit 1 = TASK 3-FIX, commit 2 = TASK B. Before EACH commit run `git check-ignore -v .env .env.local settings.json` (all three must print a rule) and `git status --short` must show no `.env*`, `settings.json`, keystore, `*.log`, `state.json`. `git add` named files only.
G2. Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
G3. Never push, never add a remote.
G4. Never touch the live install `/home/loko/uniswap-collector` (no read, write, run). `~/base-data` may be READ only, and only for file names / token ids; never write there. Never read `/dev/shm`. Never read keystore contents beyond what the existing code does (public `address` field; tests use a throwaway `ethers.Wallet.createRandom()` key). Never read real `.env` contents. No secret in code, tests or this file.
G5. No real transaction, ever. Read-only RPC (eth_call, eth_getLogs, eth_getBlockNumber, eth_getCode) to public endpoints is allowed by hand for Task B discovery only, never from the test suite. Tests use `mock-chain.js` / fake providers / `FetchRequest.registerGetUrl`, no network (`test/fixtures/no-network.js`, `test/lib/hermetic.js` for every spawn).
G6. Never kill processes by name pattern (no `pkill`, `killall`, `pgrep`-subshell kills). Kill only PIDs you started (`child.kill()`). Live services on ports 8787, 8788, 8790, 8791, 8796, 8797, 8800 and 3847 must stay up and untouched. Any test or manual server uses port 0 / an ephemeral port, is stopped before the task ends, and nothing is left running in the background. Never run `start-all.sh`, `stop-all.sh`, `restart-dashboard.sh`.
G7. `collector.js` stays BYTE-FOR-BYTE unchanged (also `collector-logic.js`, `collector-swap.js`, `collect-v4.js`, `treasury.js`, `slipstream.js`, `run-collector.sh`). `test/collector-golden.test.js` stays and passes unmodified (its `hashes.json` covers them). `git diff fc3b8f9 -- collector.js collector-logic.js collector-swap.js collect-v4.js treasury.js run-collector.sh` is empty at both commits.
G8. At the end of EACH task: `node test/run-all.js` (all, ~85 s; runner is NOT `npm test -- <filter>`) and `npx eslint .` pass. `test/smoke.js` is the one expected failure on this dev copy (no `settings.json`) and must still fail only for that reason. New `.js` files pass `test/collector-scope.test.js` and `eslint.config.js`; every spawning test uses `test/lib/hermetic.js` (`test/hermetic-audit.test.js` enforces it).
G9. All text interpolated into HTML goes through `esc()` (`dashboard.js`); no new unescaped `innerHTML`.
G10. No new dependency.

---

# TASK 3-FIX: close the security-review findings on Base auto-collect

Commit message: `base: collect pass signs only capped fees, counts reverted/L1 gas, fails closed on state`. (Body: list each finding and the test that covers it.)

## Goal
The Base collect pass must never be able to sign a transaction that costs more than the operator's configured caps, whatever the RPC says; every broadcast transaction (including reverted and timed-out ones) must be counted against the budget; and the budget state must fail closed.

## Scope
IN: `collector-base.js`, `collector-base-logic.js`, `settings.base.example.json` (new keys + comment), `README.md` (Auto-collect on Base section), `settings.js` only if a new `baseCollect` key needs pass-through (it is passed through as an object today; verify), `test/fixtures/mock-chain.js` (additive handlers only), tests.
OUT: Robinhood collector and every file in G7; `server.js`; the Base server; `run-collector.sh` (the README documents its behaviour, the script is not edited); changing which wallets/managers are enabled; the shipped `collect:false`.

## Existing code to reuse
`collector-base.js` `runPass`/`makeReaders`, `collector-base-logic.js` (`limits`, `capCheck`, `decide`, `gasCostUsd`), `collector-logic.js` helpers `budgetAllows`, `gasEstimate`, `gasSpentLast24h` (read-only use; do not edit), `rpc-retry.js`, test helpers `scene()/fakeSigner()/pass()` in `test/collector-base.test.js`, `mock-chain.js`.

## Design decisions (implementer follows; deviations need the orchestrator)

### F1 (HIGH) signed fee fields are computed by us, hard-clamped, and type-2 explicit
New pure function `logic.buildFees({ baseFeeWei, rpcPriorityWei, lim })` in `collector-base-logic.js`:
- `capWei = parseUnits(lim.maxGasPriceGwei, "gwei")` (default 1 gwei).
- `baseFeeWei` MUST come from `provider.getBlock("latest").baseFeePerGas` (a bigint > 0). Missing/zero/non-bigint -> refuse (fail closed). It is NOT taken from `getFeeData().gasPrice/maxFeePerGas`.
- `priorityWei = min(rpcPriorityWei if a positive bigint else DEFAULT_PRIORITY, lim.maxPriorityFeeGwei in wei)`. New limits: `maxPriorityFeeGwei` default `0.01` (Base is an OP-stack L2; tips are ~0 and the sequencer ignores a large tip). `DEFAULT_PRIORITY` = 0.001 gwei (1_000_000 wei). Never ethers' 1 gwei fallback; never 0n unset.
- Refuse when `baseFeeWei + priorityWei > capWei` (reason names base fee, tip and cap). This is "base fee above the cap".
- `maxFeePerGas = min(capWei, baseFeeWei * 2n + priorityWei)`; `priorityWei = min(priorityWei, maxFeePerGas)`. Invariants asserted: `0 < priority <= maxFee <= capWei`, `maxFee >= baseFee + priority`.
- The existing check "network gas price above `maxGasPriceGwei`" (capCheck) becomes this refusal; the log line keeps the words `exceeds maxGasPriceGwei`.
The transaction handed to the signer is built explicitly: `{ type: 2, chainId: 8453, to, data, value: 0n, gasLimit, maxFeePerGas, maxPriorityFeePerGas }` (no `gasPrice`, no missing fee field, so ethers does not fill any). Nonce may be left to ethers. A final guard `logic.assertSignable(tx, lim)` runs immediately before `signer.sendTransaction` and throws (-> no send, logged) unless `type===2`, `to` is the allowlisted manager, `value===0n`, `gasLimit <= lim.maxGasLimit`, `maxFeePerGas <= capWei`, `maxPriorityFeePerGas <= maxFeePerGas`, and no `gasPrice` key.

### F2 (HIGH) absolute gasLimit ceiling
New limit `maxGasLimit` default `500000` (units of gas per collect, configurable in `baseCollect`). `estimateGas` result `units`: if `units > maxGasLimit` -> skip with reason `gas estimate N exceeds maxGasLimit M` (never clamp a too-low limit; it would revert). Otherwise `gasLimit = min(units * 125n / 100n, maxGasLimit)`. (The old `GAS_UNITS_FALLBACK` for a zero estimate stays but is also bounded by the ceiling.)

### F3 (HIGH) every cap is checked against the worst case actually signed
`worstCaseWei = gasLimit * maxFeePerGas + l1AllowanceWei` (F5 defines `l1AllowanceWei`). `logic.capCheck` takes `worstCaseWei` instead of the old `estimateWei` and checks, in order: `maxCollectsPerRun`; per-tx cap `maxGasPerTxEth` (new, default `0.0002`) `worstCaseWei <= cap`; per-run `spentRunWei + worstCaseWei <= maxGasPerRunEth`; rolling 24 h `spent24hWei + worstCaseWei <= dailyGasCapEth` (spent24h includes reserved/unknown entries, F4/F6). The economic threshold (`decide`: `minFeesUsd`, `minFeesToGasRatio`) uses the EXPECTED cost: `units * min(maxFeePerGas, baseFee + priority) + L1 quote` in USD (not the worst case), and the README says so. Log line for each position shows `gas $x` (expected) and, on a send, a `worst case N ETH` figure.

### F4 (MEDIUM) gas of a reverted or unconfirmed transaction is counted
Reserve-then-settle: right before `signer.sendTransaction`, append to `state.gasSpends` an entry `{ t, wei: worstCaseWei, kind: "reserved", tx: null }` and save atomically; if that save fails, DO NOT send. After the broadcast returns a hash, update the entry's `tx`. Then:
1. `await tx.wait(1, lim.waitTimeoutSec * 1000)` (new limit `waitTimeoutSec`, default `120`).
2. Success: replace the entry with `{ kind: "settled", wei: receipt.gasUsed * effectiveGasPrice + l1AllowanceWei }` (`effectiveGasPrice` = `receipt.gasPrice ?? receipt.effectiveGasPrice`, clamped to `<= maxFeePerGas`; if absent use `maxFeePerGas`).
3. `wait` throws with `err.receipt` (ethers 6 `CALL_EXCEPTION` on revert): settle from `err.receipt` the same way, log `reverted on-chain`, count as skipped, continue the run within caps.
4. `wait` throws with code `CALL_EXCEPTION`/revert but WITHOUT `err.receipt`: `provider.getTransactionReceipt(tx.hash)` (up to 3 tries, short delay injectable for tests); if it returns, settle from it.
5. Receipt still unknown (refetch returns null/throws): the reserved worst-case amount stays in the state as `kind: "unknown"` (it keeps counting for 24 h). Log it. Continue only if the failure was a revert-class error; for any other error type after a broadcast (hash known), also stop (see 6).
6. `wait` TIMEOUT (`err.code === "TIMEOUT"` or the timeout fired): keep the worst case counted (`kind: "unknown"`), log `STOP`, send nothing more this run, `result.aborted = true` (exit code 1 so `run-collector.sh` logs `base pass failed`).
7. If `sendTransaction` itself throws before a hash exists, the reservation is removed (nothing was broadcast) unless the error is ambiguous (timeout/ network error with no hash): treat ambiguous as broadcast-unknown (keep worst case, stop the run). A plain rejection (e.g. "nonce too low", `INSUFFICIENT_FUNDS`, "replacement underpriced" that returns an error response) removes the reservation and continues, as today.
A settle that cannot be saved stops the run (the budget can no longer be recorded).

### F5 (LOW) L1 data fee is accounted, not guessed
Base charges an L1 data fee on top of gas*price. Decision: READ it from the OP-stack `GasPriceOracle` predeploy `0x420000000000000000000000000000000000000F`, `function getL1Fee(bytes _data) view returns (uint256)`, called with the unsigned serialized transaction (`ethers.Transaction.from({...fields, nonce, signature absent}).unsignedSerialized`) of the exact tx about to be sent; nonce from `provider.getTransactionCount(operator, "pending")`. `l1FeeWei` = the oracle quote; `l1AllowanceWei = l1FeeWei * 2n` (the L1 base fee can move between quote and inclusion; the doubling is the pad). Oracle call fails / returns non-bigint -> skip that position, fail closed (`L1 fee unreadable`). This is a read-only call: the ABI list of this file grows by exactly this one fragment (`getL1Fee`), kept in a separate constant `ORACLE_ABI`; the `MANAGER_ABI` stays exactly 3 functions and the static scan is updated to assert both lists (3 + 1). Settled accounting (F4) adds `l1AllowanceWei` (conservative: counts 2x the quote even though the real L1 fee is usually below). Expected cost in `decide` adds `l1FeeWei` (1x).

### F6 (LOW) state.json fails closed and is written atomically
`readState(file)` returns `{ ok:true, state }` or `{ ok:false, reason, kind }`, in `collector-base-logic.js` or a small helper, pure of globals (fs injected for tests).
- File shape: `{ "version": 1, "gasSpends": [ { t:number(ms), wei:string(decimal), kind?, tx? } ] }`.
- Corrupt JSON, unreadable (EACCES etc.), wrong shape (`gasSpends` not an array, an entry with non-numeric `t`/`wei`, negative `wei`): `ok:false, kind:"corrupt"`. The corrupt file is left in place, NOT overwritten and not deleted. Effect in `collect` mode: the whole pass sends nothing (log `STATE UNREADABLE (<reason>): today's budget is treated as spent; no transaction sent` and, once, the path), `result.aborted = true`. In `simulate` mode the pass still prints decisions but adds the same state line and marks every would-collect as `(would be refused: state unreadable)`.
- MISSING file (`ENOENT`) decision: also refuses to send in `collect` mode (log `STATE MISSING <path>: refusing to send; create it once with: node collector-base.js --init-state`). Rationale: a deleted file would otherwise reset the budget to zero, and the pass cannot tell a first-ever run from a deletion. New CLI flag `--init-state` (no chain access, no keystore): creates `state.json` with `{version:1,gasSpends:[]}` atomically ONLY if absent (never overwrites; exits 0 and says "already exists" otherwise). `simulate` never creates it. README gets the one-time step and the warning "deleting state.json stops the pass sending until you re-create it, by design". (This is a deployment step for the operator after this commit; flagged in OPEN QUESTIONS as non-design-changing.)
- Atomic write: `writeFileAtomic(file, text)` = write `file + "." + process.pid + ".tmp"` in the same dir with `fs.writeFileSync(..., {mode:0o600})`, `fsync`, `fs.renameSync` over the target; on any error remove the tmp file and throw. The tmp file name never matches a tracked path. Pruning: entries older than 7 days are dropped on write (the 24 h window needs 1 day; keep margin); `unknown` entries older than 24 h are dropped with the rest.
- `saveState` failure before a send = no send (F4). All state writes use the atomic function.

### F7 `--mode` / CLI
`main()` wires: `readState`, `writeFileAtomic`, `provider.getBlock`, the oracle contract, `waitTimeoutSec`. `runPass` takes injectable `readState`/`saveState`, `sleep`, and `provider.getTransactionReceipt` so tests stay in-process. After decrypting the key in `getSigner`, `delete process.env.LP_KEYSTORE_PASS` (hygiene; documented as not clearing `/proc/<pid>/environ`).

### F8 settings and example
`settings.base.example.json` `baseCollect` gains `maxGasPerTxEth: 0.0002`, `maxGasLimit: 500000`, `maxPriorityFeeGwei: 0.01`, `waitTimeoutSec: 120`, and its `_comment` states: `maxGasPriceGwei` is a hard cap on the SIGNED `maxFeePerGas`, not just a refusal threshold. `L.limits()` defaults for each new key in `DEFAULTS`; the existing "example carries the defaults" assertion (`collector-base.test.js` l.120) is updated to the new full object. Ships `collect:false` everywhere.

### F9 README (Auto-collect on Base section)
Edit `README.md` only inside/next to that section and make these statements (each verifiable by `collector-base-readme.test.js` greps):
1. Where it runs: scheduled `run-collector.sh` AND the Collect button of the Robinhood dashboard (`POST /api/collect` -> `run-collector.sh collect|full`, `server.js` `startCollectRun`); the Base dashboard has no such button (403). The Base pass runs only after `collector.js` exits 0 in collect mode (the script is `set -e`), is skipped when the lock is held, when locked/`--quiet` skips, and when `LP_DATA_DIR` is set in the environment (e.g. `run-collector-arc.sh`). In `simulate` mode the Base pass runs even if the Robinhood simulate failed.
2. Gas accounting, precisely: signed `maxFeePerGas = min(maxGasPriceGwei, 2*baseFee + tip)`, never above `maxGasPriceGwei`; tip `<= maxPriorityFeeGwei`; `gasLimit = min(1.25 x estimate, maxGasLimit)`, estimates above `maxGasLimit` are skipped; caps (`maxGasPerTxEth`, `maxGasPerRunEth`, `dailyGasCapEth`) are checked against `gasLimit x maxFeePerGas + 2 x L1 fee quote` before each send; a reservation of that worst case is written to `state.json` before broadcast and replaced by `gasUsed x effective gas price + 2 x L1 quote` after the receipt (reverted transactions included); an unknown outcome or a confirmation timeout keeps the worst case counted for 24 h and stops the run.
3. `state.json`: corrupt or unreadable = budget treated as spent, nothing sent; missing = nothing sent until `--init-state`.
4. The `setApprovalForAll` risk paragraph extended: the approval covers every Aerodrome NFT the wallet holds now AND any NFT it receives later on that manager (it is blanket, not a list); revoke on EVERY manager the operator was ever approved on: the two Aerodrome managers named above and, if the same operator EOA was ever approved on Base's Uniswap v3 NonfungiblePositionManager `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` or v4 PositionManager `0x7C5f5A4bBd8fD63184577525326123B519429bDc`, those too (verify each with `isApprovedForAll(owner, operator)` on its Read tab; all four must read `false` after revocation).
5. `LP_KEYSTORE_PASS`: `run-collector.sh` passes it as an environment prefix to the node process, so it is in that process's initial environment (`/proc/<pid>/environ`, same user and root), in addition to the `/dev/shm` cache; this is the same exposure as the Robinhood collector; `collector-base.js` unsets it from its own `process.env` after decrypting (hygiene only).
The existing exact-strings checks (manager addresses, `setApprovalForAll`, "Auto-collect on Base", `isApprovedForAll`, "transfer", "every") keep passing.

## Constraints
No new dependency; `collector-base.js` still contains none of `swap|exactInput|approve(|setApprovalForAll|transfer|safeTransfer|decreaseLiquidity|burn|withdraw|deposit|exactOutput|Router|Quoter` (the new `getL1Fee`/`getTransactionReceipt` words do not trip the scan; do not use the word "transfer" in code or comments of that file; note the existing scan covers comments too, check it). No network in tests. Not allowed: reading a real keystore, calling a real RPC.

## Acceptance tests (Task 3-FIX)
Run: `node test/run-all.js collector-base` for 1-16, then full suite. New files: `test/collector-base-fees.test.js` (fee/limit/L1/revert tests), `test/collector-base-state.test.js` (state tests); extend `collector-base-logic.test.js`, `collector-base.test.js`, `collector-base-readme.test.js`; additive handlers in `mock-chain.js` (`getBlock`, `getTransactionCount`, `getTransactionReceipt`, GasPriceOracle `getL1Fee`).

Malicious RPC (HIGH):
1. `buildFees` table: base fee 0.005 gwei, tip hint 1 gwei, cap 1 gwei, `maxPriorityFeeGwei 0.01` -> `maxFee == 2*base+tip <= cap`, `tip == 0.01 gwei` (clamped), `tip <= maxFee`. Hint absent -> tip 0.001 gwei, never 1 gwei, never 0.
2. A mocked RPC returning `feeData = { maxFeePerGas: 10^18, maxPriorityFeePerGas: 10^18, gasPrice: 10^18 }` and a normal block base fee: the transaction passed to the signer has `maxFeePerGas <= 1 gwei`, `maxPriorityFeePerGas <= 0.01 gwei`, `type === 2`, no `gasPrice` key; the raw tx signed by the throwaway key (as `fakeSigner` does) decodes with those values.
3. Same RPC returning a huge `baseFeePerGas` (e.g. 5 gwei with cap 1 gwei): zero `sendTransaction` calls, log contains `exceeds maxGasPriceGwei` and names base fee and cap; also when `baseFee + tip > cap` by a hair. `baseFeePerGas` missing/0/non-bigint: refused, nothing sent.
4. `estimateGas` returning 10^9 (and 600000 with ceiling 500000): zero sends, log `exceeds maxGasLimit`; estimate 300000 -> `gasLimit == 375000`; estimate 450000 -> `gasLimit == 500000` (min with ceiling).
5. Caps use the worst case: scene where `gasLimit x maxFee + l1Allowance` just exceeds `maxGasPerTxEth` -> skip naming `maxGasPerTxEth`; just under -> send. Same boundary tests for `maxGasPerRunEth` (second send blocked because spent + worst case > cap) and `dailyGasCapEth` (state holding 24 h spend). A tx whose old-style estimate fit but whose worst case does not is refused (regression for the old `min(gasPrice,maxFee)` rule).
6. `assertSignable` throws for each violated invariant (type 1/0, gasPrice present, `maxFee > cap`, `tip > maxFee`, `gasLimit > ceiling`, `to` not an allowlisted manager, `value != 0`), and the pass logs the error and sends nothing (injected by a test that bypasses `buildFees`).

L1 fee:
7. Mock oracle `getL1Fee` returning X: the reservation in state, the per-tx cap check and the settled amount each include `2*X` (assert numbers); `decide` expected cost includes `1*X`; oracle revert/garbage -> skip with `L1 fee unreadable`, zero sends. Static: `getL1Fee` is called on `0x420000000000000000000000000000000000000F` only (spy on `w.calls`); `MANAGER_ABI` still has exactly 3 functions, `ORACLE_ABI` exactly 1.

Revert and wait (MEDIUM):
8. Fake signer whose `wait()` throws `{ code:"CALL_EXCEPTION", receipt:{ gasUsed:120000n, gasPrice:50_000_000n, status:0 } }`: state ends with a settled entry equal to `120000 x 50_000_000 + 2 x L1` (not zero), the run continues to the next position if caps allow, log says `reverted on-chain`.
9. `wait()` throws `CALL_EXCEPTION` with no receipt, mock `getTransactionReceipt(hash)` returns a receipt on the 2nd try: settled from it (assert call count 2, injected sleep, no real delay).
10. `wait()` throws with no receipt and `getTransactionReceipt` returns null 3 times (or throws): state entry is `kind:"unknown"` with `wei == worstCaseWei`; counted by `gasSpentLast24h`.
11. `wait` never resolves (injected promise that never settles, `waitTimeoutSec` shrunk to a few ms or an injected timer): worst case stays counted (`kind:"unknown"`), log has `STOP`, a second qualifying position is NOT sent, `result.aborted === true`.
12. `sendTransaction` rejects with a plain error and no hash: reservation removed, state unchanged, run continues (old behaviour); rejects with an ambiguous timeout: worst case kept, run stops.
13. Crash safety: after the reservation is saved and before `wait` returns, the on-disk `state.json` already contains the worst-case entry (test reads the file through the real atomic writer in a temp dir).

State (LOW):
14. Corrupt `state.json` (truncated JSON, `[]`, `{"gasSpends":"x"}`, entry with `wei:"abc"` or negative, unreadable via a directory in its place / chmod 000 when not root): collect mode sends nothing, logs `STATE UNREADABLE`, `aborted === true`, the file bytes are unchanged after the run; simulate mode prints decisions plus the state line and sends nothing.
15. Missing `state.json`: collect mode sends nothing, logs `STATE MISSING` with the `--init-state` hint, no file is created by the run. `node collector-base.js --init-state` (spawned with `LP_DATA_DIR` temp dir, hermetic env, no network preload violations) creates it with `{"version":1,"gasSpends":[]}`; a second call leaves bytes and mtime unchanged and prints `already exists`; with the fresh file a normal in-process run can send.
16. Atomic write: with `fs.renameSync` stubbed to throw, the target file is byte-identical to before and the tmp file is removed; the writer uses a tmp in the same directory and `rename` (spy asserts the call order write -> fsync -> rename); no `*.tmp` is left after a successful write; file mode is 0600.

Docs, config, regression:
17. `collector-base-readme.test.js` greps pass for every statement in F9 (strings: `POST /api/collect`, `Collect button`, `exit`, `LP_DATA_DIR`, `maxGasLimit`, `maxFeePerGas`, `getL1Fee` or `L1`, `state.json`, `--init-state`, `/proc/`, `LP_KEYSTORE_PASS`, `0x7C5f5A4bBd8fD63184577525326123B519429bDc`, `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1`, `later`).
18. `settings.base.example.json` parses, `collect:false` everywhere, new keys present with the stated defaults; `L.limits(undefined)` equals the full default object; `settings.test.js` and `base-instance.test.js` (including the static no-signing scan for server files) pass.
19. `node test/collector-golden.test.js` passes with `test/fixtures/collector-golden/*` unmodified; `git diff fc3b8f9 -- collector.js collector-logic.js collector-swap.js collect-v4.js treasury.js run-collector.sh` prints nothing.
20. Static: `collector-base.js` forbidden-token scan passes; it contains no `gasPrice:` key in an object passed to `sendTransaction`.
21. `bash -n run-collector.sh` passes; `node test/run-all.js` and `npx eslint .` pass (G8); `git check-ignore` (G1) done before the commit.

---

# TASK B: find the six Uniswap v4 positions of Trading on Base, pin them, and warn when discovery is incomplete

Commit message: `base: pinned v4 ids per wallet, ownerOf-verified, and a visible warning when v4 discovery is incomplete`.

## Goal
Trading (`0xaDf94A20558E1E6d64c429F8F9f017169BF3d743`) holds 6 Uniswap v4 NFTs on Base (`balanceOf` on the v4 PositionManager `0x7C5f5A4bBd8fD63184577525326123B519429bDc` = 6) but `~/base-data/v4-positions.json` has `ids: []`, `complete:false`, because Blockscout answers 402/403 and the backwards log scan is slow. The dashboard must show those positions (via pinned ids, ownerOf-verified) and must say so out loud, on `/api/positions` and in the Base page, whenever v4 discovery is incomplete or the wallet owns more v4 NFTs than are known.

## Scope
IN: `univ4.js` (pinned ids, `balanceOf` read, pure warning helper), `watch.js` (per-wallet pins, per-wallet warnings), `server.js` (main-wallet pins, `warnings` in the `/api/positions` payload, balance check), `settings.js` (carry `v4Ids` through load/legacy/save), `settings.base.example.json`, `dashboard.js` (banner), `README.md` (short Base v4 pinning/warnings paragraph), tests, the one-time id discovery (below).
OUT: any write to `~/base-data`; editing the live `settings.json`; signing; changing v3/Slipstream discovery; changing `collector.js`; Blockscout key handling.

## Existing code to reuse
`univ4.createDiscovery` (+ `status`, `verifyGone`, `forget`), `univ4.loadPosition` (does the `ownerOf` check: a token not owned by the configured owner comes back `gone`), `watch.discoveryFor/loadWallet`, `server.js` `buildPositions` l.1632-1654, `settings.js` wallet handling, `dashboard.js` `#errors` rendering (l.2183-2186) and `walletIssues` (l.3804), test patterns in `test/v4-discovery.test.js` (fake provider, temp `LP_DATA_DIR`), `test/base-instance.test.js` + `stub-base-network.js` for HTTP-level checks.

## B1. One-time id discovery (read-only, by the implementer, not committed)
- In the scratchpad / a temp dir OUTSIDE the repo, write a throwaway script that: reads `balanceOf(Trading)` on the v4 PositionManager; scans ERC-721 `Transfer(address,address,uint256)` logs on that manager with `topics[2] = Trading` in the chunk size a public Base RPC allows (try `https://base-rpc.publicnode.com`, `https://mainnet.base.org` for eth_call; halve the range on refusal; start from the manager's deploy block, found by `eth_getCode` bisection or the Uniswap v4 Base deployment record, not from `historyStartBlock`), unions the ids, then confirms `ownerOf(id) == Trading` for each. If publicnode's history is too short, use another public archive RPC read-only; never a keyed endpoint copied from `.env`.
- Stop when the confirmed set has exactly `balanceOf` ids (6). If the scan cannot reach 6, report which are missing and why (do not guess ids).
- Then compute pair names and USD values by running a dev instance (G6) with a temp `--data-dir` holding a copy of `settings.base.example.json` plus `wallets.main.v4Ids` (the new field) on an ephemeral port, `LP_READONLY=1 --no-loops --no-services`, public RPC; `GET /api/positions` once; stop only that PID.
- The script is NOT committed unless it is cleaned into `tools/find-v4-ids.js` (optional; if committed it must be read-only, take `--owner`, `--manager`, `--rpc`, print ids, pass `collector-scope` and eslint, and have a mocked unit test). Default: not committed.
- Report to the caller (in the final message, not in a repo file, no secrets): the 6 token ids, for each the pool pair, fee tier, in-range, `valueUsd`, `feesUsd`, and the sum.

## B2. Pinned v4 ids per wallet (schema)
No pin mechanism exists for v4, so add one. Exact schema in the Base settings:
```
"wallets": {
  "main":    { "address": "0x...", "label": "Trading", "collect": false, "v4Ids": [123, 456] },
  "watched": [ { "address": "0x...", "label": "Wallet 11", "collect": false, "v4Ids": [] } ]
}
```
- `v4Ids`: optional array of token ids, each a JS safe integer or a decimal string (`/^[0-9]{1,78}$/`), at most 200 per wallet, duplicates collapsed; invalid entries are ignored AND reported in the warning list (code `v4-pinned-invalid`). Ids are per wallet (a v4 NFT id is only meaningful for the wallet that owns it). Absent = no pins (existing behaviour).
- `settings.js`: `wallets.main.v4Ids` -> `cfg.ownerV4Ids` (array of strings, `[]` default); watched entries keep `v4Ids` through `load -> toLegacy -> fromLegacy/save` (extend the `pick` whitelist at l.222-223 and the main object); existing round-trip assertions unchanged.
- `univ4.createDiscovery({..., pinnedIds})` plus method `setPinned(ids)` (settings are re-read per refresh in `watch.js`). `discover()` returns the union `state.ids ∪ pinned` (strings, no duplicates). Pinned ids are NOT written into `state.ids` / the state file (removing a pin removes the position; the persisted scan state is unchanged). `status` gains `pinned: <count>`.
- Verification: pinned ids go through the normal `loadPosition` path, so `ownerOf(id)` must equal the wallet. A pinned id that comes back `gone`, or whose `ownerOf` is another address, is NOT shown as a position, is NOT tombstoned (do not call `forget` for pinned ids), and produces a warning entry (code `v4-pinned-not-owned`, with the id). A pinned id whose read fails transiently (RPC error) is reported in `errors` like any unreadable position and stays pinned.
- `server.js` passes `pinnedIds: cfg.ownerV4Ids` to the main wallet's `createDiscovery`; `watch.js` `readWallets` carries `v4Ids` per watched wallet and `discoveryFor(address)` applies them (`setPinned` on every `loadWallet`).
- `settings.base.example.json`: add `"v4Ids": []` to `wallets.main` and to each watched wallet, and extend `wallets._comment` ("v4Ids: Uniswap v4 token ids pinned for this wallet, verified with ownerOf on every refresh; use when position discovery is incomplete (Blockscout refused, log scan slow)"). Test `base-instance`/`settings` assertions that list keys are updated.

## B3. Warning contract
Source of truth, `univ4.js` ~l.577-597: an unfinished scan must never read as "no positions"; `status.complete === false` means history is unread. New:
- `discovery.balance()` -> `Promise<bigint|null>`: `balanceOf(owner)` on the position manager (add `"function balanceOf(address owner) view returns (uint256)"` to `POSM_ABI`); `null` on any failure (never throws).
- Pure helper `univ4.discoveryWarnings({ wallet, label, chainId, status, balanceOf, knownOwned, pinnedInvalid, pinnedNotOwned })` -> array (empty = no warning). `knownOwned` = number of distinct ids for this wallet that were loaded and verified `ownerOf == wallet` in this build (open or closed, i.e. not `gone`).
- JSON shape of each element (all fields always present, `null` when not applicable):
```
{ "code": "v4-discovery-incomplete" | "v4-balance-exceeds-known" | "v4-pinned-not-owned" | "v4-pinned-invalid",
  "severity": "warn" | "info",
  "scope": "uniswap-v4",
  "chainId": 8453,
  "wallet": "0x...",            // checksummed
  "label": "Trading" | null,
  "complete": false,            // discovery.status.complete
  "error": "string"|null,       // discovery.status.error (escaped by the UI, trimmed to 200 chars)
  "scannedFrom": 123|null,
  "known": 6,                   // knownOwned
  "pinned": 6,                  // status.pinned
  "balanceOf": 6|null,          // number (safe) or null when unreadable
  "missing": 0|n|null,          // max(0, balanceOf - known) when balanceOf is known, else null
  "ids": ["..."]|null,          // only for the two pinned codes
  "message": "human sentence ending without secrets" }
```
- Rules (`knownOwned` vs `balanceOf` = B, `status.complete` = C):
  - C false and (B unknown OR B > knownOwned): `v4-discovery-incomplete`, severity `warn`, message "Uniswap v4 position discovery is not complete for <label>: positions it has not reached are not listed (<n> known, <B or unknown> held on-chain)". 
  - C false and B == knownOwned (all holdings are accounted for by pins/verified ids): `v4-discovery-incomplete`, severity `info`, message says the count matches on-chain balance so nothing is missing right now, but new NFTs would only appear once discovery completes or they are pinned.
  - B > knownOwned regardless of C: `v4-balance-exceeds-known`, severity `warn`, `missing = B - knownOwned`, message "<label> holds <B> Uniswap v4 NFTs on-chain but only <known> are known: <missing> not shown. Pin their ids in settings (wallets.main.v4Ids)". When both this and incomplete(warn) apply, emit both (the page de-duplicates visually by showing both lines).
  - C true and B == knownOwned (or B <= knownOwned): NO warning for that code (`[]`).
  - `v4-pinned-not-owned` / `v4-pinned-invalid` severity `warn`, `ids` lists them.
- Where it is exposed:
  - `GET /api/positions` payload gets a new top-level field `warnings: [...]` (always present, `[]` when none) for the MAIN wallet (the chain's `cfg.ownerAddress`), computed in `buildPositions` after the v4 loop (it has `knownOwned`), using `await V4.discovery.balance()`. Cache behaviour unchanged. On a chain without `cfg.contracts.v4` (PulseChain), `warnings: []`.
  - `GET /api/watch` wallets: each wallet object gets `warnings: [...]` from `watch.js` `loadWallet` (same helper, `discovery` field stays as is).
  - The older `notes`/`errors` fields are unchanged.
- UI (Base dashboard, same `dashboard.js` for every chain):
  - Main wallet: in the `#errors` block (l.2183), BEFORE the faint notes, render one banner per `warn` entry: `<div class="warn" role="alert"><b>Uniswap v4:</b> ${esc(message)}</div>` reusing the style of the existing unapproved-positions banner (same class that block uses; verify the class name in the code, add no new CSS file); `info` entries render as a muted line like `notes`. Banners are not dismissible and are re-rendered on every poll. Text is `esc()`d; `error` is shown only inside the message after `esc`.
  - Watched wallets: `walletIssues` (l.3804) shows the same banner markup for that wallet's `warnings`.
  - No `warnings` (empty) -> nothing is added; the DOM has no empty container.

## Constraints
No signing, no tx, no network in tests. `ownerOf` verification of pinned ids is mandatory (a wrong pin must not display another wallet's NFT). Pinned ids never reach the persisted discovery state. Base server stays `LP_READONLY=1`. `discoveryWarnings` is pure and has no `fs`/network access.

## Acceptance tests (Task B)
New files: `test/v4-pinned.test.js` (B2), `test/v4-warnings.test.js` (B3 helper + HTTP). Extend `test/settings.test.js`, `test/v4-discovery.test.js` (only additions), `test/base-instance.test.js` as needed. Run `node test/run-all.js v4` then the full suite.
1. Pinned used: `createDiscovery` over a fake provider whose log scan returns nothing and whose state says `ids: [], complete:false`, with `pinnedIds: [11, "22", 11]` -> `discover()` returns exactly `["11","22"]`; the state file on disk still has `ids: []` (pins not persisted); `status.pinned === 2`; `setPinned([])` removes them on the next call.
2. Pin is ownerOf-verified: a mocked posm where id 11 is owned by the wallet and id 22 by someone else: the built payload (HTTP-level on the Base example with `stub-base-network` or `buildPositions` via the existing test harness) lists #11 only, `warnings` contains `v4-pinned-not-owned` with `ids:["22"]`, id 22 is not in the persisted tombstones (`discovery.tombstones` empty).
3. Invalid pins (`-1`, `"abc"`, `1e3`, 201 entries) are ignored without throwing; `v4-pinned-invalid` lists them.
4. `settings.js`: `wallets.main.v4Ids` and `wallets.watched[].v4Ids` survive `load -> toLegacy -> fromLegacy/save` (deepStrictEqual); absent -> `ownerV4Ids === []`; the Base example still has no `collector/vault/arm/risk` keys; `settings.base.example.json` parses and carries `"v4Ids": []`.
5. Warning when incomplete (helper): `status.complete=false`, `balanceOf=6`, `knownOwned=0` -> two warnings: `v4-discovery-incomplete` (warn) and `v4-balance-exceeds-known` (warn, `missing: 6`); `balanceOf=null`, `complete=false` -> `v4-discovery-incomplete` (warn, `balanceOf: null`, `missing: null`).
6. Warning when `balanceOf` exceeds known with `complete=true`: `balanceOf=6`, `knownOwned=5` -> exactly one `v4-balance-exceeds-known`, `missing: 1`.
7. No warning when complete and matched: `complete=true`, `balanceOf=6`, `knownOwned=6` -> `[]`; also `complete=true`, `balanceOf=0`, `knownOwned=0` -> `[]`; `complete=true`, `balanceOf=null` -> `[]` (unreadable balance on a complete scan is not a warning).
8. Incomplete but all accounted for (the live case after pinning): `complete=false`, `balanceOf=6`, `knownOwned=6` -> one `v4-discovery-incomplete` with `severity:"info"` and no `warn` entry.
9. Shape: every emitted element has exactly the keys listed in the contract (assert with `Object.keys` sorted), `chainId` is 8453 for the Base example, `wallet` is checksummed, `message` is a string without newline, `error` truncated to 200 chars.
10. HTTP-level: spawn the Base example server (hermetic env, `LP_READONLY=1`, `--no-loops --no-services`, port 0 or `freePort()`, `stub-base-network.js` plus a mock where the v4 manager answers `balanceOf = 6`, and a discovery state with `ids: [], complete:false`): `GET /api/positions` returns `warnings` as an array containing the `v4-discovery-incomplete` and `v4-balance-exceeds-known` elements above; with the same mock plus 6 pinned ids that are owned: `warnings` contains only the `info` incomplete element and `positions` includes the 6 v4 cards (`version: 4`); with a complete state and 6 ids: `warnings` is `[]`. The server is stopped by PID; the port is not one of the live ports.
11. `GET /api/watch` includes `warnings` per wallet (same helper); a watched wallet with an incomplete scan has the entry.
12. UI (same vm/function-injection technique as `test/claim-fees-ui.test.js` / hygiene-paths section 6): rendering a payload with the two warn entries puts two `.warn` banners with `role="alert"` into `#errors` BEFORE the notes; hostile `message`/`error` (`<img src=x onerror=1>`) renders escaped (no raw `<img`); an `info` entry renders as a muted line, not a banner; empty `warnings` adds nothing; watched-wallet `walletIssues` renders banners for that wallet's `warnings`.
13. Regression: v3 and Slipstream tests unchanged and passing (`base-slipstream.test.js`, `v4-discovery*.test.js`, `ledger-v4.test.js`, `sell-v4.test.js`); `discover()` return value without pins is byte-identical to before.
14. G7 holds: `git diff fc3b8f9 -- collector.js collector-logic.js collector-swap.js collect-v4.js treasury.js run-collector.sh` prints nothing; `node test/collector-golden.test.js` passes unmodified.
15. Manual (not automated, no tx, results in the final report): the B1 script found exactly `balanceOf` ids and each `ownerOf == Trading`; a dev instance on an ephemeral port with the ids pinned in a temp data dir returns those positions with `warnings` containing only the `info` entry (or `[]` if discovery completed); the instance was stopped; `~/base-data` and `/home/loko/uniswap-collector` were not modified (state in the report: `git status` of the repo clean of stray files; no write attempted).
16. `node test/run-all.js` and `npx eslint .` pass (G8); `git check-ignore` (G1) done before the commit.

## Deliverable for the report: the settings snippet for the live operator (we do not edit it)
The implementer fills in the six ids found in B1 and prints exactly this block for `$HOME/base-data/settings.json`, merged into the existing `wallets.main` (keep the existing `address`, `label`, `collect`):
```
"wallets": {
  "main": {
    "address": "0xaDf94A20558E1E6d64c429F8F9f017169BF3d743",
    "label": "Trading",
    "collect": false,
    "v4Ids": [ <id1>, <id2>, <id3>, <id4>, <id5>, <id6> ]
  }
}
```
Plus the note: restart only the Base dashboard (port 8796) by the operator's own usual method after editing; settings are re-read on refresh for pins, but the first load of the new field needs the new code deployed from this commit. Also remind: for Task 3-FIX the operator must run `node collector-base.js --init-state` once (with `LP_DATA_DIR=$HOME/base-data`) before the next scheduled collect, otherwise the pass refuses to send.

---

# OPEN QUESTIONS

## Design-changing
None blocking. The two decisions closest to design-changing, stated and assumed:
D1. (3-FIX) Missing `state.json` = refuse to send until `--init-state`. If the user prefers "first run creates it", the pass cannot distinguish a deletion from a first run, so it would reset the budget on deletion; assumed refuse. Changing this changes acceptance tests 14-15 only.
D2. (3-FIX) L1 fee is read from the GasPriceOracle and padded x2 (not a flat pad). If the oracle predeploy address ever changes the pass fails closed (skips), it never sends blind.

## Non-design-changing (assumptions, retune freely)
A1. New defaults: `maxPriorityFeeGwei 0.01`, `maxGasLimit 500000`, `maxGasPerTxEth 0.0002`, `waitTimeoutSec 120`, `maxFeePerGas = min(maxGasPriceGwei, 2*baseFee + tip)`.
A2. Settled gas counts `2 x L1 quote` (conservative over-count) rather than the exact L1 fee from the receipt (ethers 6 does not parse the OP-stack `l1Fee` receipt field).
A3. The operator must run `--init-state` once after deploying commit 1; documented in the README and the final report.
A4. README item 4 interprets "BOTH managers (v3 NPM and v4 PositionManager)" as: revoke on the two Aerodrome managers the pass uses and on Base's Uniswap v3 NPM and v4 PositionManager if the operator EOA was ever approved there; verify all four read `false`. If only two addresses were meant, the extra two are harmless.
A5. (B) A wallet with `complete:false` but `balanceOf == known` gets an `info` entry rather than a `warn`, so the permanent `complete:false` on the live Base data does not show a red banner once the six ids are pinned; any shortfall or unreadable balance still yields `warn`.
A6. (B) Pins are per wallet (`wallets.main.v4Ids`, `wallets.watched[].v4Ids`), not under `contracts.v4`, because discovery state is per wallet.
A7. (B) The id-finding script is not committed by default.
A8. (B) `knownOwned` counts closed (zero-liquidity, not burned) NFTs too, because ERC-721 `balanceOf` counts them.

---

# HISTORY (previous round, condensed)

Base HEAD `980b6e5` at that time; four tasks, four commits:
1. Hermetic tests: `test/lib/tracked-files.js` (hygiene walk uses `git ls-files`), `test/lib/hermetic.js` (`hermeticEnv`, `hermeticCwd`, `PRELOAD`), `test/fixtures/no-network.js`, `test/hermetic-audit.test.js` (any test that spawns `server.js`/`chain-router.js` must use the helper).
2. "Claim fees" button on Base Slipstream cards, signed in the browser wallet (Rabby): `claim-fees-core.js`, `claim-fees.js`, `claim-fees-target.js`, route `GET /api/claim-fees/target`; the Base server never signs.
3. Opt-in daily Base fee collect (`collector-base.js`, `collector-base-logic.js`, hook at the end of `run-collector.sh`, `wallets.main.collect`, `baseCollect`, commit `2952263`): collect only, recipient = NFT owner, `isApprovedForAll` required, two Aerodrome managers allowlisted. Answers adopted: signing on Base is allowed only in `collector-base.js` (the Base SERVER stays `LP_READONLY=1`), the pass is appended to `run-collector.sh` (shared flock and unlock window), the main wallet is enabled via `wallets.main.collect`, same operator EOA on every chain. Superseded in part by TASK 3-FIX above.
4. Investigation of Base `totals.feesUsd` about 36.59 (`FINDING-task4.md`, H1 legitimate v4 fees was the leading hypothesis).
Earlier still: smoke.js fail-fast, npm audit fix, Base / PulseChain read-only instances.
