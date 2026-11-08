# Base (8453) LOKOVault — research findings (read-only)

Date: 2026-11-08. All on-chain facts from read-only JSON-RPC (eth_getCode / eth_call / eth_estimateGas / eth_getStorageAt / eth_gasPrice) against
Robinhood `https://rpc.mainnet.chain.robinhood.com` (4663, block ~109,396,398), Arc `https://rpc.mainnet.arc.io` (5042, block ~30,213,409),
Base `https://mainnet.base.org` (8453, block ~54,842,925). RPC URLs from `/home/loko/uniswap-collector/settings.json`, `~/arc-data/settings.json`,
`~/base-data/settings.json` (none contained API keys). No transactions, signatures or key access. Scratch scripts: `/tmp/claude-1000/-mnt-c-Swarm-Projects/07a8a466-72c6-4b70-8eb0-c9f28bbb12a1/scratchpad/`.

## 1. How the existing vaults were made

### Design (source in repo)
- `TreasuryNFT.sol` = the "LOKOVault" ERC-721 (name LOKOVault, symbol LKVAULT, singleton #1). **Admin / pause / pct / max all live on the NFT contract**, not on the account:
  `owner()` (admin), `paused()`, `feeSplitPct()` (default 10), `FEE_SPLIT_MAX()` = 20 constant, `setFeeSplitPct(uint256)`, `setPaused(bool)`, `transferOwnership(address)`.
  `mint(address)` (onlyOwner, once) mints #1 AND calls `registry.createAccount(implementation, 0, block.chainid, this, 1)` itself, storing `tbaAddress`.
  HEAD constructor: `(address _implementation, address _registry, string _chainName)` (requires registry has code). `REGISTRY` is an immutable.
- `TreasuryAccount.sol` = custom, minimal ERC-6551 account (NOT Tokenbound): `token()` reads the 6551 footer, `owner()` = NFT.ownerOf (0 if chainId != block.chainid),
  `isValidSigner`, `execute(to,value,data,0)` CALL only, `withdraw/withdrawAll/withdrawETH/withdrawAllETH`, `state`. Not a proxy, not upgradeable (EIP-1967 slot = 0 on RH and Arc).
- TBA = the canonical ERC-6551 v0.3 EIP-1167 proxy (173 bytes: `363d3d373d3d3d363d73<impl>5af4...` + footer) created by the registry with CREATE2.
- Deploy scripts: `deploy-treasury.js` (Robinhood, solc default settings), `tools/deploy-vault-arc.js` (Arc; optimizer 200 + viaIR + evmVersion paris; dry-run default), `tools/rehearse-arc-vault.js`, `tools/verify-arc-vault.js`. `TreasuryNFT.sol`/`TreasuryAccount.sol` identical in lp-dashboard-elysium.

### Robinhood (4663) — PROVEN via RPC
| item | address | runtime bytes | keccak256(code) | keccak256(code minus CBOR metadata) |
|---|---|---|---|---|
| Registry (canonical) | 0x000000006551c19487814612e58FE06813775758 | 571 | 0xda1d5b06…cd6735 | 0x40faff3e…3bec5a |
| NFT | 0xd3b738C78C93084F9d44cFab2934Da5e8B6c9811 | 18,591 | 0x54bd9512e3f9bba5a5348a3ce40585183d6eba5ef172b063dcad1a235222cdff | 0xb0242abf…633cec |
| Implementation | 0x94771cb67D5C4F9C022185122c07a950c87E3E35 | 7,258 | 0x6b6591b66fe01795f083f0a7db070b0311907f2ae85b66be25725aac3b574182 | 0x721087f3…85191f |
| TBA | 0x4941943B0a3860f07767d8918Cce50D8451b340B | 173 | 0x0d95db75…656db7 | — |

NFT state: owner()=Main 0x698C…48d8, ownerOf(1)=Main, paused=false, feeSplitPct=20, FEE_SPLIT_MAX=20, REGISTRY()=canonical, implementation()=0x9477…3E35,
tbaAddress()=0x4941…340B, chainName() reverts (old contract version). TBA.token()=(4663, NFT, 1), TBA.owner()=Main, state=0.
registry.account(impl,0,4663,nft,1) = 0x4941…340B (matches).

**Source reproduction (PROVEN by local compile, solc 0.8.36 from node_modules, compared to eth_getCode):**
- Implementation: `TreasuryAccount.sol` (unchanged since commit 4fd3eea), solc 0.8.36 default settings (no optimizer) → runtime **byte-for-byte identical incl. metadata** to RH impl.
- NFT: `git show 4fd3eea:TreasuryNFT.sol` (old version: hardcoded REGISTRY constant, constructor `(address _implementation)`, literal "Robinhood Chain"/"4663"), default settings → runtime identical excluding metadata.
- Deployer: both are plain CREATE (not CREATE2) from operator **0x8B650B6E03a87d844f14D499331D54377E9db9dF**: impl = nonce 11, NFT = nonce 12 (computed with getCreateAddress, exact match).
  Constructor arg of RH NFT = impl 0x9477…3E35 (from implementation() + old source).
- Deploy/mint tx hashes: **UNPROVEN** — RH RPC is not archive (historical eth_getTransactionCount fails), eth_getLogs over full range rejected, robinhoodchain.blockscout.com / arcexplorer.org behind a Cloudflare challenge. Verified source on an explorer: **UNPROVEN** (unreachable). Not needed: reproducible creation bytecode exists from repo source.

### Arc (5042) — PROVEN via RPC
| item | address | bytes | keccak256(code) |
|---|---|---|---|
| Registry (self-deployed, op nonce 0) | 0x06fe91de63e6216b9D40644298b454adc18d130d | 571 | 0xfc08ce51…e71fb (stripped 0x40faff3e… = same as canonical) |
| Canonical registry also exists on Arc now | 0x000000006551c19487814612e58FE06813775758 | 571 | 0xda1d5b06… (identical to RH/Base) |
| Implementation (op nonce 1) | 0xE07510f95DDCe14e2DE199245D3E5eb19BebbCaA | 3,051 | 0x4019de98b57e19d75b5891f785eb53ad8bdaa8508b8cfc6db7fea9c1a0334a07 |
| NFT (current, op nonce 13) | 0x416e9309Ce25e14B74A629dfAb5c12a3b5CEc903 | 10,720 | 0x60db85778f27616c502a8d3b2a1f3140f49e433015128d252f3968f2372721c2 |
| TBA | 0x56dfE4aB82a4f812aC2eF280d7F1D809A4a1C505 | 173 | 0x5fe0177a…14a59 |
| old NFT / old TBA (replaced, op nonce 2) | 0xD94008e9…0a856 / 0x507aFB73…133d2 | | |

Arc NFT: owner()=ownerOf(1)=0xB1cdC09B4C7F28365a8E7BFA2332aF54f5462aF5 (Arc LP), paused=false, pct=20, max=20, REGISTRY=0x06fe…130d, chainName="Arc", tbaAddress=0x56df…C505; TBA.token()=(5042,NFT,1), owner()=Arc LP; registry.account matches.
Reproduction: HEAD `TreasuryAccount.sol` with {optimizer 200, viaIR, paris} → **identical incl. metadata** to Arc impl; HEAD `TreasuryNFT.sol` same settings → identical incl. metadata with the REGISTRY immutable masked.

### Cross-chain comparison
- Implementations differ RH vs Arc (same source, different compiler settings). NFTs differ (different source versions + settings). Only the registry is identical everywhere (canonical CREATE2 deployment).
- Nothing in the vault is deterministic across chains: NFT and implementation are nonce-based CREATE from the operator. The TBA is CREATE2 but bound to (impl, chainId, nft), so it differs per chain.
- On Base: registry.account(RH impl, 0, 8453, RH nft, 1) = 0xeC4CB7bBB9F5496Ed4C0FEF6Fb685416e6c4d4f3 (unusable — those contracts don't exist on Base). The RH TBA address itself (chainId 4663) cannot be controlled on Base because TreasuryAccount.owner() returns 0 when chainId != block.chainid.

## 2. What must be created on Base

### Base state (PROVEN via RPC)
- Canonical registry 0x0000…5758 HAS code (571 B, keccak 0xda1d5b06… identical to RH).
- No code on Base at: RH NFT, RH impl, RH TBA, Arc NFT, Arc impl.
- Tokenbound (docs.tokenbound.org/contracts/deployments, fetched 2026-11-08, lists Base 8453): AccountProxy 0x55266d75D1a14E4572138116aF39863Ed6596E7F has code on Base (902 B, keccak 0x7f2b4bea…afdb0); Account implementation 0x41C8f39463A868d3A88af00cd0fe7102F30E44eC has code (14,924 B, keccak 0xdf5eeb80…f0f85b). Alternative only; not needed.
- Main 0x698C3A3F06B7EdBD175169d1cfa219c8232F48d8 on Base: **nonce 0, balance 0 ETH**. Operator 0x8B650B6E…db9dF on Base: nonce 0, balance 0. Base instance's settings main is "Trading" 0xaDf94A20558E1E6d64c429F8F9f017169BF3d743 (nonce 121, 0.00447 ETH).

### Creation bytecode: AVAILABLE (no blocker on implementation choice)
Compile in memory with repo solc 0.8.36, exactly as `tools/deploy-vault-arc.js` does: `{optimizer:{enabled:true,runs:200}, viaIR:true, evmVersion:"paris"}`:
- TreasuryAccount: init 3,078 B / runtime 3,051 B (= Arc impl code). 
- TreasuryNFT (HEAD): init 11,858 B / runtime 10,720 B; constructor args `(impl, 0x000000006551c19487814612e58FE06813775758, "Base")`.

### Steps (sender = deployer D; if D = Main, no admin hand-off needed)
1. Deploy TreasuryAccount (no args).
2. Deploy TreasuryNFT(impl, canonical registry, "Base"). MUST use the canonical registry: `collector-base-sweep.js` verifyVault refuses any other registry.
3. `mint(address)` 0x6a627842 → mints #1 to Main and calls `createAccount(address,bytes32,uint256,address,uint256)` 0x8a54c52f (impl, 0x0, 8453, nft, 1) internally. No separate createAccount call.
4. Optional: `setFeeSplitPct(uint256)` 0xbf9e114a (e.g. 20 to match RH/Arc; default 10, max 20); `setPaused(bool)` 0x16c38b3c not needed (starts false);
   `transferOwnership(address)` 0xf2fde38b only if D != Main.
   Views: owner() 0x8da5cb5b, paused() 0x5c975abb, feeSplitPct() 0xfbefc7e7, FEE_SPLIT_MAX() 0x7539d4dc, tbaAddress() 0x378ff1d0, REGISTRY() 0x06433b1b, chainName() 0x1c93b03a, implementation() 0x5c60da1b, token() 0xfc0c546a, ownerOf(uint256) 0x6352211e, account(...) 0x246a0021.

### Expected addresses (PROVEN given the stated nonce; registry.account eth_call on Base)
- If Main deploys at nonce 0/1: impl 0x9932381F27f720DC1131349c4b4459F306d42DC7, NFT 0x094126611290c5EC8660e8f5dCa708e35aCA573C, TBA = registry.account(impl,0,8453,nft,1) = **0x86bb62E40EDe744BBC50bC873d7294Bf0Ec854a5**. Valid only if Main's Base nonce is still 0 at send time and impl/NFT are its first two txs.
- If the operator deploys at nonce 0/1: impl 0x06fe91de…130d, NFT 0xE07510f9…BbcaA, TBA 0xf504fc62CCadB336C0b74b7ae71750398778eBb7. WARNING: these collide with Arc's registry/impl addresses but would hold different contracts — confusing; avoid.

### Dashboard / collector wiring
- `collector-base-sweep-logic.js` `VAULT_IMPLEMENTATIONS = []` (code constant, settings cannot add). The new Base impl address must be added in code (reviewed) or the vault never verifies and 100% goes to owner.
- Base sweep's split % comes from settings `baseSweep.vault.splitPct/maxSplitPct` (vaultPct, clamped to 20), NOT the NFT's feeSplitPct() — unlike treasury.js on RH/Arc where the NFT wins. Spec must decide whether to reconcile.
- verifyVault also needs settings `baseSweep.vault.{tba,nft,tokenId:1,implementation,salt 0x0,expectedOwner}`; expectedOwner must be one of the configured owners (Base settings main is Trading 0xaDf9…, not Main).
- `/api/vault-info` (server.js ~2677) reads NFT owner()/ownerOf(1)/feeSplitPct()/paused() from `cfg.treasuryNFT`; `/api/vaults` (chain-router.js 358, vaultOf) aggregates per chain; default router chains "robinhood,arc" (LP_ROUTER_CHAINS / --chains to add base).

## 3. Gas (Base, read-only)
Gas price: block baseFee 0.005 gwei, eth_gasPrice 0.006 gwei, maxPriority 0.001 gwei. L1 (Fjord) l1BaseFee 62,864,888; GasPriceOracle getL1Fee(initcode): NFT ~3.8e-8 ETH, impl ~1.1e-8 ETH.

| step | gas | method |
|---|---|---|
| deploy TreasuryAccount | 719,433 | eth_estimateGas from Main (PROVEN) |
| deploy TreasuryNFT(impl,REG,"Base") | 2,545,368 | eth_estimateGas from Main (PROVEN) |
| mint(Main) incl. createAccount | 197,105 | eth_estimateGas with state override (NFT runtime + owner/impl slots at predicted addresses) — strong estimate, not a live-state measurement. Plain registry.createAccount alone: 95,901 |
| setFeeSplitPct(20) | 30,637 | estimate with override |
| transferOwnership (only if D != Main) | 27,440 | estimate with override |
| setPaused(false) (not needed) | 26,200 | estimate with override |

Total (Main deploys, sets 20%): ~3.49M gas × 0.006 gwei ≈ 0.000021 ETH + L1 ≈ 0.0000001 ETH → ~0.00002 ETH. Fund with ≥0.0005 ETH for gas-price spikes (25x headroom). Arc's fork-measured figures (176,589 / 712,610 / 2,524,204 / 194,395 / 27,312) agree.

## 4. PROVEN vs UNPROVEN
PROVEN: all addresses/code sizes/hashes above (eth_getCode); RH & Arc NFT/TBA state (eth_call); registry.account matches on RH and Arc; impl not a proxy (EIP-1967 slot 0); RH impl and Arc impl/NFT byte-identical to local compiles of repo source; RH NFT identical (minus metadata) to 4fd3eea source; operator 0x8B65… deployed all of them with CREATE at the listed nonces; canonical registry on Base; Tokenbound contracts on Base + docs; Main has 0 ETH / nonce 0 on Base; gas estimates; selectors (computed).
UNPROVEN: RH/Arc deploy and mint tx hashes and blocks (no archive RPC, explorers Cloudflare-blocked); explorer-verified source; mint gas is override-simulated, not live; predicted Base addresses depend on deployer nonce at send time.

## Decisions for the user
1. Deployer/holder on Base: Main 0x698C… has 0 ETH on Base (needs funding), operator also 0 ETH; Base instance's own main is Trading 0xaDf9… — who holds #1 and who is admin?
2. Implementation: recommended reuse of TreasuryAccount (Arc build, reproducible). Tokenbound AccountV3/Proxy is an alternative (would need AccountProxy + initialize flow; NFT admin features are unaffected since they live on the NFT).
3. Initial fee split (default 10 vs 20 as on RH/Arc), and whether the Base sweep should read feeSplitPct() from the NFT.
4. Adding the Base impl to VAULT_IMPLEMENTATIONS (code change + review).
5. A Base deploy script analogous to tools/deploy-vault-arc.js (dry-run default, chain-id guard 8453, canonical registry, chainName "Base") + fork rehearsal.
