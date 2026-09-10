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

The site has three pages: the dashboard at `/` (tiles, Positions panel for every wallet, Risk,
Portfolio), `/analytics` (income, taxes, attribution, staking, vault tile) and `/wallet`, whose tabs
hold everything that needs your wallet: `#arm` (arm the collector with a wallet signature),
`#approvals` (allowance and operator audit with revoke buttons, plus the v3 / v4 operator approvals),
`#vault` (the LOKOVault page) and `#operator` (operator status and loop health). The old addresses
(`/arm`, `/approvals`, `/approve-v3`, `/approve-v4`, `/treasury`, `/vault`) redirect to their tab. A wallet picker in the
header switches the dashboard between the main wallet, all wallets, and each watched wallet; see
"Watching other wallets" below.

`./start-all.sh` starts one process, `node server.js`, which is everything: the dashboard, the
10-minute tick (alerts, pool scout, price log, state snapshots, daily summary, weekly digest), the
risk guardian (every 60 s), fee auto-collect (every 15 min), the nightly ledger backup (02:00 local)
and the supervisor for the companion services it starts as children and restarts if they exit: the
public gate, the remote MCP server, the Tailscale funnel and the pool scanner. One log: `server.log`.
`./stop-all.sh` stops it. `npm test` checks all of it.

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
`contracts.v4` is set in `settings.json` (position manager, StateView, pool
manager — from the Uniswap deployments page). v4 has no owner enumeration, so
ids come from Blockscout's holdings list plus a forward scan of Transfer logs
kept in `v4-positions.json`. Value, range, and uncollected fees (liquidity ×
fee-growth delta, via StateView) work the same as v3; native-ETH pools are
priced as WETH and pools against the reference stable at a dollar. With
`v4Collect.enabled` the collector collects v4 fees too (see Collector); v4
collects are recorded in `v4-collects.json` and appear in the collected-fees
history, and `ledger-v4.js` reads each v4 position's deposits, withdrawals and
owner-side collects from the PoolManager's ModifyLiquidity events (amounts from
the liquidity math at the pool price of that block: the RPC's state while it
still has it, else the nearest Swap, the Initialize price, or the current state
when no swap has happened since; rows it cannot price stay unpriced), so v4
positions get the same PnL legs and strategy data as v3.

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
address listed under `portfolio.tokens` in `settings.json`; balances and
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

### The agent (`agent.js`): one brain, three front doors

One assistant answers the web chat panel, the Telegram bot and local scripts, from
the same tools the MCP server exposes (in-process), with memory on disk:

- **Memory.** `agent-memory/<channel>.json` keeps the last ~40 turns per channel
  (`web`, `telegram:<chatId>`, `loopback`); `agent-notes.md` is a short file the
  agent keeps about your standing decisions and preferences, read into every prompt
  and editable through its `update_notes` tool. Both are gitignored and in the nightly
  backup. Every alert the dashboard sends to a Telegram chat is appended to that chat's
  transcript, so "approve it" resolves to the sale it just told you about.
- **Roles by channel, not by request.** Web panel (through the gate, or any browser)
  = read only. Telegram from your personal chat (`alerts.fallbackChat`; more under
  `alerts.agentChats` with a role) = read + approve/reject a pending sale + notes.
  A script on loopback (no browser headers) = full, `record_strategy_proposal`
  included. A sale is only ever decided when the message being answered says
  approve/reject; an alert's own wording never triggers it. Nothing on any channel
  can arm, collect, close, or change rules.
- **Telegram** (`telegram.js`): long-polls `TELEGRAM_AGENT_TOKEN`, else the alert
  bot's `TELEGRAM_TOKEN`, answers only allowed chats, ignores strangers, `/reset`
  and `/status`. Only one process may poll a bot token: if another agent already
  polls it (Telegram answers 409), this one backs off a minute at a time and says so
  in `server.log`; give it its own bot via `TELEGRAM_AGENT_TOKEN` to run both.
- **Web panel** (`chat-widget.js`): every page has a 💬 button (bottom right; `/#chat`
  opens it). Through the passphrase gate it works on the phone too (`POST /api/chat`
  is the one write the gate lets through). `GET /api/chat` shows provider, channels
  and the Telegram poll health. Scripts may pass `channel` in the body.

Credentials live in `.env` and pick the provider:

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Claude through the official SDK (default model `claude-opus-5`, effort `CHAT_EFFORT`, default medium) |
| `OLLAMA_API_KEY` | Ollama Cloud at https://ollama.com (default model `gpt-oss:120b`) |
| `OLLAMA_HOST` | a local or remote Ollama instead of the cloud |
| `CHAT_PROVIDER`, `CHAT_MODEL` | force a provider / pick another model |

When `.env` has neither key, `start-all.sh` reuses the scanner's chat settings from
`$SCANNER_DIR/.env` or `~/.config/robinhood-lp.env`, so one key serves both chat panels.
Sessions are kept in RAM per browser (two hours, last 40 turns); `↺` starts over.
`GET /api/chat` reports the provider and whether it is configured.

### MCP server (`lp-mcp.mjs`)

`lp-mcp.mjs` is an MCP server that exposes the dashboard's read-only data as
twenty tools (`positions`, `collects`, `daily_revenue`, `wallet_balances`, `portfolio`, and fifteen added since, ending with `status_report`, `position_history`, `price_history`, `pool_scout_history`, `token_lots`, `record_strategy_proposal`, `strategy_track_record`) so
Claude Code or Claude Desktop can answer questions from the live numbers. It
fetches from the running dashboard over loopback and cannot sign, collect, or
reach the operator key. The dashboard must be running.

Claude Code (already registered on this machine, user scope):

```bash
claude mcp add lp-dashboard -s user -- node ~/uniswap-collector/lp-mcp.mjs
```

Claude Desktop on Windows, in `%APPDATA%\Claude\claude_desktop_settings.json`
(the server runs inside WSL):

