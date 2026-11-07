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
`#vault` (the LOKOVault page), `#sell` (sell a token a wallet holds: the dashboard quotes its v4
pool and builds the Universal Router swap, Rabby signs it) and `#operator` (operator status and loop health). The old addresses
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

## Cross-chain Portfolio page (`/portfolio`)

One page for "what do I hold, on every chain": LP positions, wallet tokens and sNET staking across
every enabled chain and every wallet, with a grand total and breakdowns by chain, wallet and
protocol. It is served by the chain router (the same URL as the dashboards, `:8800`, and through
the public gate), linked as **Portfolio** in the chain bar that the router injects into every
dashboard page. It is read-only: GET/HEAD only, no form, no button that sends anything but a GET.

How it works. The router (`aggregate.js`, a pure module) reads four cached GET endpoints of each
chain's own instance -- `/api/positions`, `/api/watch`, `/api/portfolio`, `/api/staking` -- from
`127.0.0.1:<chain port>` only, and answers `GET /api/aggregate`. The per-chain instances, their
data directories, cookies and the proxy path are not changed and not merged: the dashboards still
show one chain each. Routes: `/portfolio`, `/api/aggregate`, `/aggregate-view.js`,
`/aggregate.css` (dashboard.css followed by the page rules, so a theme swap applies without a
restart). These four routes also check the Host header (loopback on the router's own port, or a
name in `LP_ALLOWED_HOSTS`); the existing proxy path is unchanged. `?refresh=1` on
`/api/aggregate` forces a new round (at most one per chain per 5 s); `?chains=a,b` and
`?wallet=<address|label>` on `/portfolio` only preselect the filters.

| Variable | Default | Meaning |
|---|---|---|
| `LP_AGG_TIMEOUT_MS` | 8000 | per upstream request deadline (the connection is closed after it) |
| `LP_AGG_WAIT_MS` | 4000 | how long a request waits for a refresh round before answering from cache with the unfinished chains marked `loading` |
| `LP_AGG_TTL_MS` | 30000 | cache lifetime; no more than one upstream round per chain per TTL, however many browsers poll |
| `LP_AGG_BUILD_MS` | 1000 | a cached payload is rebuilt at most this old, so `at` and `ageMs` stay current; the 15-minute stale flag flips exactly on time. Upstream rate limits are unaffected |
| `LP_AGG_MAX_BYTES` | 8388608 | upstream body cap; a larger answer is aborted (`too-large`) |
| `LP_AGG_THEME_DIR` | the repo folder | where `dashboard.css` is read from (for tests) |

Counting rules.

- **`holdings-unavailable` is a per-wallet note, not a problem.** A watched wallet whose token discovery has
  never succeeded keeps its native balance and position tokens, but its token list is incomplete. It is shown
  as `tokens unknown (discovery failed)` (`chains[].notes`, `wallets[].holdingsUnknown`, `flags.holdingsUnknown`),
  its figure is labelled "at least", and it does **not** make its chain `partial` or the total `incomplete`. Every
  other cause (a failing or slow part, a stale source, an unreadable or stale wallet, `tokens-unavailable`,
  `no-owner`) still does. Unknown is never shown as `$0.00`.
- **Ages and stale flags are computed at response time.** `at`, `ageMs` and the `stale-source` flag (a part older
  than 15 minutes) are rebuilt from the cached upstream data at most every `LP_AGG_BUILD_MS`, and when a part
  crosses the 15-minute line, so a cached payload never shows frozen ages.
- **Grand total = LP + fees + pending rewards + tokens.** `uncounted` and `rewards not counted` are
  reported separately and are never in it.
- An LP is counted when it has a USD value, is not thin and is not flagged by the instance (the same
  rule the instance uses; the PulseChain price-gap rule is kept). Others are listed under "Not counted"
  with a reason (`thin-pool`, `price-gap`, `unanchored`, `unpriced`). An unpriced value is shown as
  "unpriced", never as `$0.00`.
- LP-pair tokens in holdings are listed as uncounted with reason `duplicate-of-holdings` and add to the uncounted count.
- **Fees** are counted only for counted pools whose fees were read. Difference from the instance:
  its own `feesUsd` total also adds the fees of uncounted pools; the aggregate does not.
- **Pending gauge / farm rewards** (for example AERO on a staked Aerodrome NFT, UP, a PulseX farm) are
  **included** in the grand total and in the by-chain / by-wallet / by-protocol breakdowns, and also
  shown as their own line (`pending rewards (included)`). A priced reward counts even when the pool
  value itself is uncounted. Unpriced rewards and rewards of a killed gauge are **not counted**; they
  are listed with the reason and summed into `rewardsUncounted*`.
- sNET staking income (`rewards.today/d7/d30/total`) is history that is already in the rebased
  balance. It is shown ("already received, not pending") but **never** added as pending rewards or
  to the total, and the sNET balance is counted once, as a token row.
- Tokens: the main wallet uses only the `wallet` amount of `/api/portfolio` rows (the rest of a row is
  LP principal and fees that the positions already value); watched wallets use their holdings. Thin
  rows count at the instance's capped value; assumed-price rows count and are summed into
  `priced by assumption`. A native coin and its ERC-20 twin are one row.
- **No double counting**: positions found in both `/api/positions` and `/api/watch` count once; the
  main wallet in the watch list is read from `/api/positions` only; the same address on two chains is
  one wallet in the breakdown (items stay per chain); a token that is also an LP pair address is not
  counted again.
- **Honesty about chains**: each chain has a status. `ok`; `partial` (a part, or a wallet, is
  missing, loading or older than 15 minutes; named in the banner); `stale` (nothing fresh; the last
  good data is shown); `loading`; `down` (listed with a banner, never omitted and never shown as
  `$0`). Stale last-good data **is included** in the grand total, flagged, and its amount is shown
  separately as `staleUsd` with the last-good time. Chains never seen are excluded and make
  `incomplete` true. Last-good data is kept in memory only.
- Nothing from an instance reaches the page except a fixed set of fields; operator, unlock, ops,
  explorer, RPC and raw upstream error strings never do (errors become `timeout`, `unreachable`,
  `http-<status>`, `bad-json`, `too-large`, `loading`, `upstream-error`). Lists are capped at 5000
  items per kind (totals cover everything) and strings at 80 characters.

Deploying. After merging, restart **only** the chain router (`node chain-router.js ...`, with the same
`--chains=` as before) to pick up the new routes. The per-chain instances are untouched.

Tests: `node test/run-all.js aggregate` (`aggregate.test.js` for the module,
`aggregate-router.test.js` through the router with stub instances, `aggregate-view.test.js` for the
page script and its escaping).

## Asking questions about the data

### The agent (`agent.js`): one brain, three front doors

One assistant answers the web chat panel, the Telegram bot and local scripts, from
the same tools the MCP server exposes (in-process), with memory on disk:

