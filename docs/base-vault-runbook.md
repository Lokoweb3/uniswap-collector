# Runbook: create a LOKOVault on Base (8453)

You sign every transaction yourself in Rabby. Nothing in this repo sends a transaction, signs a message or touches a key.
Main is `0x698C3A3F06B7EdBD175169d1cfa219c8232F48d8`. It deploys both contracts and holds NFT #1, so it is also the NFT's owner/admin.
`transferOwnership` is N/A: there is no deployer-to-holder hand-off. `setPaused` is not needed (the vault starts unpaused).

What gets created: `TreasuryAccount` (the ERC-6551 account implementation), `TreasuryNFT` "LOKOVault" (chain name "Base", canonical registry
`0x000000006551c19487814612e58FE06813775758`), token #1 minted to Main, and its token-bound account (created by `mint`). Optionally the fee split is set to 20%.
The compiled contracts are pinned in `tools/base-vault-core.js` (solc 0.8.36, optimizer 200 runs, viaIR, evm paris).

## 0. Fund Main on Base

Main has 0 ETH on Base. The four transactions use about 3.5M gas, about 0.00002 ETH at 0.006 gwei. Send at least 0.0005 ETH to Main on Base (25x headroom for a gas spike).

## 1. Review the unsigned transactions (read-only)

```
node tools/base-vault-txs.js --predict
```

Check the hashes and decoded calls. `--predict` reads Main's nonce from `https://mainnet.base.org` (override `--rpc=` or `LP_BASE_RPC`) and prints the
implementation, NFT and token-bound account addresses labelled PREDICTED: they are only valid if no other transaction from Main lands on Base before you send.
If Main's nonce is 0 the expected values are impl `0x9932381F27f720DC1131349c4b4459F306d42DC7`, NFT `0x094126611290c5EC8660e8f5dCa708e35aCA573C`, TBA `0x86bb62E40EDe744BBC50bC873d7294Bf0Ec854a5`.
Other forms: `--format=json`, `--raw --step=N`, `--step=N`, `--impl=0x.. --nft=0x..`, `--verify-artifact` (recompiles the .sol files and compares).

## 2. Open the signing page

```
node tools/base-vault-serve.js
```

Open `http://127.0.0.1:8745` (set `PORT` / `HOST` to change). Click "Connect wallet" and connect Rabby as Main on Base. The page refuses another account or chain
and offers a switch to Base. It has no editable fields and reads its state from the chain, so it is safe to reload.

## 3. Steps 1 to 4, one at a time

For each step: click "Send in wallet", read the transaction in Rabby, confirm, and wait for the step to turn green (the page verifies the receipt and the deployed code hash on chain).

1. Deploy TreasuryAccount.
2. Deploy TreasuryNFT(implementation from step 1, canonical registry, "Base").
3. `mint(Main)`: mints #1 to Main and creates the token-bound account.
4. Optional `setFeeSplitPct(20)`. If you skip it the split stays at the contract default of 10%.

Do not send other transactions from Main on Base in between: the page blocks while a transaction is pending, and the addresses depend on the nonce.

## 4. Verify (read-only)

```
node tools/verify-base-vault.js --nft=<NFT address from the page>
```

Expect `All checks passed.` and `PENDING (expected until the deferred step)` for the allowlist. Add `--expect-split=10` if you skipped step 4.

## 5. Settings

The verifier prints a `baseSweep.vault` snippet. Apply it to `~/base-data/settings.json` by hand (nothing writes it). `expectedOwner` (Main) must be among the Base sweep's
configured owner addresses; the Base instance's own main is Trading `0xaDf94A20558E1E6d64c429F8F9f017169BF3d743`, so add Main to that list.

## 6. Deferred: allowlist the implementation

`VAULT_IMPLEMENTATIONS` in `collector-base-sweep-logic.js` stays `[]` until this step. After the verifier passes on mainnet, make a separate reviewed commit with the diff the
verifier prints, and update `test/collector-base-sweep-security.test.js:21` and `test/collector-base-sweep-reverify.test.js:301`, which assert the list is `[]`.

## 7. Showing Base in `/api/vaults`

Add `base` to `LP_ROUTER_CHAINS` (or `--chains`) so `/api/vaults` includes Base. Not changed here; `chain-router.js` is being edited elsewhere.

## Risks

- Whoever owns the NFT (Main) controls the vault and the contract admin.
- Predicted addresses depend on Main's nonce at send time. The page and verifier go by on-chain code hashes, not predictions. Do not send other Main transactions on Base mid-flow.
- The Base sweep reads the split from `baseSweep.vault.splitPct` (clamped to 20), not from the NFT's `feeSplitPct()`, so set both consistently.
- Until the implementation is allowlisted the sweep sends 100% to the owner.
- Main must be a configured owner for `expectedOwner` to verify.
- The chain name "Base" is permanent in the token metadata.
- Do not reuse the operator as deployer: its Base addresses would collide with Arc's.