```json
{ "mcpServers": { "lp-dashboard": {
    "command": "wsl.exe",
    "args": ["-e", "node", "~/uniswap-collector/lp-mcp.mjs"] } } }
```

`LP_DASHBOARD_URL` overrides the dashboard address and `LP_TZ` the timezone
used for day and month grouping (default America/New_York).

### From claude.ai and the Claude mobile app

Those run on Anthropic's servers, so the tools have to be reachable over the
internet. `lp-mcp-remote.mjs` serves the same tools (twenty, see
"From an agent on a server") over HTTP behind its own OAuth login (claude.ai registers itself, you type a passphrase once, it
gets a token that refreshes on its own). It binds to loopback; a tunnel gives
it a public HTTPS address. Steps:

```bash
node lp-mcp-remote.mjs --set-passphrase        # once; 12+ characters
./run-tailscale.sh                             # user-space Tailscale + Funnel on 8788
echo 'LP_MCP_PUBLIC_URL=https://<machine>.<tailnet>.ts.net' > .env.mcp
./run-mcp-remote.sh
```

The dashboard itself is reachable from anywhere at
`https://<your-node>.<your-tailnet>.ts.net:8443` behind the passphrase gate
(see "Public URLs with a passphrase"); through the gate it is read-only, so
arming, collecting, closing and revoking stay on the dashboard machine.
claude.ai caches a connector's tool list: after new tools are added,
reconnect the connector in its settings to pick them up.

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

### Agents contributing code

Patches from an agent are merged here, never pushed by the agent. The rules that keep merges clean:
start from `origin/master` HEAD (`git fetch origin && git reset --hard origin/master` in the agent's
clone before every task; ids in `settings.json` and the ledgers change daily), deliver with
`git format-patch origin/master --stdout`, and hand over the patch file; the merge runs `npm test`
(every suite plus the headless smoke test) and restarts the services. Nothing in a patch may touch
`.env`, keystores, or the runtime ledgers, and a patch that only re-derives facts already verified in
the brief it was given is sent back.

### From an agent on a server

A program with no browser cannot use the sign-in page. Issue it a
long-lived bearer token instead, from this machine:

```bash
node lp-mcp-remote.mjs --issue-token my-agent --days 365   # prints the token once
./start-all.sh                                             # or restart the remote server
```

The agent then talks Streamable HTTP to `https://<that address>/mcp` with
the header `Authorization: Bearer <token>`. It gets the read-only tools and
nothing else: `positions`, `watched_wallets`, `collects`, `daily_revenue`,
`portfolio`, `wallet_balances`, `memecoin_watch` (risk guardian status and rules),
`vault` (LOKOVault balance and splits), `staking`,
`attribution` (P&L breakdown and benchmarks), `weekly_digest` (the Monday
report text), `health` (armed state, last run, background loops) and `status_report` (one verified
end-of-day checklist: arm window, auto-collect rule, split in force, guardian, fees, gas, alerts),
plus the strategy dataset: `position_history`, `price_history`, `pool_scout_history` (below). Nothing
on the MCP can arm, collect, close or revoke; those stay on the dashboard
machine. `--list-tokens` shows what is issued and
`--revoke-token my-agent` cuts one off (restart after either change, since
the running server keeps the state in memory). The token is stored hashed,
so it cannot be recovered from the file; issue a new one if it is lost.

### Giving an agent the history for strategy work (`strategy.js`)

Live snapshots are not enough to design a strategy; the agent needs what happened. Three tools
(and `/api/strategy/positions|prices|scout`) assemble it from the ledgers:

- `position_history`: one record per position ever seen across every wallet, open and closed:
  opened/closed times and hours open, deposited and withdrawn USD (the liquidity ledger priced from
  the hourly log, else from that position's own collect-time price records, marked approximate),
  every collect (count, USD at collect time, per day), realized fee APR, time in range and flips,
  the price range and its width, PnL vs holding with its legs, the pool's TVL/volume/fees/APR, and
  for closed positions the net result versus the deposit. v4 positions take their deposits from
  `v4-liquidity-ledger.json`. Filters: wallet, include_closed, days.
- `price_history`: hourly USD (and ETH-relative) prices of a token while it was held or in a position.
- `pool_scout_history`: the scout's hourly record of each position's pool fee APR versus its best
  sibling pool.
- `record_strategy_proposal` and `strategy_track_record` (`strategy-track.js`): an agent records
  the advice it gives (items: wallet, pair, action, expected fees / APR / net result, a horizon in
  days); once the horizon passes the server scores each item against the position history (beat /
  met / missed / no data, 5% tolerance) and the proposal gets a score, the share of items met or
  beat. `record_strategy_proposal` is the one write on the MCP: it only appends to
  `strategy-proposals.json` on the dashboard machine (loopback route, refused by the gate). The
  "Strategy track record" section on Analytics shows every proposal and outcome.
- `token_lots`: cost basis of the fee tokens the collector handed back unconverted: one lot per
  hand-back from `collector.log`, priced at that hour, with per-token totals, average cost, value
  now and unrealized gain, plus `soldAtCollect` for the tokens `sell-v4.js` sold in their own pool
  (proceeds and skips from `token-sales.json`), and the realized side: outbound transfers of a
  handed-back token are found by a Blockscout scan every 6 h (`token-disposals.json`; a transfer
  into the protocol whose transaction swapped is a sale, any other outbound transfer not to your
  own wallets, the operator or the vault is a send, a liquidity deposit is neither) and consume
  lots FIFO, giving per-token disposed amount, proceeds at that hour's price, realized gain and
  the remaining amount, which unrealized then covers. Also the "Fee tokens received" table on
  Analytics (Realized and Remaining columns) with a per-lot CSV. Tokens swapped or sold at collect
  time are already income.

A prompt that works: "Use position_history for the last 14 days, group by pair and fee tier, rank
by realized fee APR and net result, note time in range and how long each was held, then propose
ranges and holding times for the next week and say what data is missing." Everything is read-only;
the agent can propose, not act.

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

## LOKOVault treasury split

`treasury.js` + settings.json (`treasuryTBA`, `feeSplitPct` default 10, `feeSplitMax` 20): after each wallet's
collected fees are swapped to USDG, `feeSplitPct` % is sent to the vault's token-bound account and the rest
to the wallet; if the vault transfer fails the wallet receives everything and the failure is recorded.
Every pass is appended to `fee-split-ledger.json` (served at `/fee-split-ledger.json`). Simulate mode
prints "Treasury split: … → LOKOVault TBA" and "Owner receives: …". The split is off until `treasuryTBA`
is set. `/wallet#vault` is the vault page (wallet-signed, no keys), `/api/treasury`
returns settings, the TBA's USDG balance and totals by month; the Analytics page has a LOKOVault panel
and the tax table/CSV carry the vault split. Alerts: three consecutive failed vault transfers, vault
balance ≥ `treasuryWithdrawAlertUsdg` (settings.json, default 1000 USDG; repeated every 6 h while it stays above), split % changed (on-chain value when the TBA exposes `feeSplitPct()`), sent to
`TELEGRAM_TREASURY_CHAT_ID` (default the group) with fallback to the main chat. The contracts
(`TreasuryNFT.sol`, `TreasuryAccount.sol`) and `deploy-treasury.js` are supplied
separately; `solc` is installed for the deploy script.

### Vault from your phone

Three URLs serve the same page (the Vault tab of `wallet.html`; `/treasury` and `/vault` redirect to it):

| URL | Works from | What you can do |
|---|---|---|
| `http://127.0.0.1:8787/wallet#vault` | the PC only | everything, with Rabby/MetaMask in the browser |
| `https://<your-node>.<your-tailnet>.ts.net:8443/wallet#vault` | anywhere (Funnel, passphrase gate) | read-only in a normal browser; withdraw / change the split when opened **inside Rabby mobile's in-app browser** (Rabby → Discover → paste the URL), which is what gives the page a wallet to sign with |
| `https://<your-node>.<your-tailnet>.ts.net:8444/wallet#vault` | devices logged into the tailnet (no gate) | same as above; the phone needs the Tailscale app for this one |

The desktop vault page shows both URLs as QR codes ("Open on your phone"; `qr.js` is a small self-contained
encoder, verified against a real decoder). Without a wallet the page loads the balances, split and history
read-only. `run-tailscale.sh` adds the tailnet-only :8444 serve; the public :8443 route passes through the gate.

The "Mobile access" card with the two QR codes is hidden on the page for now (`hidden` on
`#qr-card` in `wallet.html`) until a public domain replaces the tailnet address. The server
still reports the node's public name at runtime (`/api/vault-info` → `publicHost`, from
`LP_PUBLIC_HOST` or tailscaled), so removing the attribute brings the card back with the right
links; no hostname lives in a tracked file.

## Risk and automation

Everything in this section that can move funds is **off by default** and only ever signs with the
operator key while the collector is armed; proceeds always go to the position's own wallet.

### Risk guardian (`memecoin-guardian.js`)

The one watcher for every open position of every wallet, v3 and v4 (a 60-second timer inside
server.js; `npm run guardian` runs one cycle by hand). It reads each position and its pool from the chain, v4 every 60 s and
v3 every 5 min, keeps a 24-hour history and derives a status (`guardian-logic.js`). Positions listed
under `memecoins` in settings.json carry their own rule block; every other open position is discovered
from the dashboard (`memecoin-discovered.json`; entry price from the hourly price log at the mint,
else the first sample) and uses `memecoinDefaults`. `memecoinDiscovery: false` watches only the
listed entries. Prices are token per quote asset (ETH, or USDG for stable-paired pools).

One rule block per position, every field optional:

```json
{ "tokenId": "2239358", "pair": "Bucket/USDG",
  "alertPct": 20, "closePct": 50, "outOfRangeMinutes": 120, "tvlDropPct": 50,
  "feeFloorPerHour": 10, "collectedTargetUsd": 500, "autoClose": false, "alertOnly": true }
```

`alertPct`: the token down that much in 1 h sends a dump alert (repeats hourly while it holds).
`closePct`: down that much from entry sends a close-now alert, or closes the position when
`autoClose` is on. `outOfRangeMinutes`: out of range that long sends an alert, or closes with
`autoClose` (leaving and re-entering the range alert once each). `tvlDropPct`: pool liquidity that
far below its 24-hour high sends an LPs-leaving alert (once, again after 6 h if it persists).
`feeFloorPerHour`: the 15-minute fee rate under that many USD/h alerts once per episode (null = off).
`collectedTargetUsd`: the USDG swept for the position (`fee-split-ledger.json`) reaching it alerts
once. `alertOnly: true` is a safety latch: nothing closes whatever `autoClose` says. Every event is
exactly one Telegram message (group chat when `TELEGRAM_GROUP_CHAT_ID` is set, else the treasury chat,
falling back to the main chat). "Volume dying" (fees/h −70% in 30 min) shows on the card only, and is
skipped for an hour after a collect resets the fee balance.

It writes `memecoin-status.json`, served as `/api/risk` (alias `/api/memecoins`): the **Risk** section
on the dashboard lists every watched position with its status, the live reading next to each
threshold (click a threshold or the entry price to change it; `POST /api/risk`, loopback-only; listed
positions are updated in settings.json, discovered ones in `memecoin-discovered.json`), an auto-close
toggle and a "Close now" button. With auto-close on, a close (100% of the liquidity, both tokens to
the wallet that owns it; `close-position.js`, static-called first) runs only after the trigger has
held on three consecutive cycles with the pool price stable within 10% between reads, so one bad RPC
answer or a one-block wick cannot close a position; a failed or locked attempt restarts that
confirmation and is retried after a 30-minute cool-down. Closes and refusals go to
`memecoin-guardian-log.json`. Check entry prices against the mint transactions before enabling
`autoClose`.

