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