- **Memory.** `agent-memory/<channel>.json` keeps the last ~40 turns per channel
  (`web`, `telegram:<chatId>`, `loopback`); `brain/notes.md` is a short file the
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
- **Telegram**: incoming messages are handled by the VPS agent (LokoClawbot), which polls
  the bot and uses the remote MCP tools; this process never calls getUpdates, so there is
  no fight over the token. `telegram.js` keeps only the outbound side (`send`) and a
  `handle()` for a future relay. Alerts still go out from here and are remembered on the
  chat's transcript for whoever reads it next.
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
twenty-eight tools (`positions`, `collects`, `daily_revenue`, `wallet_balances`, `portfolio`, and the rest added since, ending with `status_report`, `position_history`, `price_history`, `pool_scout_history`, `token_lots`, `claimed_fees`, `token_health`, `daily_check`, `record_strategy_proposal`, `strategy_track_record`) so
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
internet. `lp-mcp-remote.mjs` serves the same tools (twenty-eight, see
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

The restart is not optional. The dashboard chat imports `lp-mcp.mjs` on demand (and, through it,
whatever `agent.js` pulls in), and Node caches a module that threw while loading, so a fix to one of
those files is invisible to the chat until `./stop-all.sh && ./start-all.sh`. On 2026-09-13 the chat
kept answering "server is not defined" for hours after that exact error had been fixed on disk.

### From an agent on a server

A program with no browser cannot use the sign-in page. Issue it a
long-lived bearer token instead, from this machine:

```bash
node lp-mcp-remote.mjs --issue-token my-agent --days 365   # prints the token once
./start-all.sh                                             # or restart the remote server
```

The agent then talks Streamable HTTP to `https://<that address>/mcp` with
the header `Authorization: Bearer <token>`. A token gets the read tools; only a token
issued with `--write` also gets the three tools that change something (`approve_sale`,
`run_tasks`, `record_strategy_proposal`), and claude.ai connectors are always read. The read
tools: `positions`, `watched_wallets`, `collects`, `daily_revenue`,
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
  beat. `record_strategy_proposal` is one of the three writes on the MCP (with `approve_sale`
  and `run_tasks`; remote tokens need `--write` to see them): it only appends to
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

Secrets never leave this machine: the script excludes `.env`, its backups, issued tokens, the gate and arm secrets, keystores, backups, logs and the agent memory (only `.env.mcp` and the hash-only `mcp-auth.json` go, for the VM's own MCP). `./deploy-vm.sh --check` prints what would be sent and refuses if anything secret-shaped is in the list.
move onto a fresh Ubuntu VM: Node, Tailscale, a firewall admitting only SSH,
an unprivileged `lp` user, code and data, and two systemd services
(`vm/*.service`). The VM runs the dashboard with `LP_READONLY=1`, which hides
the Collect button and Arm form and refuses those endpoints. It joins the
tailnet as `lp-dashboard`, so the connector URL and the private dashboard URL
carry over; the script renames this machine to `lp-pc` first. After every
collector run, `sync-to-vm.sh` (called from `run-collector.sh`) pushes
`state.json` and `collector.log` so the VM's ops strip stays current — it is a
silent no-op until `deploy-vm.sh` has written `.env.sync`, which has not happened
on this machine: no VM is deployed and nothing is synced there today. Re-running
the deploy script updates the code.

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

### Launch scanner (`launch-scanner.js`) and Launch Watch

Every 5 minutes (a timer in server.js, `launchScanner` in settings.json) the scanner reads every
Uniswap v4 `Initialize` event since its last pass (the first pass looks back `maxAgeMinutes`)
plus any pool the pool scanner's cache lists as created inside the window, keeps ETH- or
USDG-quoted pools without hooks (or on a known launchpad hook), drops tokens that spawn more
than 20 pools, and evaluates the newest tokens (`maxTokensPerScan` per pass, each at most every
10 minutes):

- **market cap** from Blockscout's supply × the pool's price, **pool age** from the Initialize
  block, **token age** from the contract's creation transaction (a new pool for a token older
  than `maxTokenAgeHours` is a listing, not a launch);
- **LP value**: the liquidity within ±30% of the price, in USD (an estimate; the cache's TVL when
  it has the pool), and the creator must not be the top holder;
- **contract**: Blockscout verification and proxy status, `owner()` (renounced?), and the
  bytecode scanned for mint / pause / blacklist / max-tx / tax setters (a flag only counts while
  ownership is not renounced; `transferFrom` is standard ERC-20 and is not a flag);
- **honeypot**: a real buy-and-sell round trip in one `eth_call` with a state override — a
  keyless scratch address is given 1 ETH, Multicall3 runs the Universal Router buying 0.01 ETH of
  the token (tokens kept in the router) then selling them back (router pays, ETH to the scratch),
  and the ETH that comes back against the quoter's figure is the effective sell tax; USDG-quoted
  pools go through the WETH/USDG pool both ways. A revert on the way back is a honeypot;
- **holders**: count, top holder and creator share from Blockscout;
- **volume**: PoolManager `Swap` events for the pool in the last 10 minutes (the trader's token
  delta positive = a buy), buy count and buy ratio.

Score 0-100: sweet-spot market cap ($75K-$200K) +20 (in range +10), verified +15, LP healthy
+20, sellable +25, holders spread +10, buy pressure +10. At `minScore` with every check
passing, one Telegram message (group chat, fallback personal) with the numbers and the pool /
DexScreener / Blockscout links; the same token at most once per `alertCooldownHours`, and one
follow-up when its market cap triples. Read-only: no key, no transaction. State in
`launch-scanner-state.json`, heartbeat and last results in `launch-scanner-status.json`
(gitignored); `/api/launches` serves them; the dashboard's **Launch Watch** section shows the
scanner state, today's counts, candidates scoring 50+ with their checks, and recent alerts. The
watchdog treats a scanner that has not completed a pass in 20 minutes as late.

### Selling by hand: the Sell tab (`/wallet#sell`)

For tokens that sit in a wallet outside the collector's reach (a closed position's other side,
an expired confirm-before-sell batch, launchpad leftovers): pick the wallet and token,
enter an amount, and `GET /api/sell/quote` finds the best hookless v4 pool for it (ETH- or
USDG-quoted, every fee tier), fits the amount under the chosen impact cap (a slice when the
whole batch would move the pool more), and returns the quoted output, the minimum after
slippage and the exact `execute` calldata for the Universal Router. The page then walks the
connected wallet through up to three signatures in Rabby: ERC-20 approve to Permit2 (once per
token), Permit2 approve of the router for that amount (one hour), the swap. `GET
/api/sell/tokens?wallet=` lists what a wallet holds (dust under $1 hidden). The server never
signs; the proceeds go to the wallet that signs.

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
- **Claimed fees** (`claims-store.js`, `claims-scanner.js`, `/api/claims?tokenId=`): fees already taken out
  of each v4 position, read from `PoolManager.ModifyLiquidity` for this chain and position manager, with
  withdrawn principal removed and each collection valued at its own block's price. A background scan
  starts with the main dashboard and walks every position back to its mint (or a 30-day floor, in blocks
  from the chain's measured block time), one chunk at a time behind the dashboard's own requests; it
  saves after every chunk to `claims.json`, so a restart continues where it stopped. Only one process may
  write that file (`claims.json.lock`); any other server on the same data directory only reads it.
  `LP_CLAIM_SCAN=1` (or `--claim-scan`) turns the scan on for a read-only or preview instance,
  `LP_CLAIM_SCAN=0` turns it off; `LP_CLAIM_LOOKBACK_DAYS` (30), `LP_CLAIM_CHUNK` (9000 blocks) and
  `LP_CLAIM_PAUSE_MS` (500) tune it. The file is rebuildable from chain.
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
time. `npm run daily` prints it; `/api/daily-check` previews it with the schedule state.

## Weekly digest

`digest.js` builds the Monday report (fees this week vs last across all wallets, best and worst position, vault
total and weekly inflow, sNET rewards, memecoin plays vs entry, operator gas, portfolio change with ETH and
USDG benchmarks from the price log, and a watch list of positions near an edge or out of range). The server
tick sends it once per ISO week, the first tick at or after Monday 09:00 local, to `TELEGRAM_TREASURY_CHAT_ID`
(default the group), falling back to the personal chat; `digest-state.json` remembers the week. `node digest.js
--print` (or `npm run digest`) prints it, `--send` sends now, `/api/digest` returns the text and the Analytics
page has a "Preview the weekly Telegram digest" link under the Performance panel.

## Base (read-only instance): Aerodrome Slipstream, Uniswap v3/v4

A second, read-only dashboard for Base (chain 8453), started like the Arc viewer and reachable through
the chain router. It shows Aerodrome Slipstream positions (staked in a gauge and unstaked, with pending
AERO) through `slipstream.js`, plus Uniswap v3/v4 through the existing readers. The Base SERVER cannot sign: it runs
`LP_READONLY=1 ... --no-loops --no-services`, its settings have no `collector`, `vault` or `risk`
sections, and it only ever calls contracts with view / `staticCall`. Signing on Base exists only in
`collector-base.js`, started by `run-collector.sh`, and only for wallets with `collect: true` whose owner approved
the operator (see "Auto-collect on Base" below). The server never imports it.

`"noTransactionData": true` (top level of `settings.json`; set in `settings.base.example.json`, and set it
in the PulseChain settings too) makes an instance refuse `/api/approval`, `/api/v4-approval`,
`/api/sell/quote` and `/api/mint/*` (403), skip the operator keystore, and hide the operator approvals,
Sell and Mint on the Wallet page (`/api/chain` reports `noTx`). It defaults to true for chains 8453 and
369 and false elsewhere: `LP_READONLY=1` alone does not imply it, so the Arc viewer and the Robinhood VM
still serve unsigned calldata and show the real operator.

Enable it (nothing changes until `settings.json` exists in its data directory):

```
mkdir -p ~/base-data && cp settings.base.example.json ~/base-data/settings.json   # edit wallets / tokenIds
./start-all.sh        # starts :8796 (LP_BASE_PORT) and adds Base to the router (--chains=robinhood,arc,base)
./stop-all.sh         # stops it by its port only
node tools/verify-onchain.js base      # read-only proof of every address in the example (PASS / FAIL)
```

- Two Aerodrome managers coexist and both answer `name()` "Slipstream Position NFT v1", so each is a
  `contracts.slipstream` entry with its own `name` (it prefixes the token id): `aerodrome-v1` and
  `aerodrome-cl2` (the "Gauges V3" manager). A gauge whose `nft()` is a different manager is rejected.
- Staked positions are found without Blockscout: Blockscout when it answers JSON (Base's public one is
  a Cloudflare page; the PRO gateway needs a key), then pinned `tokenIds` (`ownerOf` is a gauge), the
  gauges of pools the wallet still holds, and an `eth_getLogs` scan of the manager's Transfer events to and
  from the wallet (both directions, newest first, resumable: cursor in `slipstream-scan-<name>.json`,
  chunks of the entry's own `scanRange`, default 2,000,000 -- `chain.maxLogRange` is deliberately not inherited --
  at most 200 calls and 10 s per wallet per refresh; a log RPC that hangs is cut off at that deadline and
  backed off, not retried). A failing or partial scan is shown as a quiet note under the errors, never as a
  position error and never silently empty. `"scan": false` on an entry switches the scan off (the Base example
  does, for both managers: pins and held-pool gauges cover the known ids); to enable it set `"scan": true`, a
  `fromBlock` inside the log RPC's history and a `scanRange` that RPC answers. The same code path runs on every chain: it
  is also what finds a staked NFT on Robinhood when its explorer's Cloudflare blocks scripts.
- Uniswap v4 on Base is discovered by log scan only (no Blockscout, no indexer) and has not been verified live
  against a v4 position: the addresses pass `verify-onchain.js`, but treat v4 results there as unconfirmed.
- The approval and quote routes (`/api/approval`, `/api/v4-approval`, `/api/sell/quote`, `/api/mint/*`) answer 403 on
  a read-only instance and the operator keystore is never read; the Wallet page hides the approval card.
- "Claim fees" button: each unstaked Aerodrome Slipstream card on Base has one. Rabby (or any injected wallet)
  signs; the server never does. The button opens a panel showing the manager, the NFT's on-chain owner (always
  the recipient, never editable) and the estimated fees, then asks the wallet to connect, to switch to Base
  (`wallet_switchEthereumChain`, no chain is ever added), checks that the connected account is the owner and that
  the wallet's own `ownerOf` agrees, and sends `collect((tokenId, owner, 2^128-1, 2^128-1))` to the manager. The
  manager comes only from the `contracts.slipstream` entry of settings (the allowlist is those entries). Server side
  there is one read-only route, `GET /api/claim-fees/target?protocol=<name>&id=<digits>` (manager, owner, fee estimate;
  never calldata or `to`); the browser modules are `claim-fees-core.js` (calldata) and `claim-fees.js` (the only file
  that contains `eth_sendTransaction`). Staked positions get a disabled button (fees go to the gauge's voters;
  rewards are claimed through the gauge), as do positions with nothing to collect. Fees are an estimate.
