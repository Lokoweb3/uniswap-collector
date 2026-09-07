# LP Positions

A local dashboard for Uniswap v3 positions, plus an optional collector that
sweeps fees to ETH. Runs in WSL.

## Dashboard

```bash
chmod +x *.sh
npm install
./run-dashboard.sh       # then open http://localhost:8787 in Windows
```

WSL forwards Windows localhost into the distro, so the Windows browser reaches a
server bound to 127.0.0.1 inside WSL. If your setup has that forwarding
disabled, `./run-dashboard.sh 8787 --lan` binds to all interfaces instead —
which also exposes it to your local network, so prefer the default.

Reads load no key. Your RPC endpoint stays in the Node process and is never
handed to the browser, which also means no CORS to fight.

The site has two pages: the dashboard at `/` (tiles, Positions panel for every wallet, Portfolio) and
`/analytics` (collected fees and daily revenue). A wallet picker in the header switches the dashboard
between the main wallet, all wallets, and each watched wallet; see "Watching other wallets" below.

The page can also drive the collector: a Collect button runs
`run-collector.sh collect` on this machine, and an Arm form caches the operator
passphrase into the same `/dev/shm` window `unlock.sh` uses (verified against
the keystore first). Both endpoints are loopback-only; the arm endpoint stays
loopback-only even with `LP_ALLOW_REMOTE_COLLECT=1`. No key material ever
reaches the browser — the passphrase passes through it once, on localhost, when
you arm. The server also keeps local ledgers next to the code
(`fee-events.json`, `fee-snapshots.json`, `fee-daily.json`, `backfill.json`,
`liquidity-ledger.json`, `portfolio.json`)
for earnings history, accrual rates, daily revenue, and PnL — data files, safe
to delete, rebuilt on their own (the backfill via Blockscout's API, slowly;
`fee-daily.json` only from the moment it is deleted, since it is a running
ledger of fee accrual read off the five-minute snapshots). The collected-fees panel
breaks earnings down by calendar month (browser-local time); picking a month
(or opening `/?month=2026-09`) narrows the headline total, the chart, the
collects table, and the CSV export to it. Each collect is valued at the prices
of its moment once the scanner sees it — pool state at its block while the RPC
still serves it (about an hour), else the nearest five-minute fee snapshot,
which carries a per-token price table — and that value is locked in
`fee-prices.json`. Collects from before this existed have no price record and
are shown with ≈ at today's prices. Dollar figures use
current prices, and collects in pairs no longer held are counted as unpriced.
A position's PnL basis (its deposits and withdrawals) is read from the
chain itself: `ledger.js` scans the position manager's logs through the RPC,
forward every tick and, once, backward from the collector's start block to
each open position's mint (`liquidity-ledger.json`; about an hour for a
week-old position at this RPC's pace). Blockscout is not trusted for this
because its index has dropped whole transactions on this chain; its basis
is used only until the chain scan reaches a position's mint, and refetched
if the chain changes meanwhile (its anonymous API allows ten requests an
hour, three per position, so that is slow; a free key from dev.blockscout.com
in `BLOCKSCOUT_API_KEY (or LP_BLOCKSCOUT_KEY)` lifts the limit). Either way a basis is marked
approximate (≈) while it disagrees with the live liquidity, which on the
chain ledger means only that the next tick has not run yet.
A Daily revenue panel shows fees as they accrue per pool and per local day,
independent of when they are collected, next to what the collect runs actually
swept that day, with today-so-far, yesterday, 7-day average, and month-to-date
figures.
A projection tile carries today's accrual rates forward 7 and 30 days for
positions open at least a week (younger ones are listed as not projected).
Each card also shows its time in range — the share of observed time spent
earning, from a persistent log of range entries and exits in
`range-log.json` (gaps in observation are not counted) — and once a day of
that history exists the projection is the in-range rate weighted by it, for
idle positions too. Without it, idle positions count at zero. It is a run
rate, not a forecast, and says so.

