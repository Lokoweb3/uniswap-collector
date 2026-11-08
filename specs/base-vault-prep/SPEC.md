# SPEC: Prepare (not execute) a LOKOVault on Base (8453)

Project: /mnt/c/Swarm-Projects/projects/lp-dashboard (DEV repo, branch master). This file lives in `specs/base-vault-prep/`; the top-level `SPEC.md` is untouched.
Research: `.swarm/base-vault-research.md` (2026-11-08). Nothing in this work sends a transaction, signs, or touches a key.

## Open questions (design-affecting)

None. Assumptions that are NOT design-changing are listed at the end under "Assumptions / minor questions".

## 1. Goal

Prepare everything the user needs to create a LOKOVault (TreasuryNFT "LOKOVault" #1 plus its ERC-6551 token-bound account, reusing `TreasuryAccount.sol`) on Base (chain 8453) from Main `0x698C3A3F06B7EdBD175169d1cfa219c8232F48d8`, signing every transaction themselves in Rabby. The swarm delivers: a deterministic unsigned-transaction builder, a local signing page that verifies each step on-chain before enabling the next, a read-only verifier that prints the settings snippet and the (deferred) `VAULT_IMPLEMENTATIONS` diff, mock-based tests, and a runbook. The swarm executes nothing.

## 2. Scope

In:
- `tools/base-vault-txs.js` (unsigned tx builder + read-only nonce prediction), shared core `tools/base-vault-core.js`.
- `tools/compile-base-vault.js` (dev-time, offline artifact generator; writes the artifact file only) and committed `tools/artifacts/base-vault.json`.
- Signing flow: `tools/base-vault-serve.js` (tiny static server), `tools/base-vault/index.html`, `tools/base-vault/flow.js` (pure UMD module).
- `tools/verify-base-vault.js` (read-only).
- Tests under `test/`, runbook `docs/base-vault-runbook.md`.

Out (explicit):
- Any transaction, deployment, signature, or private-key / keystore / mnemonic code path (no `Wallet`, `Signer`, `sendTransaction`, `LP_KEYSTORE_*`, `promptHidden` in any new file).
- Editing `server.js`, `chain-router.js`, `approve-serve.js` (another swarm edits them in a worktree), `collector-base-sweep-logic.js`, `collector-base-sweep.js`, `TreasuryNFT.sol`, `TreasuryAccount.sol`, `package.json` dependencies.
- Writing `~/base-data/settings.json` or any settings file (the verifier only prints a snippet).
- Adding any address to `VAULT_IMPLEMENTATIONS` (deferred user step, see D).
- `transferOwnership`: N/A, because Main is deployer, NFT owner/admin and holder of #1. `setPaused`: not needed (starts false).
- Base sweep reading split from the NFT (documented only), `LP_ROUTER_CHAINS` change (documented only).

## 3. Existing code to reuse

- `TreasuryAccount.sol` (no constructor args) and `TreasuryNFT.sol` HEAD: `constructor(address _implementation, address _registry, string _chainName)`, `mint(address)` (onlyOwner; also calls `registry.createAccount(impl, 0, block.chainid, this, 1)` and stores `tbaAddress`), `setFeeSplitPct(uint256)` (max 20), views `owner() ownerOf(uint256) tbaAddress() REGISTRY() chainName() implementation() feeSplitPct() paused()`. `REGISTRY` is an immutable, so the NFT runtime code contains the registry address (see A.4).
- Compile recipe from `tools/deploy-vault-arc.js` `compileWith` / `artifacts()`: repo `solc` (node_modules, 0.8.36 per research; record the real `solc.version()`), settings `{optimizer:{enabled:true,runs:200}, viaIR:true, evmVersion:"paris"}`, selecting contracts by name, outputSelection `abi, evm.bytecode, evm.deployedBytecode` (add `evm.deployedBytecode.immutableReferences`).
- `tools/verify-arc-vault.js`: style (`check(ok, what)` printing `ok  `/`FAIL`, `bad` counter, `process.exit(bad ? 1 : 0)`, ethers v6 `Contract` with human-readable ABIs, `strip()` for metadata-stripped comparison, `.catch` printing `ERR` and exit 1).
- `tools/deploy-vault-arc.js` for `arg()` parsing style and the `ethers.getCreateAddress` approach; its signing/keystore parts must NOT be copied.
- `claim-fees.js` + `claim-fees-core.js` (UMD pattern, `env` injection with `getEthereum()`, `eth_requestAccounts`, `eth_chainId`, `wallet_switchEthereumChain`, wallet-side `eth_call` cross-check, `sameAddress`, `isTxHash`, `errCode` 4001 handling, `accountsChanged`/`chainChanged` listeners) and `test/claim-fees-core.test.js` / `test/claim-fees-ui.test.js` for the mocked-provider test style.
- `collector-base-sweep-logic.js`: `CHAIN_ID`, `ERC6551_REGISTRY` (canonical `0x000000006551c19487814612e58FE06813775758`), `VAULT_IMPLEMENTATIONS` (frozen, `[]`), `config()` vault shape (`tba, nft, tokenId, implementation, registry, salt, expectedOwner, splitPct, maxSplitPct`), `vaultPct`. `collector-base-sweep.js` `verifyVault` (lines ~104-136) is the acceptance bar the verifier mirrors; the verifier may `require` `collector-base-sweep-logic` read-only for the constants.
- `tools/_paths.js` (do not use Arc paths; add nothing to it, a Base settings path may be taken from `--settings=` / `LP_BASE_SETTINGS` / `~/base-data/settings.json` for read-only RPC URL lookup only).
- `test/run-all.js` auto-discovers `test/*.test.js` (one process per file); `npm test` = `node test/run-all.js && eslint .`, so new code must pass the repo eslint config. No test framework: plain `assert`.

## 4. Constraints

- Node CommonJS, `"use strict"`, `ethers` ^6 and `solc` already in `package.json`; no new dependencies. Browser code has no build step.
- Read-only RPC only (`eth_call`, `eth_getCode`, `eth_getTransactionCount`, `eth_getTransactionReceipt`, `eth_chainId`). Every RPC provider must be checked `chainId === 8453` before use; refuse otherwise. Default RPC `https://mainnet.base.org`, override `--rpc=` / `LP_BASE_RPC`.
- Servers bind `127.0.0.1` by default, `HOST` env override (repo convention); port default `8745`, `PORT` override.
- No secrets in code, spec or artifact. `.env*` stay ignored.
- Fixed values (constants in `base-vault-core.js`): chainId 8453 / `0x2105`; Main above; registry canonical; chainName `"Base"`; tokenId 1; salt `0x00..00`; feeSplitPct target 20.
- Gas estimates in output are informational (research: impl 719,433; NFT 2,545,368; mint 197,105; setFeeSplitPct 30,637; total about 3.49M). The page does not set gas; Rabby estimates.

## A. Unsigned transaction builder

`tools/base-vault-txs.js` (CLI) over `tools/base-vault-core.js` (pure functions, no I/O except an injected `provider`).

A.1 Artifact. `tools/artifacts/base-vault.json` is committed and contains for `TreasuryAccount` and `TreasuryNFT`: `abi`, `initCode` (creation bytecode, no constructor args), `runtime`, `immutableReferences` (NFT), plus `solcVersion` (full, e.g. `0.8.36+commit.xxxx`), `settings` (the exact object above), `sourceSha256` of each `.sol` file. `tools/compile-base-vault.js` regenerates it in memory with the repo `solc` and writes only that file; it is run by the implementer once, offline, not by the user.

A.2 Pinned hashes. `base-vault-core.js` holds constants `PINNED = { account: { initCodeKeccak, runtimeKeccak }, nft: { initCodeKeccak, runtimeKeccak (with registry slot masked, see A.4) }, artifactFileSha256 }` computed by the implementer from the compile. Loading the artifact recomputes keccak256 of each `initCode`/`runtime`, and sha256 of the file, and throws (CLI exit 2, no output of any tx) on any mismatch with the pins or with the `solcVersion`/`settings` recorded. `--verify-artifact` re-compiles from the current `.sol` sources and checks the result equals the artifact (reproducibility check; also a test, skippable with a clear message only if `solc` fails to load). Cross-check pin: `account.runtimeKeccak` must equal the Arc implementation's `0x4019de98b57e19d75b5891f785eb53ad8bdaa8508b8cfc6db7fea9c1a0334a07` (research: identical build incl. metadata); if the recompile disagrees the implementer stops and reports rather than re-pinning silently.

A.3 Output. For each step 1..4 (step 4 `setFeeSplitPct(20)` is flagged optional) print a block with: step number and name, `from` (Main), `to` (`null`/"contract creation" for deploys), `data`, `value` `0x0`, `chainId` 8453, decoded call (function + args; for deploys the constructor args decoded), `keccak256(initCode)` (deploy steps), `expected runtime keccak256` (deploy steps), expected effects, and the informational gas estimate. Step 2 and later need `--impl=<addr>` (and `--nft=<addr>` for 3 and 4); with `--predict` they default to predicted addresses and are labelled `PREDICTED (depends on nonce, verify on-chain)`.

A.4 Expected NFT runtime hash. NFT runtime contains the immutable `REGISTRY`. The expected runtime for a given registry is `artifact.runtime` with the 32-byte word(s) at `immutableReferences` set to the left-padded canonical registry; the pin is on the zero-masked runtime. A helper `expectedRuntime("nft", registry)` returns bytes and its keccak256.

A.5 Prediction. `--predict` reads `eth_getTransactionCount(Main, "latest")` (and "pending", warning if they differ) from `--rpc`, then `ethers.getCreateAddress({from: Main, nonce})` for impl (n) and NFT (n+1); the TBA is `registry.account(impl, 0x0, 8453, nft, 1)` via `eth_call`. Output header states that if Main's nonce is 0 the research predicted impl `0x9932381F27f720DC1131349c4b4459F306d42DC7`, NFT `0x094126611290c5EC8660e8f5dCa708e35aCA573C`, TBA `0x86bb62E40EDe744BBC50bC873d7294Bf0Ec854a5`. Predictions are never used as truth by the signing page (B.5).

A.6 Advanced mode. `--format=json` prints one JSON array of `{step, name, from, to, data, value, chainId}` (value and chainId as hex strings, EIP-1193 ready); `--raw --step=N` prints only the `data` hex. `--step=N` selects one. Output is deterministic for identical inputs. No flag in the tool broadcasts or signs.

## B. Signing flow (Rabby)

Choice: a tiny separate static server `tools/base-vault-serve.js` serving `tools/base-vault/index.html` and `flow.js`, NOT a `file://` page. Justification: Rabby/Chromium extensions inject `window.ethereum` into `file://` pages only if the user enables "Allow access to file URLs" per extension, and `file://` origins break `fetch` of sibling assets and give a null origin; an `http://127.0.0.1` origin works out of the box, matches the existing `claim-fees.js` served-page model, and needs zero edits to `server.js`/`chain-router.js`/`approve-serve.js`.

B.1 Server. GET/HEAD only, other methods 405. Serves an exact allowlist of routes (`/`, `/flow.js`, `/ethers.umd.min.js` from `node_modules/ethers/dist/`, `/plan.json`); everything else 404; no directory listing, no path joining from the URL. Rejects requests whose `Host` header is not `127.0.0.1:<port>`, `localhost:<port>` or the configured `HOST` (DNS-rebinding guard, as in `test/host-guard.test.js`). Headers: `Content-Security-Policy: default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. `/plan.json` is built at startup by `base-vault-core` (artifact-verified, A.2) and contains the step list, `initCode`s, pins, and constants; the server refuses to start if the artifact check fails. The server holds no keys, makes no RPC calls and offers no endpoint that accepts data.

B.2 Page + pure module. `flow.js` is UMD (like `claim-fees.js`), exporting `create(env)` with `env = { getEthereum(), plan, ethers, render(state), now }`. All decisions live in it, none in the HTML. The page only wires `window.ethereum`, renders, and forwards clicks.

B.3 Guards (all enforced in `flow.js`, re-checked immediately before each `eth_sendTransaction`):
1. Only `eth_sendTransaction` is used to send; no `personal_sign`, `eth_sign`, `eth_signTypedData*`, `wallet_addEthereumChain`, `eth_sendRawTransaction`, `eth_signTransaction`.
2. `eth_chainId` must equal `0x2105`. If not, the send button is disabled and the page offers `wallet_switchEthereumChain` (`0x2105`); after the switch the chain is re-read; any `chainChanged` re-runs the guards. Never sends on another chain.
3. `eth_requestAccounts` account[0] must equal Main (case-insensitive) or the page refuses with a message naming both addresses; `accountsChanged` re-runs the guards.
4. Tx params sent are exactly `{from: Main, to?, data, value:"0x0", chainId:"0x2105"}`; for deploys `to` is omitted. `data` is built from the plan and the verified state, never from user text; the page has no editable fields.
5. One step at a time: the next button is enabled only if all previous steps verified (B.5) and no step is `pending`. A step with `latest` nonce != `pending` nonce for Main (a tx still in the mempool) blocks sending.

B.4 Steps and their on-chain verification (reads via the wallet's own provider `eth_call`/`eth_getCode`/`eth_getTransactionReceipt`, as `claim-fees.js` does):
1. Deploy TreasuryAccount. After the hash is returned the page polls the receipt: `status==1`, `from==Main`, `contractAddress` present. Verify `keccak256(eth_getCode(contractAddress)) == plan.account.runtimeKeccak`. The impl address used later is the receipt's `contractAddress` (the prediction is shown only as a cross-check; a mismatch is a warning, the code hash is the authority).
2. Deploy TreasuryNFT with args `(impl, 0x000000006551c19487814612e58FE06813775758, "Base")`, impl from step 1's verified address. Verify receipt as above, runtime hash equals `expectedRuntime("nft", registry)`, and `implementation()==impl`, `REGISTRY()==canonical`, `chainName()=="Base"`, `owner()==Main`.
3. `mint(Main)` to the verified NFT. Verify `ownerOf(1)==Main`, `tbaAddress()` has code, its 173-byte proxy code embeds `impl` and footer `(salt 0, 8453, nft, 1)`, `registry.account(impl,0,8453,nft,1)==tbaAddress()`, `TBA.owner()==Main`.
4. Optional `setFeeSplitPct(20)`. Verify `feeSplitPct()==20`. May be skipped explicitly; the final screen then states the split is 10%.

B.5 State is derived from chain, never from storage. On load/reload (and after every event) the page recomputes the step state from chain only: Main's nonce, then candidate CREATE addresses `getCreateAddress(Main, n)` for the last `K=8` nonces below `latest` (and `latest` itself for pending detection); a candidate whose code hash equals the account runtime pin is the impl; a later candidate whose runtime matches the NFT expected hash and whose `implementation()` equals that impl is the NFT. `localStorage`/`sessionStorage`/cookies are not used (a test asserts `flow.js` and the page contain none). A wrong or unexpected contract at a candidate address does not count as done.

B.6 Errors: user rejection (code 4001) leaves state unchanged with a clear message; a reverted receipt marks the step `failed` and stops (no automatic retry); RPC failure fails closed (step not verified).

## C. Verifier `tools/verify-base-vault.js` (read-only)

Args: `--nft=<addr>` (required), `--rpc=`, `--main=` (default Main), `--impl=` (optional cross-check), `--require-allowlisted`, `--expect-split=20`. Same style as `verify-arc-vault.js`. Checks (each via `check()`; chain id 8453 first; any failure increments `bad`, exit non-zero; uncaught error exit 1):
1. Code present at registry (canonical, runtime hash equals the canonical `0xda1d5b06...` full keccak recorded as a pin), NFT, TBA.
2. NFT runtime hash equals `expectedRuntime("nft", canonical registry)`; `name()=="LOKOVault"`, `symbol()=="LKVAULT"`, `chainName()=="Base"`, `REGISTRY()==canonical`.
3. `tbaAddress()` is the TBA; `registry.account(impl, 0x0, 8453, nft, 1)==TBA` where `impl` comes from the TBA's proxy bytecode (below).
4. TBA bytecode is exactly the 173-byte ERC-1167 proxy `363d3d373d3d3d363d73 <impl:20> 5af43d82803e903d91602b57fd5bf3` + 128-byte footer `(salt, chainId, token, tokenId)`; extract `impl`, require footer == `(0x0, 8453, nft, 1)`.
5. `keccak256(code(impl))` equals the account runtime pin; `NFT.implementation()==impl`; `--impl` if given equals it.
6. `TBA.token()==(8453, nft, 1)`; `TBA.owner()==Main`; `NFT.ownerOf(1)==Main`; `NFT.owner()==Main`; `NFT.paused()==false`; `feeSplitPct()==--expect-split` (default 20; mismatch is FAIL, with a note that 10 is the contract default); `FEE_SPLIT_MAX()==20`.
7. The deployer is not an extra authority: `owner()` equals Main, so no leftover admin.
8. Allowlist status: `impl` in `VAULT_IMPLEMENTATIONS` (read from `collector-base-sweep-logic.js`). Not yet listed prints `PENDING (expected until the deferred step)` and does not fail unless `--require-allowlisted`.
9. Also runs the repo's own acceptance bar: calls `collector-base-sweep.verifyVault(provider, {vault: <snippet>}, {operator:null, owners:[Main], implementations:[impl]})` and requires `ok === true` (proves the snippet would verify once allowlisted).

Printed output on success (exact text blocks, copy-pasteable, nothing written to disk):
- Settings snippet for `~/base-data/settings.json` under `baseSweep.vault`, shape from `collector-base-sweep-logic.js config()`: `{"nft": "...", "tokenId": 1, "tba": "...", "implementation": "...", "registry": "0x000000006551c19487814612e58FE06813775758", "salt": "0x000...0", "expectedOwner": "<Main>", "splitPct": 20, "maxSplitPct": 20}` (values from chain; `splitPct` = the NFT's `feeSplitPct()` because the Base sweep does not read it itself). Note: `expectedOwner` must be among the sweep's configured owner addresses, and the Base instance's own main is Trading `0xaDf94A20558E1E6d64c429F8F9f017169BF3d743`, so Main must be added to that owner list by the user.
- The code diff for `collector-base-sweep-logic.js`:
  `-const VAULT_IMPLEMENTATIONS = deepFreeze([]);` / `+const VAULT_IMPLEMENTATIONS = deepFreeze(["<impl checksummed>"]);`, plus the note that `test/collector-base-sweep-security.test.js:21` and `test/collector-base-sweep-reverify.test.js:301` assert the list is `[]` and must be updated in the same reviewed change.

## D. VAULT_IMPLEMENTATIONS (deferred)

This swarm must NOT edit `collector-base-sweep-logic.js` or add any address: the implementation does not exist on Base yet. Adding it is a user step after the verifier (C) passes on mainnet, via a separate reviewed commit. The verifier prints the exact diff. Acceptance includes a negative check that the constant is still `[]` and the file unmodified.

## E. Tests (plain `assert`, `test/*.test.js`, mocked EIP-1193 provider and mocked ethers provider, no network, no solc compile at test time except the one marked)

Files: `test/base-vault-core.test.js`, `test/base-vault-flow.test.js`, `test/base-vault-serve.test.js`, `test/base-vault-verify.test.js`. The mock provider is a small in-memory chain: accounts, chainId, code map, call handlers, nonce, receipts, records every `request` method so tests can assert "no signing/other methods called".

## Acceptance tests

1. `node test/run-all.js base-vault` passes; `npm test` (incl. eslint) passes with the new files.
2. Tx builder known inputs: for Main nonce 0 and registry canonical, `base-vault-txs.js --predict --format=json` against a mock provider yields exactly 4 steps; step 1 `data == artifact.account.initCode`, `to` absent, `chainId` `0x2105`, `value` `0x0`; step 2 `data == artifact.nft.initCode + abi.encode(address,address,string)(impl, canonical registry, "Base")` with impl `0x9932381F27f720DC1131349c4b4459F306d42DC7`; step 3 `data == 0x6a627842` + Main padded, `to == NFT 0x094126611290c5EC8660e8f5dCa708e35aCA573C`; step 4 `data == 0xbf9e114a` + 20 padded. Output labelled PREDICTED, and the printed keccak of init code equals the pinned constants.
3. Artifact integrity: modifying one byte of `initCode` (or of the file, or `solcVersion`/`settings`) in a temp copy makes `loadArtifact` throw, the CLI exit 2 and print no transaction, the server fail to start, and the flow module refuse to build `/plan.json`.
4. Reproducibility (the one test allowed to compile): recompiling `TreasuryAccount.sol` and `TreasuryNFT.sol` with the recorded settings yields `initCode`/`runtime` equal to the artifact, and `account.runtimeKeccak` equals `0x4019de98b57e19d75b5891f785eb53ad8bdaa8508b8cfc6db7fea9c1a0334a07`.
5. `expectedRuntime("nft", canonical)` equals the artifact runtime with the immutable slot filled; with a different registry the hash differs.
6. Wrong chain: with the mock wallet on `0x1`, sending is refused, `wallet_switchEthereumChain` is offered with `0x2105`; if the switch is rejected or the chain is still not `0x2105`, zero `eth_sendTransaction` calls are recorded. A `chainChanged` to another chain mid-flow disables the button again.
7. Wrong account: connected account other than Main (including the Main address in different case being ACCEPTED) results in refusal naming both addresses and zero `eth_sendTransaction` calls; `accountsChanged` to a wrong account re-disables.
8. Order: invoking step 2, 3 or 4 before the previous step is verified throws/refuses with zero sends; two clicks on the same step while pending send once; a step is blocked while Main's pending nonce exceeds its latest nonce.
9. Step verification: step 1 whose deployed code hash is wrong (or receipt status 0, or `from != Main`) is marked failed and step 2 stays disabled; step 2 built from the receipt's `contractAddress` (not the predicted one) when they differ; step 3 not verified if `ownerOf(1)` != Main, TBA has no code, or `registry.account` disagrees; step 4 not verified if `feeSplitPct()` != 20.
10. Reload: a fresh `create(env)` against a mock chain already containing a verified impl (at an earlier nonce) and NFT derives steps 1-2 done and enables step 3; with only a wrong contract at the candidate address it derives step 1 as not done; `localStorage`/`sessionStorage`/`document.cookie` are never referenced (grep-style assertion over `flow.js` and `index.html`).
11. Only allowed methods: across all flow tests the set of recorded wallet methods is a subset of `{eth_requestAccounts, eth_accounts, eth_chainId, wallet_switchEthereumChain, eth_sendTransaction, eth_call, eth_getCode, eth_getTransactionReceipt, eth_getTransactionCount}`.
12. Server: binds `127.0.0.1` by default and `HOST` when set; POST/PUT return 405; unknown path and `/../package.json` return 404; request with `Host: evil.example` is rejected; response carries the CSP and `no-store` headers; `grep` over the new files finds none of `Wallet(`, `privateKey`, `fromEncryptedJson`, `LP_KEYSTORE`, `sendTransaction(`, `signTransaction`, `personal_sign`.
13. Verifier passes (exit 0, `All checks passed`, snippet and diff printed) against a mock chain built with the correct contracts; each of these makes it exit non-zero with a `FAIL` line: wrong `ownerOf(1)`; wrong `NFT.owner()`; implementation with a different runtime hash; TBA proxy pointing at a different implementation; footer/`token()` with wrong chainId, wrong nft or wrong tokenId; `registry.account` mismatch; non-canonical registry; `feeSplitPct` != 20; no code at TBA; RPC chainId != 8453.
14. Verifier output: the printed settings snippet parses as JSON, passes through `collector-base-sweep-logic.config({vault: ...})` unchanged for `tba, nft, tokenId, implementation, registry, salt, expectedOwner`, and the printed diff contains the checksummed implementation address; the verifier writes no file (mocked `fs.writeFileSync` never called).
15. Allowlist: with the unmodified constant the verifier prints `PENDING` and exits 0 on an otherwise valid vault; with `--require-allowlisted` it exits non-zero.
16. Deferred step respected: `git diff` of the swarm's commits shows no change to `collector-base-sweep-logic.js`, `collector-base-sweep.js`, `server.js`, `chain-router.js`, `approve-serve.js`, the two `.sol` files, `package.json`; a test asserts `VAULT_IMPLEMENTATIONS` deep-equals `[]`.
17. Runbook exists at `docs/base-vault-runbook.md` and contains: the ordered steps with exact commands, the funding note (Main has 0 ETH on Base; about 3.5M gas is about 0.00002 ETH at 0.006 gwei; fund at least 0.0005 ETH), the transferOwnership N/A note, and the risks list in F.

## F. Runbook content (`docs/base-vault-runbook.md`)

Ordered: (0) fund Main on Base with at least 0.0005 ETH; (1) `node tools/base-vault-txs.js --predict` and review hashes and decoded calls; (2) `node tools/base-vault-serve.js`, open `http://127.0.0.1:8745`, connect Rabby as Main on Base; (3) steps 1 to 4 one at a time, confirming in Rabby, waiting for each green verification; (4) `node tools/verify-base-vault.js --nft=<NFT>`; (5) apply the printed settings snippet by hand; (6) deferred: reviewed commit of the printed `VAULT_IMPLEMENTATIONS` diff plus the two test updates; (7) note: add `base` to `LP_ROUTER_CHAINS` / `--chains` for `/api/vaults` to include Base (not changed here, `chain-router.js` is under edit elsewhere).
Risks: whoever owns the NFT (Main) controls the vault and the contract admin; predicted addresses depend on Main's nonce at send time (the page and verifier go by on-chain code hashes, not predictions; do not send other Main txs on Base mid-flow); the Base sweep reads the split from `baseSweep.vault.splitPct` (clamped to 20), not from the NFT's `feeSplitPct()`, so set both consistently; until the implementation is allowlisted the sweep sends 100% to the owner; Main must be a configured owner for `expectedOwner`; the chain name "Base" is permanent in token metadata; do not reuse the operator as deployer (its Base addresses would collide with Arc's).

## Assumptions / minor questions

- Build settings are the Arc ones (optimizer 200 runs, viaIR, evm paris) with the repo's installed solc (research: 0.8.36); the implementer records the real version from `solc.version()`.
- Step 2's implementation address comes from the step 1 receipt, verified by code hash; prediction is a cross-check only.
- Default port 8745 is arbitrary and overridable with `PORT`.
- Nonce window `K=8` for reload derivation; if more than 8 Main txs happened after deployment the page reports "cannot locate" and fails closed (verifier with explicit `--nft` is the fallback).
- The canonical registry runtime full keccak (`0xda1d5b06...cd6735`) must be taken in full from chain by the implementer (read-only) when pinning; the research only lists the abbreviated value.