- Uniswap v4 positions and pinned ids: the v4 PositionManager cannot list an owner's NFTs, so discovery reads
  Blockscout and then scans `Transfer` logs backwards, which a public Base RPC (50,000 blocks, recent history only)
  and a Blockscout that answers 402/403 cannot finish. Pin the ids instead: `wallets.main.v4Ids` (and
  `wallets.watched[].v4Ids`) take token ids (numbers or decimal strings, at most 200 per wallet). Each pin is verified
  with `ownerOf` on every refresh, and the pin lists are re-read from settings on every refresh too (main wallet and
  watched wallets alike; no restart needed). Only the first 400 entries are examined, at most 20 unusable ones are named
  in a warning ("and N more" for the rest), and an id above 2^256-1 or a JSON number above 2^53 is unusable (write
  large ids as strings). A wrong pin never shows another wallet's NFT; it is reported instead
  (`v4-pinned-not-owned`), and never written to `v4-positions.json`. `GET /api/positions` (and each wallet in
  `/api/watch`) carries `warnings`: `v4-discovery-incomplete` (the scan has not read all history; `warn`, or `info` when
  the known NFTs already equal the wallet's on-chain `balanceOf`), `v4-balance-exceeds-known` (the wallet holds more v4
  NFTs than were found), `v4-pinned-not-owned`, `v4-pinned-invalid`. The page shows each `warn` as a banner and each
  `info` as a quiet line. A v4 NFT with zero liquidity is a closed position: counted in `balanceOf`, listed under
  Closed, not drawn as a card.
