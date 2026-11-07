# SPEC (round 4): open Low items, user-approved. TASK L1 (Base auto-collect, self-healing) and TASK L2 (v4 pinning leftovers)

Project: `/mnt/c/Swarm-Projects/projects/lp-dashboard` (DEV repo), local `master`, base HEAD `8db9320` (contains f0c24ab auto-collect fix and e521641 v4 pinning). Source: REPORT.md "Left to do". Rounds 1-3 are implemented; their task bodies were removed from this file (retrieve with `git show 8db9320:SPEC.md` if the file was committed there, else `git log -p -- SPEC.md`). The global constraints G1-G10 are kept below and apply to both tasks.

Two commits, in this order: commit A = TASK L1, commit B = TASK L2. The implementer commits SPEC.md together with each task (the spec-writer does not commit). Each commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

Facts verified at 8db9320 (the implementer re-checks line numbers):
- `collector-base.js` `runPass`: run-start settlement (l.132-143) only handles `kind:"unknown"` entries that have a `tx`, calls `BigInt(e.gasLimit)` etc. on unvalidated state (a bad field throws a raw TypeError/SyntaxError), and accepts any receipt (no hash/from/to/block/gasUsed-range check). The send is `signer.sendTransaction(txFields)` (l.292): the hash is unknown until it returns, so a throw leaves an entry with `tx:null` that never settles (`keepUnknown`, l.275-280); because `spentWindowWei` counts `unknown` at any age, it can block collection until `state.json` is hand-edited. After the reservation (l.267-274) a failed `persist("transaction hash")` (l.302) or `persist("unknown outcome")` (l.278) is ignored. `entry.tx = tx.hash` is used without checking a hash exists. The nonce is only used for the L1 quote (`getTransactionCount(operator,"pending")`, l.227), is not in `txFields`, and is not recorded. A crashed-run `reserved` entry counts in `spentWindowWei` only while `t` is within 24 h (only `kind==="unknown"` is age-exempt).
- `collector-base-logic.js`: `readState` (l.242-259) validates only `t` and `wei`; `assertSignable` (l.140-161) accepts ANY allowlisted manager for `to`; `settledWei` (l.173) clamps price and gasUsed against the signed gasLimit/maxFee; `spentWindowWei` (l.185); `l1Allowance = max(2 x quote, minL1AllowanceEth)` (l.164); `serializeState` keeps `unknown` at any age and everything else 7 days.
- README "Auto-collect on Base" (l.676-755) states the worst case as `gasLimit x maxFeePerGas + 2 x L1 fee quote` (l.705, table row l.747) and the settled amount as `gasUsed x effective gas price + 2 x L1 quote` (l.707). Wrong: the code uses `max(2 x quote, minL1AllowanceEth)`. l.717-722 tell the operator to hand-edit `state.json`; that text must go.
- v4 (e521641): `server.js` l.1620-1641 builds `deny = Set(cfg.denylist)` and `v4Denied = v4All.length - v4Ids.length`; l.1846-1847 subtract `min(balanceOf, v4Denied)` from `balanceOf` although a denied id is never loaded, so a denied id that is NOT owned by the wallet makes a genuinely missing NFT vanish from the count. `server.js` l.1662-1664 and `watch.js` l.349-352: for a pinned id that comes back `gone`, `forget` is skipped, so an id that is both pinned AND in discovery's `ids` is never tombstoned (re-loaded and re-reported every refresh; still in `ids` after the pin is removed). `watch.js` l.467 returns `discovery` (raw `disc.status`, `error` unredacted) in each `/api/watch` wallet, while `warnings` get a redacted copy (l.425). `univ4.js` `reason()` (l.580) redacts before `slice(0,200)`; `discoveryWarnings` (l.460) slices to 200 after `oneLine`, relying on callers having redacted first.
- Test files to extend: `test/collector-base.test.js` (`scene()`, `fakeSigner()`, `pass()`; `fakeSigner` currently exposes `sendTransaction`, `sent`, `failFirst`, `status`), `collector-base-fees.test.js`, `collector-base-state.test.js`, `collector-base-logic.test.js`, `collector-base-readme.test.js`, `v4-pinned.test.js`, `v4-warnings.test.js`, `v4-discovery.test.js` (additions only), `test/fixtures/mock-chain.js` (additive handlers only), `collector-golden.test.js`.

