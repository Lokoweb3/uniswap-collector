#!/usr/bin/env node
/**
 * recover-stranded.js — convert a fee token left in the operator wallet into the
 * sweep target and deliver it the way the collector would have.
 *
 * Fee tokens reach the operator during a full-mode pass and leave it in the same
 * pass. When a pass dies between those two steps they stay there: on 2026-09-18 a
 * ReferenceError thrown while logging a successful collect's receipt left 99.409273
 * ARGUS in the operator wallet, and the split was taken on the USDC leg alone.
 *
 * This finishes that pass. It is deliberately not part of the collector: it moves a
 * balance the collector no longer considers its own, so it should be run
 * knowingly, once, with the amount in front of you.
 *
 * It uses the collector's own money path (collector-swap.convertFeeToken), its own
 * route choice (collector-logic.pickSwapRoute) and its own split arithmetic
 * (collector-logic.splitAmount), so what runs here is what runs there. The split
 * percentage is read from the vault NFT, never from settings.
 *
 * The amount delivered is measured from the operator's balance change across the
 * swap, not from the quote, so slippage lands where it actually fell.
 *
 * DRY RUN BY DEFAULT.
 *   node tools/recover-stranded.js --token=0xeCe5…cb3c
 *   node tools/recover-stranded.js --token=0xeCe5…cb3c --execute
 */
"use strict";

const fs = require("fs");
const { ethers } = require("ethers");
const cl = require("../collector-logic");
const swapMod = require("../collector-swap");

const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const EXECUTE = process.argv.includes("--execute");
const SETTINGS = arg("settings", "/home/steven/arc-data/settings.json");
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];
const log = (...m) => console.log(...m);

