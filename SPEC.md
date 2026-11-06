# SPEC: five tasks, five commits (1..5, in order)

Project: `/mnt/c/Swarm-Projects/projects/lp-dashboard`, Node (CommonJS plus a few `.mjs`), git branch `master`, HEAD `92ee3c6`.
The previous spec (smoke.js fail-fast, npm audit fix) is kept verbatim at the end as "Appendix A (superseded)".

Tests: `node test/run-all.js` (~85 s); one file: `node test/run-all.js <filter>`. Do NOT use `npm test -- <filter>` (it feeds the filter to eslint). `eslint .` must stay clean. This dev copy has no `settings.json` / `.env`, so `test/smoke.js` failing fast is the one expected failure; nothing else may fail. Every new test uses mocked RPC / mocked fetch / injected clock: NO network in the suite.

## HARD CONSTRAINTS (apply to all five tasks)

H1. LIVE install `/home/loko/uniswap-collector` (serving 127.0.0.1:8787, router :8800, Arc viewer :8797) is read-only reference. Never write to it, never restart, stop, signal or otherwise touch its processes, never run `start-all.sh`/`stop-all.sh`/`restart-dashboard.sh` against it. Its `settings.json` may be read for real contract addresses only. No test or script in this work may default to its paths as a write target.
H2. Architecture stays: one `server.js` per chain, own settings file and own `--data-dir`; `chain-router.js` fronts them with a per-browser chain picker (`CHAINS`, today Robinhood + Arc). No cross-chain merging, no shared ledgers, no shared cookies. Existing router behaviour for `robinhood,arc` must be byte-for-byte unchanged by default.
H3. All new chain support (Base, PulseChain) is READ-ONLY: no signing, no keystore, no collect, no claim, no arm, no approval, no new transaction path of any kind. New instances run with `LP_READONLY=1 --no-loops --no-services` and their settings contain no `collector`, `vault`, `risk.autoCollect` or `risk.sell` sections. Contracts are only ever called with view / `staticCall`.
H4. Secrets (an RPC URL containing an API key, the Blockscout PRO key) come only from environment variables, are never committed, never put in `SPEC.md`/`REPORT.md`/examples, never sent to the browser, never logged. Defaults are public endpoints. No SSRF: no request parameter, cookie, header or API body can choose an RPC, explorer or Blockscout URL; configured URLs are validated (https only; no userinfo; no loopback/private/link-local/metadata IP literals or `localhost`); a bearer key is only ever sent to an allow-listed host.
H5. Contract addresses are never trusted from memory. Each must be verified on chain by `eth_call` (name()/symbol(), factory(), ownerOf/positions of a known token) against a public RPC, and the call + result recorded in the "On-chain verification" section below. Anything unverified is marked UNVERIFIED and listed in Open Questions; the implementer must verify it (with `tools/verify-onchain.js`, see Task 4/5) before it goes into an example settings file, and must leave it out if it fails.
H6. Follow `/mnt/c/Swarm-Projects/CLAUDE.md`: servers bind 127.0.0.1 (override `HOST`), `.gitignore` covers `node_modules`, `.env`, `.env.*`, check secrets are ignored before committing, never push, never add a remote. This spec-writing step did not commit; the orchestrator commits per task.

---

## ON-CHAIN VERIFICATION (status as of this spec)

NOTE (superseded for Base, see the table below, verified at implementation time): the spec-writer agent had NO shell tool (only file read/search/write), so it could not run curl/node and performed ZERO on-chain calls. Nothing below is verified. The addresses marked "given" come from the task description / live `settings.json`; the rest are from model memory and are UNVERIFIED. A ready, untested, read-only script was written at
`/tmp/claude-1000/-mnt-c-Swarm-Projects/07a8a466-72c6-4b70-8eb0-c9f28bbb12a1/scratchpad/verify-onchain.js`
(run `node <that path> base` and `node <that path> pulse`; `CAND=0xmgr1,0xmgr2 node ... base` to test candidate newer Aerodrome managers). The orchestrator (or the Task 4 implementer, as its first step) must run it and paste the output into the table below / into `REPORT.md`. It uses ethers from the project's `node_modules`, public RPCs `https://mainnet.base.org` and `https://rpc.pulsechain.com`, and only `eth_chainId`, `eth_call`, `eth_getBalance`, `eth_getCode`.

Source of the Robinhood values (live settings, read-only, given): sNET `0xb773ec2C326B7f98a5a83fc098825492F020a4c7`, NET `0xCA9c78Dd337A67F6e0077F65F5E9218719d30eDf`, staking contract `0xB078cc304A0B264C5F3680DC0488954ACcd02E87` (these are on Robinhood chain 4663; Task 3 needs no new verification, the existing ledger already runs against them). Live watched wallets include `collect: true` for SEAL wallet, Trading, LP Rewards (relevant to Task 2 footer).

### Base (8453), public RPC https://mainnet.base.org  (VERIFIED 2026-11-06, read-only; re-run: `node tools/verify-onchain.js base`)
Every row was proven by `eth_call` / `eth_getCode` against the public RPC (Base head about 53.69M). `tools/verify-onchain.js base` repeats every PASS below and also checks that each address written in `settings.base.example.json` has a PASS line. All three Aerodrome managers return `name()` "Slipstream Position NFT v1": identify them by address, never by name.

| Item | Address | Call | Result | Status |
|---|---|---|---|---|
| chain | - | eth_chainId | 0x2105 (8453) | PASS |
| Slipstream v1 NPM | 0x827922686190790b37229fd06084350E74485b72 | name() / symbol() / factory() | "Slipstream Position NFT v1" / "AERO-CL-POS" / 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A (= CL factory) | PASS |
| v1 deploy block | same | getCode at 13,843,718 / 13,843,719 | "0x" / code | PASS (fromBlock 13843719) |
| token #79371151 | v1 NPM | ownerOf; positions | owner = Trading 0xaDf94A20558E1E6d64c429F8F9f017169BF3d743 (not staked); WETH/cbBTC, tickSpacing 100, ticks -265800..-265200, liquidity 6975006731118, operator = gauge | PASS |
| v1 pool + gauge | CL factory getPool(WETH,cbBTC,100) | pool.gauge() ; factory.voter().gauges(pool) | pool 0x70aCDF2Ad0bf2402C957154f944c19Ef4e1cbAE1, gauge 0x41b2126661C673C2beDd208cC72E85DC51a5320a (both agree); gauge.nft() = v1 NPM, rewardToken() = AERO | PASS |
| v1 gauge state | gauge 0x41b2... | stakedContains(Trading,id) / stakedLength / earned / voter.isAlive | false / 0 / reverts "NA" / false (periodFinish 2026-10-22) | NOT STAKED, GAUGE KILLED |
| Newer manager ("Gauges V3" NPM) | 0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53 | name() / symbol() / factory() | "Slipstream Position NFT v1" / "AERO-CL-POS" / 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef | PASS (answers Open Q1) |
| cl2 deploy block | same | getCode at 44,394,729 / 44,394,730 | "0x" / code | PASS (fromBlock 44394730) |
| token #8905958 | cl2 NPM | ownerOf; positions (same 12-field tuple as v1) | owner = Trading (not staked); USDC/LAPTOP, tickSpacing 200, ticks 305400..309400, liquidity 14324821211673834, owed 249320 / 10163567688833743533 | PASS |
| cl2 pool + gauge | cl2 factory getPool(USDC,LAPTOP,200) | pool.gauge(); voter().gauges(pool) | pool 0x99cf3E8bfB02c300312c53Aac5D0B082e3D5975C, gauge 0x334C37C4133aC56961Ef428696D2D375E89cCA03; gauge.nft() = cl2 NPM, rewardToken() = AERO | PASS |
| cl2 gauge state | gauge 0x334C... | stakedContains / stakedLength / earned / isAlive | false / 0 / reverts "NA" / false | NOT STAKED, GAUGE KILLED |
| "Gauge Caps" NPM (not configured) | 0xa990C6a764b73BF43cee5Bb40339c3322FB9D55F | factory(); ownerOf(8905958) | 0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a; reverts (token does not exist there) | INFO: holds none of the positions; left out of the example |
| Voter | 0x16613524e02ad97eDfeF371bC883F2F5d6C480A5 | isAlive over all 2013 gauges | 0 alive | INFO: every Aerodrome gauge is killed; reader reports AERO 0 with "gauge killed" |
| Trading wallet | 0xaDf94A20558E1E6d64c429F8F9f017169BF3d743 | getCode | 0xef0100 + 69007702764179f14f51cdce752f4f775d74e139 (EIP-7702 delegated EOA) | PASS: "owner has code" must exclude 0xef0100 and be confirmed by gauge.nft() |
| Wallet 11 / Wallet 12 | 0xFc1235E6523Becf4b329ed9ADf21750cfAF65Bfb / 0xAAB445f2846476A31Aaed66112B0f3e2ad82c50A | getBalance; balanceOf on v1 / cl2 / Uniswap v3 NPM | 0.000952 ETH, 1/0/39 ; 0.000302 ETH, 0/0/4 | PASS |
| WETH | 0x4200000000000000000000000000000000000006 | symbol / decimals | WETH / 18 | PASS |
| USDC | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 | symbol / decimals | USDC / 6 | PASS |
| cbBTC | 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf | symbol / decimals | cbBTC / 8 | PASS |
| LAPTOP | 0xB095274743941e953c746F9C228DA9c18Bb6ec29 | symbol / decimals | LAPTOP / 18 | PASS |
| AERO | 0x940181a94A35A4569E4529A3CDfB74e38FD98631 | symbol / decimals; = gauge.rewardToken() | AERO / 18; yes | PASS |
| Aerodrome classic PoolFactory | 0x420DD381b31aEf6683db6B902084cB0FFECe40Da | getPool(AERO,USDC,false) + reserves | 0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d: 2.49M USDC / 4.31M AERO => AERO $0.579 | PASS |
| Uniswap v3 factory | 0x33128a8fC17869897dcE68Ed026d694621f6FDfD | getPool(WETH,USDC,100/500/3000/10000); liquidity; USDC balance | deepest fee 3000: 0x6c561B446416E1A00E8E93E221854d6eA4171372 (41.0M USDC, liq 3.13e19); fee 500 0xd0b5...F224 (1.83M); fee 10000 0x0b1C...2d69 (0.54M); fee 100 0xb4CB...00e5 (0.10M) | PASS: usdReferenceFeeTier 3000 |
| Uniswap v3 NPM | 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1 | name() / factory() | "Uniswap V3 Positions NFT-V1" / 0x3312...FdfD | PASS |
| Uniswap v4 PoolManager | 0x498581fF718922c3f8e6A244956aF099B2652b2b | getCode | 24,009 bytes | PASS |
| Uniswap v4 PositionManager | 0x7C5f5A4bBd8fD63184577525326123B519429bDc | name(); poolManager() | "Uniswap v4 Positions NFT"; 0x4985...2b2b (not enumerable: tokenOfOwnerByIndex reverts) | PASS |
| Uniswap v4 StateView | 0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71 | poolManager() | 0x4985...2b2b | PASS |
| Multicall3 | 0xcA11bde05977b3631167028862bE2a173976CA11 | getCode | 3,808 bytes | PASS (not used by the dashboard) |
| Log RPC | https://base-rpc.publicnode.com | eth_getLogs, 50,000 blocks, Transfer logs of the cl2 NPM | 112 logs; but only recent history (older ranges time out or need a token) | PASS: `chain.logsRpcUrl`, `maxLogRange` 50000 |
| mainnet.base.org logs | https://mainnet.base.org | eth_getLogs | HTTP 429 for every range while eth_call works | FAIL for logs, hence `logsRpcUrl` |
| Blockscout | base.blockscout.com / api.blockscout.com/8453 | GET /api/v2 | Cloudflare HTML 403 / JSON 402 without a key | UNAVAILABLE: treated as "unavailable", RPC discovery covers it |