---

## GLOBAL CONSTRAINTS (both tasks; carried over from round 3)

G1. One commit per task, in order. Before EACH commit run `git check-ignore -v .env .env.local settings.json` (all three must print a rule) and `git status --short` must show no `.env*`, `settings.json`, keystore, `*.log`, `state.json`. `git add` named files only.
G2. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
G3. Never push, never add a remote.
G4. Never touch the live install `/home/loko/uniswap-collector` (no read, write, run). `~/base-data` is not to be written, and not read either in this round (no task needs it). Never read `/dev/shm`. Never decrypt a real keystore (tests use a throwaway `ethers.Wallet.createRandom()` key). Never read real `.env` contents. No secret in code, tests or this file.
G5. No real transaction, ever; no network from the test suite. Tests use `mock-chain.js` / fake providers / fake signers, `test/fixtures/no-network.js`, and `test/lib/hermetic.js` for every spawn.
G6. Never kill processes by name pattern. Kill only PIDs you started. Live services on ports 8787, 8788, 8790, 8791, 8796, 8797, 8800, 3847 stay untouched. Any test server uses port 0 / an ephemeral port and is stopped before the task ends; nothing is left running in the background. Never run `start-all.sh`, `stop-all.sh`, `restart-dashboard.sh`.
G7. `collector.js` stays BYTE-FOR-BYTE unchanged, also `collector-logic.js`, `collector-swap.js`, `collect-v4.js`, `treasury.js`, `slipstream.js`, `run-collector.sh`. `test/collector-golden.test.js` stays and passes unmodified (`fixtures/collector-golden/*` untouched). `git diff 8db9320 -- collector.js collector-logic.js collector-swap.js collect-v4.js treasury.js run-collector.sh` is empty at both commits.
G8. At the end of EACH task: `node test/run-all.js` (all, ~85 s; not `npm test -- <filter>`) and `npx eslint .` pass. `test/smoke.js` is the one expected failure on this dev copy (no `settings.json`) and must fail only for that reason. New `.js` files pass `test/collector-scope.test.js` and `eslint.config.js`; every spawning test uses `test/lib/hermetic.js` (`test/hermetic-audit.test.js`).
G9. All text interpolated into HTML goes through `esc()`; no new unescaped `innerHTML`.
G10. No new dependency.

---

# TASK L1: Base auto-collect fails closed AND heals itself

Commit message: `base: collect pass signs before recording, settles every entry by nonce and receipt, validates state strictly`.

## Goal
Collection must never need a manual `state.json` edit. Every transaction the pass can broadcast is signed first and recorded (hash and nonce) on disk before it is broadcast; every recorded entry is settled at the next run start from the chain (receipt, or by nonce); anything that cannot be proven keeps the conservative worst case; bad state fails closed with a one-line message, never a stack.

## Scope
IN: `collector-base.js`, `collector-base-logic.js`, `README.md` (Auto-collect on Base section only), tests, additive handlers in `test/fixtures/mock-chain.js` (`broadcastTransaction`, `getTransactionCount` "latest" vs "pending"). OUT: `settings.js`, `settings.base.example.json` (no new settings keys), `server.js`, the Base server, `run-collector.sh` and every file in G7, the shipped `collect:false`.

## Existing code to reuse
`runPass`, `settledWei`, `spentWindowWei`, `readState`/`serializeState`/`writeFileAtomic`/`initStateFile`, `assertSignable`, `l1Allowance`, `withTimeout`, `isTimeout`/`isRevertClass`, the REFETCH loop, and the test helpers `scene()/fakeSigner()/pass()`.

## Constraints
No new dependency, no network in tests. The static scan of `collector-base.js` for `swap|exactInput|approve(|setApprovalForAll|transfer|safeTransfer|decreaseLiquidity|burn|withdraw|deposit|exactOutput|Router|Quoter` (comments included) keeps passing: do not write the word "transfer" or the others in code or comments. `MANAGER_ABI` stays 3 functions, `ORACLE_ABI` 1. Only `signTransaction` + `broadcastTransaction` carry a transaction out. Each refusal is ONE log line; where the run stops, `result.aborted = true` (exit code 1 through the existing path).

## Design (implementer follows; deviations need the orchestrator)

