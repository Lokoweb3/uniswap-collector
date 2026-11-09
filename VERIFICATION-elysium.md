# VERIFICATION-elysium.md

Date of every check: 2026-11-08. All requests: `curl -sS --max-time 20`, read-only. Fetched pages were saved in a
scratch directory and treated as untrusted data (values extracted, nothing followed).
RPC methods used against `https://testnet-rpc.elysium.kinetiq.xyz`: eth_chainId, eth_blockNumber, eth_gasPrice,
eth_feeHistory, eth_getBlockByNumber, eth_getCode, eth_call, eth_estimateGas, eth_getBalance. Nothing was signed or sent.

## V1 Docs - PASS (no conflict with the brief)

Commands: `curl -sS --max-time 20 https://elysium.kinetiq.xyz/docs/connecting-to-elysium` (HTTP 200, 264306 bytes) and
`.../docs/building-on-elysium` (HTTP 200, 348149 bytes). Both server-rendered, text extracted by stripping tags.

connecting-to-elysium, "Network configuration" table (Testnet | Mainnet columns), verbatim lines:

```
Elysium is an Arbitrum Orbit Layer 2 that settles to HyperEVM and uses HYPE as its native gas token.
Chain ID           99801            99901
Currency           HYPE             HYPE
Block explorer     elysium.kinetiq.xyz/testnet-explorer     Coming soon
Settles to         HyperEVM testnet (chain ID 998)          HyperEVM (chain ID 999)
Mainnet is pre-launch. Its block explorer and public RPC are published at launch.
Public endpoints:  RPC   https://testnet-rpc.elysium.kinetiq.xyz     Coming soon
Every user shares the public RPC, so use a provider endpoint for production traffic.
```

| Item | Brief | Docs | Match |
|---|---|---|---|
| Testnet chain ID | 99801 / 0x185d9 | 99801 | yes |
| Mainnet chain ID | 99901 / 0x1863d | 99901 | yes |
| Testnet RPC | https://testnet-rpc.elysium.kinetiq.xyz | same | yes |
| Explorer | https://elysium.kinetiq.xyz/testnet-explorer | `elysium.kinetiq.xyz/testnet-explorer` (no scheme printed) | yes |
| Symbol | HYPE | HYPE | yes |
| Settlement | 998 / 999 | HyperEVM testnet 998 / HyperEVM 999 | yes |
| Native decimals | (18 assumed) | NOT STATED on either page | n/a |
| Mainnet RPC / explorer | (to be disabled) | "Coming soon" / "published at launch" | consistent with disabled |

building-on-elysium: only mentions that Elysium is the rollup framework that "settles to HyperEVM", and lists
ecosystem tools (an explorer dashboard "for the Elysium testnet"). No chain parameters, no wallet metadata, no decimals.
Docs also say "Testnet runs the same stack and the same contracts as mainnet will; only the endpoints and deployed
addresses differ" - no DEX or NPM address is given, so none is configured.

## V2 Chain ID - PASS

```
POST {"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}
{"jsonrpc":"2.0","id":1,"result":"0x185d9"}
eth_blockNumber -> {"jsonrpc":"2.0","id":1,"result":"0x18e99b5"}   (26,122,677)
```

## V3 Native decimals - 18 NOT independently proven

- (a) Docs wallet metadata / `nativeCurrency`: the two docs pages state the symbol HYPE and nothing about decimals
  (searched for "decimal", "wei", "nativeCurrency", "wallet_add", "18": no hit outside script blobs). PROVED NOTHING.
- (b) Orbit chain config (`chain-info` / `nativeToken` / orbit-setup-script): no such published config was found for
  Elysium in the docs; none was fetched. NOT PROVEN.
- (c) Explorer API (`/testnet-explorer/api/v2/config`, `/api/v2/stats`): not reachable, see V4 (Vercel bot challenge,
  HTTP 429, no JSON). NOT PROVEN.
- (d) Orbit convention: fetched `https://docs.arbitrum.io/launch-orbit-chain/concepts/custom-gas-token-sdk`
  (307 -> `/launch-arbitrum-chain/chain-config/costs/custom-gas-token-rollup`, HTTP 200). The static HTML contains
  no occurrence of "decimals" / "18" / "scaled" / "normalized", so the claim "child-chain native balances are
  18-decimal" is "recalled, not fetched" here. NOT PROVEN from a fetched source.
- `eth_getBalance` of `0xf32fa92f...ab07` returned `0x6cbe8ce5f5d2176` (~0.49 if 18 decimals); this alone proves
  nothing about decimals, as the spec says. Gas price `0x5f6f270` = 0.100 gwei at 18 decimals is plausible, not proof.

- (e) Public chain registries, read-only GETs, fetched in the fix stage (2026-11-08):
  - `https://raw.githubusercontent.com/ethereum-lists/chains/master/_data/chains/eip155-99801.json` returned
    HTTP 404 ("404: Not Found"): ethereum-lists/chains has no entry for chain 99801.
  - `https://chainid.network/chains.json` returned HTTP 200 (1,212,224 bytes, 2,855 chains). Searching for
    `chainId` 99801 (and the mainnet id 99901) found NO entry. Nothing states `nativeCurrency.decimals` for Elysium.
  - Result: zero sources state decimals = 18 (two independent ones are required). NOT PROVEN; the unverified
    fallback stays: no `decimals` in the registry or the example, no automatic wallet add, raw wei with a
    "decimals unverified" badge.