### PulseChain (369), public RPC https://rpc.pulsechain.com  (VERIFIED 2026-11-06, read-only; re-run: `node tools/verify-onchain.js pulse`)
Run at block 27,985,312. Every address in `settings.pulsechain.example.json` has a PASS line in that run (15 of 15). Reserves move; the figures are as read.
| Item | Address | Call | Result | Status |
|---|---|---|---|---|
| chain | - | eth_chainId | 369 (0x171) | PASS |
| WPLS | 0xA1077a294dDE1B09bB078844df40758a5D0f9a27 | symbol() / decimals() | WPLS / 18 | PASS |
| DAI from Ethereum (bridged) | 0xefD766cCb38EaF1dfd701853BFCe31359239F305 | symbol() / decimals() | DAI / 18 ("Dai Stablecoin from Ethereum") | PASS |
| USDC from Ethereum | 0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07 | symbol() / decimals() | USDC / 6 | PASS |
| USDT from Ethereum | 0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f | symbol() / decimals() | USDT / 6 | PASS |
| forked pDAI (NOT a stable) | 0x6B175474E89094C44Da98b954EedeAC495271d0F | symbol(); v1 getPair(WPLS, it) reserves | "DAI"; 18,075,386 pDAI / 3,734,429,205 WPLS (about $0.001 per pDAI at the WPLS price) | INFO: never counted as $1, absent from the example |
| PulseX v1 factory | 0x1715a3E4A142d8b698131108995174F37aEBA10D | getCode; allPairsLength() | 14,134 bytes; 65,500 pairs | PASS |
| PulseX v2 factory | 0x29eA7545DEf87022BAdc76323F373EA1e707C523 | getCode; allPairsLength() | 14,151 bytes; 191,995 pairs | PASS |
| v1 WPLS/DAI (reference pair, deepest) | 0xE56043671df55dE5CDf8459710433C10324DE0aE | getPair(WPLS, DAI) on v1; pair.factory(); getReserves() | non-zero; = v1 factory; 323,668 DAI / 58,861,667,328 WPLS => WPLS $5.4988e-6; LP symbol "PLP" | PASS (used as `tokens.usdReferencePair`) |
| v1 WPLS/USDC | 0x6753560538ECa67617A9Ce605178F788bE7E524E | same | = v1 factory; 323,035 USDC / 58,675,151,729 WPLS | PASS (second, within 0.2 %) |
| v1 WPLS/USDT | 0x322Df7921F28F1146Cdf62aFdaC0D6bC0Ab80711 | same | = v1 factory; 231,656 USDT / 42,182,586,642 WPLS | PASS |
| v2 WPLS/DAI | 0x146E1f1e060e5b5016Db0D118D2C5a11A240ae32 | getPair(WPLS, DAI) on v2; pair.factory(); getReserves() | = v2 factory; 31,114 DAI / 5,675,221,464 WPLS | PASS (shallow) |
| v2 WPLS/USDC | 0x8eBe62D5e9D26b637673d91f56900233d6A4910d | same | = v2 factory; 9,914 USDC / 1,806,153,300 WPLS | PASS (shallow) |
| v2 WPLS/USDT | 0x21e4d9dfB30B097316De38ea49c68776C9735329 | same | = v2 factory; 1,206 USDT / 220,243,851 WPLS | PASS (shallow) |
| Multicall3 | 0xcA11bde05977b3631167028862bE2a173976CA11 | getCode; aggregate3([WPLS.symbol()]) | 3,808 bytes; success | PASS |
| PulseX farm (MasterChef; Blockscout-verified name "MasterChef") | 0xB2Ca4A66d3e57a5a9A12043B6bAD28249fE302d4 | poolLength(); inc(); inc().symbol(); poolInfo(0..18).lpToken.factory() | 19 pools; reward token 0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d "INC"; 18 of 19 lpTokens are PulseX v1/v2 pairs (pid 17 is not a pair) | PASS |
| same | same | userInfo(pid, wallet), pendingInc(pid, wallet) for the six wallets (all 19 pids, `tools/verify-pulsechain-wallets.js`) | amount 0, pending 0 everywhere: no farm stake today | PASS (interface proven; no stake to value) |
| same | same | a real staker found from the farm's Deposit logs (bounded ranges, rpc.pulsechain.com): `userInfo(pid, staker)`, `pendingInc(pid, staker)`, `poolInfo(pid).lpToken.factory()` | pid 1, staker 0xeB03658Ff4B3F4DE46E0A4D686257DF964F5a404 (block 27,985,530): amount 779,475.52 LP of the v1 WPLS/DAI pair 0xE56043671df55dE5CDf8459710433C10324DE0aE, pendingInc 0.8540 INC. Other stakers found: pid 5 (v1 WPLS/USDT) 0x5A26b889Dff34C4f159A76A95EcBf85591c9ed2A, pid 9 0x7Cc0a0ca2f9346AceAdd5110cfa15C4FA12f9251 | PASS (a non-zero stake is read; `tools/verify-onchain.js pulse`) |
| Main | 0x698C3A3F06B7EdBD175169d1cfa219c8232F48d8 | eth_getBalance | 2,998,501.70 PLS | PASS |
| Wallet 11 | 0xFc1235E6523Becf4b329ed9ADf21750cfAF65Bfb | eth_getBalance; LP via `tools/verify-pulsechain-wallets.js` | 11,570,092.60 PLS; 199 PulseX LP positions | PASS |
| Wallet 12 | 0xAAB445f2846476A31Aaed66112B0f3e2ad82c50A | same | 1,553,762.33 PLS; 39 LP positions | PASS |
| Wallet 2 | 0x6314077131232f7D8282d07DcB4c31387dDC81DA | same | 999,773.44 PLS; 4 LP positions | PASS |
| Wallet 3 | 0xA78c81a0b7551BD9a6F6965fB01AafaE9CEf96ca | same | 56,049,720.26 PLS; no LP | PASS |
| Wallet 5 | 0xb4e5753644BAe0dCbB9D6e7B5ea7EaC8d5aF5cf0 | same | 19,827.82 PLS; no LP | PASS |

Explorer: `https://api.scan.pulsechain.com/api/v2/addresses/{addr}/token-balances` answers JSON 200 without a key; the `scan.pulsechain.com` host is the HTML frontend. `rpc.pulsechain.com` accepts 2,000,000-block `eth_getLogs` but caps the number of logs returned.

---