**L1-1 Sign first, record, then broadcast.** `txFields` gets an explicit `nonce` = the `getTransactionCount(operator,"pending")` value already read for the L1 quote (so the quoted unsigned bytes equal the signed ones). Order per send: `assertSignable` (incl. nonce and exact manager, see below) -> `raw = await signer.signTransaction(txFields)` -> parse with `ethers.Transaction.from(raw)` and require `from == operator`, `to == manager`, and `nonce`, `gasLimit`, `maxFeePerGas`, `maxPriorityFeePerGas`, `value 0n`, `data`, `chainId`, type 2 all equal to what was asked (mismatch: nothing recorded, nothing broadcast, one log line, skip this position, continue) -> `hash` = the hash of that parse (never taken from an RPC) -> reserve: push `{ t, wei: worstCase, kind: "reserved", tx: hash, nonce, from: operator, to: manager, gasLimit, maxFeePerGas, l1 }` and save atomically; if that save fails: log `STOP`, `aborted = true`, NO broadcast, no later send -> `provider.broadcastTransaction(raw)`. The pass uses `signer.address` + `signer.signTransaction` only. Every entry written by this version has `tx` and `nonce`.
- Broadcast throws (any error): the entry stays `reserved` on disk (the broadcast may have reached the network), the send counts toward `maxCollectsPerRun`, `aborted = true`, the run stops cleanly with one log line. It is settled at the next run start (L1-2).
- Broadcast returns nothing, a response without `hash`, or a different hash: set the entry to `kind:"unknown"` at worst case (keep the locally computed `tx`), save, log `STOP: broadcast returned no/mismatching hash`, `aborted = true`, stop. No TypeError.
- After a good broadcast the existing wait/settle/timeout/revert/refetch logic is kept. EVERY `persist(...)` after the reservation (hash, unknown, settlement) that fails sets `aborted = true`, logs `STOP: the budget cannot be recorded`, and leaves the whole loop before any further send.