- `chain.logsRpcUrl` (public) serves `eth_getLogs` when the main RPC refuses it; `mainnet.base.org` does.
- A killed gauge (its voter says `isAlive` false) reports `rewards.amount` 0 with the note "gauge killed".
- An EIP-7702 delegated wallet (code `0xef0100...`) is never mistaken for a gauge.
- Secrets: a keyed RPC goes in `.env` as `LP_BASE_RPC_URL` (overrides `chain.rpcUrl` in that process, the
  public one stays as the fallback), the Blockscout PRO key as `BLOCKSCOUT_API_KEY`. Every configured
  URL is validated (https, no credentials, no localhost/private/link-local/metadata host); a page is only
  ever told an origin (`rpc` in `/api/chain` etc.), errors and logs have URL paths and `proapi_` keys
  redacted, and the Bearer key is sent only to `api.blockscout.com` and the configured explorer host.

## Auto-collect on Base

The daily collector run (`run-collector.sh`, the 8:00 Windows task) can also collect swap fees on your Aerodrome
Slipstream positions on Base. It is **off** until you turn it on, and it ships off everywhere
(`collect: false` in `settings.base.example.json`).

**What it does.** After the Robinhood pass, `run-collector.sh` runs `collector-base.js` when
`$LP_BASE_DATA_DIR/settings.json` exists (default `$HOME/base-data/settings.json`). It shares the Robinhood run's lock, unlock
window and environment, and its log and state live in the Base data dir (`collector.log`, `state.json`), never in
Robinhood's. For each wallet with `collect: true` and for each of the two managers it first reads
`isApprovedForAll(owner, operator)`; if that is false it logs one `SKIP` line and does nothing else for that pair. Otherwise it
reads the wallet's positions, skips staked ones, positions whose fees are unreadable or unpriced, and any NFT whose
`ownerOf` is not the configured owner, simulates `collect` as the operator, and collects only when the fees are at
least `minFeesUsd` and at least `minFeesToGasRatio` times the gas cost and the gas caps allow it. The fees always go to the
NFT's owner (`recipient` = `ownerOf`, re-read just before sending).

**Where it runs.** Two ways start `run-collector.sh`, and both run the Base pass: the scheduled task, and the
**Collect button** of the Robinhood dashboard (`POST /api/collect` spawns `run-collector.sh collect|full`, `server.js`
`startCollectRun`). The Base dashboard has no such button (that route answers 403). The Base pass runs only after `collector.js`
exits 0 in `collect` or `full` mode (the script is `set -e`, so a failed Robinhood pass stops it), and is skipped when the lock is held,
when the unlock window is closed and the run is `--quiet` or has no TTY on stdin (the script logs `locked, skipping` and exits 0; an
interactive run is asked for the passphrase instead), and when `LP_DATA_DIR` is set in the environment (for example `run-collector-arc.sh`).
In `simulate` mode the Base pass runs even if the Robinhood simulate failed.

**Gas accounting.** The pass never trusts the RPC's fee numbers. The signed fee is `maxFeePerGas = min(maxGasPriceGwei,
2 x block base fee + tip)`, so it is never above `maxGasPriceGwei`, and the tip is at most `maxPriorityFeeGwei` (the transaction
is always type 2 with both fields set explicitly). If the base fee plus tip exceeds `maxGasPriceGwei` the position is skipped
(`exceeds maxGasPriceGwei`). `gasLimit = min(1.25 x estimate, maxGasLimit)`; an estimate above `maxGasLimit` is skipped, never
clamped. Base also charges an L1 data fee: the pass asks the OP-stack GasPriceOracle (`getL1Fee`, read-only) about the exact
transaction and uses `max(2 x L1 quote, minL1AllowanceEth)` as the L1 fee allowance. Before each send the caps (`maxGasPerTxEth`, `maxGasPerRunEth`,
`dailyGasCapEth`) are checked against the worst case `gasLimit x maxFeePerGas + max(2 x L1 quote, minL1AllowanceEth)`; the economic
thresholds (`minFeesUsd`, `minFeesToGasRatio`) use the expected cost (current price, 1 x the L1 quote).

**Sign, record, broadcast.** Every send goes in this order: the pass signs the transaction (the nonce is the one it already read for
the L1 quote, so the quoted bytes are the signed bytes), checks the signed bytes field by field (sender, destination, nonce, gas
fields, value 0, calldata, chain), takes the hash from those bytes, writes a `reserved` entry with the worst case, the hash and the
`nonce` to `state.json` (atomically), and only then broadcasts. If that write fails nothing is broadcast and the run stops. The entry
is replaced by `gasUsed x effective gas price + max(2 x L1 quote, minL1AllowanceEth)` after the receipt; reverted transactions are
counted too. A confirmation timeout (`waitTimeoutSec`) keeps the worst case counted and stops the run (exit code 1, so
`run-collector.sh` logs `base pass failed`). A broadcast error (the transaction may still have reached the network) or a broadcast
answer without the expected hash also stops the run (exit 1), counts toward `maxCollectsPerRun`, and is settled on the next run.
The receipt of a send is validated before it is counted (same checks as at run start: hash, sender, manager, block number,
`gasUsed` between 21000 and the gas limit); a receipt that fails keeps the worst case counted as unknown and stops the run. A
`TRANSACTION_REPLACED` answer is treated the same way (never settled at the replacement's receipt; the next run settles it by nonce).
A missing, negative or oversized `gasUsed` also keeps the worst case as unknown (a negative or non-numeric price counts `maxFeePerGas`); a settled amount is always within `[0, reservation]`. A receipt price below
the signed `maxPriorityFeePerGas` (recorded in each new entry) cannot be real and counts as `maxFeePerGas`.

**The L1 part is an estimate.** The L1 data fee comes from an RPC answer (the GasPriceOracle quote), so the allowance
`max(2 x quote, minL1AllowanceEth)` (default floor `0.00002` ETH) is a padded floor, not a hard bound on what Base charges.

**Unknown entries do not expire.** An entry that is not settled (`kind: "reserved"` or `"unknown"`) keeps counting in the 24 h total
at any age and is exempt from the 7-day pruning, so a crashed run's reservation is never silently aged out. Nothing needs a manual
edit: at the start of each collect run the pass settles every such entry from the chain.

- A receipt is used only when it is provably that transaction: same hash, sent by the operator, to the recorded manager (one of the two
  allowlisted), mined in a block (a positive safe-integer block number), and `gasUsed` between 21000 and the signed gas limit. The entry then settles at `gasUsed x min(price, maxFeePerGas)` plus
  the recorded L1 allowance, never above its reservation. An entry older than 24 h that settles from its receipt gets a fresh clock, so the late-paid gas counts in the current window. A receipt that fails a check is logged with the failed check and the worst
  case stays counted. If the operator's `latest` nonce is above the entry's nonce, the entry is closed once at its worst case with a
  fresh clock (`closed: "receipt-rejected"`, same semantics as replaced-or-dropped), so a receipt that keeps failing never needs a manual edit.
- No receipt and the operator's `latest` nonce is above the entry's `nonce`: the transaction was replaced or dropped. Standard
  JSON-RPC cannot look up the transaction that used a nonce, so the entry is closed once at its worst case with a fresh clock (`closed:
  "replaced-or-dropped"`): it counts for another 24 h, then ages out. (A lookup can be plugged in through `findByNonce`.)
- No receipt and the nonce is not used yet: the transaction is `pending`; the entry stays `reserved` at its worst case. If the node dropped it, the next
  send reuses that nonce and supersedes it; otherwise it is settled from its receipt once mined.
- Legacy entries (from versions that did not record a nonce, or without a hash) cannot be proven: they are closed once at their worst
  case with a fresh 24 h (`closed: "legacy-unsettled"`), or settled from the receipt when they have a hash and a valid receipt.
- An RPC error while settling leaves the entry unchanged and counted, and the run goes on. A failed save of a settlement stops the run.
- `simulate` never settles or writes; it counts these entries in its cap decisions.

**Clock.** The 24 h window and the pruning follow the system clock; a forward jump of the clock can age entries out of the window early.

**`state.json`** (Base data dir) is the 24 h budget. Corrupt or unreadable means today's budget is treated as spent: nothing is
sent, and the file is left as it is. Missing means nothing is sent either, until you create it once with
`LP_DATA_DIR=$HOME/base-data node collector-base.js --init-state` (it never overwrites an existing file). Deleting `state.json`
therefore stops the pass sending until you re-create it, by design: otherwise a deleted file would reset the budget to zero.
It is written atomically (tmp file, fsync, rename).

**What it does not do.** Only `collect` is ever sent. No swap, no sell, no transfer, no approval: the code never calls
`setApprovalForAll` or `approve`, it only reads `isApprovedForAll`, and a per-token approval is not accepted. It touches only
the managers `0x827922686190790b37229fd06084350E74485b72` (`aerodrome-v1`) and `0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53`
(`aerodrome-cl2`), and aborts unless the settings and the RPC both say chain 8453. The Base server stays read-only
(`LP_READONLY=1`); `collector-base.js` is a separate short-lived process and does not read `LP_READONLY`.

**Settings** (`$HOME/base-data/settings.json`):

| key | default | meaning |
| --- | --- | --- |
| `wallets.main.collect` | `false` | enable the main wallet (Trading holds the positions, so this is the one you want) |
| `wallets.watched[].collect` | `false` | enable a watched wallet |
| `baseCollect.minFeesUsd` | `2` | collect only when the fees are worth at least this many USD |
| `baseCollect.minFeesToGasRatio` | `5` | and at least this many times the gas cost of the collect |
| `baseCollect.maxGasPerRunEth` | `0.0003` | stop sending once spent + the next worst case would exceed this in one run |
| `baseCollect.maxGasPerTxEth` | `0.0002` | one transaction's worst case (`gasLimit x maxFeePerGas + max(2 x L1 quote, minL1AllowanceEth)`) may not exceed this |
| `baseCollect.maxGasPriceGwei` | `1` | HARD cap on the signed `maxFeePerGas`; nothing is sent when base fee + tip exceed it |
| `baseCollect.maxPriorityFeeGwei` | `0.01` | cap on the signed tip |
| `baseCollect.maxGasLimit` | `500000` | absolute gas-limit ceiling; a larger estimate is skipped |
| `baseCollect.waitTimeoutSec` | `120` | how long to wait for a receipt before the run stops |
| `baseCollect.minL1AllowanceEth` | `0.00002` | floor of the L1 data-fee allowance (`max(2 x quote, floor)`); an estimate, not a hard bound |
| `baseCollect.maxCollectsPerRun` | `6` | at most this many collect transactions per run |
| `baseCollect.dailyGasCapEth` | `0.001` | rolling 24 h gas ceiling over all runs (from the Base `state.json`) |

**Log lines** (a run prints them and appends them to `$HOME/base-data/collector.log`):

```
=== base collect mode=collect chainId=8453 ===
Operator: 0x...                     <- the address to approve below
--- Trading (0x...) ---
SKIP aerodrome-v1 Trading 0x...: operator 0x... is not approved for all on 0x827922686190790b37229fd06084350E74485b72 (isApprovedForAll=false); no transaction sent, no approval requested
#8905958 USDC / LAPTOP fees $6.9989 gas $0.0150 -> collect: fees $6.9989 >= $2 and >= 5x gas
  collected #8905958 to 0x...: tx 0x..., simulated amounts ..., gas used ..., paid ... ETH