Uniswap v4 positions show up alongside v3 ones, tagged `v4`, when
`contracts.v4` is set in `config.json` (position manager, StateView, pool
manager — from the Uniswap deployments page). v4 has no owner enumeration, so
ids come from Blockscout's holdings list plus a forward scan of Transfer logs
kept in `v4-positions.json`. Value, range, and uncollected fees (liquidity ×
fee-growth delta, via StateView) work the same as v3; native-ETH pools are
priced as WETH and pools against the reference stable at a dollar. Read-only:
the collector does not collect v4 fees, so v4 cards never show `collectable`
or `not approved`, and v4 collects do not appear in the collected-fees history
(the daily revenue panel covers their earnings as they accrue).

Every number is derived from pool state — no third-party price API. Position
value comes from `liquidity` plus the pool's `sqrtPriceX96` run through
Uniswap's own tick math; uncollected fees come from a `collect` static call,
which pokes the pool internally and so reflects fees accrued right up to the
current block rather than the stale `tokensOwed` on the position struct.

The range rail is the point of the thing. Ticks are logarithmically spaced, so a
linear position on the rail is a true log position on price, and the centre mark
is the geometric midpoint — the price at which a position sits 50/50 by value.
Positions within 12% of a bound are flagged. Idle positions show the move needed
to start earning again rather than a percentage that means nothing while out of
range.

Tokens not paired with WETH are shown without a dollar value rather than a
guessed one.

## Portfolio

The Portfolio panel lists every token the wallet holds, wherever it sits:
in the wallet, inside open positions, or as uncollected fees, with a price,
a dollar value, its share of the whole, and the 24-hour price change. The
headline total is wallet plus positions plus fees, and an hourly series of
that total (split the same way) is kept in `portfolio.json` and charted.
Tokens are found through Blockscout's holdings list for the wallet (only a
hint, refreshed every six hours) plus every token seen in a position and any
address listed under `portfolio.tokens` in `config.json`; balances and
prices always come from the chain. A token is priced through the deepest v3
pool it shares with WETH, else with USDG, and only if that pool holds a
minimum of the quote token, so an airdrop with a dead pool shows as
unpriced rather than as a fake number. Rows under a dollar are folded away
behind a link. The `portfolio` MCP tool returns the same view.

Pricing fallbacks, in order:

1. **Uniswap v3**: the deepest pool with WETH, else USDG, at the standard fee tiers.
2. **Uniswap v4 or v2**, whichever is deeper in USD. v4 has no factory, so pool keys are
   enumerated: quotes native ETH / WETH / USDG, the common (fee, tickSpacing) tiers, and hooks =
   none plus `contracts.v4.pricingHooks` (the Pools.trade launchpad hook is listed; SEAL/ETH lives
   there). Liquidity checks go through Multicall3 in one call per token; depth is the quote-side
   virtual reserve at the current price. The v2 pair comes from `contracts.v2Factory`
   (reserves-based price, same depth floor).
3. **`portfolio.priceVia`** maps a token to the token it is redeemable for 1:1 (sNET, the rebasing
   StakedNET receipt from the NET Staking contract, is priced as NET); such rows show "as NET" next
   to the price. Add other staked or wrapped receipts the same way.

The pool chosen per token is cached six hours in `portfolio.json`.

## Asking questions about the data

`lp-mcp.mjs` is an MCP server that exposes the dashboard's read-only data as
five tools — `positions`, `collects`, `daily_revenue`, `wallet_balances`, `portfolio` — so
Claude Code or Claude Desktop can answer questions from the live numbers. It
fetches from the running dashboard over loopback and cannot sign, collect, or
reach the operator key. The dashboard must be running.

Claude Code (already registered on this machine, user scope):

```bash
claude mcp add lp-dashboard -s user -- node /home/<user>/uniswap-collector/lp-mcp.mjs
```

Claude Desktop on Windows, in `%APPDATA%\Claude\claude_desktop_config.json`
(the server runs inside WSL):

```json
{ "mcpServers": { "lp-dashboard": {
    "command": "wsl.exe",
    "args": ["-e", "node", "/home/<user>/uniswap-collector/lp-mcp.mjs"] } } }
```

`LP_DASHBOARD_URL` overrides the dashboard address and `LP_TZ` the timezone
used for day and month grouping (default America/New_York).

### From claude.ai and the Claude mobile app