### Selling fee tokens (`sell-v4.js`)

Launchpad tokens (LAPTOP, Bucket, CRUMBS, ...) have no v3 route, so the collector used to hand
them back unsold and the vault split never saw them. With `memecoinSell.enabled` the collector
sells them at collect time in the hookless v4 pool the fees came from (the pool key from the
position itself, native ETH as address zero), through the Universal Router's V4_SWAP command with
Permit2 pulling the input (exact-amount approvals, one hour). Policy: only when the batch is worth
at least `minUsd` (25); price impact against the pool's spot price capped at `maxImpactPct` (3),
with a batch over the cap trimmed to the largest slice under it and skipped when that slice is
under `minUsd`; `hold` lists tokens never to sell; hooked pools are never used; every hookless pool
the token was earned in plus the live ETH-quoted pools found by tier enumeration are quoted and the
best proceeds under the cap wins (`nativeQuoteOnly` restricts to ETH-quoted pools if ever needed).
This chain's Universal Router decodes the v4 exact-input struct with an extra empty `bytes` field
before the amounts (read from a swap the Uniswap app sent); the stock single-pool encoding reverts
with no data, so `sell-v4.js` encodes the path form with that field, then SETTLE and TAKE;
`thresholds.maxSwapValueWeth` and `slippageBps` apply; the exact call is dry-run from the operator
before it is sent. Proceeds (ETH or USDG) join the normal sweep, so the vault split and the wallet
delivery cover them. Every sale and every skip, with its reason, is written to `token-sales.json`
(backed up nightly) and shows in the daily summary and the `token_lots` tool.

### Fee auto-collect (`memecoin-collect.js`)

Every 15 min, as a timer inside server.js (`memecoinCollect` in settings.json: `minUsd` 50, `minIntervalMinutes` 15; re-read each cycle), it checks the
memecoin positions' uncollected fees (every v4 position in the main wallet and the collected watched wallets, plus the ids in `memecoins`) and, when one exceeds the threshold and the collector is armed,
runs the normal `./run-collector.sh full --quiet` (all wallets, vault split included), logs to
`memecoin-collect-log.json` and reports "💰 Collected …" per position. While locked it nudges once per
lock episode. It also verifies the first vault split (ledger entry, TBA balance, owner transfer) and
reports it once. The 09:00 task, the Collect button and this loop all start the same script, which
takes a lock file (`.collector.lock`, `flock`) so only one signing run happens at a time; a second
starter logs "another collector run is in progress" and exits. The server's watchdog knows when its
own timers last completed a cycle (guardian, auto-collect, backup); it alerts once when one is late
(10 / 45 min / 26 h) and once when it is back, and the dashboard shows a warning chip meanwhile.
`node memecoin-collect.js --once --dry-run` evaluates the trigger once against the running dashboard.

### Analytics additions

- **Attribution & benchmarks** (`attribution.js`, `/api/attribution?days=N`): daily P&L per wallet and
  position split into fees, price move, impermanent loss (a residual), staking rewards, vault splits and
  gas, with a stacked-bar chart and a benchmark table (portfolio vs holding ETH, USDG, or staking NET
  over 7/30/90 days; the note says when history is shorter). Watched positions also get "PnL vs HODL"
  (v3 from the shared liquidity ledger, v4 from first-seen amounts, marked ≈).
- **Range advisor and IL forecast** (`advisor.js`, `/api/advisor`): replays the pool's swaps for the
  last 7 days (RPC, grows across ticks) and shows on each card what the same capital would have earned
  in the actual, a 50% tighter and a 2× wider range, plus expected fees vs impermanent loss for the
  next 7 days from realised volatility (capped at 150%).
- **Pool scout** (`scout.js`): hourly; when a sibling pool's 24h fee APR beats the position's pool by
  50% for two consecutive days, one Telegram suggestion per week; `pool-scout-log.json`.
- **Auto-compound** (`compound.js`, `./run-collector.sh full --compound`): opt-in; after the vault's
  share, v3 fees are reinvested into the same position instead of swept; v4 positions are skipped.
  Not used by the scheduled run.

### Token health and the approvals audit

`token-health.js` scores every token held in any wallet (bytecode selectors for mint/pause/tax/admin,
live `paused()`/`taxEnabled()`/`owner()` reads, Blockscout holders/age/verification; cached 6h in
`token-health.json`, `/api/token-health`) and shows a 🟢/🟡/🔴 badge per Portfolio row. The Approvals tab of the Wallet page
(`/wallet#approvals`, `/api/approvals?owner=`) lists every ERC-20 allowance and operator approval of each
wallet, flags unlimited or older-than-90-days ones, shows the LOKOVault holder/admin, and revokes with
the connected wallet's signature. The header nav has an "Approvals" link.

### Modules and state files

`memecoin-guardian.js`, `guardian-logic.js`, `close-position.js`, `memecoin-collect.js`,
`attribution.js`, `advisor.js`, `scout.js`, `compound.js`, `token-health.js`, `approvals.js`,
`wallet.html` (arm, approvals, vault, operator tabs), `digest.js`, `daily.js`, `qr.js`, `ops.js` (collector-log parsing for alerts),
`agent.js` + `telegram.js` + `chat-widget.js` (the agent and its front doors), `strategy.js` (strategy dataset), `ledger-v4.js` (v4
liquidity ledger), `sell-v4.js` (fee-token sells), and their tests under `test/`. `npm test` runs
every suite plus the headless smoke test. Runtime state files (`memecoin-*.json`,
`advisor-cache.json`, `pool-scout-*.json`, `token-health.json`, `digest-state.json`,
`compound-log.json`, `v4-collects.json`, `v4-owner-collects.json`, `v4-liquidity-ledger.json`,
`token-sales.json`) are gitignored and backed up nightly by `backup-ledgers.sh`.