#79371151 WETH / cbBTC fees $0.4000 gas $0.0150 -> skip: below minFeesUsd ($0.4000 < $2)
=== base done: 1 collected, 1 skipped, gas 0.000006 ETH ===
```

`./run-collector.sh simulate` runs the Base pass as `--mode=simulate` (reads only, nothing sent, no keystore is decrypted; the
operator address is read from the keystore's public `address` field) and marks every decision line `(simulate)`. You can also run
`LP_DATA_DIR=$HOME/base-data node collector-base.js --mode=simulate` yourself.

### Approving the operator (Rabby, once per manager)

The collector can only collect for a wallet that approved the operator on the position manager. Do this for the wallet that
OWNS the NFTs (Trading), once for each manager.

1. Get the operator address: run `LP_DATA_DIR=$HOME/base-data node collector-base.js --mode=simulate` (or `./run-collector.sh simulate`)
   and read the line `Operator: 0x...`. Never type it from memory.
2. Open Rabby, select the owner wallet, switch the network to **Base**.
3. Open `https://basescan.org/address/<manager>#writeContract` (or `#writeProxyContract` if that is the tab shown) for
   `0x827922686190790b37229fd06084350E74485b72` (`aerodrome-v1`), checking the address character by character against this
   page. Do the same later for `0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53` (`aerodrome-cl2`).
4. Click **Connect to Web3** and choose Rabby.
5. Find `setApprovalForAll(operator address, bool approved)`: `operator` = the address from step 1, `approved` = `true`.
6. Click **Write** and read the Rabby prompt before confirming: it must say Base, the manager as the contract, and an
   "Approve all NFTs" style warning for the operator address. Confirm. Repeat steps 3 to 6 for the second manager.
7. Verify: on each manager's **Read Contract** tab call `isApprovedForAll(owner, operator)` with the owner wallet and the
   operator; it must return `true`.
8. Then set `"collect": true` for that wallet in `$HOME/base-data/settings.json` (`wallets.main.collect` for Trading) and run
   `./run-collector.sh simulate` to see the decisions before the next scheduled run.

**Revoke:** the same `setApprovalForAll` call with `approved` = `false` (then `isApprovedForAll` reads `false` and the SKIP
line appears again). Set `collect` back to `false` when you do not want the pass to run for that wallet.

**RISK, read this.** `setApprovalForAll` does not mean "collect only". It lets the operator key **transfer** or sell **every**
Aerodrome position NFT of that wallet on that manager on Base, and remove their liquidity, not only collect fees. It is blanket,
not a list: it covers every NFT the wallet holds now AND any NFT it receives later on that manager. The operator key is the same
one that runs the Robinhood collector: it is cached in `/dev/shm` while the unlock window is armed and any process of your user
can read it there. In addition, `run-collector.sh` hands `LP_KEYSTORE_PASS` to the node process as an environment prefix, so the
passphrase is in that process's initial environment (`/proc/<pid>/environ`, readable by the same user and by root); this is the
same exposure as the Robinhood collector. `collector-base.js` unsets `LP_KEYSTORE_PASS` from its own `process.env` after
decrypting (hygiene only; it does not clear `/proc/<pid>/environ`). The code only ever calls `collect`, but an attacker who has
the key is not bound by the code. Mitigations: keep the unlock window short, revoke the approval when you do not need it, and
keep in that wallet only the positions you accept this for.

