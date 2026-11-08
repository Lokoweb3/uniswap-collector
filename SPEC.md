# SPEC: Base sweep (collect to operator, swap fee tokens to native USDC, deliver to the NFT owner)

Project: `/mnt/c/Swarm-Projects/projects/lp-dashboard` (DEV repo), base HEAD `3103487`. Replaces the previous SPEC.md (history keeps it). Applies the conventions in `/mnt/c/Swarm-Projects/CLAUDE.md`. No secret appears in this file or in any file the work creates.

## 1. Goal

The Base collector (`collector-base.js`) gains a `full`-style sweep, like Robinhood's: collect the fees to the OPERATOR, swap every non-USDC fee token into native Base USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals), and deliver the proceeds. 100% goes to the NFT's on-chain owner (re-read with `ownerOf` at send time, never taken from config or a client). The vault split is written but gated OFF (no Base vault exists; `vault.tba` is null). The sweep ships disabled behind its own flag, independent of `collect:true`. A token with no safe allowlisted route is sent to the owner unswapped and reported; nothing is ever stranded with the operator.

## 2. Scope

IN
- New `collector-base-sweep-logic.js` (pure: config, allowlists, impact/minOut math, split, vault-verification decision, ledger validation, `assertSignableSweep`) and `collector-base-sweep.js` (orchestration, every side effect injected, as `collector-swap.js` does).
- New `sweep-state.json` in the Base data dir (the sweep ledger, section 5), created by `--init-state` next to `state.json`.
- Edits to `collector-base.js` and `collector-base-logic.js`, behaviour-preserving when the sweep is off (all existing `test/collector-base*.test.js` pass UNMODIFIED): extract the sign-first / reserve / broadcast / receipt block into one `sendTracked(op, txFields, expect)` used by the collect AND by every sweep tx; `assertSignable` gets an optional `expect.recipient` (default `expect.owner`, so existing calls are unchanged); `checkReceipt` gets an optional allowed-`to` set (default the managers); `entryProblem` validates a new optional `op` field.
- `settings.js` (additive only, like `baseCollect` at l.154 and l.270: carry a top-level `baseSweep` object), `settings.base.example.json` (`baseSweep`, `enabled:false`), `README.md` (new section), `tools/verify-base-sweep.js` (read-only on-chain proof of the allowlist, pools and a configured vault, in the style of `tools/verify-arc-vault.js`), tests, additive helpers in `test/lib/base-scene.js` / `test/fixtures/mock-chain.js`.

OUT
- `collector.js`, `collector-logic.js`, `collector-swap.js`, `collect-v4.js`, `treasury.js`, `slipstream.js`, `run-collector.sh` and `test/fixtures/collector-golden/*` stay BYTE-FOR-BYTE unchanged (`git diff 3103487 --` on them is empty). The sweep is switched ONLY by settings, never by a new CLI argument (the golden test asserts argv is exactly `[collector-base.js, --mode=simulate|collect]`).
- Any server/HTTP/API/dashboard route that sets recipients, routers, pools, amounts or the sweep flag. The Base server stays read-only.
- Slipstream (Aerodrome) router, multihop, any pool or router not listed in section 4, v4 swaps, wrapping/unwrapping ETH, native-ETH transfers, a Base vault deployment, touching `/home/loko/uniswap-collector`, `~/base-data`, `/dev/shm`, or any keystore (tests use `ethers.Wallet.createRandom()`).

## 3. Existing code to reuse

- `collector-base.js` `runPass` (chain checks, `isApprovedForAll`, `ownerOf` re-read, fee building, L1 oracle, sign-first reservation, `settleEarlier` nonce settlement, `withTimeout`), `collector-base-logic.js` (`limits`, `buildFees`, `capCheck`, `settledWei`, `spentWindowWei`, `readState`/`serializeState`/`writeFileAtomic`/`initStateFile`, `checkReceipt`, `entryProblem`).
- Robinhood design to mirror (read, do not edit): `collector-swap.js` (`convertFeeToken` order: no route -> hand back; budget -> quote -> over-cap -> hand back; exact approve then swap), `collector.js` sweep sections (l.968-1100: swap, split, deliver), `treasury.js` (`split` integer math; the split is capped by a max pct and a failed vault transfer gives the owner everything).
- `tools/verify-arc-vault.js` for the vault proof (registry `account(...)`, `token()`, `owner()`, `ownerOf`, code present).
- `alerts.js` `create(...).send` (Telegram; `collector.js` l.524-525 shows the guarded use), `test/lib/base-scene.js` (`scene`, `fakeSigner`, `pass`), `test/lib/hermetic.js`.
- `ethers` v6 only. No new dependency.

## 4. Fixed facts (compiled into code as constants; settings can only DISABLE entries, never add)

- Chain 8453. USDC (target, 6 dec) `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- Router: Uniswap v3 SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`. Quoter: QuoterV2 `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`. Factory `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`.
- Routes, single-hop `exactInputSingle` only (token -> USDC):