**L1-2 Run-start settlement (collect mode, state readable).** Wrap the whole phase so no value from state or RPC can throw out of it. For every entry with `kind` `reserved` or `unknown` (any age):
1. Look up `provider.getTransactionReceipt(entry.tx)` (entries with a hash) and `nonceUsed = (await provider.getTransactionCount(operator, "latest")) > entry.nonce` (entries with a nonce).
2. A receipt is ACCEPTED only if: its hash (`hash` or `transactionHash`) equals `entry.tx` (case-insensitive); `from` equals the operator and equals `entry.from` when present; `to` equals `entry.to` when present AND is in `ALLOWED_MANAGERS`; `blockNumber`/`blockHash` present; `gasUsed` is a bigint (or integer string) with `21000n <= gasUsed <= BigInt(entry.gasLimit)`. Accepted: `settledWei` (price clamped to `[0, entry.maxFeePerGas]`, result never above the reservation), `kind:"settled"`, saved, logged. A receipt that fails a check: keep the worst case, `kind:"unknown"`, log which check failed; not closed. (Orchestrator clarification after review: if the entry's nonce is already used on chain (latest nonce > entry.nonce), close it once at worst case with `t = now()`, `closed:"receipt-rejected"`, like replaced-or-dropped; if unused, keep unknown/counted. A findByNonce replacement without a valid `tx.gasLimit` is rejected.)
3. No receipt: if `nonceUsed` the tx was replaced or dropped. Ask the injectable `deps.findByNonce(operator, nonce)` -> `{ receipt, tx } | null` (default returns `null`: standard JSON-RPC has no by-nonce lookup). A result is accepted under the checks of step 2 with the hash replaced by `tx.hash`, plus `tx.nonce == entry.nonce`, `tx.from == operator`, `gasUsed` within `[21000, tx.gasLimit]`; settle at that receipt (cost capped by the entry's reservation). Not found or not accepted: settle at the worst case ONCE: `kind:"settled"`, `wei` = worst case, `t = now()` (counts a further 24 h from the closing, then ages out), `closed:"replaced-or-dropped"`. Closed entries are never re-examined. If the nonce is NOT used the tx is pending: keep `reserved`, still counted at worst case, log `pending: nonce N not used yet`; this alone does not stop the run (see OPEN QUESTIONS).
4. Legacy entries (from f0c24ab and earlier: `reserved`/`unknown` with `tx:null` or without `nonce`) cannot be proven: close ONCE at worst case with `t = now()`, `kind:"settled"`, `closed:"legacy-unsettled"`. A legacy entry that has a hash but no nonce is first looked up by hash (steps 1-2); no receipt -> closed as legacy.
5. An RPC error for an entry (receipt or nonce read) leaves it unchanged and counted, is logged, and the run continues. A failed state save after a settlement stops the run (kept).
6. `spentWindowWei` counts `reserved` and `unknown` entries at any age; `serializeState` keeps both kinds at any age until settled (7-day pruning applies to `settled`). A crashed `reserved` entry is never silently aged out.
7. `simulate` mode never settles, saves, or makes these calls, but its cap decisions count those entries.

**L1-3 Strict validation on read (`logic.readState`).** Keep `{ok:false, kind:"corrupt", reason, file}`. In addition to `t`/`wei`: `kind` (if present) is `reserved|unknown|settled`; `tx` (if present, not null) matches `/^0x[0-9a-fA-F]{64}$/`; `nonce` (if present) is a non-negative safe integer; `gasLimit`, `maxFeePerGas`, `l1` (if present) are decimal strings `/^\d{1,40}$/`; `from`/`to` (if present) are valid addresses; `closed` (if present) is a string of at most 40 chars; unknown extra fields are ignored; entries with only `t` and `wei` stay valid. A violation gives a reason naming index and field (`gasSpends[3].nonce is not a non-negative integer`). The file is left untouched; collect mode sends nothing and logs `STATE UNREADABLE (<reason>)` (existing path). No stack is ever printed for bad state.

**L1-4 Exact manager.** `assertSignable(tx, lim, expect)` takes `expect.manager` (the position's allowlisted manager of the loop iteration) and requires `tx.to` equal to it (case-insensitive) in addition to being allowlisted; missing `expect.manager` -> refuse. `assertSignable` also requires `Number.isSafeInteger(tx.nonce) && tx.nonce >= 0`.

**L1-5 README** (that section only): replace every `2 x L1 fee quote` / `2 x L1 quote` used as a formula (worst case, settled amount, `maxGasPerTxEth` row) with `max(2 x L1 quote, minL1AllowanceEth)`; describe sign -> record (hash, nonce) -> broadcast; document the self-healing settlement (receipt validation, replaced/dropped by nonce, pending stays reserved, legacy and crashed `reserved` entries settled at run start, `reserved`/`unknown` never expire until settled, the one-time worst-case close with a fresh 24 h); delete the paragraph that tells the operator to edit `state.json` by hand (keep `--init-state`); state that a broadcast error or hashless response stops the run (exit 1) and is settled on the next run.

**Orchestrator clarification after security review:** in-run receipts are validated with `checkReceipt` before settling (a rejected one or `TRANSACTION_REPLACED` keeps the worst case as unknown and stops the run); each new entry records `maxPriorityFeePerGas` (optional on read) and a receipt price below it counts as `maxFeePerGas`; an entry older than 24 h settled at run start gets `t = now`; `checkReceipt` requires a positive safe-integer `blockNumber`.

## Acceptance tests (TASK L1)
Run `node test/run-all.js collector-base` for L1-1 to L1-24, then the full suite.

Sign first, then record:
1. For a normal send the shared call log shows `signTransaction` -> state saved (the saved state already holds an entry with `kind:"reserved"`, `tx` = hash of the signed raw bytes, `nonce`, `from`, `to`, `gasLimit`, `maxFeePerGas`, `l1`) -> `broadcastTransaction(raw)`; broadcast is never called before the first save succeeded.
2. The signed raw bytes decode to type 2, `chainId 8453`, `to == manager`, `value 0`, the nonce that was quoted to the oracle (the oracle received exactly the unsigned serialisation of the same fields), fees within the caps.
3. A signer whose `signTransaction` returns a tx with a different `to`, nonce, or `from` than requested: nothing saved, nothing broadcast, the log line names the mismatch, the run continues to the next position.
4. `saveState` throws on the reservation: zero `broadcastTransaction` calls, `aborted === true`, log `STOP`, a second qualifying position is not sent.
5. `saveState` throws on any later write (hash update, unknown, settlement): `aborted === true`, no further send, `STOP: the budget cannot be recorded` logged.
6. `broadcastTransaction` rejects ("nonce too low", then a timeout error): the reserved entry with hash and nonce stays on disk, `aborted === true`, no further send, `collected === 0`, no stack.
7. `broadcastTransaction` resolves `undefined`, then `{}` (no hash), then a response with a different hash: entry `kind:"unknown"` at worst case with the local hash, state saved, `aborted === true`, no TypeError, no further send.

Run-start settlement:
8. Reserved entry, receipt for its hash valid (hash, from == operator, `to` allowlisted == `entry.to`, block present, `gasUsed` in `[21000, gasLimit]`): settled at `gasUsed x min(price, maxFee) + l1` (assert the number), `kind:"settled"`, never above the worst case, state saved.
9. One test per failed receipt check, each keeps worst case and `kind:"unknown"`, not closed, log names the check: wrong hash; `from` not the operator; `to` not allowlisted; `to` allowlisted but != `entry.to`; no `blockNumber`; `gasUsed` 20999; `gasUsed` above the signed `gasLimit`; `gasUsed` not a number.
10. Replaced/dropped: no receipt, `getTransactionCount("latest") = nonce + 1`, `findByNonce` returns a valid receipt+tx (different hash, same nonce, from == operator, `to` allowlisted): settled at that receipt's cost. `findByNonce` null (default): settled at worst case once, `closed:"replaced-or-dropped"`, `t == now()`; a second run makes no receipt/nonce call for that entry and does not double-count it; 24 h + 1 ms later it no longer counts toward `dailyGasCapEth`. `findByNonce` returns a result failing the checks (e.g. `to` not allowlisted): worst case once.
11. Pending: no receipt, `getTransactionCount("latest") == nonce`: entry stays `reserved`, counted at worst case even when `t` is 48 h old, log `pending`, the run may still send if the caps allow, and a cap that the reserved worst case pushes over blocks the send with the existing cap message.
12. Crashed run: a `reserved` entry with `t` 3 days old: valid receipt available -> settled at run start; no receipt and nonce used -> closed at worst case with fresh `t`; no receipt and nonce unused -> still counted (`spentWindowWei` includes it; it did not before).
13. Legacy entries (`tx:null` and no `nonce`; and `tx` set, no `nonce`, no receipt): closed once at worst case, `closed:"legacy-unsettled"`, `t = now()`; with a hash and a valid receipt the legacy entry settles from the receipt. A state fixture shaped like f0c24ab output (hashless `unknown`) lets the next run send again once the caps allow, with no file edit.
14. RPC errors in the settlement phase (`getTransactionCount` throws, `getTransactionReceipt` throws): entries unchanged and counted, no crash, no abort, the pass continues.
15. `simulate` mode makes no settlement calls and writes nothing, but counts `reserved`/`unknown` entries in its cap decisions.
16. A settlement whose state save fails stops the run (`aborted === true`, no send) (regression).

State validation:
17. `readState` returns `ok:false, kind:"corrupt"` with a reason naming index and field for each of: `kind:"weird"`, `tx:"0x12"`, `tx:123`, `nonce:-1`, `nonce:1.5`, `nonce:"3"`, `nonce:2**60`, `gasLimit:"abc"`, `maxFeePerGas:-5`, `l1:1e30` (number), `from:"nothex"`, `to:5`, `closed:{}`. A fully populated valid entry passes; an entry with only `t` and `wei` passes; extra unknown fields are ignored.
18. `runPass` over each corrupt fixture in collect mode: nothing sent, `STATE UNREADABLE (...)` logged, `aborted === true`, file bytes unchanged, no exception out of `runPass`, no log line contains `    at ` (stack). A spawned `node collector-base.js --mode=collect` (hermetic helper, temp `LP_DATA_DIR` holding a corrupt state, no keystore, no network) prints no stack and exits 1.

Exact manager:
19. `assertSignable` with `to` = the OTHER allowlisted manager than `expect.manager` throws `refusing to sign`; missing `expect.manager` throws; matching (case-insensitive) passes; nonce missing, negative or non-integer throws.
20. In `runPass`, a scene where the position belongs to manager A but the tx fields are built for manager B (via an injected hook/stub): zero signs, zero broadcasts, the log names the refusal.

Docs, static, regression:
21. `collector-base-readme.test.js`: README contains `max(2 x L1 quote, minL1AllowanceEth)` (verbatim) in the gas-accounting paragraph, the `maxGasPerTxEth` row and the settled-amount sentence; no longer contains `+ 2 x L1 fee quote` or `+ 2 x L1 quote` as a formula; mentions `nonce`, `replaced or dropped`, `pending`, `legacy`, `--init-state`; no longer tells the operator to edit `$HOME/base-data/state.json`.
22. Static: the forbidden-token scan passes; `sendTransaction` does not occur in `collector-base.js`; `signTransaction` and `broadcastTransaction` each occur exactly once as calls; `MANAGER_ABI` 3 functions, `ORACLE_ABI` 1.
23. Robinhood untouched: `git diff 8db9320 -- collector.js collector-logic.js collector-swap.js collect-v4.js treasury.js run-collector.sh` prints nothing, and `node test/collector-golden.test.js` passes with `test/fixtures/collector-golden/*` unmodified (hashes).
24. Existing tests updated only where they name the old `sendTransaction` call (`fakeSigner` gains `signTransaction`; `fakeProvider`/mock gains `broadcastTransaction`); all existing cap, fee, revert, timeout, `--init-state` and atomic-write assertions still pass. `node test/run-all.js` and `npx eslint .` pass (smoke.js the one expected failure). G1 done before the commit; the commit includes `SPEC.md`.

---

# TASK L2: v4 pinning leftovers

Commit message: `v4: denylist count subtracts only ownerOf-confirmed ids, tombstone departed pinned ids, redact discovery.error on /api/watch, missing tests`.

## Goal
A genuinely missing NFT must never be hidden by the denylist adjustment; a pinned id that is also discovered and leaves the wallet is tombstoned; no secret-bearing text leaves in `discovery.error`; the two missing tests exist.

## Scope
IN: `server.js` (`buildPositions` denylist adjustment and pinned-gone branch), `watch.js` (`loadWallet` gone branch and returned `discovery`), `univ4.js` only for a small pure helper if needed, tests (`v4-pinned.test.js`, `v4-warnings.test.js`, `v4-discovery.test.js` additions only, a `/api/watch` test). OUT: the warning JSON contract (keys of each warning stay exactly as in round 3; add no fields), the pin schema, v3/Slipstream, `collector*.js`.

## Existing code to reuse
`univ4.createDiscovery` (`forget`, `tombstones`, `isPinned`, `setPinned`, `balance`, `status`), `univ4.discoveryWarnings`, `endpoint.redactText`, `watch.js` `loadWallet`, `server.js` `buildPositions`, and the fake-provider / HTTP harness of `v4-pinned.test.js` and `v4-warnings.test.js`.

## Constraints
Offline, mocked provider (`ownerOf`, `balanceOf`, protected values registered through `endpoint` as existing tests do). No real transaction. `esc()` rules and warning keys unchanged.

## Design
**L2-1 Denylist adjustment.** `bal = balanceOf - (number of denylisted v4 ids CONFIRMED owned by the wallet)`, confirmed = `V4.posm.ownerOf(id)` equals `cfg.ownerAddress` (case-insensitive) in this build. Only ids that are in `v4All` and in `deny` are checked, at most 50 per build (extra ones are not subtracted), never throwing; a failed/reverting `ownerOf` or another owner = NOT subtracted. `balance()` null stays null. `knownOwned` is unchanged (denied ids are not counted as known). So: owning 6, one confirmed denied, 5 known -> `bal` 5, no `v4-balance-exceeds-known`; owning 6, one denied id the wallet does not own, 5 known -> `bal` 6 -> `v4-balance-exceeds-known` with `missing: 1`.

**L2-2 Tombstone a departed pinned+discovered id.** In `server.js` and `watch.js`, when a v4 id comes back verified `gone`: if pinned, still push it into `pinnedNotOwned`; and ALWAYS call `discovery.forget(id, reason)` (it returns `false` and writes nothing for an id not in discovery's `ids`, so a pin-only id is still never tombstoned or persisted).

**L2-3 Redact `discovery.error` in `/api/watch`.** `watch.js` `loadWallet` returns `discovery` with `error` through `redactText` (compute the redacted copy once and use it for both `discovery` and the warnings). Find every other place that returns `disc.status` / `V4.discovery.status` to a client (`/api/positions` payload, `registry.discoveryStatus` around `server.js` l.3259) and redact `error` there too; list the places in the commit message. Wherever text is cut to 200 chars, `redactText` runs first, then `.slice`.

## Acceptance tests (TASK L2)
Run `node test/run-all.js v4`, `node test/run-all.js watch`, then the full suite.

1. Denylist confirmed: wallet holds 6 (`balanceOf` 6), 5 loaded and verified, 1 denylisted id with `ownerOf` = wallet: `/api/positions` `warnings` has no `v4-balance-exceeds-known`.
2. Denylist unconfirmed: same, but the denylisted id's `ownerOf` is another address: `warnings` has `v4-balance-exceeds-known` with `missing: 1`. Same when `ownerOf` reverts/throws for it, and when the denylisted id is not among the discovered ids at all.
3. Denylist mixed: 2 denied ids, one confirmed, one not: exactly 1 subtracted. With more than 50 denied ids at most 50 `ownerOf` calls are made for them (spy count) and nothing throws.
4. Pinned+discovered departs: id 11 is in discovery's persisted `ids` AND pinned; mock `ownerOf(11)` returns another address: after one build `tombstones` contains 11 with a reason, the state file's `ids` no longer lists 11, `warnings` still holds `v4-pinned-not-owned` with `ids:["11"]`, and 11 is not shown as a position. Covered for `buildPositions` and for the watched-wallet path (`/api/watch`).
5. Pin-only departs: id 22 pinned, not in `ids`, `ownerOf` another address: reported in `v4-pinned-not-owned`, `tombstones` empty, state file bytes unchanged (regression).
6. Redaction in `/api/watch`: a discovery whose `lastError` contains a protected URL/key: the body of `/api/watch` has the redaction marker and no part of the secret in `wallets[].discovery.error` or `wallets[].warnings[].error/message`; `/api/positions` likewise (status and warnings). A grep of the full bodies finds no secret substring.
7. MISSING TEST, redaction before truncation: an error whose secret-bearing URL straddles character 200 (starts before 200, ends after): the emitted `error` (warnings, `/api/watch` `discovery.error`, `/api/positions`) has length <= 200 and the secret's first 8 characters occur nowhere in the response body. Include a unit-level control showing that cutting first and redacting after would leak (a direct call to the non-redacting slice), so the test proves the order matters.
8. MISSING TEST, pins change between refreshes: one discovery object, two builds with different settings: build 1 pins `[11, 22]`, build 2 pins `[22, 33]` (via `setPinned` from re-read settings; main wallet through `buildPositions`, watched wallet through two `refresh()` runs): positions and `warnings` `known`/`pinned` follow the settings each time (11 gone, 33 added); no pinned id is ever written to the discovery state file; a `v4-pinned-not-owned` for an id pinned in build 1 and unpinned in build 2 is absent from build 2; a settings read that throws keeps the previous pins (server path).
9. Regression: all v4/watch tests pass unmodified except assertions that depended on the old unconditional `v4Denied` subtraction or the old no-forget behaviour; each such change is listed in the commit message.
10. G7: `git diff 8db9320 -- collector.js collector-logic.js collector-swap.js collect-v4.js treasury.js run-collector.sh` prints nothing; `node test/collector-golden.test.js` passes unmodified. `node test/run-all.js` and `npx eslint .` pass (smoke.js the one expected failure). G1 done before the commit; the commit includes `SPEC.md`.

---

# OPEN QUESTIONS (round 4)

Design-changing: none blocking. Assumptions stated (changing them moves only the named tests):
- Q1 (L1 tests 10-13): standard JSON-RPC cannot look up "the tx that mined at nonce N". The default `findByNonce` returns `null`, so a replaced/dropped entry is closed at worst case once (with a fresh 24 h) unless a lookup is plugged in. A real lookup (explorer API or bounded block scan) would add an endpoint dependency; say so if wanted.
- Q2 (L1 test 11): an entry whose nonce is still unused stays reserved at worst case and does not block sending by itself (the next send reuses that nonce, which supersedes it; it is then closed on the following run). It has no timeout, so a tx truly lost with no later operator activity keeps one worst case (<= `maxGasPerTxEth`) counted until the operator sends again.
- Q3 (L1 tests 6-7): a definite broadcast rejection ("nonce too low") also stops the run and is settled next run, instead of dropping the reservation at once, because the pass cannot tell a rejection from a lost response.