## Daily summary

`daily.js` sends one short Telegram message a day (`dailySummary` in settings.json: `enabled`, `hour`
in `LP_TZ` local time, default 08:00, `chat` main or group): arm window and time left, collects in
the last 24 h per wallet and the vault's share, open positions with uncollected fees and the top
fee rates, guardian flags, the auto-collect rule and its last run, vault balance and split, operator
gas, the last collector run, and any stopped loop. Every figure is read from the dashboard at send
time. `npm run daily` prints it; `/api/daily` previews it with the schedule state.

## Weekly digest

`digest.js` builds the Monday report (fees this week vs last across all wallets, best and worst position, vault
total and weekly inflow, sNET rewards, memecoin plays vs entry, operator gas, portfolio change with ETH and
USDG benchmarks from the price log, and a watch list of positions near an edge or out of range). The server
tick sends it once per ISO week, the first tick at or after Monday 09:00 local, to `TELEGRAM_TREASURY_CHAT_ID`
(default the group), falling back to the personal chat; `digest-state.json` remembers the week. `node digest.js
--print` (or `npm run digest`) prints it, `--send` sends now, `/api/digest` returns the text and the Analytics
page has a "Preview the weekly Telegram digest" link under the Performance panel.

## Blockscout API key

Every Blockscout call goes through `blockscout.js`. Put a free PRO key (https://dev.blockscout.com, value
starts with `proapi_`) in `.env` as `BLOCKSCOUT_API_KEY=…` and restart: requests then use
api.blockscout.com with Bearer auth at 5 requests/second instead of the anonymous explorer's ~10 per 15
minutes, which removes the throttling on holdings discovery for watched wallets and on the PnL basis
backfill. The key never leaves the server process.

## Collector

### Collecting for more than one wallet

Any wallet in `settings.json `wallets`` with `"collect": true` gets its own pass in every collector run, after the
main wallet: its v3 positions (owner enumeration) and v4 positions (the dashboard's discovery file for
that address) are simulated, the eligible ones collected to the operator, swapped to the sweep target and
delivered back to that wallet itself. Each pass only moves what it produced (balance deltas from the
start of the pass), so wallets never receive each other's fees. The wallet has to approve the operator
once on each position manager: open `/wallet#approvals`, unfold the v3 and v4 managers, connect that wallet, approve; the
pages accept any listed wallet and show every wallet's approval state. The dashboard's wallet header
line shows "collector: v3 ✓ v4 ✓" for collect-enabled wallets.


Uniswap v4 positions are collected too (`collect-v4.js`, `v4Collect.enabled` in settings.json): a
`modifyLiquidities` call that decreases 0 liquidity and takes both currencies to the recipient. It needs
the operator approved on the v4 PositionManager once, from the owner wallet. Two ways: the browser pages
the Wallet page's Approvals tab (open http://127.0.0.1:8787/wallet#approvals while the dashboard
runs, or `npm run approve` for a standalone server on :3333 serving both; the v3 page grants the same blanket
approval on the v3 NonfungiblePositionManager; connect the owner wallet in MetaMask, the page checks the network, the
account and the current approval, shows the exact calldata, and signs `setApprovalForAll` in the wallet so
no key touches the server; addresses come from settings.json and the operator keystore's public address via
`/api/v4-approval`), or `node approve-operator.js --v4` on the command line (`--v4 --check` reads the state). Native ETH fees are wrapped to WETH above the gas reserve so the
normal swap-and-sweep handles them. Each collect is static-called first and skipped if it would revert.


Collects fees, swaps the non-WETH side into WETH, unwraps it, and sweeps ETH to
your main wallet.

## What happens to collected fees

`sweep.target` in `settings.json` decides. `ETH` (the original behaviour):
every collected token is swapped to WETH through the pool it came from, the
WETH is unwrapped, and ETH above the gas reserve is sent to
`sweepDestination`. `USDG`: the same consolidation into WETH, then the
operator's ETH gas float is refilled from this pass's ETH and WETH up to
`gasTargetEth` (`keepGasReserveEth` is the floor it never sweeps below), the remaining WETH is swapped to USDG through the
WETH/USDG pool at `targetFeeTier` and delivered straight to
`sweepDestination`, and any USDG that arrived as fees is kept for the split.
Fee tokens with no v3 route are sold in their own v4 pool first when
`memecoinSell` allows it (see Selling fee tokens); what is not sold is handed
back to the owner as-is. `maxSwapValueWeth` and `slippageBps` apply to every swap. Only the
`full` mode converts; `collect` sends the raw tokens to the owner. The
Windows task and the dashboard's Collect button (`dashboard.collectMode`)
are both set to `full`. Simulate mode prints what the eligible fees would
convert to.

## Before anything else

**Chain: RESOLVED — Robinhood Chain mainnet, chainId 4663.** settings.json now
carries the verified Uniswap v3 deployment for it (the position manager
self-reports the factory and WETH9 on-chain, and CASHCAT/WETH pools exist with
live liquidity). The original warning is kept below for context.

**Verify your chain.** Your Uniswap position URLs contain `/robinhood/`, which
is a chain slug and is not Ethereum mainnet. Revert reports "mainnet /
ethereum". These disagree. The contract addresses in `settings.json` are Ethereum
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

1. Put a real RPC endpoint in `settings.json` (`chain.rpcUrl`). For full mode, a protected endpoint
   (Flashbots Protect or similar) meaningfully reduces sandwich risk on the
   memecoin swaps.
2. Set `wallets.main` (and `collector.sweepDestination`) to your main wallet.
3. Send ~0.01 ETH to the operator address for gas.
4. From your main wallet, approve the operator on the position manager.