**Revoke on EVERY manager the operator was ever approved on:** the two Aerodrome managers named above and, if the same operator
EOA was ever approved on Base's Uniswap v3 NonfungiblePositionManager `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` or v4
PositionManager `0x7C5f5A4bBd8fD63184577525326123B519429bDc`, those too. Verify each with `isApprovedForAll(owner, operator)` on
its Read tab; all four must read `false` after revocation.

**Schedule.** The task runs `run-collector.sh` as before; the Base pass rides on it. Register it for 8:00 with
`windows-task.ps1 -At 8am` (the script defaults to 9am). Nothing changes in how the task is registered.

## PulseChain (read-only instance): PulseX v1 and v2 liquidity

A third read-only dashboard, for PulseChain (chain 369), started and fronted exactly like Base: its own data
directory and port, `LP_READONLY=1 ... --no-loops --no-services`, no `collector`/`vault`/`risk` sections,
`"noTransactionData": true`, view calls only. PulseX is Uniswap-v2-style, so a position is a balance of the
pair's own LP token, not an NFT: `v2lp.js` reads it (reserves, totalSupply, your share, value) and puts it in
`external`, never `positions`, so the collector, guardian and Sell tab cannot act on it. There are no
Uniswap v3/v4 contracts in its settings and the v3 paths are skipped.

```
mkdir -p ~/pulse-data && cp settings.pulsechain.example.json ~/pulse-data/settings.json   # edit wallets
./start-all.sh        # starts :8795 (LP_PULSE_PORT) and adds PulseChain to the router (--chains=...,pulsechain)
./stop-all.sh         # stops it by its port only, and only if it is that server.js with that --data-dir
node tools/verify-onchain.js pulse            # read-only proof of every address in the example (PASS / FAIL)
node tools/verify-pulsechain-wallets.js       # what each wallet holds right now (add --json for JSON)
```

- Data dir `${LP_PULSE_DATA_DIR:-$HOME/pulse-data}`, port `${LP_PULSE_PORT:-8795}`; nothing starts unless
  `settings.json` exists there. A keyed RPC goes in `.env` as `LP_PULSE_RPC_URL` (same handling as
  `LP_BASE_RPC_URL`: validated, never shown to a page, redacted from logs and errors). The Blockscout PRO key is
  never used on this chain (`api.scan.pulsechain.com` answers JSON without one; `scan.pulsechain.com` is the HTML
  frontend).
- `contracts.v2lp` lists the PulseX factories (`pulsex-v1`, `pulsex-v2`; the name prefixes the position id). A pair
  counts only if `pair.factory()` equals the configured factory: both factories' LP tokens are called "PLP" and
  unrelated "PLP" tokens exist, so symbols are never trusted. `pairs: [..]` pins LP addresses.
- Discovery, as a union: pinned pairs; the explorer's token list (JSON only, every candidate confirmed on chain;
  an HTML/Cloudflare answer is "unavailable" and logged once); and, while the list is unavailable (or with
  `"scan": true`), a resumable enumeration of the factory (`allPairs(i)` + `balanceOf`, cursor in
  `v2lp-scan-<name>.json`, at most `scanBudget` requests and 10 s per wallet per refresh). Reads go through
  Multicall3 (~150 sub-calls per request), so ~200 LPs per wallet cost a handful of requests; at most `maxPairs`
  (300) pairs are read in full per refresh and what is left over is reported as partial.