Those run on Anthropic's servers, so the tools have to be reachable over the
internet. `lp-mcp-remote.mjs` serves the same four tools over HTTP behind its
own OAuth login (claude.ai registers itself, you type a passphrase once, it
gets a token that refreshes on its own). It binds to loopback; a tunnel gives
it a public HTTPS address. Steps:

```bash
node lp-mcp-remote.mjs --set-passphrase        # once; 12+ characters
./run-tailscale.sh                             # user-space Tailscale + Funnel on 8788
echo 'LP_MCP_PUBLIC_URL=https://<machine>.<tailnet>.ts.net' > .env.mcp
./run-mcp-remote.sh
```

The dashboard itself has a private URL on the same node,
`https://<your-node>.<your-tailnet>.ts.net:8443`, served to tailnet devices
only (not Funnel): install Tailscale on a phone or laptop, sign in with the
same account, and open it. Requests arrive from loopback, so the Collect
button and Arm form work there too; that is why it must never be put on
Funnel.

This machine is set up already: Tailscale's static build lives in
`~/.local/tailscale` (no root needed, user-space networking), the node is
`lp-dashboard`, and the connector URL is
`https://<your-node>.<your-tailnet>.ts.net/mcp`. After a WSL restart run
`./start-all.sh`, which brings up the dashboard, the tunnel, and this server.
The first Funnel start on a fresh tailnet needs two approvals in the browser
(device login, then "Enable Funnel"), and public DNS for the name can take ten
minutes to appear.

Then in claude.ai: Customize → Connectors → Add custom connector, URL
`https://<that address>/mcp`. Sign in with the passphrase when asked. The
connector works in the web, desktop, and mobile apps. It answers only while
this machine, WSL, the dashboard, the tunnel, and this server are all up.
State lives in `mcp-auth.json`: the passphrase as a scrypt hash, and issued
tokens and codes as SHA-256 hashes, so the file is not a credential if it
leaks. Re-running `--set-passphrase` logs every client out. Only the Claude
apps' OAuth callbacks (claude.ai and Claude Code's loopback) are accepted at
registration, so nobody can register a client that routes your sign-in to
their own site. Five wrong passphrases from one address lock that address out
for 15 minutes. The sign-in page refuses to be framed. Token symbols read
from chain are reduced to plain printable characters before they reach any
page or tool output. If you wrote the passphrase to `.mcp-passphrase.txt`,
move it to a password manager and delete the file.

### From an agent on a server

A program with no browser cannot use the sign-in page. Issue it a
long-lived bearer token instead, from this machine:

```bash
node lp-mcp-remote.mjs --issue-token my-agent --days 365   # prints the token once
./start-all.sh                                             # or restart the remote server
```

The agent then talks Streamable HTTP to `https://<that address>/mcp` with
the header `Authorization: Bearer <token>`. It gets the same four read-only
tools and nothing else. `--list-tokens` shows what is issued and
`--revoke-token my-agent` cuts one off (restart after either change, since
the running server keeps the state in memory). The token is stored hashed,
so it cannot be recovered from the file; issue a new one if it is lost.

## Moving the read-only stack to a VM

Ledgers only record and the phone connector only answers while the dashboard
server runs, so the read-only half belongs on an always-on machine. The
collector and keystore stay where you sit. `deploy-vm.sh root@<ip>` does the
move onto a fresh Ubuntu VM: Node, Tailscale, a firewall admitting only SSH,
an unprivileged `lp` user, code and data, and two systemd services
(`vm/*.service`). The VM runs the dashboard with `LP_READONLY=1`, which hides
the Collect button and Arm form and refuses those endpoints. It joins the
tailnet as `lp-dashboard`, so the connector URL and the private dashboard URL
carry over; the script renames this machine to `lp-pc` first. After every
collector run, `sync-to-vm.sh` (configured in `.env.sync`, called from
`run-collector.sh`) pushes `state.json` and `collector.log` so the VM's ops
strip stays current. Re-running the deploy script updates the code.

## Blockscout API key