### settings.json

One file, in sections, is the whole configuration (`settings.js` reads it; `settings.example.json`
is the template; the file is gitignored because it holds your wallet addresses):

| section | holds |
|---|---|
| `chain` | `rpcUrl`, `chainId`, `explorer` |
| `wallets` | `main { address, label }` and `watched [ { address, label, collect } ]` |
| `tokens` | `USDG`, `WETH` (each address once), `usdReferenceFeeTier` |
| `contracts` | Uniswap v3 / v4 / v2 addresses (`v4.pricingHooks` included) |
| `collector` | `sweepDestination`, `thresholds`, `sweep`, `tokenIds`, `denylist`, `v4Collect`, `swapFeeTierOverrides` |
| `vault` | `nft`, `tba`, `implementation`, `tokenId`, `feeSplitPct`, `feeSplitMax`, `withdrawAlertUsdg` |
| `risk` | `memecoins` (rule blocks), `defaults`, `discovery`, `autoCollect`, `sell` |
| `alerts` | `telegramChat` (group), `fallbackChat` (personal), `treasuryChat`, `dailySummary` |
| `dashboard`, `portfolio`, `staking` | port and collect mode, price routes, staking tokens |

Secrets never go in it: `TELEGRAM_TOKEN`, `BLOCKSCOUT_API_KEY` and the chat provider keys stay in
`.env`, the operator key in its keystore. Environment variables, when set, override the chat ids.
The names used further down this README (`memecoins`, `memecoinSell`, `treasuryTBA`, `thresholds`,
…) are the keys inside these sections; `settings.js` maps them for the modules. Coming from an older
checkout with `config.json` + `wallets.json`: `node tools/migrate-settings.js` builds settings.json
from them. The dashboard re-reads the file when it changes; the collector reads it at each run.

### Fresh machine, from the repo alone

```bash
git clone https://github.com/Lokoweb3/uniswap-collector.git ~/uniswap-collector && cd ~/uniswap-collector
chmod +x *.sh && npm install
cp settings.example.json settings.json    # then fill in chain, wallets, contracts, collector thresholds
./setup-key.sh                             # operator keystore in ~/.lp-collector/ (never in the repo)
cat > .env <<'EOF2'                        # secrets, gitignored; loaded by start-all.sh
TELEGRAM_TOKEN=...
# chat ids live in settings.json (alerts.telegramChat / fallbackChat / treasuryChat); env values override them
LP_BACKUP_HOST=user@host                   # VPS for nightly ledger backups
BLOCKSCOUT_API_KEY=proapi_...
EOF2
chmod 600 .env
./start-all.sh                             # one process: dashboard :8787 + guardian, auto-collect, backup, gate, remote MCP, tailscale
npm test                                   # alert tests + headless smoke test of every page (needs Windows Chrome from WSL)
```

Then, from the browser with the owner wallet: `/wallet#approvals` (operator approvals, one per
wallet that should be collected), `/wallet#arm` (one-time passphrase seal, then sign to arm), and
`node deploy-treasury.js` once for the LOKOVault (writes its addresses into settings.json). The JSON
ledgers (`fee-*.json`, `portfolio*.json`, `price-log.json`, …) are runtime data, created on first run
and restored from `backups/` or the VPS copy if you are moving machines. `./run-collector.sh simulate`
is the read-only check that everything lines up before the first armed run.

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

### Arming with a wallet signature (Wallet page, Arm tab)

`http://127.0.0.1:8787/wallet#arm` (the dashboard's "Arm collector…" button opens it; shift-click keeps the old
passphrase form) arms the collector with the owner wallet's signature instead of the passphrase. One-time
setup: connect the owner wallet, enter the operator passphrase once and sign; `arm.js` verifies the
passphrase against the keystore, derives an AES-256-GCM key from the signature bytes (EOA signatures over
a fixed message are deterministic) and stores only the ciphertext in `~/.lp-collector/arm-secret.json`.
Arming afterwards: sign the same message (it names chain, owner and operator), the server re-derives the
key, decrypts, checks the keystore still opens, and writes the same RAM cache `unlock.sh` writes, for the
chosen window (2 hours to 1 week; a WSL restart clears the cache regardless). Nothing on disk is decryptable without the owner wallet; the `/api/arm*` endpoints answer
over loopback only and the public gate refuses them. Replacing the keystore changes the message, so setup
must be repeated. "Forget saved passphrase" deletes the ciphertext.

The intended arm window is also recorded on disk (`~/.lp-collector/arm-window.json`). When the RAM cache
is gone before that window has expired (a WSL restart), the dashboard chip and the arm page say the
window was lost rather than expired, and a Telegram alert asks for a re-arm.


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
The dashboard process starts the gate; `run-tailscale.sh` publishes the two Funnel ports. `/__gate/logout` signs out.

## Watching other wallets

The `wallets` section of settings.json names the wallets: `owner.label` for the
collector's wallet and `watched`, a list of `{"address": "0x...", "label": "name"}` entries shown
read-only. `watchWallets` in `settings.json` is the fallback when the file is absent. Both are re-read on
every refresh, so editing needs no restart. Watched wallets are observed only: no PnL, range log or collects, and the collector never touches
them. The owner wallet is skipped if listed. Their fee accrual is tracked (`watch-accrual.json`: the
change in each position's uncollected fees between refreshes, at current prices, in hourly buckets per
wallet; an interval where fees dropped, i.e. a collect, is skipped): wallet header lines show earned
today and 7 days, and the Analytics page has an "Earned by wallet" table for the main and watched wallets.

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