- Values: WPLS/USD comes from `tokens.usdReferencePair` (the PulseX v1 WPLS/DAI pair, ~323k DAI deep): its DAI
  reserve over its WPLS reserve, unpriced when the DAI side is under `usdReferenceMinLiquidityUsd`. Stablecoins are
  keyed by ADDRESS (`contracts.pulsex.stables`: bridged DAI, USDC, USDT). The forked pDAI
  (`0x6B17...1d0F`, also symbol "DAI") is not a dollar and is priced like any other token. Another token is priced
  from its WPLS or stable pools on either factory, never from the pair being valued, and never from a pool whose
  quote side holds under `minQuoteUsd` ($100). No price gives `valueUsd: null` with the reason, never 0; a pair
  whose smaller side is under that floor is flagged thin. Because a memecoin's only market is usually its own
  pair, many LPs show "no price": that is the honest answer, not an error.
  - A non-anchor side (anything but WPLS or a configured stable) is capped at what its amount would sell for
    through its price-source pool (x*y=k), never its face value.
  - If the two sides differ by more than 10%, the position is shown as 2 x the smaller side, marked "≈", with a
    note, and is not counted.
  - Only an LP that is not thin, not gap-flagged and has a WPLS or configured-stable side (by address) counts
    toward "LP value" and "in pools". Others stay on their cards with "not counted in the liquidity total: ...",
    and the headline shows their sum as "+$X shown, not counted" (`totals.uncountedUsd`). The totals are
    deliberately conservative: memecoin/memecoin LPs never count.
  - Portfolio loose tokens follow the same cap, but only on chains with v2 LP readers configured (PulseChain):
    there every row with a known pool depth is limited to `depthUsd x amount / (depthTok + amount)` (and to the
    pool's quote-side depth), as for LPs, in the owner and the watched views alike. Other chains cap thin rows
    only, as before.
- Fees accrue inside the reserves of a v2 pair and are realised on removal, so fee0/fee1 are 0 with that note.
- Farm: `contracts.pulsex.farms` holds the PulseX MasterChef (`0xB2Ca...02d4`, 19 pools, reward INC), read by a
  view-only adapter (`kind: "pulsex-masterchef"`: `poolLength`, `poolInfo`, `userInfo`, `pendingInc`). LP staked
  there is valued like unstaked LP and marked `staked: true` with the pending INC. None of the configured wallets
  has a stake today.
- Loose wallet tokens are priced by the portfolio from their PulseX v2 pairs (`contracts.v2Factory`); a wallet
  with hundreds of spam tokens makes that read slow.

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

### Login throttle (gate and remote MCP)

`lp-gate.mjs` and `lp-mcp-remote.mjs` share `login-throttle.mjs`. Both listen on
127.0.0.1 only, so the socket peer is always loopback and the real client comes from
`X-Forwarded-For`: the throttle key is the **last** entry (the one the trusted local
hop appended) and only when the peer is loopback; the first entry is client-controlled
and never used. Invalid or missing values fall back to the peer address; IPv6 keys on
the /64. `LP_GATE_TRUST_PROXY=0` ignores XFF entirely.

- 5 wrong passphrases lock a key for 15 minutes; a key with failures but no lock
  expires 15 minutes after its last failure. Storage is capped at 5000 records; under
  pressure the oldest unlocked record is evicted, locked records never are, and if
  nothing is evictable new keys are refused (429, fail closed). Nothing is ever cleared in bulk.
- Global budget: 60 failures per 15 minutes across all keys (`LP_GATE_GLOBAL_MAX`,
  `LP_GATE_GLOBAL_WINDOW_MS`). While engaged every login, even with the right
  passphrase, gets 429. Trade-off: a distributed guesser can deny service (including
  to you) for up to the window, but cannot exceed about 60 guesses per 15 minutes
  (about 5,700 a day). A successful login clears only its own key, never the global count.
- The gate and the remote MCP each have their **own** budget (separate processes), and
  both check the same shared passphrase, so together they allow about 120 guesses per
  15 minutes (60 each).
- `lp-mcp-remote.mjs` uses `trust proxy "loopback"` (XFF honoured only from a loopback
  peer) instead of a hop count. If a second proxy hop is ever added in front of it, or
  the bind address is widened, change that setting deliberately.
- Open question: if the Tailscale Funnel forwards a client-sent `X-Forwarded-For`
  without appending the real address, the last entry is client-controlled and only the
  global budget limits guessing. Do a one-time live check: send
  `X-Forwarded-For: 203.0.113.1` through the Funnel URL and confirm the gate log shows
  your real IP, not 203.0.113.1.
- `lp-gate.mjs` and `lp-mcp-remote.mjs` hard-code the `127.0.0.1` bind instead of
  honouring `HOST`. This is deliberate and part of the trust model (the loopback peer
  is what makes the last-XFF-entry rule safe), so it is an exception to the usual
  `HOST` convention.
- `LP_GATE_GLOBAL_MAX` must be an integer 1..10000 and `LP_GATE_GLOBAL_WINDOW_MS`
  60000..86400000; anything else falls back to the default with a warning. The gate
  forwards the normalized client IP (not the raw header) upstream; the /64 folding is
  only the throttle key.

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
chmod +x *.sh                      # exec bits are lost in transit
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
| `arm` | `maxMinutes` — the longest arm window (how long the collector key stays decrypted); default 1440 = 24 h, hard cap 7 days. While armed the operator can move every v4 position, so keep it short |
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
Arming afterwards: sign the same message, the server re-derives the
key, decrypts, checks the keystore still opens, and writes the same RAM cache `unlock.sh` writes, for the
chosen window (2 hours to 1 week; a WSL restart clears the cache regardless). Nothing on disk is decryptable without the owner wallet; the `/api/arm*` endpoints answer
over loopback only and the public gate refuses them. Replacing the keystore changes the message, so setup
must be repeated. "Forget saved passphrase" deletes the ciphertext.

The message names the asker on its first line (`127.0.0.1:8787 wants you to sign this message`) and
carries a `nonce:` — 16 random bytes generated at setup and kept in `arm-secret.json`. Everything else in
it is public: the template is in this repository and the chain, owner and operator addresses are on chain,
so without the nonce anyone could compose the exact string and ask the owner to sign it somewhere else.
That signature is the key to the stored passphrase, and the text truthfully says it moves no funds, which
is what makes it a good thing to be asked to sign. **A setup made before this change has no nonce and
cannot be armed: the arm page will say so, and one further setup replaces it.** Keeping the nonce out of
the message would have meant keeping a phishable signature.

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
./systemd-install.sh
```

It enables lingering so the timer survives closing your terminals, and uses
`Persistent=true` to catch up a run missed while WSL was down. Fees keep
accruing regardless of when you sweep, so a late run costs nothing.

### The 6-hourly task loop (`tasks/run-all.sh`)

server.js spawns `tasks/run-all.sh` ten minutes after it starts and every six hours after that
(cron is not running here; the cadence survives restarts). It runs four scripts, each non-fatal
for the next, and appends what they found to `brain/proposals.md`:

- `tasks/improvement-loop.js` — LP analysis from attribution, the portfolio and the pool scout.
- `tasks/code-scan.js` — TODO markers, untested modules, hardcoded values.
- `tasks/code-review.js` — the review model reads the files changed in the last six hours plus one
  rotating key file (Ollama Cloud, `OLLAMA_API_KEY`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT`).
- `tasks/dashboard-review.js` — the dashboard reviewed as a product: every page at 1280 and
  375 px is captured from the live server through the smoke test's Chrome, reduced to a text
  skeleton, and sent to the model with the data the page is built from; at most six element-tied
  findings per page-width, fingerprinted across runs so only new ones count. Screenshots land in
  `tasks/output/screens/`. It is read-only by construction: an allow-list of GET routes is checked
  before any request and nothing is clicked.

Outputs are in `tasks/output/` (git-ignored). `POST /api/tasks/run?task=<name>` and the MCP
`run_tasks` / `get_task_output` tools start one script or all of them and read the results.

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
  **Every watched wallet** (`wallets.watched`, as `watch.js` reads them) is tracked the same way, in the
  same `snet-staking.json`: the main wallet stays at `tokens[token]` (no migration; an older build still
  reads the file), the others at `wallets[address][token]`. A wallet with no sNET and no earlier entry
  creates no ledger and costs no backfill; a failure for one wallet is logged and the rest go on.
  `/api/staking` keeps `ok, at, tokens` (main) and adds `wallets: [{address, label, tokens}]`;
  `/api/staking?wallet=<address|label>` returns one configured wallet, anything else is a 400 and makes
  no RPC call. The Dashboard shows each wallet's staking in its Wallet detail, and Analytics > Staking
  follows the wallet picker (All wallets: one row per wallet, a USD subtotal, no merged APR); tax rows
  carry the wallet that earned them. The MCP `staking` tool takes an optional `wallet`. Known limit:
  sNET sent between two watched wallets counts as an out for one and an in for the other. Attribution,
  the digest and alerts still read the main wallet's staking only.

All of it is the collector wallet's own history, so the wallet picker is hidden there. Each page fetches
only what it shows. The public gate serves the page at the same path.

## Changelog

### 2026-09-23

- Claimed fees are split by how they left the pool: **explicit collects** (a zero liquidity
  change, by the collector or the wallet) and **settled on liquidity changes** (v4 pays out a
  position's fees whenever liquidity is added or removed, with no collect involved). Both are
  the owner's fees and both stay in the total; the split answers "what was collected" apart from
  "what came out because the position was changed". `summary()` carries `byAction`, and
  `/api/claims/total` carries `byAction` in the shape of `subtotals`; the Total claimed fees
  panel shows it under "By how it was settled" and each card's Claimed fees tile adds a line.
  Each part takes a USD figure only when every record in it is priced, as the total does.
- Arc's viewer runs the background claims scan (`--claim-scan`, in `start-all.sh` and
  `restart-dashboard.sh`). `--no-loops` had switched it off, so Arc scanned only ~54k blocks
  (about 7.5 hours) each time a claims panel was opened and never reached collects older than
  that. The scanner only reads logs and writes `claims.json`; the viewer stays `LP_READONLY`.

### 2026-09-22