## TASK 1: SECURITY, gate login rate-limit bypass (Medium)

### Goal
Fix the passphrase-login throttle in `lp-gate.mjs` so an attacker cannot get unlimited guesses by rotating `X-Forwarded-For`, nor wipe existing lockouts by flooding distinct keys; add a global failure budget and TTL expiry; review and fix `trust proxy 1` in `lp-mcp-remote.mjs`.

### Findings (read from the code)
- `lp-gate.mjs:86-89` `clientIp()` returns the FIRST `x-forwarded-for` entry, which the client controls; the throttle map `fails` (line 85) is keyed on it, so each guess can use a new key (unlimited guesses at 5/key).
- `lp-gate.mjs:91-96` `fail()` calls `fails.clear()` when the map exceeds 5000 keys: 5001 junk keys erase every lockout, including a legitimately locked-out attacker key.
- `lp-gate.mjs:132` `proxy()` forwards `x-forwarded-for = clientIp(req)` upstream; the same derived value must be used (never the raw client header).
- The gate listens on 127.0.0.1 only (line 185), so its socket peer is always loopback (tailscale funnel -> local gate). Therefore "socket address" alone gives every client the same key 127.0.0.1 (one shared bucket: 5 wrong guesses from anyone lock out everyone, incl. the owner). The real client must come from XFF, but only the entry appended by the trusted hop.
- `lp-mcp-remote.mjs:148-159` has its own throttle (`failures` map): keyed on `req.ip`; it is only pruned when size > 5000 and only prunes entries with `count === 0`, so entries with partial counts are never evicted (unbounded memory growth with distinct keys); no global budget. `lp-mcp-remote.mjs:308` `app.set("trust proxy", 1)`: with hop count 1 Express trusts whatever socket peer connects and takes the RIGHTMOST `X-Forwarded-For` entry as `req.ip`. That is safe only because the server binds 127.0.0.1 (line 380) and the single hop (funnel) appends the real client. It is wrong if (a) the bind ever widens, (b) a second hop (e.g. the gate, which currently REPLACES XFF with its first-entry value) is inserted, or (c) the funnel does not append. The SDK's `mcpAuthRouter` rate limiters (authorize/token/register) also key on `req.ip`, so the same trust decision governs them.

### Scope
In: new shared module `login-throttle.mjs` (pure, injectable clock and storage cap, no I/O) used by both `lp-gate.mjs` and `lp-mcp-remote.mjs`; client-key derivation function (exported, unit-testable); `lp-gate.mjs` and `lp-mcp-remote.mjs` edits; new tests; README note.
Out: changing the passphrase scheme, cookie format, session TTL, `server.js` (plain `http`, uses `socket.remoteAddress` directly at line 2007; it does not use XFF), any other XFF consumer (grep confirmed none).

### Design
1. `clientKey(req, opts)`: `peer = normalize(req.socket.remoteAddress)` (strip `::ffff:`). If `peer` is loopback (127.0.0.0/8, `::1`) AND trust is enabled (default on; `LP_GATE_TRUST_PROXY=0` turns it off): take the LAST entry of the XFF header chain (all `x-forwarded-for` header lines joined, split on commas, trimmed), accept only if `net.isIP()` is non-zero, normalize (lowercase, strip `::ffff:`; for IPv6 key on the /64 prefix to stop per-address rotation inside a prefix); otherwise (invalid, empty, or peer not loopback) the key is `peer`. A non-loopback peer's XFF is ignored entirely. Never use the first entry.
2. Per-key record `{ count, lockedUntil, expires }`: 5 failures lock the key for 15 min (unchanged behaviour); a record with `count>0` and no lock expires 15 min after its last failure. Expired records are swept on every `fail()`/`check()`. Cap of 5000 live records; when full, evict the oldest-expiring UNLOCKED record first; locked records are never evicted by pressure. If the cap is full and nothing is evictable, new keys are refused (fail closed, 429) instead of clearing anything.
3. Global budget: all failures across all keys counted in a sliding window (defaults 60 failures per 15 min, env `LP_GATE_GLOBAL_MAX`, `LP_GATE_GLOBAL_WINDOW_MS`). When exceeded, every login (even a correct passphrase) gets 429 until the window drains. Trade-off documented: a distributed guesser can deny service for up to the window, but cannot exceed ~60 guesses / 15 min total (~5,700/day). The log line says "global login budget engaged" without any key or passphrase.
4. A successful login clears only that key's record, never the global counter.
5. `lp-mcp-remote.mjs`: replace `trust proxy 1` with `app.set("trust proxy", "loopback")` (trust XFF only from a loopback peer; combined with the 127.0.0.1 bind this is the same exposure as before but cannot be widened by a hop-count mistake), compute the throttle key with the same `clientKey` using the LAST entry rule, and use the shared throttle (TTL + global budget). The SDK limiters keep `req.ip` (now only honoured from a loopback peer). State in README that if a second proxy hop is ever added, the trust setting must be changed deliberately.
6. Whether Tailscale funnel appends to or replaces a client-supplied XFF is not verifiable here (Open Q5); "last entry" is correct in both cases, "first entry" only in one.

### Files touched
`lp-gate.mjs`, `lp-mcp-remote.mjs`, `login-throttle.mjs` (new), `test/login-throttle.test.js` (new), `README.md`.

### Acceptance tests (Task 1; unit tests, injected clock, no sockets to the outside)
1. Rotating XFF does not bypass: 5 wrong guesses from peer 127.0.0.1 with `X-Forwarded-For: 198.51.100.7`, then 100 more guesses each with a fresh first XFF entry but the same LAST entry 198.51.100.7: attempts 6.. are locked (429); a request whose last entry is a different real client 203.0.113.9 is not locked by the first client's failures.
2. A client-supplied first entry is ignored: `X-Forwarded-For: 1.1.1.1, 198.51.100.7` keys on `198.51.100.7`; `X-Forwarded-For: garbage` / empty / `999.1.1.1` falls back to the peer address.
3. XFF from a non-loopback peer (e.g. peer 192.0.2.5 with XFF 198.51.100.7) is ignored: the key is 192.0.2.5.
4. `::ffff:127.0.0.1` and `::1` peers count as loopback; `::ffff:192.0.2.1` does not. IPv6 XFF addresses in the same /64 share a key.
5. Flooding does not wipe lockouts: lock key A, then submit failures from 6000 distinct keys; A is still locked afterwards (no `clear()`); the live record count never exceeds the cap; expiry after 15 min of the injected clock unlocks A.
6. Cap full of locked records: a new key is refused (429) rather than evicting a locked key.
7. Global budget engages: with max 60 / window, 61 failures from 61 distinct keys make the 62nd attempt from a brand-new key return 429 even with the correct passphrase; after the window passes on the injected clock logins work again; a successful login from key K does not reset the global counter.
8. TTL: a key with 3 failures and no lock is removed 15 min after its last failure (record count drops).
9. Gate proxy: the `x-forwarded-for` header sent upstream equals the derived key, never the raw client header.
10. `lp-mcp-remote.mjs`: `trust proxy` is `"loopback"` (not a number); the throttle in it is the shared module (assert import + unit run of the same scenarios 1, 5, 7 against it); the `failures` map no longer exists.
11. Source guard: grep shows no remaining `.split(",")[0]` XFF parsing in `lp-gate.mjs`.
12. `node test/run-all.js` passes except the expected `smoke.js`; `test/gate-chain-cookie.test.js` still passes unchanged.

---

## TASK 2: HYGIENE, remove hard-coded old-home paths; fix watched-wallet footer

### Goal
The install moved from the old home directory (user "steven") to `/home/loko` and the nightly backup stopped finding the Arc data dir. Remove every hard-coded path of the old home; use `$HOME`, environment variables or repo-relative paths. Fix the dashboard footer text that wrongly says watched wallets are never collected from.

### Scope
In: `backup-ledgers.sh` (line 40), `restart-dashboard.sh` (lines 5, 18), `data-dir.js` (comments lines 9-10), `test/service-port.test.js` (line 47: fake `HOME`), `tools/swap-routes.js`, `tools/deploy-vault-arc.js`, `tools/verify-arc-vault.js`, `tools/propose-collector-settings.js`, `tools/rehearse-arc-vault-replace.js`, `tools/apply-vault-settings.js`, `tools/recover-stranded.js`, `tools/move-split-row.js`; `dashboard.js:3565` footer text; `lp-mcp.mjs:127` description (same wrong claim); README if it names these paths.
Out: touching the live install; changing any tool's behaviour other than default paths; deleting files.
Historical docs: the repo contains no markdown with the old path (grep found 16 hits in 12 code/script files only), so there is nothing to exclude except `.git`, `SPEC.md` and `REPORT.md` (they may describe the pattern; this spec avoids the literal string).