| token | decimals | pool | fee |
|---|---|---|---|
| WETH `0x4200000000000000000000000000000000000006` | 18 | `0xd0b53D9277642d899DF5C87A3966A349A798F224` | 500 |
| cbBTC `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | 8 | `0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef` | 500 |
| LAPTOP `0xB095274743941e953c746F9C228DA9c18Bb6ec29` | 18 | `0x7702411B3893ea4F6Ab96C50231cFEc65448AB9F` | 10000 |

- USDC fee legs need no swap. Any other token (or a route that fails a check below) is delivered unswapped to the owner.
- Operator ETH: gas only. No sweep transaction has `value != 0`; there is no WETH `withdraw` and no ETH transfer anywhere. The Slipstream manager's `collect` pays WETH as an ERC-20, so a WETH fee is an ordinary token leg.

## 5. Design (decisions, with reasons)

**D1 Config.** Top-level `baseSweep` in the Base settings (all optional, code defaults and HARD bounds in `collector-base-sweep-logic.js`; a value outside a bound is clamped and logged, a non-numeric one falls back to the default):
`enabled` (default false; only the boolean `true` enables, the string "true" does not), `targetToken` (must equal the constant USDC, else the sweep refuses to start; this explicit key is the sweep target, the legacy `tokens.USDG` alias is never consulted by the sweep and the log says so once), `slippageBps` (default 50, hard max 100), `maxPriceImpactBps` (100, hard max 300), `maxSwapValueUsdc` (250, hard max 1000), `minSwapValueUsdc` (1; a leg below it is delivered unswapped), `minPoolUsdc` (2000), `maxPoolShareBps` (300), `twapSeconds` (1800) and `twapMaxDeviationBps` (200), `minOperatorEthReserve` (0.0005), `maxAttemptsPerLeg` (3), `maxTxPerRun` (20), `dailyTxCap` (40), per-kind gas-limit ceilings `maxGasLimitByOp` (collect 500000 as today, approve 100000, swap 350000, transfer 120000), and sweep-time overrides `maxGasPerTxEth`, `maxGasPerRunEth`, `dailyGasCapEth` (when the sweep is enabled these replace the `baseCollect` values only if set; defaults 0.0007 / 0.002 / 0.004, hard max 5x default; `maxGasPriceGwei` and the tip cap stay as `baseCollect` has them). `routes.<WETH|cbBTC|LAPTOP>.enabled` may only set false. `vault` (D7). When `enabled` is not true, the sweep code path is not entered: the collect recipient is the owner, exactly as today.

**D2 Flow per position (sweep enabled, wallet `collect:true`, operator approved).** Today's gates first (approval, staked, priced, `ownerOf == configured owner`, thresholds, simulate-as-operator). Then a PREFLIGHT, because collecting moves value onto the operator: the run must be able to finish the delivery. It requires (a) both ledgers readable, (b) operator native ETH >= worst case of the whole planned chain (collect + per token: reset, approve, swap, reset, transfer; + one transfer per unswapped token) + `minOperatorEthReserve`, (c) the caps (D6) allow that whole planned chain, (d) a pre-collect check of every swappable leg (D4) so the plan is known. Any failure -> skip the collect (fees stay safe in the NFT) and log why. Then: collect with `recipient = operator` -> per token leg: swap or not -> deliver. The recipient check in `assertSignable` becomes "the operator" for the sweep collect; no other recipient is ever signable.

**D3 Attribution (what the operator may touch).** The ONLY amounts the sweep may move are those recorded in `sweep-state.json` for a job. A job's owed amount per token is read from the `Collect(tokenId, recipient, amount0, amount1)` event of the validated collect receipt (emitted by the manager, tokenId matches, recipient == operator); if the event is absent the job is marked `unattributed` (security review L3: there is NO fallback to the pre-signing `staticCall` amounts), nothing is sent and it is reported. The ledger is not trusted (security review M3): `job.owner` must be one of the configured owner wallets, and before a leg's first send its `owedRaw` must be <= the Collect amount re-parsed from the chain receipt of `job.collect.tx` (manager, topic, tokenId, operator recipient; token from the manager's `positions()`); every delivery is value-capped by `maxUnswappedValueUsdc`: USDC 1:1, priced tokens at the pool mid price, and an unpriced leg (no route or no mid) by its own raw amount times its per-side USD price (the pool spot price, so a best-effort cap; tokens only ever go to the verified owner), and it is REFUSED in preflight when that price is unknown. Swap-planned legs are capped in preflight too (valued at the mid price), so a forced swap failure cannot get around the cap, and any runtime unswapped delivery (declined, attempts used up, decision without a mid) is capped first (a fresh mid, else the per-side price recorded on the job) or the leg is HELD with a reason when no value can be established. Every swap/transfer amount is `min(owed - alreadyProcessed, balanceOf(operator))` read right before signing; balances above the ledger (a donation, an earlier unrelated holding, native ETH) are never swept. Swap output owed = the USDC `Transfer` to the operator in the swap receipt (pool -> operator), clamped to balance; never `balanceOf` of the whole account. Token addresses of a leg must be that position's token0/token1.

**D4 Per-token swap decision (every check must pass, else deliver unswapped and report the reason).** Route exists and enabled; leg value (quote) >= `minSwapValueUsdc` and <= `maxSwapValueUsdc`; pool address == the constant == `factory.getPool(tokenIn, USDC, fee)`; pool `factory()`, `token0/token1`, `fee()` match; router and quoter have code and are the constants; USDC `decimals()==6`. Quote = `QuoterV2.quoteExactInputSingle` (static call, `sqrtPriceLimitX96 = 0`). Mid price = `slot0.sqrtPriceX96` (decimals- and token-order-adjusted, fee-free): `midOut`, `midOutAfterFee = midOut * (1e6 - fee) / 1e6`. IMPACT (bps) = `(midOutAfterFee - quote) / midOutAfterFee`; the pool fee is NOT impact (so LAPTOP at ~0.16% passes while ~1.2% under mid incl. its 1% fee is simply the fee). Refuse if quote is 0, if quote > `midOutAfterFee * 1.001` (inflated or stale quoter), if impact > `maxPriceImpactBps`, if `slot0.sqrtPriceX96 == 0` or in-range `liquidity() == 0`, if the pool's USDC balance < `minPoolUsdc`, if the quoted USDC > `maxPoolShareBps` of the pool's USDC balance, or if the spot tick differs from the `observe([twapSeconds,0])` TWAP tick by more than `twapMaxDeviationBps` (spot manipulation guard; an `observe` that reverts, e.g. too little oracle cardinality, FAILS CLOSED). `minOut = quote * (10000 - slippageBps) / 10000`, always > 0. The swap is `exactInputSingle{tokenIn, tokenOut: USDC, fee, recipient: operator, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0}`, `to` = router. Why recipient = operator and not the owner: one uniform delivery path that also serves the vault split; the cost is the short custody window the README states.

**D5 Approvals.** Exact amount to the router only (never infinite, never another spender). At the start of a swap leg read `allowance(operator, router)`: if nonzero, send `approve(router, 0)` first (leftover found), then `approve(router, amountIn)`, then the swap. After the swap (success or failure) read the allowance again; if nonzero send `approve(router, 0)`. At run start (collect mode) any nonzero operator->router allowance on the 4 known tokens with no active leg is reset the same way, within the caps. A leg is not `swapped` until the allowance is back to 0 or the reset was attempted and recorded.

**D6 Caps cover every transaction.** Every tx (collect, approve, swap, approve-reset, transfer) goes through `sendTracked`: `assertSignableSweep` (exact `to`, exact decoded calldata, `value 0`, type 2, chainId, fee/tip clamp, per-op gas ceiling; `to` for approve/transfer is a position token of an active leg, approve spender is the router, transfer recipient is the verified owner or verified vault, swap `to` is the router with calldata == the decided params), then sign, check the signed bytes field by field, write the `gasSpends` entry (`op`, worst case incl. L1 allowance, hash, nonce) atomically, then broadcast, then receipt validation and settlement as today. The existing caps apply to ALL: per-tx worst case, `maxGasPerRunEth`, `dailyGasCapEth` (reservations and unknown entries included); new `maxTxPerRun` counts every tx, new `dailyTxCap` counts `gasSpends` entries with an `op` in the trailing 24 h; `maxCollectsPerRun` keeps counting collects only. `checkReceipt` accepts `to` = the manager, router or a token of the entry's leg according to the entry's recorded `to`/`op`. Estimated gas above an op's ceiling means skip, never clamp (as today). A nonce is read fresh per tx (`pending`).

**D7 Vault split (written, gated).** `baseSweep.vault = { tba, nft, tokenId, implementation, registry, salt, expectedOwner, splitPct, maxSplitPct }`; ships `tba: null`, `splitPct: 0`. Effective pct = 0 unless `tba` is set AND `verifyVault` passes at run time (not cached across runs). `verifyVault` (all on chain, via mocks in tests): `registry` is the hard-coded canonical ERC-6551 registry `0x000000006551c19487814612e58FE06813775758` (settings cannot change it; a different `vault.registry` is refused); `implementation` must be in the code allowlist `VAULT_IMPLEMENTATIONS`, EMPTY by default, so the vault can never verify until code is changed (security review L1); `expectedOwner` must be one of the configured owner wallets; `registry.account(implementation, salt, 8453, nft, tokenId) == tba`; `getCode(tba)`, `getCode(nft)`, `getCode(registry)` non-empty; `tba.token()` returns exactly `(8453, nft, tokenId)`; `tba.owner()` and `nft.ownerOf(tokenId)` both equal `expectedOwner` from settings; `tba` is not the operator, the zero address, the router, a pool or a token. `pct = clamp(splitPct, 0, min(maxSplitPct, 20))`. Only USDC proceeds are ever split; unswapped tokens go 100% to the owner. DECISION on failure: do NOT abort; send 100% to the owner and report the reason loudly (Telegram + log). Reason: the owner is the beneficiary anyway, aborting would leave funds on the operator, and an unverified vault is never a recipient. A vault transfer that reverts or is not mined falls back the same way (owner gets the full remaining amount) and the ledger records the failure, as `treasury.js` does. Vault-side `split` uses integer math identical to `treasury.split` (parity tested).

**D8 Delivery recipient.** At each transfer: `ownerOf(tokenId)` on the job's manager is re-read; it must be non-zero, not the operator, and equal to the owner recorded at collect time. If it differs (sold, staked into a gauge, transferred) NOTHING is sent: the leg stays `held`, is reported, and is retried next run (still attributable, never swept elsewhere). Transfers use `to = token`, calldata `transfer(owner|vault, amount)`; a token with a non-standard return is accepted only if the operator balance fell by the amount (balance-delta proof). A transfer that reverts counts an attempt; after `maxAttemptsPerLeg` the leg is `stuck`: reported every run (Telegram + exit code 1), never redirected.

**D9 Ledger `sweep-state.json` (fail closed, atomic, mode 0600, version 1, same writer as `state.json`).** `jobs[]`: `{ id, tokenId, manager, owner, collect: {tx, nonce, status}, legs: [ { token, owedRaw, doneRaw, phase, attempts, pending, swap: {amountIn, quoteRaw, minOutRaw, outRaw, tx}, deliver: {to, raw, tx} } ], createdAt }`. Phases per leg: `collected -> approved -> swapped -> delivered`, or `collected -> delivered-unswapped` (terminal), plus `held` / `stuck`. `pending = {op, tx, nonce}` is written BEFORE the `gasSpends` reservation, which is written BEFORE the broadcast (sign-first, two files, strictly in that order). The collect also gets a pending intent before its reservation (so a crash after it mined is recovered from the receipt's `Collect` event). The file missing (sweep enabled, collect mode) -> refuse to send anything, log the exact `--init-state` command; unreadable or corrupt -> refuse everything (no guessing from balances; funds are not lost, they are still attributed on chain); simulate never writes it. Terminal jobs are kept 30 days. `readSweepState` rules (corrupt on any violation): a `collect.tx` repeated across jobs, a leg token repeated within a job, malformed or repeated `swap.tx` / `swap.txs` hashes, a swap hash (`swap.tx` or any of `swap.txs`, lowercased) recorded for more than one leg anywhere in the ledger, and a swap hash equal to any job's `collect.tx`. Before USDC proceeds move, every swap receipt of the leg is re-read (it must target the router and come from the operator; a missing `to` or `from` is refused) and `swap.outRaw` is capped at the USDC those receipts show the pool paying the operator.

**D10 Recovery at run start (collect mode, before any new collect, even if the sweep flag was since turned off: legs of existing jobs are finished, no new job starts).** First `settleEarlier` settles gas entries (extended to the new ops). Then per non-terminal leg: a `pending` tx with a valid receipt (hash, operator, expected `to`, block) advances the phase (a successful swap receipt -> `swapped` with `outRaw` from its USDC Transfer log; status 0 -> back to the previous phase, attempts+1); a pending tx with no receipt and nonce unused stays pending (leg skipped this run); a pending tx with no receipt and nonce used is NOT voided at once (security review M2): `getTransaction(hash)` is asked too, and the intent is voided only when neither the receipt nor the tx is found on two separate runs (counter `notFoundRuns` in the ledger intent), else it waits; a collect that was broadcast but is never found becomes `unattributed` and blocks new collects until an operator resolves it (it is no longer voided and re-collected); a voided swap/transfer becomes held + unattributed (never re-evaluated from balances, never resent). An intent without a signature or without a reservation (never broadcast) is voided at once and the leg is re-evaluated from `balanceOf` clamped to the owed amount. A transfer mined with a non-falling operator balance (read at the receipt block, M1) is never a revert/retry: the leg is held + unattributed. A recovered mined transfer is credited only with proof (the balance fall at the receipt block, or the token's own non-removed `Transfer(operator -> to, amount)` log; USDC for proceeds); otherwise the leg is unattributed. "Collected, not swapped" re-runs D4 with a FRESH quote (a persisted `minOut` is never reused for a new tx). "Swapped, not sent" delivers `outRaw` to the owner (and the vault share only if D7 verifies now). A leg that failed `maxAttemptsPerLeg` swaps falls back to delivered-unswapped. New collects are not started while any leg is `stuck` or `unattributed`.

**D11 Simulate.** `--mode=simulate` with the sweep enabled prints the whole plan per position, reading chain state only: collect (simulated amounts) -> per token: route, pool/factory proof result, quote, mid, impact bps, minOut, decision (swap | unswapped + reason) -> split (`0% vault: vault.tba not set`, or the verification result when configured) -> recipients (owner address from the live `ownerOf`) -> estimated txs and the cap verdict; plus the resume plan for open legs. It creates no signer, decrypts nothing, writes neither `state.json` nor `sweep-state.json`, sends no Telegram. With the sweep off it prints one line `sweep: disabled (baseSweep.enabled is not true)` and behaves as today.

**D12 Reporting.** Log lines per step (collected, swap with quote/minOut/impact, delivered, unswapped + reason, gas) and a closing summary line `=== base sweep: N positions, delivered X USDC, Y tokens unswapped, Z stuck, gas G ETH ===`. In collect mode a Telegram summary (via `alerts.create`, guarded like `collector.js`; failure to send is logged and never changes the outcome) with the same figures, any vault refusal reason, and any held/stuck/unattributed leg. Exit code 1 when aborted or a leg is stuck/held/unattributed, as an aborted run does today.

## 6. Constraints

- Style: CommonJS, `"use strict"`, existing eslint config; every new `.js` passes `test/collector-scope.test.js` and `npx eslint .`. Pure logic has no I/O; the orchestration takes every side effect (provider, signer, quoter, clock, state IO, notify, log) by injection so tests prove what was NOT attempted.
- Fail closed everywhere: a missing/odd number, RPC error, unexpected ABI result, or malformed ledger means "do not send".
- Security: no recipient, router, pool, token, amount or flag from HTTP, env or CLI; the allowlists are code constants; settings can only tighten. Keystore only decrypted when the first tx is about to be signed (unchanged). `.env` and state files stay git-ignored; servers (none added) bind 127.0.0.1.
- No real tx and no network in tests (`test/fixtures/no-network.js`, `mock-chain.js`, fake signer, `test/lib/hermetic.js` for spawns). Never read `/dev/shm`, a keystore or a real `.env`; never touch `/home/loko/uniswap-collector` or `~/base-data`.
- Git: named-file commits only, check `.env*`, `settings.json`, `state.json`, `sweep-state.json`, keystores, `*.log` are ignored first (add `sweep-state.json` to `.gitignore` if the pattern does not cover it); no remote, no push.
- Run `node test/run-all.js` (full) and `npx eslint .` before declaring done; `test/smoke.js` failing only for the missing `settings.json` is the one pre-existing expected failure.

## 7. Acceptance tests (all mock-based, no network, no real tx)

Default and gating
1. `settings.base.example.json` has `baseSweep.enabled === false` and `vault.tba === null`; with the key absent, `enabled:"true"`, `1`, or `false`, a `collect:true` run behaves byte-for-byte like today (recipient = owner, no sweep-state read or write, one `sweep: disabled` line).
2. With `enabled:true` but `targetToken` not equal to the Base USDC constant, or USDC `decimals()` != 6, the run refuses to start the sweep and sends nothing; `tokens.USDG` set to a different address changes nothing.
3. Sweep enabled but `sweep-state.json` missing: no tx, log names `--init-state`; corrupt/unreadable: no tx and no collect; `--init-state` creates it once and never overwrites.

Recipients and allowlists
4. Every signed tx in a full mocked run satisfies: swap `to` = the router constant; collect `to` = a manager; approve/transfer `to` = a token of that leg; approve spender = router only; the collect `recipient` = operator; every transfer `to` = the live `ownerOf` (or a verified vault).
5. `ownerOf` changes between collect and delivery -> nothing is sent, leg `held`, reported, exit code 1; the next run with the original owner restored delivers.
6. A settings/input attempt to add a router, quoter, pool, route, token or recipient (extra keys, a `routes.X.pool`, a client-style override) has no effect: the code constants are used or the run refuses; `routes.LAPTOP.enabled=false` makes LAPTOP go unswapped to the owner.
7. A mocked router address, quoter address, or pool that is not the allowlisted constant, or whose `factory.getPool(tokenA, USDC, fee)` differs, or whose `token0/token1/fee` disagree: that token is delivered unswapped to the owner with the reason logged; no approve and no swap tx is signed.

Swap safety
8. Quoter returns 0 -> unswapped to owner. Quoter returns an inflated amount (> `midOutAfterFee * 1.001`) -> unswapped. Impact above `maxPriceImpactBps` (settings value above the hard max 300 is clamped to 300) -> unswapped. No swap tx exists in any of these.
9. Impact math: for a mock pool with fee 10000 and a quote 0.16% below `midOutAfterFee`, impact is 16 bps and the swap proceeds (the 1% fee is not counted as impact); `minOut = quote * (10000 - slippageBps) / 10000` exactly; `slippageBps` 500 in settings is clamped to 100; `minOut` is never 0.
10. Pool USDC balance below `minPoolUsdc`, quote above `maxPoolShareBps` of the pool, `liquidity()==0`, `sqrtPriceX96==0`, leg value above `maxSwapValueUsdc` (hard max 1000), spot/TWAP deviation above `twapMaxDeviationBps`, or `observe` reverting -> unswapped to owner, never swapped. A leg below `minSwapValueUsdc` -> unswapped transfer.
11. The sent swap calldata decodes to `exactInputSingle` with `amountIn` = the attributed leg amount (not the full balance when the operator holds more), `recipient` = operator, `amountOutMinimum` = the computed `minOut`, `sqrtPriceLimitX96` = 0.
12. A USDC fee leg: no quote, no approve, no swap; one transfer to the owner. A token not in the route table: unswapped transfer to the owner.
13. Approvals: only `approve(router, exactAmountIn)` is ever signed (never `MaxUint256`); a nonzero leftover allowance found at start produces `approve(router,0)` before the exact approval; after a reverted swap `approve(router,0)` is sent; a stale nonzero allowance with no active leg is reset at run start; after every run the mocked allowance is 0.

Operator funds
14. The operator holds extra unrelated token balance and native ETH: only ledger-attributed amounts are swapped/sent; native ETH is never sent (no tx with `value != 0` exists in any scenario); WETH fees are treated as the ERC-20 token. A low native ETH balance (below the planned worst case + reserve) -> the collect is skipped and nothing is moved onto the operator.
15. Simulate with the sweep enabled prints, for a mocked position with WETH, cbBTC, LAPTOP and USDC fees, the collect, per-token quote/minOut/impact/decision, `0% vault`, and the owner recipient; the fake signer records zero `signTransaction` calls, `getSigner` is never called, `saveState` and the sweep-state writer are never called, no Telegram.

Vault (mocks)
16. With the shipped config (`tba:null`) the split is 0% and no tx goes to any vault address. With the real Robinhood TBA `0x4941943B0a3860f07767d8918Cce50D8451b340B` configured (no code on mocked Base) -> verification fails, 100% to the owner, reason reported.
17. Each failure alone refuses the split and gives 100% to the owner with the failing check named: `registry.account(...)` != `tba`; `tba` has no code; `token()` returns a wrong chainId, NFT, or tokenId; `tba.owner()` != `expectedOwner`; `nft.ownerOf(tokenId)` != `expectedOwner`; a call reverts; `tba` equals the operator/zero/router/token. No tx ever targets the unverified address.
18. A fully valid mocked vault with `splitPct: 10` and `maxSplitPct: 20` sends `floor(out * 10%)` USDC to the vault (identical to `treasury.split`) and the rest to the owner; `splitPct: 50` is clamped to 20; unswapped tokens are never split; a reverting vault transfer sends the owner the full remaining amount and records the failure.

Recovery and ledger
19. Crash after the collect mined but before it was recorded: the next run reads the pending intent, parses the `Collect` event, creates the legs, and completes swap + delivery.
20. "Collected, not swapped" (process stops after the collect, and separately after an approve): the next run re-quotes (a changed mocked quote changes `minOut`; the old `minOut` is not reused), swaps, resets the allowance, delivers; no duplicate collect.
21. "Swapped, not sent" (stop after the swap receipt): the next run delivers exactly the receipt's USDC `outRaw` to the owner and does not swap again.
22. Pending tx with no receipt and unused nonce: the leg is skipped (no second swap); with a used nonce and no receipt, the intent waits until neither receipt nor tx is found on two runs, then a collect becomes unattributed (new collects blocked, not re-collected) and a swap/transfer is held + unattributed (no second swap or transfer); an intent that was never reserved or broadcast is voided.
23. `maxAttemptsPerLeg` consecutive reverting swaps -> the leg is delivered unswapped to the owner. A transfer that keeps reverting -> `stuck`, reported each run, exit code 1, new collects blocked, never redirected.
24. Recovery runs before new collects and still finishes open legs when `baseSweep.enabled` was set back to false (no new job starts).
25. `state.json` stays version 1 and every existing state test passes unmodified; new entries carry a valid `op`, an invalid `op` makes the file corrupt (fail closed).

Caps and gas
26. A multi-tx run (collect + approve + swap + reset + transfer, several tokens) never exceeds `maxTxPerRun`, `maxGasPerRunEth`, `dailyGasCapEth` or `dailyTxCap`; the first tx that would exceed any of them is not signed; reservations of all ops count in `spentWindowWei`; a preflight that cannot afford the whole chain skips the collect.
27. Every tx type is sign-first: for each, the `gasSpends` reservation (with hash, nonce, `op`) is on disk before `broadcastTransaction`; a failing save blocks the broadcast and stops the run; a broadcast error, timeout, replaced tx or bad receipt keeps the worst case counted and stops the run; the next start settles by receipt/nonce for all ops.
28. Signed fee fields never exceed `maxGasPriceGwei` / `maxPriorityFeeGwei`; gas estimates above the op's ceiling are skipped; a tampered `tweakTxFields` (wrong `to`, `value`, spender, recipient, amount, selector) is refused by `assertSignableSweep` for each op.

Telegram and docs
29. A collect-mode run calls the injected `notify` once with the summary (counts, USDC delivered, unswapped tokens with reasons, vault status, stuck legs); a throwing `notify` does not change results; simulate never calls it.
30. README has a "Sweep on Base" section covering: how to enable (`baseSweep.enabled:true` after `--init-state`, operator approval on both Aerodrome managers still required), the risk (the operator key briefly holds the collected tokens and proceeds; the approvals let the operator key act on the NFTs), caps and what "stuck/held" means, how to verify (`node tools/verify-base-sweep.js`, simulate first), and how to enable the vault later (deploy, set the keys, verify with the tool, then set `splitPct`). A README test asserts those headings/keys exist, consistent with `test/collector-base-readme.test.js`.

Regression and hygiene
31. `test/collector-golden.test.js` passes unmodified; sha256 of `collector.js`, `collector-logic.js`, `collector-swap.js`, `collect-v4.js`, `treasury.js` equals `fixtures/collector-golden/hashes.json`; `git diff 3103487 -- collector.js collector-logic.js collector-swap.js collect-v4.js treasury.js slipstream.js run-collector.sh` is empty; a new test pins the sha256 of `collector.js`, `collector-swap.js`, `treasury.js` explicitly.
32. Every pre-existing `test/collector-base*.test.js` passes unmodified; `node test/run-all.js` passes (except the known `smoke.js` settings failure) and `npx eslint .` is clean; the new tests are discovered by `run-all.js`.
33. `tools/verify-base-sweep.js` is read-only (no signer, no keystore import) and a test on its mocked provider reports the allowlist/pool/factory/vault checks as ok/FAIL like `verify-arc-vault.js`.

## 8. Open questions (assumptions made; flag only if you disagree)

1. TWAP guard (D4): assumed to be wanted and to fail closed when a pool's oracle cardinality is too low. If the LAPTOP pool (thin) has `observe` unavailable, LAPTOP would always go unswapped to the owner. Needs a one-time read-only check of `slot0().observationCardinality` for the three pools before enabling; `twapSeconds` is tunable down, but there is no "off" switch by design.
2. Swap output goes to the operator, not straight to the owner (D4): uniform with the vault path, costs one extra transfer tx per token and a brief custody window. Paying the owner directly from the swap is a possible later optimisation when the effective split is 0.
3. Delivery to a changed owner (D8): assumed hold-and-report rather than pay the new owner or the recorded one.
4. Cap defaults for sweep mode (D1) are chosen from Base fee levels (about 0.005 gwei) and the 1 gwei hard price cap; adjust after the first simulate output.


---

<!-- Merged from branch worktree-agent-afe4e6be413177e2c (Portfolio fee totals) -->

# SPEC: Fee totals and earning rate on the Portfolio page

## Open questions (read first)

None blocks the design. One assumption changes what users see, so it is stated here:

- Q1. Rate source for the main wallet is the per-position `dailyUsd` from `/api/positions`; for watched wallets it is the wallet-level `earned.perHour` from `/api/watch`. Both exist in `server.js` / `watch.js` of the main-chain server. ASSUMPTION: the base (8796) and arc (8797) instances expose the same fields (they are not in this worktree's `server.js` if they run a different server file). If a live GET shows the fields missing for a chain, that chain shows "rate unknown" and the missing server fields are listed as a follow-up. No per-chain change is made in this task.
- Q2. APR is NOT aggregated. Reason: `dashboard.js` already states "APR is a per-wallet figure and is never merged", and `aprPct` is per position on a different value basis. Listed as a follow-up. Fees per day, and per week as day x 7 (labelled "extrapolated"), are shown.

## 1. Goal

On the Portfolio page (`/portfolio`), the user asked: "can we add a total of how much fees is earning". Add, to the LP positions section, a totals row for uncollected fees and pending rewards, and a measured fees-per-day rate, both following the chain and wallet filters.

## 2. Scope

In:
- Totals row on the LP positions table: counted uncollected fees, counted pending rewards (priced rewards ARE in the grand total, per the "round-5" decision: `aggregate.js` `rewardsCounted` / `totals.rewardsUsd`), and uncounted fees shown separately.
- Earning-rate line under the LP table: fees per day (and per week), labelled with basis and window, per chain/wallet source. "rate unknown" where no measured rate exists.
- Fee columns in the By chain and By wallet breakdowns.
- Router-side changes only: `aggregate.js`, `aggregate-view.js`, `aggregate.css` if needed, `chain-router.js` only if needed (likely not).

Out:
- Any per-chain instance change (`server.js`, `watch.js`, `collector-base*.js`, `dashboard.js`, per-chain routes). Do not touch `collector-base*.js`.
- New RPC calls, new price lookups, estimating or projecting a rate.
- A new fetched path. `PATHS` in `aggregate.js` stays the same four paths (`/api/positions`, `/api/watch`, `/api/portfolio`, `/api/staking`). `/api/daily` is NOT fetched.
- APR aggregation (see Q2). Rates for tokens/staking (staking already has its own 7d/30d columns).
- Deploying to the live install (`/home/loko/uniswap-collector`).

## 3. Existing code to reuse

- `aggregate.js`
  - `ingestEntry()` whitelist: add `dailyUsd: num(e.dailyUsd)` and `rateWindowH: num(e.rateWindowH)`.
  - watch `ingest("watch")`: add per wallet `earned: { perHour: num(w.earned.perHour), rateWindowH: num(w.earned.rateWindowH) }` (null when `w.earned` is not an object).
  - `compose()` `addEntries()` items: `feesUsd`, `_feesCounted` (= `counted && feesOk && feesUsd !== null`), `rewardsUsd`, `rewardsCounted`, `flags.feesUnavailable`.
  - `build()` totals: `feesUsd`, `rewardsUsd`, `rewardsUncountedUsd/Count`, and `breakdown.byChain/byWallet`.
- `aggregate-view.js`: `totalsFor()` (client mirror, used when filtered; server `payload.totals` used when unfiltered), `breakdownFor()`, `breakdownHtml()`, `tableHtml()`, `feesCellHtml()`, `esc()`, `usd()`, `reasonText()`, `isUnfiltered()`, `filterItems()`.
- Tests and fixtures: `test/aggregate.test.js`, `test/aggregate-view.test.js`, `test/aggregate-router.test.js`, `test/aggregate-fixtures.test.js`, `test/lib/aggregate-fixtures.js`. Add to these in their existing style (`node:assert`, `test/run-all.js` picks them up).
- Style: CommonJS, `"use strict"`, `num()` for every number from upstream, no new dependencies.

## 4. Design

### 4.1 Which fields feed the totals (no recomputation)

Counted fees = items with `kind==="lp"` and `_feesCounted`. Counted rewards = `rewardsCounted`. Both already enter `totals.grandUsd` (`lpUsd + feesUsd + rewardsUsd + tokensUsd`). The new row shows exactly `totals.feesUsd` and `totals.rewardsUsd` (unfiltered) or the `totalsFor()` values (filtered). It adds nothing to the grand total and subtracts nothing.

New figures in `build()` totals (and the same in `totalsFor()`):
- `feesUncountedUsd` = sum of `feesUsd` over LP items where `feesUsd` is a number and NOT (`counted` and fees available). Client form: `isNum(feesUsd) && !(counted && !flags.feesUnavailable)`. Server form: `feesUsd !== null && !_feesCounted`.
- `feesUncountedCount` = number of such items.
- Invariant: `feesUsd + feesUncountedUsd` = sum of all numeric `feesUsd` on LP items in scope.
- Rewards not counted stay as the existing `rewardsUncountedUsd/Count`; the row displays them as it does today.

Breakdowns: `breakdown.feesByChain` and `breakdown.feesByWallet` (counted fees only, same rounding `round()` as existing; `null` for a chain whose status is `down`/`loading`, like `byChain`). Client `breakdownFor()` returns the same for filtered views. Rendered as an extra "fees" column in By chain and By wallet. These are subsets of the existing contrib values, not additions to them.

### 4.2 Earning rate

Rate unit is the USD value of newly accrued UNCOLLECTED FEES, measured by the instance itself. It excludes pending rewards, which must be said in the label.

New in `compose()` output: `rates: [{ wallet: key, kind, perDayUsd, windowH, measured, total, stale }]`, one entry per (chain, wallet) that has LP items, where
- Main wallet (read from `/api/positions`): `kind:"positions"`, `perDayUsd` = sum of `dailyUsd` over its LP items that are `_feesCounted` and have a non-null `dailyUsd`; `measured` = how many such items; `total` = number of `_feesCounted` LP items; `windowH` = the shortest `rateWindowH` among the measured items. External (non-`positions`) entries never carry `dailyUsd`, so they count in `total` but not `measured`.
- Watched wallet (read from `/api/watch`): `kind:"wallet"`, `perDayUsd` = `earned.perHour * 24`, `windowH` = `earned.rateWindowH`, `measured` = `total` = null. This is a wallet-level figure covering all of that wallet's positions, including ones not counted in the totals; label it so.
- `perDayUsd = null` ("rate unknown") when: no measured items / `perHour` or `dailyUsd` is null (the instance returns null for under 45 min of snapshots or under 1 h of history), the part is missing or the chain is down/loading, or the wallet is `unavailable`. Never 0 in place of unknown. A real measured 0 stays 0.
- `stale: true` when the source part is stale (reuse `flags.stale` / `usable[name].stale`).

`build()` passes `rates` through to the payload as top-level `rates: [{ chain, wallet, ... }]`; `totals` is unaffected.

View: `ratesFor(payload, sel)` filters `rates` by the same chain set and wallet key as `filterItems`. Output of the line under the LP table:
- Known part: `Fees earning (measured, uncollected fees only, excludes pending rewards): $X/day, $Y/week (x7, extrapolated)`, followed by the window as a range ("measured over 3.5-24.0 h") and a basis note ("main wallet: sum of per-position accrual; watched wallets: wallet accrual, all positions").
- Coverage: `from N of M chain/wallet sources`. For the main wallet with partial positions, `n of m positions measured`.
- Unknown part: one entry per unknown source, text `<Chain label> <wallet name>: rate unknown`. When nothing in scope is known, only `rate unknown` (no $ figure, no estimate).
- When any contributing source is stale, add the existing stale badge text.
- If a window under 6 h contributes, add "short window" (mirrors `dashboard.js` `rateWindowH < 24` hint).

### 4.3 Rendering and safety

- LP table gets a `<tfoot>` totals row (via `tableHtml`, LP only): label "Total (counted)", Value cell = `lpUsd`, Fees cell = `fees $A + pending rewards $B`, and a second muted line `fees not counted $C (n items)` only when `feesUncountedCount > 0`, and the existing `rewards not counted` wording when `rewardsUncountedCount > 0`. Colspan consistent with the existing 7 columns.
- Every dynamic value goes through `esc()`; numbers through `usd()`; chain/wallet names through `esc()` (they are upstream strings: labels, chain labels, `protocol`).
- No inline script, no event-handler attributes, no new `style=` use beyond the existing `--accent` custom property. `AGG_CSP` in `chain-router.js` is unchanged. Any new styling goes in `aggregate.css` class rules.
- `isUnfiltered` path uses server `totals`; filtered path uses `totalsFor()`; both must give identical numbers for the same set (add the new fields to both).
- The "uncounted wallet" tile (`selWallet.unavailable`) behaviour is kept: the totals row shows `unavailable` for that selection, not $0.

### 4.4 Deploy constraint (explicit)

The change set is router-only: `aggregate.js`, `aggregate-view.js`, `aggregate.css`, optionally `chain-router.js`, plus tests/README. Nothing under per-chain instance code changes, and no instance restart is needed. If a rate input is missing from a chain's instance, the result is "rate unknown" for that chain, and the missing field goes in the follow-ups below.

### 4.5 Live shapes to confirm (read-only GET, implementer only)

- `GET 127.0.0.1:8800/api/aggregate` (router; before/after shape of `totals`, `items`, `breakdown`).
- Per chain, GET only, no `fresh=1`: `127.0.0.1:8787` (robinhood), `:8796` (base), `:8797` (arc), paths `/api/positions` (check `positions[].dailyUsd`, `rateWindowH`, `feesUsd`, `feesOk`, `counted`) and `/api/watch` (check `wallets[].earned.perHour`, `earned.rateWindowH`). Record in the PR notes, per chain, whether each field is present; absent means "rate unknown" for that source. Do not read `/dev/shm` or any keystore; do not POST.

### 4.6 Follow-ups (not in this task)

- Aggregate APR (needs a defined common basis).
- If base/arc lack `dailyUsd`/`earned.perHour`: add them in those instances (separate deploy).
- `/api/daily` as a longer-window rate source (7d/30d) would need a fifth fetch path.

## 5. Constraints

- Router-only deploy (4.4). No per-chain files, no `collector-base*.js`.
- No new RPC, no new dependencies, no new fetched paths, no estimation. Unpriced/unknown stays null, never 0.
- Strict CSP unchanged (4.3). All rendered values escaped.
- Totals must satisfy the existing grand-total arithmetic: `grandUsd = lpUsd + feesUsd + rewardsUsd + tokensUsd`, unchanged.
- `npm test` (`node test/run-all.js && eslint .`) passes with zero eslint errors.
- Performance: no extra upstream requests; `compose`/`build` stay linear in items.

## 6. Acceptance tests

Fixtures: use or extend `test/lib/aggregate-fixtures.js`. Unless stated, the chain keys are `robinhood`, `base`, `arc`, with wallet M (main) and W (watched).

1. Unfiltered totals match the grand total. Fixture: robinhood M has LP A (counted, fees $10, rewards $4 priced, counted) and LP B (counted, fees $5, no rewards); base W has LP C (counted, fees $2). `build()` gives `totals.feesUsd === 17`, `totals.rewardsUsd === 4`, and `grandUsd - tokensUsd - lpUsd === 21`. The rendered LP totals row contains `$17.00` for fees and `$4.00` for pending rewards.
2. Uncounted fees separate. Add LP D: thin pool, `counted:false`, `feesUsd` $3. `totals.feesUsd` still 17, `totals.feesUncountedUsd === 3`, `feesUncountedCount === 1`, `grandUsd` unchanged from test 1. The row shows `fees not counted $3.00 (1 items)` and the $3 is not in the displayed counted fees.
3. Also uncounted: LP E has `feesOk:false` with numeric `feesUsd` $9 and `counted:true`: not in `feesUsd`, is in `feesUncountedUsd` (now 12), and its row shows `fees unavailable`.
4. No fees uncounted: with only counted items, no `fees not counted` text appears and `feesUncountedCount === 0`.
5. Chain filter. `sel.chains = {base}` only: row fees = `$2.00` and rewards `$0.00`; with `{robinhood}`: `$15.00` and `$4.00`. `totalsFor()` filtered results equal what `build()` produces for a payload containing only that chain's items (deep-equal on `feesUsd`, `rewardsUsd`, `feesUncountedUsd`, `feesUncountedCount`, `grandUsd`).
6. Wallet filter. `sel.wallet = W key`: fees `$2.00`; `sel.wallet = M key`: fees `$15.00`. Chain and wallet filters together: intersection (robinhood + W gives `$0.00` and no rate/no error).
7. Server/client parity. For the unfiltered selection, `totalsFor()` is not used (server totals shown); forcing the client path over the same items gives the same `feesUsd`, `rewardsUsd`, `feesUncountedUsd`, `grandUsd` as the server (property over 3 fixtures including a stale and a killed-gauge item).
8. No double counting. A position present in both `/api/positions` (main) and `/api/watch` (same wallet, same tokenId) is counted once: `totals.feesUsd` equals the single value; `sum(items.feesUsd where _feesCounted) === totals.feesUsd` (checked via items in the payload). `feesByChain` values sum to `totals.feesUsd` when all chains are up. `feesByWallet` values sum to the same.
9. Rewards policy. Priced, non-killed rewards ($4) are in `totals.rewardsUsd` and in `grandUsd`; a killed-gauge reward ($6) is not in `rewardsUsd`, appears as `rewards $6.00 not counted (gauge killed)` and in `rewardsUncountedUsd`. The row shows both the same way the tile does.
10. Down chain. base status `down`: its fees are absent from the totals, `breakdown.feesByChain.base === null`, the By chain fees cell for base shows `no figure`, not `$0.00`. Existing banner text still renders.
11. Wallet unavailable. Selecting a wallet with `unavailable:true` shows `unavailable` in the totals row and no rate figure (not `$0.00`).
12. Breakdown fee columns. With test 1's fixture, By chain shows robinhood fees `$15.00`, base `$2.00`; By wallet shows M `$15.00`, W `$2.00`; existing Value columns and percentages are unchanged (snapshot of the old columns equals before).
13. Rate, main wallet. robinhood M: A `dailyUsd:2.4, rateWindowH:20`, B `dailyUsd:0.6, rateWindowH:20`. Rate source gives `perDayUsd === 3`, `windowH === 20`, `measured === 2`, `total === 2`. Rendered text includes `$3.00/day`, `$21.00/week`, `excludes pending rewards`, and a window of `20.0 h`.
14. Rate, partial. LP B has `dailyUsd:null`: `perDayUsd === 2.4`, `measured 1` of `total 2`; text says `1 of 2 positions measured`.
15. Rate unknown, main. All main LP items `dailyUsd:null` (or `/api/positions` part missing): `perDayUsd === null`; text for that chain/wallet reads `rate unknown`; no `$0.00/day` anywhere. Same output when the instance returns `dailyUsd` as a string or negative (`num()` rejects).
16. Rate, watched wallet. base W `earned:{perHour:0.5, rateWindowH:24}`: `perDayUsd === 12`, `windowH === 24`, text labelled as wallet accrual (all positions). With `earned.perHour:null` or `earned` absent (old instance): `rate unknown` for that source.
17. Rate sums follow filters. With sources robinhood M = $3/day, base W = $12/day: unfiltered `$15.00/day` (`$105.00/week`); chains `{base}` `$12.00/day`; wallet M `$3.00/day`; chains `{robinhood}` + wallet W gives no source (nothing in scope, no rate line figure).
18. Mixed known and unknown. robinhood known $3/day; arc unknown: line shows `$3.00/day` plus `Arc ...: rate unknown`, and states coverage (`1 of 2 sources`). It never adds an estimate for arc. Filtering to arc only shows only `rate unknown`.
19. Stale and short window. A stale source shows the stale badge text beside its rate; a source with `windowH` 3 includes `short window`. A genuine measured `perDayUsd:0` renders `$0.00/day`, not `rate unknown`.
20. Escaping. A fixture with pair/label/chain label `<img src=x onerror=alert(1)>` and wallet label `"><script>x</script>` produces no unescaped `<img`, `<script` or `onerror=` in `renderPage()` output across the totals row, rate line, and both breakdowns (assert on `&lt;` forms and that `renderPage` output has no `<img` / `<script`). The existing AST test in `aggregate-view.test.js` (no `eval`, no handler in markup, no non-GET fetch) still passes.
21. CSP and markup. The `/portfolio` HTML served by the router has the same `Content-Security-Policy` header as before (`AGG_CSP` byte-identical), no inline `<script>`, and `renderPage()` output contains no `on*=` attributes and no new `style=` attribute other than `--accent` ones.
22. Router-only. `git diff --name-only` against the base commit lists only files from this set: `aggregate.js`, `aggregate-view.js`, `aggregate.css`, `chain-router.js`, `README.md`, `SPEC.md`, `REPORT.md`, and files under `test/`. It lists none of `server.js`, `watch.js`, `dashboard.js`, `collector-base*.js`, `daily.js`, or other per-chain modules. `aggregate.PATHS` deep-equals the current four paths.
23. No new upstream calls. In `test/aggregate-router.test.js`, a full aggregation round makes exactly 4 GETs per chain, with the same four paths, no query string; no request to `/api/daily`.
24. Whitelist. `ingest("positions", raw)` and `ingest("watch", raw)` with extra fields (`operator`, `rpc`, a long `earned.note` string) output only the whitelisted fields; `earned` yields only `{perHour, rateWindowH}`.
25. Full suite: `npm test` exits 0 (all tests plus eslint, no warnings added). New tests live in the aggregate test files above.
26. Live read-only check (manual, recorded in the report): for 8787, 8796, 8797, `/api/positions` and `/api/watch` GETs show whether `dailyUsd`/`rateWindowH` and `earned.perHour` are present; the dashboard `/api/aggregate` payload from a local router run against these shows `rates` entries consistent with them (unknown where absent). Nothing is POSTed or written.