Every Blockscout call goes through `blockscout.js`. Put a free PRO key (https://dev.blockscout.com, value
starts with `proapi_`) in `.env` as `BLOCKSCOUT_API_KEY=…` and restart: requests then use
api.blockscout.com with Bearer auth at 5 requests/second instead of the anonymous explorer's ~10 per 15
minutes, which removes the throttling on holdings discovery for watched wallets and on the PnL basis
backfill. The key never leaves the server process.

## Collector

Uniswap v4 positions are collected too (`collect-v4.js`, `v4Collect.enabled` in config.json): a
`modifyLiquidities` call that decreases 0 liquidity and takes both currencies to the recipient. It needs
the operator approved on the v4 PositionManager once, from the owner wallet. Two ways: the browser pages
`approve-v4.html` / `approve-v3.html` (open http://127.0.0.1:8787/approve-v4 or /approve-v3 while the dashboard
runs, or `npm run approve` for a standalone server on :3333 serving both; the v3 page grants the same blanket
approval on the v3 NonfungiblePositionManager; connect the owner wallet in MetaMask, the page checks the network, the
account and the current approval, shows the exact calldata, and signs `setApprovalForAll` in the wallet so
no key touches the server; addresses come from config.json and the operator keystore's public address via
`/api/v4-approval`), or `node approve-operator.js --v4` on the command line (`--v4 --check` reads the state). Native ETH fees are wrapped to WETH above the gas reserve so the
normal swap-and-sweep handles them. Each collect is static-called first and skipped if it would revert.


Collects fees, swaps the non-WETH side into WETH, unwraps it, and sweeps ETH to
your main wallet.

## What happens to collected fees

`sweep.target` in `config.json` decides. `ETH` (the original behaviour):
every collected token is swapped to WETH through the pool it came from, the
WETH is unwrapped, and ETH above the gas reserve is sent to
`sweepDestination`. `USDG`: the same consolidation into WETH, then the
operator's ETH gas float is topped up from WETH if it has slipped under
`keepGasReserveEth`, the remaining WETH is swapped to USDG through the
WETH/USDG pool at `targetFeeTier` and delivered straight to
`sweepDestination`, and any USDG that arrived as fees is forwarded as-is.
`maxSwapValueWeth` and `slippageBps` apply to that last swap too. Only the
`full` mode converts; `collect` sends the raw tokens to the owner. The
Windows task and the dashboard's Collect button (`dashboard.collectMode`)
are both set to `full`. Simulate mode prints what the eligible fees would
convert to.

## Before anything else

**Chain: RESOLVED — Robinhood Chain mainnet, chainId 4663.** config.json now
carries the verified Uniswap v3 deployment for it (the position manager
self-reports the factory and WETH9 on-chain, and CASHCAT/WETH pools exist with
live liquidity). The original warning is kept below for context.

**Verify your chain.** Your Uniswap position URLs contain `/robinhood/`, which
is a chain slug and is not Ethereum mainnet. Revert reports "mainnet /
ethereum". These disagree. The contract addresses in `config.json` are Ethereum
mainnet defaults. If your positions live on another chain, the position manager,
router, quoter, and WETH addresses are all different, and running this as-is
will fail or, worse, interact with an unrelated contract. Confirm first.

## Security model

The script runs as a separate **operator** wallet that is not your position
owner. Its entire balance is a small gas float. If the operator key leaks, the
attacker gets the float plus whatever fees happen to be mid-flight.

What the operator can do, once approved:

- `collect` your fees — but the `recipient` is set from config, and in
  collect-only mode goes straight to your main wallet.
- `decreaseLiquidity` and `transferFrom` on any position it is approved for.
  **This is the real exposure.** `setApprovalForAll` grants it across every
  position including future mints; per-`tokenId` approval limits it to the ones
  you name.

  This setup uses **blanket `setApprovalForAll`** (granted 2026-09-01), chosen
  deliberately: with every open position already approved per-token the blanket
  added marginal exposure only for future mints, position churn here is high
  enough that per-mint approvals were a recurring chore, and the approval
  workflow kept pulling the owner key onto this machine — a worse habit than
  one clean wallet-signed grant. Revoke any time with
  `setApprovalForAll(operator, false)` from the owner wallet. The consequence:
  treat the operator keystore and its unlock windows as guarding the full
  position set, not just a gas float.