Consequence (spec open question 2): `nativeCurrency.decimals` is OMITTED from the registry and from
`settings.elysium-testnet.example.json`; the example `_comment`, the README and this file say "18 NOT independently
proven". The loader leaves `nativeCurrency` unset, `/api/chain` answers `nativeCurrency: null`, the Wallet page
tells the user to add the network by hand, and native balances are shown as raw wei labelled "decimals unverified".

## V4 Explorer URL format - NOT PROVEN (the explorer blocks automated clients)

```
GET https://elysium.kinetiq.xyz/testnet-explorer                      -> 429 text/html
GET .../testnet-explorer/tx/0xc4d0aeb5...f19b7   (a real hash from the latest block) -> 429
GET .../testnet-explorer/address/0xf32fa92f...ab07 (a real sender)                    -> 429
GET .../testnet-explorer/address/0xcd57f65c...e1f234 (a real contract)                -> 429
GET .../testnet-explorer/tx/0x00..01 (fake hash), /nonexistent-path-xyz              -> 429 (identical)
GET .../testnet-explorer/api/v2/stats, /api/v2/config, /api/v2/main-page/blocks       -> 429
GET https://elysium.kinetiq.xyz/api/v2/stats                                          -> 429
response headers: server: Vercel, x-vercel-mitigated: challenge, body title "Vercel Security Checkpoint"
```

Every path, real or invented, gets the same Vercel challenge, so the status says nothing about whether `/tx/<hash>` or
`/address/<addr>` resolve. I did not try to bypass the challenge. Neither a Blockscout API nor the link shapes are
proven. Decision: `explorer-links.js` uses the conventional `/tx/<hash>` and `/address/<addr>` under the
`/testnet-explorer` prefix (documented as unconfirmed); `blockscout` is set to `""` in the example (no Blockscout API
is claimed). The docs list the explorer's own sections (Overview, Accounts, Batches...) and a
`testnet-explorer/verify-contract` link, which confirms the prefix but not the tx/address segments. The LIVE test
(LP_LIVE_TESTS=1) for non-404 links was not written to hit the explorer because it cannot pass against a challenge.

## V5 Orbit fees - PASS (NodeInterface answers)

```
eth_gasPrice        -> 0x5f6f270   (100,070,000 wei)
eth_feeHistory(4,"latest",[25,75]) -> {"oldestBlock":"0x18e99b2","reward":[["0x0","0x0"] x4],
   "baseFeePerGas":["0x5f60810","0x5f67d40","0x5f6cb60","0x5f6f270","0x5f6f270"],"gasUsedRatio":[1,1,1,1]}
eth_getBlockByNumber("latest") -> "baseFeePerGas":"0x5f6f270", "l1BlockNumber":"0x41d70f4", "miner":"0xa4b000000000000000000073657175656e636572", "gasLimit":"0x4000000000000"
   => EIP-1559: YES (baseFeePerGas present). Priority rewards are all 0x0.
eth_getCode(0x00000000000000000000000000000000000000C8) -> "0x"
eth_call to 0x...C8 gasEstimateComponents(0xcd57f65c...e1f234 [a proxy contract], false, 0x) -> {"error":{"code":-32000,"message":"execution reverted"}}
eth_call to 0x...C8 gasEstimateComponents(0xf32fa92f...ab07 [an EOA], false, 0x)
   -> 0x00..52b4 00..07 00..05f6f270 00..48f09
   = gasEstimate 21172, gasEstimateForL1 7, baseFee 100,070,000, l1BaseFeeEstimate 298,761
eth_estimateGas({from: EOA, to: contract, data: 0x}) -> 0x8a89 (35,465)
```

Findings: the NodeInterface is a virtual contract. `eth_getCode` at `0x...C8` returns `0x` (as on Arbitrum One) yet
`eth_call` returns all four values for an EOA target, so `orbit-fees.js` decides by the call, NOT by code presence
(a deviation from the spec text, which said "missing code falls back": here that rule would wrongly disable a working
NodeInterface). A revert (for example a target whose fallback reverts) falls back to `eth_estimateGas`.
Priority fee: 0 (feeHistory rewards all 0x0), matching the spec's Orbit assumption.

## V6 Settlement - PASS (metadata only)

Docs: "Settles to  HyperEVM testnet (chain ID 998)" and "HyperEVM (chain ID 999)" for mainnet. No 998 RPC URL is
quoted in the docs, so no 998 endpoint was called. 998 / 999 are recorded only as `settlementChainId` metadata.

## Proven / Not proven

| Claim | Status | Source |
|---|---|---|
| Testnet chain ID 99801 / 0x185d9 | PROVEN | docs + live eth_chainId |
| Mainnet chain ID 99901 / 0x1863d | docs only (pre-launch, disabled) | docs |
| Testnet RPC URL | PROVEN | docs + live |
| Symbol HYPE | docs only | docs |
| Native decimals 18 | NOT PROVEN | no source states it |
| Explorer base URL | docs only | docs (page itself blocked to curl) |
| Explorer /tx/ and /address/ shapes | NOT PROVEN | explorer returns a bot challenge |
| Blockscout API at the explorer | NOT PROVEN | same |
| EIP-1559 baseFeePerGas | PROVEN | latest block |
| Priority fee 0 | PROVEN (feeHistory) | live |
| NodeInterface gasEstimateComponents via eth_call | PROVEN (EOA target) | live |
| NodeInterface visible to eth_getCode | NO (returns 0x) | live |
| Settlement chain 998 / 999 | docs only | docs |
| Any Elysium DEX / NPM / contract address | NONE known, none configured | docs |