Each card carries its pool's statistics from the Robinhood LP pool scanner (`pools.js`, scanner on :3847,
`LP_SCANNER_URL` to override; cached 5 min): TVL, 24h volume and fees, 24h fee APR, and the sibling pools
for the same pair ranked by APR (green when they beat the position's own pool). Absent when the scanner
is down.


Every wallet's positions live in one "Positions" panel under the tiles, grouped per wallet with a header
line (total, tokens, in pools, uncollected, open count; top priced tokens beneath). The main wallet comes
first with its full cards and the closed-positions toggle; watched positions render as compact two-column
cards with the same log-scale range rail, price flag, edge distances, composition bar and fee amounts
(full-range positions are badged instead of showing 0 to ∞ edges). Cards and tiles share one look: white
border, soft shadow, brighter on hover.

### Portfolio scope

The Portfolio panel follows the picker: the watched wallets' tokens and position holdings are merged into
the same per-token table client-side (amounts summed, price and 24h change per token). The value chart
shows the main wallet's hourly series, or, for All wallets and each watched wallet, the hourly totals the
server records in `portfolio-all.json` (`/api/portfolio-all`).

### Price log

`price-log.json` keeps the USD price of every token that matters (in a position, or worth ≥ $1 in the
main or a watched wallet) once an hour for 400 days. Collects and rewards are valued at their own hour
from it when neither the chain state nor a fee snapshot covers that moment, so the ≈ (today's price)
marks on the Analytics page stop appearing for new events.

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
  settings.json (sNET from NET Staking) hourly into `snet-staking.json`; history is rebuilt once from the
  token's LogRebase events. The Staking contract's verified source shows `stake()` issues sNET 1:1 and
  `unstake()` returns NET 1:1, so principal is the net of the wallet's sNET transfers (two stakes on
  2026-09-04, 3.717 sNET) and everything above it is reward. A balance change matching the index change is a reward, anything else is a
  stake/unstake and is skipped. `/api/staking` serves the view.

All of it is the collector wallet's own history, so the wallet picker is hidden there. Each page fetches
only what it shows. The public gate serves the page at the same path.

## Changelog

### 2026-09-10

- Phase 2, unified brain: `agent.js` is the one assistant behind the web panel, Telegram
  (`telegram.js`, long-polling, allowed chats only, 409-aware) and loopback scripts, with
  transcripts per channel and a notes file on disk; alerts are remembered on the chat they
  went to, so "approve it" needs no id; roles by channel (web read, Telegram approve,
  loopback full); a sale is decided only on the owner's explicit word. The watchdog no
  longer reports a loop as "never reported" right after a restart.
- One settings.json replaces config.json + wallets.json: sections `chain`, `wallets`, `tokens`
  (USDG and WETH written once), `contracts`, `collector`, `vault`, `risk`, `alerts` (chat ids;
  the bot token stays in .env), `dashboard`, `portfolio`, `staking`. `settings.js` is the one
  reader and writer; `tools/migrate-settings.js` converts an old pair of files;
  `settings.example.json` is the template.
- Three pages: Dashboard, Analytics, Wallet. The Wallet page (`wallet.html`) holds the former
  arm, approvals, approve-v3 / approve-v4 and treasury pages as tabs (Arm, Approvals with revoke
  buttons and the operator approvals, Vault, Operator status) with the site's header; the old
  addresses redirect to their tab. The smoke test loads every page at desktop and 375 px width.
- One process: the risk guardian, fee auto-collect and the nightly backup are timers inside
  server.js; the gate, remote MCP server, Tailscale funnel and pool scanner are supervised children
  of it. `./start-all.sh` is one command, `./stop-all.sh` its opposite, `server.log` the one log.
  The watchdog reads its own timers instead of heartbeat files. `nightly.sh` is gone;
  `POST /api/backup` (loopback) runs a backup on demand. A second server (the smoke test, a
  read-only copy) runs none of this.
- Exit rules merged into the guardian: one risk engine over every open position of every wallet
  (v3 and v4), one rule block per position (`alertPct`, `closePct`, `outOfRangeMinutes`,
  `tvlDropPct`, `feeFloorPerHour`, `autoClose`, `alertOnly`), one Telegram message per event, one
  "Risk" section on the dashboard with editable thresholds. `exit-rules.js`, `exit-state.json`,
  `exitRules` and `exitRuleOverrides` are gone; `/api/risk` replaces `/api/exit-rules`; the
  `exit_rules` MCP tool is folded into `memecoin_watch` (21 tools).
- Vault withdraw reminder level is configurable: `treasuryWithdrawAlertUsdg` (default 1000 USDG, was
  a fixed 100).
- Disposal scan: a transfer of a handed-back token into any contract whose transaction also swaps
  (launchpad trading contracts included) is a sale, valued from the swap's USDG or ETH leg.
- Confirm-before-sell live test: the request, the 10-minute expiry and the hand-back all worked;
  an expired batch stays in the wallet and is not retried.
- Sell path fixed for real: the router's exact-input struct has an extra empty bytes field (decoded
  from an app swap); with that layout ERC-20-quoted pools sell too, so Bucket sells in the deep
  USDG/Bucket pool. Router switched to the address the app uses.
- Realized side of fee-token cost basis (Theo): FIFO disposals from an outbound-transfer scan,
  telling router sales from liquidity deposits and moves between own addresses; Realized and
  Remaining on Analytics and in the lots CSV.
- Dashboard: v4 cards show the collectable / not approved state and a current tooltip; owner-side
  collects are tagged in the collects table (with a note when the ETH leg is unknown); the fee-tokens
  table shows sales at collect time and hides junk prices from drained pools; Memecoin Watch cards
  label holdings with the pool's quote asset and show the per-position rules against their thresholds.
- Every position card (main, watched, Memecoin Watch) shows what it has paid out so far: claimed
  USD, number of collects, last collect time (collect-time prices where recorded, ≈ otherwise).
- Strategy track record (`strategy-track.js`, Theo): agents record proposals through the MCP,
  the server scores them against the position history when the horizon passes, Analytics shows
  the outcomes and per-author averages.