async function main() {
  const cfg = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  const provider = new ethers.JsonRpcProvider(cfg.chain.rpcUrl, undefined, { staticNetwork: true });
  const chainId = Number((await provider.getNetwork()).chainId);
  const token = ethers.getAddress(arg("token"));
  const owner = ethers.getAddress(arg("owner", "0xB1cdC09B4C7F28365a8E7BFA2332aF54f5462aF5"));
  const target = ethers.getAddress(cfg.collector.sweep.targetToken);
  const unitDec = cl.unitDecimals(cfg.numeraire ? { numeraire: cfg.numeraire } : {});
  const natDec = (cfg.chain.nativeCurrency || {}).decimals ?? 18;
  const natSym = (cfg.chain.nativeCurrency || {}).symbol || "ETH";

  let wallet = null;
  if (EXECUTE) {
    const ks = process.env.LP_KEYSTORE_PATH;
    const pass = process.env.LP_KEYSTORE_PASS;
    if (!ks || !pass) throw new Error("LP_KEYSTORE_PATH and LP_KEYSTORE_PASS must be set");
    wallet = (await ethers.Wallet.fromEncryptedJson(fs.readFileSync(ks, "utf8"), pass)).connect(provider);
  }
  const operator = wallet ? wallet.address : ethers.getAddress(arg("operator", "0x8B650B6E03a87d844f14D499331D54377E9db9dF"));

  const erc = new ethers.Contract(token, ERC20, wallet || provider);
  const tgt = new ethers.Contract(target, ERC20, wallet || provider);
  const [sym, dec] = [await erc.symbol(), Number(await erc.decimals())];
  const tgtSym = await tgt.symbol().catch(() => "target");
  const balance = await erc.balanceOf(operator);

  // The split comes from the vault NFT, which is what treasury.js honours.
  const nft = new ethers.Contract(cfg.vault.nft, ["function feeSplitPct() view returns (uint256)"], provider);
  const pct = Number(await nft.feeSplitPct());
  const tba = ethers.getAddress(cfg.vault.tba);

  log(`\nStranded balance recovery — ${EXECUTE ? "EXECUTE" : "dry run"}`);
  log(`  chain            : ${chainId}`);
  log(`  operator         : ${operator}`);
  log(`  stranded         : ${ethers.formatUnits(balance, dec)} ${sym}`);
  log(`  convert to       : ${tgtSym} ${target}`);
  log(`  split            : ${pct}% -> vault ${tba}`);
  log(`  remainder        : ${100 - pct}% -> ${owner}`);
  if (chainId !== Number(cfg.chain.chainId)) throw new Error(`settings say chain ${cfg.chain.chainId}, RPC says ${chainId}`);
  if (balance === 0n) { log("\nNothing stranded. Done."); return; }

  const quoter = new ethers.Contract(cfg.contracts.quoterV2,
    ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"],
    provider);
  const quoteAt = async (fee) => {
    try { return (await quoter.quoteExactInputSingle.staticCall({ tokenIn: token, tokenOut: target, amountIn: balance, fee, sqrtPriceLimitX96: 0 }))[0]; }
    catch { return 0n; }
  };
  const route = await cl.pickSwapRoute({
    override: (cfg.collector.swapFeeTierOverrides || {})[token] ?? null,
    quote: quoteAt,
  });
  if (!route || route.fee == null) throw new Error(`no pool quotes ${sym} -> ${tgtSym}; nothing was sent`);
  log(`  route            : ${route.fee / 10000}% pool, quoting ${ethers.formatUnits(route.out, unitDec)} ${tgtSym}`);
  const split = cl.splitAmount(route.out, pct);
  log(`  at that quote    : ${ethers.formatUnits(split.toVault, unitDec)} to the vault, ${ethers.formatUnits(split.toOwner, unitDec)} to ${owner}`);

  if (!EXECUTE) {
    log("\nDry run: nothing was sent. Re-run with --execute.");
    return;
  }

  const before = await tgt.balanceOf(operator);
  const router = new ethers.Contract(cfg.contracts.swapRouter02,
    ["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"],
    wallet);
  let gasSpent = 0n;
  const result = await swapMod.convertFeeToken({
    token: { address: token, symbol: sym, decimals: dec },
    balance,
    feeTier: route.fee,
    maxSwap: ethers.parseUnits(String(cfg.collector.thresholds.maxSwapValueWeth), unitDec),
    slippageBps: BigInt(cfg.collector.thresholds.slippageBps),
    weth: target,
    recipient: operator,
    quote: (amountIn) => quoteAt(route.fee).then((o) => (amountIn === balance ? o : o)),
    allowanceOf: () => erc.allowance(operator, cfg.contracts.swapRouter02),
    approve: async (amount) => {
      const tx = await erc.approve(cfg.contracts.swapRouter02, amount);
      log(`  approve ${sym} -> ${tx.hash}`);
      return tx.wait();
    },
    swap: async (params) => {
      const tx = await router.exactInputSingle(params);
      log(`  swap -> ${tx.hash}`);
      const r = await tx.wait();
      log(cl.gasLine(r.blockNumber, r.gasUsed * r.gasPrice, { nativeCurrency: cfg.chain.nativeCurrency }));
      return r;
    },
    handBack: async (reason) => {
      // Not this tool's job: it exists to finish the conversion, and quietly sending
      // the token somewhere else would be a different decision than the one asked for.
      throw new Error(`refusing to hand back instead of converting (${reason}); nothing further was sent`);
    },
    budget: () => true,
    recordGas: (c) => { gasSpent += c; },
    log: (m) => log(`  ${String(m).trim()}`),
    fmtUnit: (v) => `${ethers.formatUnits(v, unitDec)} ${tgtSym}`,
    fmtToken: (v) => ethers.formatUnits(v, dec),
  });
  if (result.action !== swapMod.RESULT.SWAPPED) throw new Error(`swap did not complete (${result.action}: ${result.reason || ""}); the balance is untouched in the operator wallet`);

  // Delivered from the balance change, not from the quote: slippage lands here.
  const received = (await tgt.balanceOf(operator)) - before;
  log(`  received         : ${ethers.formatUnits(received, unitDec)} ${tgtSym} (quote was ${ethers.formatUnits(route.out, unitDec)})`);
  if (received <= 0n) throw new Error("the swap reported success but the operator received nothing; stopping before any transfer");

  const final = cl.splitAmount(received, pct);
  const vtx = await tgt.transfer(tba, final.toVault);
  log(`  split ${ethers.formatUnits(final.toVault, unitDec)} ${tgtSym} (${pct}%) -> vault -> ${vtx.hash}`);
  const vr = await vtx.wait(); gasSpent += vr.gasUsed * vr.gasPrice;
  const otx = await tgt.transfer(owner, final.toOwner);
  log(`  send  ${ethers.formatUnits(final.toOwner, unitDec)} ${tgtSym} (${100 - pct}%) -> ${owner} -> ${otx.hash}`);
  const or = await otx.wait(); gasSpent += or.gasUsed * or.gasPrice;

  const left = await erc.balanceOf(operator);
  log(`\n  ${sym} left in the operator wallet: ${ethers.formatUnits(left, dec)}`);
  log(`  gas spent: ${ethers.formatUnits(gasSpent, natDec)} ${natSym}`);
  log(EXECUTE ? "\nDone." : "");
}

main().catch((e) => { console.error("\nFAILED:", e.shortMessage || e.message); process.exit(1); });