One WSL-specific thing worth knowing: **the WSL filesystem is readable from
Windows**, via `\\wsl$\` and the `\\wsl.localhost\` path. Unix permissions on
your keystore protect it from other Linux users, but not from a Windows process
running as you. Keep BitLocker on and treat the operator key as a hot key
regardless of which side of the boundary it sits on.

Full mode routes collected fees through the operator wallet, because the
operator must hold the tokens to swap them. That is a real (if brief) hot-wallet
exposure that collect-only mode avoids entirely.

## Setup

```bash
chmod +x *.sh systemd/install.sh   # exec bits are lost in transit
npm install
./setup-key.sh                     # generates the operator wallet
```

Then:

1. Put a real RPC endpoint in `config.json`. For full mode, a protected endpoint
   (Flashbots Protect or similar) meaningfully reduces sandwich risk on the
   memecoin swaps.
2. Set `ownerAddress` and `sweepDestination` to your main wallet.
3. Send ~0.01 ETH to the operator address for gas.
4. From your main wallet, approve the operator on the position manager.

`setup-key.sh` refuses to write keys under `/mnt/c` or any other Windows drive.
Those mounts do not enforce Unix permissions by default, so `chmod 600` there is
decoration — the file stays world-readable. Keys belong on the ext4 side.

## Running

```bash
./run-collector.sh simulate   # read-only, sends nothing, needs no passphrase
./run-collector.sh collect    # collect to owner, no swapping
./run-collector.sh full       # collect, swap, unwrap, sweep
```

**Run simulate for several days first.** Reconcile its output against Revert's
uncollected fees per position. `collect.staticCall` pokes the pool internally
before computing amounts, so it reflects fees accrued to the current block, not
the stale `tokensOwed` on the position struct. The numbers should line up
closely. If they don't, stop and work out why before sending a transaction.

Then run `collect` for a while. Only move to `full` once you trust it.

## Unlocking

There is no DPAPI equivalent here, and no secrets service worth relying on in a
default WSL install. Rather than leave a passphrase sitting in a dotfile, the
keystore is unlocked for a window:

```bash
./unlock.sh          # 120 minutes
./unlock.sh 1440     # a day, for a scheduled run
./unlock.sh --lock   # forget it now
```

The passphrase is verified against the keystore before caching (a typo surfaces
now, not at 9am) and held in `/dev/shm`, which is RAM-backed and never written
to disk. It is discarded when the window expires. A scheduled run that finds no
live unlock logs and exits rather than prompting into the void.

The tradeoff is explicit: fully unattended operation requires a passphrase at
rest somewhere. This trades some automation for not having one.

The WSL and Windows setups cannot share an operator wallet. DPAPI-sealed
passphrases are not readable from Linux, and a keystore under `/mnt/` has no
enforced permissions to protect it. Running both leaves you with two operator
addresses, only one of which is approved on your positions. Pick a side.

## Scheduling

Two options. The Windows one is more reliable.

**Windows Task Scheduler (recommended).** It can start WSL; a timer inside WSL
only fires if WSL is already running, and WSL shuts itself down when idle.

```powershell
powershell -ExecutionPolicy Bypass -File .\windows-task.ps1
```

Pass `-Distro`, `-LinuxDir`, `-Mode` or `-At` to override the defaults.

**systemd timer**, if you have systemd enabled in WSL (`[boot] systemd=true` in
`/etc/wsl.conf`, then `wsl --shutdown`):

```bash
./systemd/install.sh
```

It enables lingering so the timer survives closing your terminals, and uses
`Persistent=true` to catch up a run missed while WSL was down. Fees keep
accruing regardless of when you sweep, so a late run costs nothing.

## Output

Everything goes to `collector.log` with transaction hashes. `state.json` holds
the rolling gas budget. Both are gitignored, along with the keystore and the
sealed passphrase — but check `.gitignore` is intact before you ever
`git add .` in this directory.

## Known limitations

- The dashboard's tick math is derived by fixed-point exponentiation rather than
  Uniswap's constant table. It matches the published anchors at tick 0, MIN_TICK
  and MAX_TICK, and reproduces reported position splits to four significant
  figures, but can differ by a couple of ulps at extreme ticks. Fine for
  display; do not use it to build calldata.
- Position age is not shown. It needs a Transfer-event log query, which many RPC
  providers rate-limit or cap by block range.

- Swaps route through the fee tier of the position the token came from, single
  hop. Fine for CASHCAT/WETH and PONS/WETH. A token with better liquidity
  elsewhere would get a worse fill than the Uniswap UI's smart router gives you.
- Positions where neither token is WETH will collect but not swap.
- Sequential, not batched. Six positions is six collect transactions. At
  sub-0.1 gwei that is negligible; at 30 gwei it would not be.
- Both PONS positions now sit in different fee tiers on the same pair. The swap
  leg maps a token to the fee tier of the first position it sees holding it, so
  that mapping is ambiguous for PONS. Denylist one of them, or the swap may
  route through the thinner pool. It will fail on `amountOutMinimum` rather than
  fill badly, but it will fail.
- No MEV protection beyond `amountOutMinimum` unless you point `rpcUrl` at a
  protected endpoint.

## Public URLs with a passphrase (lp-gate.mjs)

`lp-gate.mjs` puts a login page in front of the dashboard and the pool scanner so they can be
published with Tailscale Funnel and used from any browser, no Tailscale app needed:

| Site | Public URL | Gate port | Upstream |
|---|---|---|---|
| LP dashboard | https://<your-node>.<your-tailnet>.ts.net:8443 | 127.0.0.1:8790 | 127.0.0.1:8787 |
| Pool scanner | https://<your-node>.<your-tailnet>.ts.net:10000 | 127.0.0.1:8791 | 127.0.0.1:3847 |

The passphrase is the remote MCP server's (`node lp-mcp-remote.mjs --set-passphrase` changes both). A login
sets a signed cookie for 30 days; the signing secret is `gate-state.json` (delete it to log every browser out).
Only GET/HEAD reach the dashboard and `/api/collect`, `/api/unlock`, `/api/lock` are refused outright, because
those endpoints trust loopback and everything behind a proxy is loopback. The scanner also accepts
`POST /api/chat` and `/api/chat/reset`. Five wrong passphrases lock an address for 15 minutes; `gate.log` records logins.
`start-all.sh` starts the gate; `run-tailscale.sh` publishes the two Funnel ports. `/__gate/logout` signs out.

## Watching other wallets

`wallets.json` (copy `wallets.example.json`; gitignored) names the wallets: `owner.label` for the
collector's wallet and `watched`, a list of `{"address": "0x...", "label": "name"}` entries shown
read-only. `watchWallets` in `config.json` is the fallback when the file is absent. Both are re-read on
every refresh, so editing needs no restart. Watched wallets are observed only: no fee snapshots, PnL, range log or collects, and the
collector never touches them. The owner wallet is skipped if listed.

For each watched wallet the server reads its open v3/v4 positions (pool, fee tier, in-range status,
distance to the edges, price range, value, uncollected fees) and values the tokens sitting in the wallet
itself (discovered and priced like the Portfolio panel, via `portfolio.holdingsOf`). `GET /api/watch`
returns the cached JSON at once (`fresh=1` starts a background rebuild and returns the current cache with
`refreshing: true`; the tick rebuilds every 10 minutes anyway), and the MCP server has a `watched_wallets` tool.

### Wallet picker

The page header has a wallet picker: **All N wallets** (the default), **Main wallet (0x…)**, then each
watched wallet by label. `#scope=all` or `#scope=0x…` in the URL picks it; the choice is remembered per
browser. The picker scopes the whole page:

- **All wallets**: everything, with the headline tiles and the Portfolio summed across wallets.
- **Main wallet**: the page as it was before watched wallets existed.
- **A watched wallet**: only that wallet's tiles ("Held by", positions count, uncollected fees, out of
  range), its positions and its Portfolio. The collector's own panels (chips, Collect button, position
  cards, closed positions, collectable / PnL / projection tiles, value chart) exist only for the main
  wallet and are hidden.

### Positions panel

Every wallet's positions live in one "Positions" panel under the tiles, grouped per wallet with a header
line (total, tokens, in pools, uncollected, open count; top priced tokens beneath). The main wallet comes
first with its full cards and the closed-positions toggle; watched positions render as compact two-column
cards with the same log-scale range rail, price flag, edge distances, composition bar and fee amounts
(full-range positions are badged instead of showing 0 to ∞ edges). Cards and tiles share one look: white
border, soft shadow, brighter on hover.

### Portfolio scope

The Portfolio panel follows the picker: the watched wallets' tokens and position holdings are merged into
the same per-token table client-side (amounts summed, price and 24h change per token). The hourly value
chart is the main wallet's only.

## Analytics page

`/analytics` (same `dashboard.html`, view picked from the path; the header has a Dashboard / Analytics
switch) is the income and history page:

- **Performance**: income over 30 days, LP fees over 7 days, this month, year to date, average earned per
  day and best day (from the accrual ledger), staking rewards over 30 days, all-time fees.
- **Income for taxes**: per year and month, LP fee collects (USD at the moment of receipt; ≈ marks rows
  valued at today's price for lack of a record) and staking rewards (USD at each rebase), with a
  "Download tax CSV" of every income event (date, type, description, amounts, USD, price basis, tx).
  Fees taken on a close are included, the principal is netted out. A record, not tax advice.
- **Collected fees** (chart, by-month table, position-value chart, collects table, CSV) and **Daily revenue**.
- **Staking rewards**: `staking.js` samples each rebasing receipt listed under `staking.tokens` in
  config.json (sNET from NET Staking) hourly into `snet-staking.json`; history is rebuilt once from the
  token's LogRebase events. A balance change matching the index change is a reward, anything else is a
  stake/unstake and is skipped. `/api/staking` serves the view.

All of it is the collector wallet's own history, so the wallet picker is hidden there. Each page fetches
only what it shows. The public gate serves the page at the same path.

## Changelog

### 2026-09-07 (overnight)

- Git repository with a hardened .gitignore; nightly ledger backup to the VPS (`backup-ledgers.sh`,
  `nightly.sh`, 02:00); `start-all.sh` exports `./.env` to the server.
- Telegram alerts (`alerts.js`): out of range / back in range, failed or locked-skipped collect, missing
  09:00 run, locked collector before the run, missing keepalive session, outage on restart.
- Wallet labels in `wallets.json`; picker, tiles and Positions panel use them.
- Uniswap v4 fee collection (`collect-v4.js`, `approve-operator.js --v4`).
- Shared Blockscout client with PRO key (`blockscout.js`, `BLOCKSCOUT_API_KEY`).
- Phone layout at 375px; `/api/watch` serves the cache and rebuilds in the background.
- Staking rewards ledger (`staking.js`) and Analytics page: Performance, Income for taxes with CSV,
  Staking rewards.
- v4 pool keys learned from a token's own swaps (Bucket, BULLIONS priced); more launchpad hooks.
- Dark glassmorphism theme.

### 2026-09-07

- Watched wallets: three wallets configured with labels (Wallet 1/2/3); each shows token holdings value,
  positions and a total; full-range positions display as "full range".
- Wallet picker in the header scopes tiles, Positions panel and Portfolio; "All wallets" is the default;
  the main wallet is named with its address everywhere.
- Positions panel: main wallet's cards moved in as the first group; watched positions became cards with
  rails; white-bordered card style applied to position cards and the summary tiles (hero card + grid).
- Portfolio pricing: Uniswap v4 pools (key enumeration, Multicall3) and Uniswap v2 pairs as fallbacks;
  `priceVia` for 1:1 receipts. Fixed the missing staked NET (sNET) and Wallet 1's SEAL.
- Analytics page at `/analytics` for Collected fees and Daily revenue; removed from the main page.
- Bug fixes: full-range edge noise, page selector hiding table cells that used the `wrap` class, a
  script-order error on the analytics page, stale "no pool" cache entries after pricing changes.

### 2026-09-06

- Public passphrase gate (`lp-gate.mjs`) for the dashboard and scanner over Funnel.
- `watchWallets` support, `/api/watch`, `watched_wallets` MCP tool.
- Windows keepalive task so WSL no longer stops the servers.