### Design
- `backup-ledgers.sh:40`: `DATA_DIRS="${LP_BACKUP_DATA_DIRS:-$PWD ${LP_ARC_DATA_DIR:-$HOME/arc-data}}"` (same variable `start-all.sh` already uses). Dirs that do not exist are skipped with one log line (verify current behaviour, keep it).
- `restart-dashboard.sh`: `DATA="${DATA:-${LP_ARC_DATA_DIR:-$HOME/arc-data}}"`; usage comment uses `$HOME/uniswap-collector`-style generic text or `"$PWD"`.
- `tools/*.js`: a single default `process.env.LP_ARC_SETTINGS || path.join(process.env.LP_ARC_DATA_DIR || path.join(os.homedir(), "arc-data"), "settings.json")`, preferably through one tiny helper (`tools/_paths.js`, new) so the 8 files share it; `verify-arc-vault.js`'s Robinhood settings default becomes `process.env.LP_RH_SETTINGS || path.join(__dirname, "..", "settings.json")` (repo-relative, read-only); `--settings=` flags still override. `move-split-row.js` comment example uses `$HOME/arc-data/...`.
- `data-dir.js` comments: `--data-dir=$HOME/arc-data`.
- `test/service-port.test.js`: replace the fixture `HOME: "/home/steven"` with a neutral `"/home/example"`; assertions unchanged (the test only checks what is passed to the child; confirm by reading before editing).
- Footer: `renderWatch(d)` builds `Read-only: <labels>. Collect-enabled (fees collected and swept back to the wallet): <labels>.` from each wallet's `collect` flag (omit a clause when its list is empty; if all are read-only keep the old sentence). The watched payload (`watch.js:278` already carries `collect: !!o.collect`) must expose `collect` to the page; verify `/api/watch` entries include it and add it if not. Labels are escaped with the existing `esc`. `lp-mcp.mjs:127` description changed to "observed; collection is performed only for wallets marked collect: true in settings".

### Acceptance tests (Task 2)
1. `grep -rIn 'home/steve[n]' . --exclude-dir=.git --exclude-dir=node_modules --exclude=SPEC.md --exclude=REPORT.md` prints nothing.
2. `bash -n backup-ledgers.sh restart-dashboard.sh` passes. A test (shell fixture in a temp dir, `LP_BACKUP_DATA_DIRS` unset, `HOME=$tmp`, `$tmp/arc-data` exists) shows the default `DATA_DIRS` contains `$tmp/arc-data` and not any `/home/<other>` path; with `LP_ARC_DATA_DIR=$tmp/x` it contains `$tmp/x`.
3. `restart-dashboard.sh` default `DATA` resolves to `$HOME/arc-data`, or `LP_ARC_DATA_DIR` when set, shown without starting anything (a dry-run/echo mode or extracting the line in the test); the test must not start or kill any process.
4. Each of the 8 tools, run with `--help`/no network or required-arg error path (or `require`d where they export), resolves its default settings path to `$HOME/arc-data/settings.json` / `LP_ARC_SETTINGS`; `--settings=X` still overrides. No tool is executed against the live install.
5. `node test/run-all.js service-port` passes; `node test/run-all.js` shows no new failure.
6. Footer unit test (follow `test/wallet-tabs.test.js` style): given wallets A (collect true), B (no), C (collect true) the note contains `Collect-enabled` with A and C and `Read-only` with B, and does NOT contain the sentence "never collected from"; given all read-only the old sentence is retained; a label `<b>` is escaped.
7. `/api/watch` wallets entries include a boolean `collect` (test via the existing watch fixture).
8. `lp-mcp.mjs` tool description no longer says "never collected from".

---

## TASK 3: sNET staking for every watched wallet (Robinhood)

### Goal
`staking.js` tracks the NET Staking rebasing receipt (sNET `0xb773ec2C326B7f98a5a83fc098825492F020a4c7`, NET `0xCA9c78Dd337A67F6e0077F65F5E9218719d30eDf`, staking contract `0xB078cc304A0B264C5F3680DC0488954ACcd02E87`) for the MAIN wallet only (`cfg.ownerAddress`, `staking.js:118`). Extend it to every watched wallet with the same method (principal from 1:1 Transfer in/out, rewards from rebase index), shown on the wallet header/detail and Analytics > Staking, scoped by the wallet picker, and make the MCP `staking` tool accept an optional wallet.

### Decision: ledger layout
Keep ONE file `snet-staking.json`. Main wallet's data stays exactly where it is today (`state.tokens[tokenLower]`), so migration is a no-op (zero copy, zero rewrite, lossless by construction, and an older build can still read the file). Other wallets live in a new key `state.wallets[addressLower][tokenLower]` with the identical entry shape (`samples`, `principal`, `principalAt`, `backfilledAt`, `sinceBlock`, `symbol`, `label`, `underlying`). Rationale over one-file-per-address: one atomic write per sample cycle, one backup entry in `backup-ledgers.sh`, no new filenames to ignore/back up, no per-wallet file explosion (12 wallets). The cap of 20,000 samples applies per wallet entry. A wallet with zero sNET balance and no prior entry creates no entry (no empty ledgers, no backfill RPC).

### Scope
In: `staking.js`, `server.js` (`/api/staking`, sampling loop at ~3551, construction at ~3326, `getStaking` at ~3413 stays main-only), `dashboard.js` (renderStaking ~1422, tax-event builder ~1457 which currently labels every event with `ownerLabel()`, wallet header/detail), `dashboard.html` if a container is needed, `lp-mcp.mjs` staking tool (~449), tests, README.
Out: attribution.js / digest.js / alerts (they keep reading main-only `getStaking()`; state this in README), Arc, any write path, collecting/claiming.

### Design
- Wallet set = main + `wallets.watched` as `watch.js` reads them (reuse its reader; labels from settings). Sampling runs in the existing hourly step, wallets sequential, one `balanceOf` per wallet; backfill/principal (`LOG_FLOOR` getLogs) only for wallets with balance > 0 or an existing entry; failures per wallet are isolated (log, continue).
- `view()` keeps returning `{ ok, at, tokens }` for main exactly as today. New: `view({ wallet })` for a configured address and `viewAll()` returning `wallets: [{ address, label, tokens }]` (same token object shape) for configured wallets only.
- `GET /api/staking` unchanged shape (main) plus additive `wallets: [...]`. `GET /api/staking?wallet=<addr|label>` returns `{ok, at, wallet:{address,label}, tokens}`; an address not in the configured list is 400 (never an arbitrary RPC target), invalid format 400.
- UI: wallet header/detail shows balance, principal, rewards (today/7d/30d/total), APR for that wallet; Analytics > Staking uses `pfScope()` (`'owner'`, `'all'`, or an address) to pick the wallet(s); "all" lists each wallet with a subtotal row, no cross-wallet merged APR. Tax/income events carry their own wallet label instead of `ownerLabel()`.
- MCP `staking`: `inputSchema: { wallet: z.string().optional() }` (address or label). No wallet: existing output `{ tokens: [...] }` for main, plus additive `wallets: [{label, address, tokens}]`. With wallet: `{ wallet:{label,address}, tokens }`. Unknown wallet: tool error, not a crash. Existing field names and rounding unchanged.
- Known limitation, same as today, documented: principal counts sNET sent between two watched wallets as an out/in; no special casing.