- v4 liquidity ledger (`ledger-v4.js`): deposits, withdrawals and owner collects for v4 positions
  from PoolManager events, priced at the block; feeds PnL legs and the strategy dataset.
- Fee tokens with no v3 route are sold in their own v4 pool at collect time (`sell-v4.js`,
  `memecoinSell`): $25 minimum, 3% impact cap with the minimum-slice rule, hold list, Permit2
  exact approvals, dry-run before sending, `token-sales.json`, daily summary and `token_lots`.

### 2026-09-09

- Daily Telegram summary (`daily.js`, `dailySummary` config, 08:00 local) and the fee-token cost
  basis view (`token_lots` tool, `/api/strategy/lots`, "Fee tokens received" on Analytics with CSV,
  `test/strategy.test.js`).
- Guardian per-position rules (fee-rate floor, collected-USD target, liquidity drop from max) with
  group-chat delivery; first used on Bucket/USDG #2239358 ($10/h floor, $500 target, -60%).
- Vault page: phone links come from the server at runtime (`publicHost`) instead of a hostname in
  the file; the mobile-access card is hidden until a public domain exists.
- Strategy dataset for agents (`strategy.js`, `/api/strategy/*`, MCP tools `position_history`,
  `price_history`, `pool_scout_history`): per-position lifecycles across all wallets with deposits,
  collects, realized APR, time in range and results; hourly price series; pool scout history.
- Operator gas float refills itself: `sweep.gasTargetEth` (0.02) is the ETH the operator keeps out of
  collected fees before swapping or sending anything; `keepGasReserveEth` stays the floor.
- Memecoin guardian discovers every v4 position in the main wallet and the collected watched wallets
  on its own (`memecoin-discovered.json`; entry price from the hourly price log at the mint, else the
  first sample; `memecoinDefaults` / `memecoinDiscovery: false` in config.json). Pools quoted in USDG
  rather than ETH are handled (prices are token per quote asset). The $50 auto-collect trigger covers
  the same wallets.
- Collector: fee tokens are valued trying the sweep pool's tier and the standard tiers after the pool's
  own, so the USDG leg of a USDG/X v4 position counts (it was valued at 0 and never collected); USDG
  fees are kept for the split instead of being handed back unswapped.
- `/api/treasury` reports the split in force from the contract; `status_report` MCP tool: one verified
  answer for end-of-day summaries (arm window, auto-collect rule, split, guardian, fees, gas, alerts).

### 2026-09-08

- Uniswap v4 collects now appear in the collects history, Analytics (Earned by wallet, Income for
  taxes, Collected fees, by month) and position PnL. v4 leaves no Collect event on the v3 manager,
  so the collector records every v4 collect it sends in `v4-collects.json` (history.js merges it
  with the scanned v3 events; the hourly price log values each row at collect time).
  `tools/backfill-v4-collects.js` rebuilds the ledger from `collector.log` and the receipts,
  dropping duplicates from overlapping runs; it recovered the Trading wallet's 17 LAPTOP/PINK collects.
- Vault page restyled as a private bank on the site's dark glass palette: serif masthead, gold
  hairlines, vault-door hero around the NFT, account-balance card, statement-style deposit table.
- Chat panel built into the site (`chat.js`, `chat-widget.js`, `POST /api/chat`): answers from the
  thirteen read-only MCP tools over an in-memory transport; Claude (Anthropic SDK) or Ollama Cloud
  picked from `.env`; allowed through the gate for the phone; `test/chat.test.js`.
- External audit (Theo) of the public repo: no leaks found; three issues fixed. Failed auto-closes no
  longer mark a position as closed and are retried; both auto-close paths need the trigger to hold on
  consecutive checks with a stable price before acting; `tmp` pinned under `solc` (`npm audit` clean).
- Seven read-only MCP tools for agents: memecoin_watch, exit_rules, vault, staking, attribution,
  weekly_digest, health.
- Collector lock file (`flock` in `run-collector.sh`) so the 09:00 task, the Collect button and the
  auto-collect loop can never sign at once; background-loop watchdog (heartbeats, Telegram alert when
  the guardian or auto-collect stops reporting and when it is back, warning chip on the dashboard).
- Repository published at https://github.com/Lokoweb3/uniswap-collector with placeholders for every
  wallet, vault, host and chat identifier; `config.json` is now local (`config.example.json` is the
  template); `docs/` stays local.

### 2026-09-08 (night)

- Memecoin guardian, exit rules, fee auto-collect (all closes opt-in and off), attribution and
  benchmarks, range advisor / IL forecast / pool scout / `--compound`, token health badges and the
  `/approvals` audit page, weekly digest and `/vault` with QR codes; direct v4 pool reads for new pools;
  sNET 1:1 verified; start-all.sh process checks fixed; README setup section.
- Review in `docs/agent-review-2026-09-07.md`; fee tokens with no v3 pool are handed to the owner.
- Known overlap: guardian and exit rules both alert on drops; a merge into one risk engine is planned.

### 2026-09-07 (evening)

- LOKOVault deployed; 10% fee split live for every wallet's collects.
- Collect history, by-month totals and the tax CSV cover every wallet (per-wallet catch-up scan).
- Out-of-range and collect-failure alerts for watched wallets (`ops.js` parses per-owner runs).
- dashboard.html split into `dashboard.css` / `dashboard.js` (`tools/split-dashboard.js`); `npm test`
  runs the alert tests and a headless smoke test of every page.

### 2026-09-07 (afternoon)

- Browser approval pages for v3/v4 operators with revoke of old operators; operator keystore replaced,
  new operator approved, old one revoked; first collect with the new operator.
- Wallet-signature arming (`arm.html`, `arm.js`), windows up to a week, lost-window detection with a
  Telegram alert.
- Pool stats and sibling pools on position cards; fee accrual and "Earned by wallet" for watched
  wallets; hourly price log; combined portfolio history and per-wallet value charts.

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