- Claims: a settlement that reaches the owner through this collector is the owner's, and a
  native leg's amount is read from the transaction's internal transfers. Only 7 of 40
  positions could be reconstructed before, for two reasons that turned out to be the same
  money. Twenty were refused because a native leg emits no log -- but the amounts are in the
  transaction's internal transfers, which Blockscout serves. The rest were refused because
  "the pair's tokens also moved between the pool manager and 0x8b65…, not this position's
  owner" -- and 0x8b65 is this collector's own operator, which takes the fees and sweeps them
  to the owner. Fixing either alone changes nothing: reading the native amount still leaves it
  paid to the "stranger" operator, and accepting the operator still leaves the native amount
  unknown. So both, together, under `DECODER = 8`, which re-derives every stored record.
  A payout settled through a collector is flagged `viaCollector` rather than passed off as a
  direct payment; an address that is not the owner or a configured collector is still a
  stranger and still refused; and a failed internal-transfer lookup fails the scan chunk so it
  is retried, instead of freezing a network blip into a permanent "cannot be read". The
  server's own native-asset gate, which refused such positions before the store was ever
  consulted, now defers to the store whenever a source for internal transfers is configured.
- `settings.json`: `arm.maxMinutes` raised to 10080, so the wallet page's "1 week" window can
  actually be chosen. `unlock.sh` never honoured this cap and still does not.
- Watchdog: a public-path probe. Everything it watched before ran on this machine, so it
  could not see the 2026-09-21 outage at all -- the dashboard answered on loopback, the
  funnel listed every mapping, the cert was valid, and the public address answered nothing
  for hours because the node's Funnel ingress registration had gone stale after the machine's
  IP changed. The probe goes through the relay as a browser does, on its own slower clock
  (every 10 cycles, three consecutive failures before acting, because ingress takes ~25 s to
  propagate), and its recovery restarts tailscaled and re-applies the funnel -- never the
  dashboard, which was never at fault. At most one tunnel restart per 30 min. The address is
  read from the funnel config, so there is no second copy to keep in step, and no tailscale
  means the probe is a no-op. `watchdog.sh --self-test` covers it and now runs in the suite.
- Improvement loop: move proposals are filtered to positions that are still open. The pool
  scout's window is historical, so a position closed days ago still had rows in it and still
  beat a sibling; on 2026-09-22 the loop's single HIGH action was "Move ETH / USDG #2302341",
  closed since, and two of its four proposals were for positions no longer held. An unknown
  position list leaves every candidate in rather than silently emptying the report.
- Dashboard: token symbols and the "priced as" name are escaped where they enter the balance
  table (`chainRef` is deliberately given markup by other callers, so the escaping belongs at
  the call site). The nav highlight and the scope picker's listener are guarded -- both run at
  the top level, where one missing element threw and left the page blank. `renderHeadline`
  now sets the section header for a single watched wallet instead of leaving the previous
  wallet's name and total on screen.

### 2026-09-21

- Three MCP tools. `claimed_fees`: fees settled on chain across every wallet, rebuilt from
  events. It is not `collects`, which counts only runs this collector made -- fees the wallet
  settled itself are absent there and present here, so a zero in one is not a zero in the
  other. It returns `state` and `coverage` alongside the subtotal because the history is
  usually partial (7 of 40 positions complete when it was written), and a subtotal quoted as a
  lifetime total is the failure this tool exists to prevent. `token_health`: contract risk per
  token (transfer tax, mint function, guardian or admin powers, verified source, holders, age),
  defaulting to the tokens above `safe`. `daily_check`: the daily Telegram text. All three are
  read tools, so the read-only remote connector serves them; reconnect the claude.ai connector
  to pick them up, as it caches the tool list.
- Portfolio chart: the 2026-09-17 sample that recorded $2.34e39 was removed with
  `tools/repair-portfolio-spike.js`. The write-time guard in `server.js` refuses such a sample,
  but it was added after this one was already stored, so the point sat in history setting the
  chart's upper bound. Axis labels now use the compact formatter, which switches to an exponent
  above $1T: a misread price can no longer print a forty-digit label across the gutter.
- `arm.js`: a pre-salt `arm-secret.json` no longer wedges the arm page. `currentSalt()` offers a
  fresh nonce instead of throwing and the refusal moved into `decrypt()` -- setup and forget both
  need a signable message, so throwing in the message builder meant the only advertised way out
  ("run setup again") raised the very error it was telling the owner to clear.

### 2026-09-10

- Launch scanner: new v4 pools every 5 min, scored on market cap, contract, LP value, an
  `eth_call` buy-and-sell round trip (honeypot / sell tax), holders and buy pressure; Telegram
  alert at 70/100; Launch Watch section on the dashboard; `/api/launches`.
- Sell tab on the Wallet page: quote and sell any token a wallet holds in its v4 pool, signed
  by the wallet in the browser (`/api/sell/tokens`, `/api/sell/quote`, `sell-v4.js quote()` and
  USDG-quoted pool discovery).
- Phase 2, unified brain: `agent.js` is the one assistant behind the web panel and loopback
  scripts, with transcripts per channel and `brain/notes.md` on disk; Telegram input stays
  with the VPS agent (no polling here, so no 409), `telegram.js` only sends; alerts are remembered on the chat they
  went to, so "approve it" needs no id; roles by channel (web read, Telegram approve via a relay,
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


### Dashboard insights

Dashboard now shows up to three **Needs attention** items and **What changed since my last
visit?**. The last successful visit timestamp stays in that browser; it is saved when the
page is hidden or left. Refreshes keep the comparison baseline fixed. First visits show the
last 24 hours. Position observations older than ten minutes are labeled stale.

Analytics compares the main wallet over two complete Monday–Sunday weeks in `LP_TZ` (or
the server timezone). It shows measured fees, recorded gas, observed time in range, value
change, recorded external transfers, and estimated return on starting value. Returns
subtract recorded transfers from wallet value change; gas is already included in that
change. Incomplete transfer history can still distort these estimates. Missing prices or
value-history gaps withhold the affected weekly figures, and missing gas prices remain
unavailable. Time in range is weighted by observed position-hours, not unobserved downtime.

`GET /api/insights?since=<epoch-ms>` returns the same read-only summary. `since` defaults to
24 hours ago and accepts at most 30 days of lookback. It reads existing snapshots/ledgers
without initiating RPC requests, signing, or writing state. Loko_AI can call the read-only
`dashboard_insights` MCP tool with a timestamp or use its 24-hour default; it cannot see a
browser's private last-visit timestamp. No Telegram message is sent automatically.

Verification: `LP_TZ=America/New_York node test/insights.test.js`. This test is also part of
`npm test`; the existing live-config browser smoke remains a separate environment requirement.

### Explicit settings for write tools, and the restart guard

The Arc tools default to `$HOME/arc-data/settings.json` (or `LP_ARC_DATA_DIR`). That default can be
a live instance's data, so the write-capable tools (`tools/apply-vault-settings.js --apply`,
`tools/propose-collector-settings.js --apply`, `tools/recover-stranded.js --execute`,
`tools/deploy-vault-arc.js --execute`) refuse to run when none of `--settings=`, `LP_ARC_SETTINGS`
or `LP_ARC_DATA_DIR` was given, and print the path the default would have used. Dry runs keep
the default.

`restart-dashboard.sh` applies the same idea: with `DATA` and `LP_ARC_DATA_DIR` both unset it
refuses (before stopping anything) unless the script sits in `$HOME/uniswap-collector`, or
`LP_RESTART_ALLOW_DEFAULT=1`. A dev copy cannot replace the live :8797 viewer by accident.