### Acceptance tests (Task 3; mocked provider/contracts, temp `LP_DATA_DIR`)
1. Loading a fixture `snet-staking.json` in the OLD format (main only) and calling `view()` returns a deep-equal result to the pre-change implementation (golden captured from HEAD code on the same fixture), including `principal`, `rewards`, `aprPct`, `daily`, `series`.
2. After `sample()` with no other wallets configured, the saved file's `tokens[sNET].samples` still starts with the unmodified original samples (byte-equal prefix) and no `wallets` key is required to be present; reloading the file with the previous version's loader semantics (read `tokens` only) works.
3. With three configured wallets (main, A balance 100, B balance 0): after `sample()`, `state.wallets[A][sNET]` has a sample with bal 100 and the index; B has no entry; main unchanged.
4. Per-wallet principal: given mocked Transfer logs in/out for A (in 100, out 0) and a balance of 103 at the later index, `view({wallet:A})` reports principal 100 and total rewards 3; main's numbers are unaffected by A's logs (log filters use the wallet's own padded address topic).
5. Rebase vs stake: for wallet A, a balance jump that matches the index ratio is a reward, a jump that does not is skipped (same `rewards()` rule), proven on A with the existing fixtures' numbers.
6. Backfill for A runs once (`backfilledAt` set) and is not repeated on the second `sample()`; a getLogs failure for A does not stop sampling of B or main.
7. `/api/staking` (no query) response keys are a superset of today's (`ok, at, tokens`) with `tokens` identical for main; `?wallet=<A address>` returns A's tokens; `?wallet=<label>` works; `?wallet=0x000...dead` (not configured) and `?wallet=zzz` return 400 and make no RPC call.
8. MCP tool: with no argument output has the same `tokens` array shape/rounding as before (golden); with `wallet` returns that wallet's data; unknown wallet returns an error result; schema accepts omitted `wallet`.
9. Dashboard: with `pfScope()` = address A the staking panel renders A's data only; with `'all'` renders one row per wallet and no merged APR; tax-event rows for A's rewards carry A's label (follow `test/analytics-scope.test.js` / `earned-by-wallet-scope.test.js`).
10. `backup-ledgers.sh` already includes `snet-staking.json` (assert; no new file name introduced).
11. Full `node test/run-all.js`: only `smoke.js` fails.

---

## TASK 4: BASE (8453) read-only instance, Aerodrome Slipstream (+ Uniswap v3/v4 secondary)

### Goal
A read-only Base dashboard instance showing Aerodrome Slipstream positions (staked in a gauge and unstaked) with pending AERO, via the existing `slipstream.js`, supporting BOTH the v1 manager `0x827922686190790b37229fd06084350E74485b72` (claimed name "Slipstream Position NFT v1") and the newer Aerodrome CL manager that holds the user's USDC/LAPTOP 0.8% CL200 deposit #8905958. Token #79371151 (WETH/cbBTC, tickSpacing 100) is claimed owned by watched wallet "Trading" `0xaDf94A20558E1E6d64c429F8F9f017169BF3d743` (if staked, `ownerOf` is a gauge). Uniswap v3/v4 on Base via the existing readers are secondary.

### Scope
In: `settings.base.example.json` (new, no secrets), Base instance wiring in `start-all.sh` / `stop-all.sh`, `chain-router.js` `CHAINS`, staked-position discovery without Blockscout, RPC/Blockscout secret handling (H4), `tools/verify-onchain.js` (new; read-only; cleaned version of the scratch script, `base` and `pulse` modes), README, tests.
Out: collecting, claiming, unstaking, any signing; merging with other chains; changing Robinhood/Arc behaviour; the live router/instances.

### Design
- Settings: `settings.base.example.json` mirrors the sectioned format (`chain`, `wallets`, `tokens`, `contracts`, `portfolio`), with `chain.chainId 8453`, public `chain.rpcUrl "https://mainnet.base.org"`, `chain.rpcUrls` public fallbacks only if verified, `chain.explorer "https://basescan.org"`, `chain.blockscout "https://base.blockscout.com"`, `chain.maxLogRange` (set to what the verification finds the public RPC allows), native ETH 18, `tokens.WETH` = Base WETH, `tokens.USDG` slot = Base USDC (the key name is legacy; document), `contracts.slipstream` as TWO entries with distinct `name`s (names prefix the tokenId, `slipstream.js:182`): `aerodrome-v1` (v1 manager, CL factory, `poolFactory` = classic PoolFactory for AERO pricing) and `aerodrome-cl2` (newer manager and its factory), plus optional Uniswap v3/v4 blocks (`positionManager`, `factory`, `v4.*`) only if verified. `wallets.main` = Trading wallet (no collector exists on this instance); the user's other Base wallets go in `watched` (Open Q2). No `collector`/`vault`/`risk` actions. Every address in the file must appear in the verification table with a PASS.
- Secrets: optional env `LP_BASE_RPC_URL` (may contain a provider key) overrides `chain.rpcUrl` in this instance's process only; `BLOCKSCOUT_API_KEY` (existing, `blockscout.js:18`) is used only when present. Required code changes: (a) `/api/chain`, `/api/...` payloads at `server.js:2308, 2347, 2690, 2918` currently return `rpc: cfg.rpcUrl` to the browser; they must return a sanitized form (origin only for the public default, or `null`/"custom (hidden)" when the endpoint came from the env) so a keyed URL never reaches a page; (b) a `redactUrl()` used wherever an RPC URL or ethers error text (which embeds the URL) is logged or returned; (c) `blockscout.js` `bsFetch` accepts a full URL (line 55-56) and then adds `Authorization: Bearer`; restrict full URLs to an allow-list (`api.blockscout.com` and the configured explorer host) so the PRO key cannot be sent elsewhere; (d) a `validateEndpoint(url)` used on `chain.rpcUrl(s)`, `chain.explorer`, `chain.blockscout` and the env override (https only, no userinfo, no `localhost`/loopback/private/link-local/metadata IP literals; failing closed with a clear startup error that does not echo the URL's path/query).
- Instance wiring: data dir `${LP_BASE_DATA_DIR:-$HOME/base-data}`, port `${LP_BASE_PORT:-8796}`, started like `start_arc()`: only when `$dir/settings.json` exists, `LP_READONLY=1 node server.js --data-dir=$dir --port=$port --no-loops --no-services --claim-scan` (claim-scan only if it is chain-neutral; otherwise omit), log to `$dir/server.log`. `stop-all.sh` stops it by port the same way as Arc, only that port. `start_router` starts the router when any of arc/base/pulse settings exists and passes `--chains=` (see below). Nothing changes when the Base settings file is absent.
- Router: add `{ key: "base", label: "Base", accent: "#0052ff", port: Number(arg("base-port", 8796)) }`. To keep default behaviour byte-identical, `CHAINS` is built from the full known list filtered by `--chains=` / `LP_ROUTER_CHAINS` (default `robinhood,arc`); `start-all.sh` passes `robinhood,arc[,base][,pulsechain]` according to which settings files exist. A listed chain whose instance is down behaves like Arc down today (verify and test). `lp-gate.mjs` needs no change (it fronts the router).
- Pricing: ETH/USD from the WETH/USDC pool verified deepest (record address, liquidity, USDC balance); implemented by the existing `usdReference` path (Uniswap v3 style, fee tier) if the chosen pool is a Uniswap v3 pool; if the chosen pool is a Slipstream pool, the existing path cannot read it (different factory/`slot0`), so use the Uniswap v3 WETH/USDC pool (deep on Base) and say so. AERO price from `slipstream.js` `rewardUsd` (classic pool via `poolFactory`; `MIN_QUOTE_USD` 100 guard stays; null price shows "no price", never 0).
- Staked-position discovery without Blockscout. `sentTo()` (`slipstream.js:90`) uses Blockscout and silently returns `[]` when Cloudflare serves HTML (`r.json()` throws, caught). Required changes, in order of use (union of results, each gauge confirmed on chain: `gauge.nft()` equals this manager, then `stakedValues(wallet)`):
  1. Blockscout when it answers JSON (check `content-type`; with `BLOCKSCOUT_API_KEY` it goes through `api.blockscout.com/8453`); an HTML/non-JSON answer is treated as "unavailable" and logged once, not as "no results".
  2. Pins: `contracts.slipstream[].tokenIds: [..]` (optional): for each id, `ownerOf(id)`; if the owner is a contract, treat it as a candidate gauge and confirm with `gauge.nft()`/`stakedContains(wallet,id)`. Deterministic and cheap; the examples pin 79371151 and 8905958.
  3. Gauges of the pools of NFTs the wallet still holds unstaked (exists today).
  4. Bounded-range RPC scan of the manager's `Transfer(from=wallet)` logs (topics `[Transfer, wallet]`, `address = manager`) in chunks of `chain.maxLogRange`, from `contracts.slipstream[].fromBlock` (manager deploy block, set in settings), with at most N getLogs calls per refresh (default 200) and a resumable cursor persisted in the data dir (`slipstream-scan-<name>.json`, per wallet), so it converges over several refreshes; recipients that are contracts become gauge candidates. A scan failure degrades to "partial" with a visible note, never to a silent empty list.
  Staked positions are still kept in `external`, never `positions` (collector/guardian/Sell cannot act on them).
- Uniswap v3/v4 on Base: reuse `univ3.js`/`univ4.js`/`watch.js` readers with verified Base addresses; v4 discovery uses log scans bounded by `maxLogRange`; any v4 address not verified is omitted (v3 only) and noted.
- `tools/verify-onchain.js base`: performs the table's calls against the configured public RPC (override with `BASE_RPC`), prints PASS/FAIL per check, never writes files, never signs; `CAND=` tests candidate managers. The Task 4 implementer runs it first and records the output in `REPORT.md`; it also locates the newer manager (e.g. from the Aerodrome docs/contract list at implementation time, then proves it with `ownerOf(8905958)` and `positions(8905958)`).

### Files touched
`settings.base.example.json` (new), `slipstream.js`, `blockscout.js`, `settings.js` (accept/validate new fields, `redactUrl`, endpoint validation; no change to existing chains' output), `server.js` (sanitized `rpc` fields), `watch.js` (only if passing `tokenIds`/`fromBlock` through), `chain-router.js`, `start-all.sh`, `stop-all.sh`, `tools/verify-onchain.js` (new), `README.md`, `test/base-slipstream.test.js`, `test/endpoint-safety.test.js`, `test/chain-router.test.js` (extend), `test/settings.test.js` (extend).

### Acceptance tests (Task 4; mocked RPC / fetch, no network)
1. Verification record: `REPORT.md` contains the output of `node tools/verify-onchain.js base` against the public RPC with PASS for: chainId 8453; v1 manager `name()` = "Slipstream Position NFT v1"; `factory()` equals the CL factory in the example; `ownerOf(79371151)` is the Trading wallet or a gauge whose `nft()` is the v1 manager; `positions(79371151)` = WETH/cbBTC, tickSpacing 100; the newer manager's `name()`, `factory()`, `ownerOf(8905958)`, `positions(8905958)` (USDC/LAPTOP, tickSpacing 200); the WETH/USDC pricing pool. Every address in `settings.base.example.json` has a PASS line; any FAIL means that entry is removed from the example.
2. `settings.base.example.json` loads through `settings.load()` without error; contains no secret, no `collector`/`vault` actions, valid `contracts.slipstream` with two distinct names; `rpcUrl` is a public https URL.
3. Staked position (mock): `ownerOf(id)` is a gauge, `gauge.nft()` = manager, `stakedValues(wallet)` = [id], `earned(wallet,id)` = 1.5 AERO, AERO price from a mocked classic pool: result has `staked: true`, `gauge` address, `rewards.amount` 1.5, `rewards.usd` = 1.5 x price, `fee0/fee1` = 0, in `external` not `positions`.
4. Unstaked position (mock): `collect.staticCall` fees are read, `staked: false`, no gauge call.
5. Two managers: with two `slipstream` specs, a wallet's positions from each appear with tokenIds `aerodrome-v1-79371151` and `aerodrome-cl2-8905958`, each read against its own manager/factory/gauges (a gauge of manager B is rejected by reader A because `gauge.nft()` differs).
6. Discovery without Blockscout: `bsFetch` returns an HTML 200 (Cloudflare page): result is not an error; pinned `tokenIds` discovery still finds the staked id; the log notes "unavailable" once. With a mocked JSON Blockscout response, behaviour equals today's.
7. Scan fallback: mocked `getLogs` with `maxLogRange` 10,000 yields chunked calls none wider than 10,000 blocks, stops after the per-refresh call budget, persists the cursor, and the next refresh resumes from it; a Transfer whose recipient is a verified gauge adds that gauge; a failing chunk marks the result partial.
8. Secrets: with `LP_BASE_RPC_URL=https://x.example/v2/SECRETKEY`, no response body of `/api/chain`, `/api/watch`, `/api/wallet`, nor any captured log/console line or error text contains `SECRETKEY`; with `BLOCKSCOUT_API_KEY=proapi_SECRET`, `bsFetch("https://evil.example/x")` throws/refuses and never sends `Authorization` to a non-allow-listed host; `proapi_SECRET` appears nowhere in outputs.
9. Endpoint validation (`validateEndpoint`): rejects `http://`, `https://user:pw@h`, `https://localhost`, `https://127.0.0.1`, `https://10.0.0.1`, `https://169.254.169.254`, `https://[::1]`, `file:`; accepts `https://mainnet.base.org`; the startup error text contains no path/query of the rejected URL. No HTTP route accepts a URL parameter that reaches RPC/explorer (grep-style test over `server.js` route table for `searchParams.get("rpc"|"url"|"explorer")`).
10. Read-only: with `LP_READONLY=1` and the Base settings, POST to the existing collect / arm / claim / sell / approve routes are refused (reuse the existing route list used by the Arc tests, `test/arc-phase1.test.js`), and a static test asserts the Base example has no key material and the instance command line in `start-all.sh` contains `LP_READONLY=1 ... --no-loops --no-services`.
11. Router: default `CHAINS` keys are exactly `["robinhood","arc"]` (existing `chain-router.test.js` passes unchanged); with `--chains=robinhood,arc,base` the picker lists Base with port 8796, cookie `lpchain=base` selects it, per-chain cookie namespacing `c_base__...` holds, an unknown key is still rejected, and the arm routes still go to `ARM_CHAIN`.
12. `start-all.sh` / `stop-all.sh` (`bash -n` plus a stubbed-`ss`/`node` harness in a temp dir and temp `HOME`): with no `$HOME/base-data/settings.json` nothing Base-related is started and the router list is unchanged; with it present exactly one Base start command is issued with the flags above. The harness must not touch any real process or port.
13. Pricing: with mocked WETH/USDC pool slot0, a WETH/USDC 1-ETH price is computed with correct decimals (18 vs 6); a position pair WETH/cbBTC is valued using ETH price and the cbBTC pool/price path, or reported `valueUsd: null` (not 0) when a side is unpriced.
14. Uniswap v3 on Base (mock): a v3 position owned by Trading is read through `univ3.js` with the Base factory/manager from the example; v4 absent from settings means v4 code paths are skipped without error.
15. Full `node test/run-all.js`: only `smoke.js` fails; `eslint .` clean.

---

## TASK 5: PULSECHAIN (369) read-only instance, PulseX v1 and v2 LP

### Goal
A read-only PulseChain instance for six wallets (Wallet 11 `0xFc1235E6523Becf4b329ed9ADf21750cfAF65Bfb`, Wallet 12 `0xAAB445f2846476A31Aaed66112B0f3e2ad82c50A`, Wallet 2 `0x6314077131232f7D8282d07DcB4c31387dDC81DA`, Wallet 3 `0xA78c81a0b7551BD9a6F6965fB01AafaE9CEf96ca`, Wallet 5 `0xb4e5753644BAe0dCbB9D6e7B5ea7EaC8d5aF5cf0`, Main `0x698C3A3F06B7EdBD175169d1cfa219c8232F48d8`) showing PulseX v1 and v2 (Uniswap v2-style) LP positions: reserves, totalSupply, wallet share, value; plus LP staked in PulseX farms if a farm contract is identifiable and verifiable on chain (otherwise skipped with a note). A read-only verification script lists what each wallet holds; results go to `REPORT.md`.

### Scope
In: new reader `v2lp.js`, a v2-reserves USD pricing branch, `settings.pulsechain.example.json` (new), wiring identical to Task 4 (data dir `${LP_PULSE_DATA_DIR:-$HOME/pulse-data}`, port `${LP_PULSE_PORT:-8795}`, router key `pulsechain`, accent `#c026d3`, `start-all.sh`/`stop-all.sh` opt-in only when its settings file exists, `LP_READONLY=1 --no-loops --no-services`), `tools/verify-onchain.js pulse` and `tools/verify-pulsechain-wallets.js`, README, tests. Reuses Task 4's endpoint validation, URL redaction, sanitized `rpc` fields and allow-listed Blockscout (env `LP_PULSE_RPC_URL`).
Out: any transaction, farm deposit/withdraw/harvest, v3-style DEXes on Pulse (9inch, 9mm), bridge positions, cross-chain merging.

### Design
- `v2lp.js` (CommonJS, ethers v6 like its neighbours): `create({ provider, cfg, spec, priceOf, toFloat })` with `spec = { name: "pulsex-v1"|"pulsex-v2", factory, pairs?: [..] }`; `positionsOf(wallet)` returns the same position shape as `slipstream.js` where sensible: `protocol`, `tokenId: "<name>-<pair>"`, `pair "A / B"`, `token0/token1`, `amount0 = share x reserve0`, `amount1`, `usd0/usd1`, `valueUsd`, plus v2 fields `lpBalance`, `totalSupply`, `sharePct`, `reserve0`, `reserve1`, `pair` address; `inRange` / ticks / fee fields are absent, `fee0/fee1 = 0` with `feesNote: "fees accrue inside the reserves and are realised when liquidity is removed"`. Results are placed in `external`, not `positions` (collector/guardian/Sell cannot act on them).
- Every pair is validated: `pair.factory()` equals the configured factory (v1 vs v2 never confused), `token0/token1` and decimals read on chain (`decimalsOk` guard as in `slipstream.js:138-141`), `totalSupply() > 0`. value = `lpBalance/totalSupply x (r0 x p0 + r1 x p1)`; a side without price gives `valueUsd: null`, never 0 (and the pair's own implied price is not used to price its own tokens, to avoid circularity/manipulation); a pair whose quote-side liquidity is below `MIN_QUOTE_USD` is flagged thin.
- LP discovery (which pairs a wallet holds), in order: (1) pinned `pairs` in settings; (2) PulseChain Blockscout (public `scan.pulsechain.com`, JSON content-type checked, `chain.blockscout` set accordingly; PRO key only if the key's service covers chain 369 - Open Q) listing the wallet's ERC-20 balances, each candidate accepted only if `pair.factory()` is a configured PulseX factory; (3) fallback enumeration `allPairsLength()`/`allPairs(i)` + `balanceOf(wallet)` via Multicall3 if present (or batched JSON-RPC), resumable cursor in the data dir (`v2lp-scan-<name>.json`), bounded calls per refresh; partial results are labelled partial.
- Farms: identify a PulseX farm / staking contract only if its on-chain interface can be demonstrated with real calls against a known staker; implement as a view-only adapter (`userInfo`/`pendingReward` style) behind `contracts.pulsex.farms: [{ name, address, kind }]`. If none can be verified, Task 5 ships WITHOUT farm support and says so in README and `REPORT.md` ("skipped: no verifiable farm contract").
- Pricing: native PLS 18 decimals, numeraire WPLS; USD from the deepest verified WPLS/stable v2 pair (stable = DAI-from-Ethereum or USDC/USDT, whichever verifies deepest). The existing `usdReference` path assumes a Uniswap v3 pool at a fee tier; add one new settings field `tokens.usdReferencePair` (a v2 pair address) that switches the WETH-slot USD rate to reserves (`reserveStable/reserveWPLS`, decimals-adjusted) when set, with a minimum-liquidity guard; chains without it behave exactly as today (existing pricing tests unchanged). The implementer must find the single place the numeraire USD rate is derived (`grep usdReference`; `settings.js` numeraire block, `portfolio.js`, `server.js`) and keep the change there.
- `tools/verify-pulsechain-wallets.js`: read-only (view calls only), public RPC (override `PULSE_RPC`/`LP_PULSE_RPC_URL`, redacted in output), for each of the six wallets prints native PLS, WPLS and stable balances, every PulseX v1/v2 LP position found (pair, reserves, totalSupply, share, value), and farm stakes if an adapter exists; `--json` for machine output; writes nothing; the results are pasted into `REPORT.md` (no secrets, balances of the user's own wallets only).

### Files touched
`v2lp.js` (new), `settings.pulsechain.example.json` (new), `settings.js`, `watch.js` (register the v2 readers in `external`), `server.js`/`portfolio.js` (v2-reserves rate branch only where the numeraire rate is computed), `chain-router.js`, `start-all.sh`, `stop-all.sh`, `tools/verify-onchain.js`, `tools/verify-pulsechain-wallets.js` (new), `README.md`, `test/v2lp.test.js`, `test/pulse-wiring.test.js`, `test/chain-router.test.js` (extend).

### Acceptance tests (Task 5; mocked RPC, no network)
1. Verification record in `REPORT.md`: `node tools/verify-onchain.js pulse` PASS for chainId 369; WPLS and stable `symbol()/decimals()`; both factories `allPairsLength()`, `getPair(WPLS, stable)` non-zero and `pair.factory()` equal to its factory; the chosen deepest WPLS/stable pair with reserves; every address in `settings.pulsechain.example.json` has a PASS line (FAIL = removed).
2. `settings.pulsechain.example.json` loads via `settings.load()`; chainId 369; six wallets (Main as `wallets.main`, the other five watched, labels as in the Goal); public https RPC; no secrets; no `collector`/`vault` actions.
3. Math (mock pair): reserves (1,000,000 WPLS; 50,000 DAI), totalSupply 10,000 LP, wallet balance 100: share 1.00 %, amount0 10,000 WPLS, amount1 500 DAI, `valueUsd` = amount0 x p0 + amount1 x p1 with exact decimals (18 vs 6 mixed-decimal case also tested); wallet balance 0 returns no position.
4. v1/v2 separation: a pair whose `factory()` is neither configured factory is ignored; the same token pair on v1 and v2 yields two positions named `pulsex-v1-...` / `pulsex-v2-...`.
5. Unpriced side (no pool) gives `valueUsd: null` and a reason, not 0; a thin pair (stable reserve below the minimum) is flagged and not used as a price source.
6. Discovery: (a) pinned pairs; (b) Blockscout JSON listing with one pair token and one random ERC-20 (random one rejected because `factory()` reverts or is foreign); (c) Blockscout HTML/Cloudflare response falls back to enumeration; enumeration respects the per-refresh call budget and resumes from the persisted cursor; partial results are marked partial.
7. WPLS pricing: `tokens.usdReferencePair` set, mocked reserves give the right PLS/USD with decimals; absent, the Robinhood/Arc pricing tests pass unchanged; guard returns "unpriced" when the stable reserve is below the minimum.
8. Farms: either (a) a mocked `userInfo`/`pendingReward` adapter returns the staked LP amount, is valued like unstaked LP, and is marked `staked: true`; or (b) no `contracts.pulsex.farms` configured and the code path is inert, with the skip note present in README. The implementer states which in `REPORT.md`.
9. Read-only and wiring: same assertions as Task 4 tests 10-12 for key `pulsechain`/port 8795 (router default list unchanged; opt-in via settings file; stop-all only that port; `LP_READONLY=1 --no-loops --no-services`).
10. Secrets/SSRF: same as Task 4 tests 8-9 with `LP_PULSE_RPC_URL`.
11. `tools/verify-pulsechain-wallets.js` with a mocked provider (injected) prints the table for six wallets, never calls a non-view method (a stub provider that throws on `sendTransaction`/`signer` access passes), and with `--json` emits parseable JSON containing no URL with a key.
12. Real run (manual, recorded): `node tools/verify-pulsechain-wallets.js` against the public RPC; output pasted in `REPORT.md` (holdings per wallet, LP found, farms or "none verified").
13. Full `node test/run-all.js`: only `smoke.js` fails; `eslint .` clean.

---

## OPEN QUESTIONS

Flag legend: [DESIGN] would change the design if answered differently; [DATA] only fills in a value.

1. RESOLVED (0xe1f8cd9A...8b53, see the Base table; same positions() tuple, no ABI variant needed). [DATA] Address of the newer Aerodrome CL position manager holding #8905958 (USDC/LAPTOP, CL200) and its CL factory/gauge factory. Not known from the code or memory; must be proven with `ownerOf(8905958)`/`positions(8905958)`. If #8905958 turns out to be on a manager with an incompatible `positions()` ABI (different tuple), `slipstream.js` needs an ABI variant per spec [DESIGN].
2. [DATA] Which Base wallet(s) own #8905958 and which other Base wallets to watch. Assumption: Trading `0xaDf9...3d743` is `wallets.main`; add others to `watched`.
3. [DESIGN] Does the public Base RPC allow `eth_getLogs` ranges wide enough for the Transfer-scan fallback, and is `eth_getCode` at old blocks (archive) available to find a deploy block? Assumption: neither is needed because pinned `tokenIds` are the primary no-Blockscout path; the scan is best-effort with settings-provided `fromBlock`.
4. [DESIGN] PulseX farm contract: none identified. If none is verifiable, farms are skipped (stated). If one exists with a non-MasterChef interface, the adapter `kind` set grows.
5. [DESIGN] Does Tailscale funnel append to or replace a client-supplied `X-Forwarded-For`? Not testable in this environment. "Last entry from a loopback peer" is correct either way; but if funnel strips XFF entirely, all clients share key 127.0.0.1 (one bucket + global budget) and the owner can be locked out by guessers; the fix would then be a per-IP key from a different header (`Tailscale-User-*` is not present on funnel) - needs a live check by the owner.
6. [DATA] Does Blockscout PRO (`api.blockscout.com/<chainId>`) cover chain 8453 and 369? Assumption: 8453 yes (public base.blockscout.com exists), 369 unknown; the key is used only if the chain is supported, otherwise anonymous/public path.
7. [DATA] Is `scan.pulsechain.com` (Blockscout) reachable and returning JSON from this machine? Assumption: yes with a browser User-Agent; the enumeration fallback covers the case it is not.
8. [DATA] Public RPC rate limits on `mainnet.base.org` and `rpc.pulsechain.com`; `chain.rpcUrls` may list extra public fallbacks only after each is verified for chain id.
9. [DESIGN] Task 1 global budget lets a distributed attacker lock the owner out for up to the window. Assumption accepted (documented); alternative is a separate allow-list/cookie for the owner.
10. [DATA] Base v4 and Pulse Multicall3 availability: the implementer verifies; absent means v4 skipped / batched JSON-RPC used.
11. Environment note: the spec-writer had no shell; zero on-chain calls were made; the prior-task "no commit" status holds (nothing committed). The orchestrator should run `verify-onchain.js` before dispatching Task 4 so Q1 and the address tables are settled first.

---

# Appendix A (superseded; retained verbatim from the previous SPEC.md)

# SPEC: smoke.js fail-fast, then `npm audit fix`

Two tasks, two separate commits in this order. HEAD at start is 2e6d414; `test/service-port.test.js` must not be touched. Never push, never add a remote, never `--force`.

---
## TASK 1: make `test/smoke.js` fail fast

### 1. Goal
`test/smoke.js` spawns the server and polls `/api/positions` for up to 6 minutes. If the server dies at once (for example `settings.json` is missing), the test should notice that the child exited, stop polling, and fail with a clear message instead of waiting the full 6 minutes.

### 2. Scope
In: `test/smoke.js` only (a small helper inside it is fine).
Out: `server.js`, `settings.js`, `test/smoke-lib.js`, other tests, the page and asset checks, timeouts for a healthy server.

### 3. Existing code to reuse
- `test/smoke.js`: `spawn(process.execPath, ["server.js", "--port=PORT"], { stdio: ["ignore", log, log] })` at line 43. Stdout and stderr both go to the fd opened on `test/.tmp/smoke-server.log` (git-ignored via `test/.tmp/`).
- `waitFor(url, ms, perRequestMs)` (lines 24-34) loops with `sleep(1000)`. The 6-min call is at line 47, with a failure message at line 48. The `finally` block (95-100) does SIGTERM, sleep 500, SIGKILL, `closeSync(log)`.
- `settings.js:44` throws `Error("<basename> is missing: copy settings.example.json to settings.json and fill it in (...)")` on ENOENT. This is an uncaught throw at require time, so node prints the stack to stderr (which lands in the log) and exits with code 1. The exact message text is `settings.json is missing`.

### 4. Design (assumptions stated)
- Attach `server.once("exit", (code, signal))` and `server.once("error")` right after spawn. Record `exited = { code, signal }`.
- `waitFor` gets an abort condition (for example an `isDead()` callback, or a Promise.race against the exit event) checked each iteration and during the sleep. The in-flight fetch already has a 3 s timeout, so also race the sleep against the exit event to react within about 1 s or less. When the child has exited, `waitFor` returns early with a distinct result, not plain `false`.
- On early exit, read the log file (`fs.readFileSync`, by path, not the open fd) and:
  - if it contains `settings.json is missing` (regex `/settings\.json is missing/`), fail with a message that includes the exact words `settings.json missing`, and the fix: `copy settings.example.json to settings.json and fill it in (or pass --data-dir)`, plus the log path;
  - otherwise fail with `server exited before answering (code=<code> signal=<signal>)` and the last ~20 lines (or 2 KB) of the log.
- The same exit check applies to the warm-up `waitFor` calls (lines 56-58) so a server that dies mid-run also fails fast.
- Exit with code 1 via the existing `main().catch` or `process.exit(1)`. Note `process.exit` inside `try` skips nothing important only if cleanup has run, so throw an Error and let `finally` clean up, rather than calling `process.exit` mid-`try`.
- Remove the exit listeners and the sleep timers on all paths. No timer or child may outlive the process.
- A normal healthy run behaves exactly as before: same output, same timeouts.

### 5. Constraints
CommonJS, no new dependencies, same style as the file. ESLint (`eslint .` is part of `npm test`) must pass. No change to env passed to the child.

### 6. Acceptance tests (Task 1)
1. With no `settings.json` (the current checkout), `time node test/smoke.js` exits non-zero in under 10 s (target: about 2 s).
2. Its stderr contains the literal `settings.json missing` and the fix instruction (copy `settings.example.json` to `settings.json`), and does NOT contain "within 6 min".
3. Simulated non-settings crash (for example run with a temporary `SMOKE_PORT` plus a deliberately failing server, or a stub via a temporary wrapper kept outside the repo) reports `code=`/`signal=` and the log tail, and exits non-zero in under 10 s. Verify the generic branch by temporarily pointing the child at a script that prints `boom` and exits 3, then revert it. The final diff must not contain that hook, unless it is a documented env override such as `SMOKE_SERVER_CMD` (see open question 1).
4. After a failed run, `pgrep -f "server.js --port=8799"` finds nothing, and `node` exits on its own (no hang) without needing a signal.
5. If a `settings.json` is present (copy of `settings.example.json` may not boot the full server; use the real dev settings if available), the smoke test's behaviour is unchanged: the server is polled, pages load, output matches the old format. If this cannot be run, state so in the commit message and the report.
6. `git diff --stat` for the commit shows only `test/smoke.js`; `test/service-port.test.js` is untouched.
7. `npm test` is run in full and the result recorded (pass/fail count per file, duration). Expected: `test/smoke.js` still fails (no settings.json) but fast, and is the only failure. Run time drops by about the 6 min that smoke used to burn. Record exact numbers.
8. Commit message describes the change and ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---
## TASK 2: `npm audit fix` (non-forced)

### 1. Goal
Run `npm audit fix` (never `--force`) on its own commit to clear the audit findings: 13 vulnerabilities including critical proxy-addr (GHSA-jqcg-44mw-7w3h), high zod < 4.6.6 (GHSA-mrhx-c7xc-m3w5) and moderate qs.

### 2. Scope
In: `package-lock.json`, and `package.json` only if `npm audit fix` itself changes it. Out: any source change, `--force`, major-version bumps, manual edits of the lockfile, `overrides` changes (existing `tmp` override stays).

### 3. Existing code to reuse / examine
- `package.json`: deps `zod ^4.5.4`, `@modelcontextprotocol/sdk ^1.30.0`, `ethers`, `dotenv`, `solc`, `@anthropic-ai/sdk`; dev `eslint`. `proxy-addr` and `qs` are transitive through express (lockfile: proxy-addr 2.0.7 at line 1849, required by express).
- **Loopback decision sites (read in this audit):**
  - `server.js` is plain `http`, not express. It does NOT use proxy-addr. It reads `req.socket.remoteAddress` directly: `chatChannel()` at line 2007 compares against `["127.0.0.1","::1","::ffff:127.0.0.1"]`. Every other "localhost-only" endpoint (collect/arm at 2143-2260, `LP_ALLOW_REMOTE_COLLECT` at 2260, lines 2175-2506, 2745-2880) tests the bind address `HOST !== "127.0.0.1"` (`HOST = process.env.LP_BIND || "127.0.0.1"`, line 67), not the peer address. The Host-header guard is at 2095-2118.
  - `lp-gate.mjs:86-89` `clientIp()` takes the first `x-forwarded-for` entry, else `socket.remoteAddress`. Used for the login throttle only, not an authorisation decision; no proxy-addr.
  - `lp-mcp-remote.mjs` is express: `app.set("trust proxy", 1)` (line 308) and `req.ip` for the login throttle (lines 335-340). This is the only path through proxy-addr. It is used for rate-limiting keys, not for a loopback/authorisation decision.
  - `arm.js` and `csrf.js` rely on loopback by the comments; check by grep that they take no peer address from proxy-addr.
- **zod users:** only `lp-mcp.mjs` imports zod directly (about 40 uses, MCP tool schemas). `daykey.js` and the claims tests do not import it; `lp-mcp-remote.mjs` uses zod only via the MCP SDK. Note: `npm test -- <filter>` passes the filter to eslint (the script is `node test/run-all.js && eslint .`); to run one test file use `node test/run-all.js <filter>` (run-all.js takes the filter from `process.argv[2]`).

### 4. Constraints
- Use only `npm audit fix` (no `--force`, no `--legacy-peer-deps` tricks). Run from the project folder; `npm ci` state is the baseline.
- If `npm audit fix` cannot fix an item without `--force`, leave it and list it; do not escalate.
- Exact semver-compatible bumps only; the lockfile diff is the source of truth.
- No secrets in the commit; verify `.env`, `.env.*`, `settings.json` are ignored (they are, per `.gitignore`) before committing.
- Commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### 5. Acceptance tests (Task 2)
1. Before: save `npm audit` output (summary counts by severity; expect 13 total, 1 critical proxy-addr, zod high, qs moderate) in the report.
2. `npm audit fix` runs without `--force`; its exit status and output are recorded.
3. After: `npm audit` summary recorded. proxy-addr, zod and qs advisories are gone, or each remaining item is listed with the reason (needs a semver-major or `--force`).
4. `git diff --stat` shows only `package-lock.json` (and `package.json` only if npm changed it). Every `name old -> new` version change from the lockfile diff is listed exactly.
5. Security (a), loopback: after the change, a test or script shows that `::ffff:127.0.0.1`, `::1` and `127.0.0.1` are treated as loopback and a non-loopback address are not, at each site: `server.js` `chatChannel`; `lp-gate.mjs` `clientIp`; `lp-mcp-remote.mjs` `req.ip` under `trust proxy 1`; `LP_ALLOW_REMOTE_COLLECT`, arm and collect endpoints still refuse when `HOST !== "127.0.0.1"` (existing `test/host-guard.test.js`, `test/arm-salt.test.js`, `test/csrf.test.js` must pass unchanged). The report states for each site whether the check goes through proxy-addr or reads `socket.remoteAddress` directly.
6. Security (b), zod: old and new zod versions recorded; changelog between them read; any behavioural change relevant to schemas in `lp-mcp.mjs` noted; single deduped zod (`npm ls zod`).
7. `npm ls` reports no `ERR!`/invalid/missing for the touched packages; `lp-mcp.mjs` and `lp-mcp-remote.mjs` import cleanly.
8. Full `npm test` after the change compared with the Task 1 result: only `test/smoke.js` fails; `eslint .` clean.
9. Commit contains only the files in item 4, required Co-Authored-By line, no push.

### Prior open questions
1. Env override for the server command in smoke (assumption: none). 2. Chrome check order in smoke (assumption: unchanged). 3. Partial `npm audit fix` is a pass with leftovers listed. 4. `trust proxy 1` out of scope then; now handled by Task 1 above.

## EXTRA A: remove the "Fees claimed to date" tile
Goal: drop the top-row `#claimtile` (claimfig/claimsub) from dashboard.html in every wallet view, with its dead JS (tile branch of renderClaimTotalButton, click/keydown handlers) and `#claimtile{cursor:pointer}` CSS (base and themes). Keep `#ctotbtn`/`#ctotalpanel`, per-position Claimed fees tiles and the Analytics claims table.
Acceptance: (1) no `claimtile`/`claimfig`/`claimsub` in dashboard.html/js/css; (2) test asserts absence while `#ctotbtn` and `#ctotalpanel` remain; (3) full suite: only smoke.js may fail; `npx eslint .` clean.

## EXTRA B: risk panel follows the wallet picker; claim history uses the position's own owner
Goal: (1) `loadRisk` filters /api/risk positions by `currentScope()` like renderHeadline ('all' everything; 'owner' main wallet's; an address matches `walletAddress` case-insensitively) and the note reads "N of M watched" when filtered; changing the picker reloads the panel. (2) `/api/risk` calls `claimedSummary` with the position's own `walletAddress` as owner (main only when none), and every other claimedSummary call site is checked: watch.js via getClaimedSummary (w.address), registryClaim (e.wallet), line ~3091 (wallet) were already right; the main-wallet card list correctly uses cfg.ownerAddress.
Acceptance: test/risk-scope.test.js covers all/owner/address filtering and the count note, and that a watched wallet's position claim owner is its own address while main's uses main; full suite (only smoke.js may fail); eslint clean.
