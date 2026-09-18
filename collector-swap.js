"use strict";
/**
 * Convert one fee token in the operator wallet into the unit of account, or hand
 * it back to its owner untouched.
 *
 * This is the money path, so it lives on its own and takes every side effect as a
 * dependency: the quote, the allowance read, the approval, the swap, the hand-back
 * transfer and the gas budget. A test can therefore run the real decision sequence
 * with mocks and prove what was NOT attempted — that a quote over
 * maxSwapValueWeth never reaches the router, and that nothing is sent once the
 * 24-hour gas budget cannot cover it.
 *
 * Order matters and is deliberate:
 *   1. no usable fee tier            -> hand back (no quote, no swap)
 *   2. gas budget cannot cover a tx  -> do nothing at all (a hand-back is itself
 *                                      a transfer, so it is not a free fallback)
 *   3. quote fails                   -> hand back
 *   4. quote over the ceiling        -> hand back, never swap
 *   5. otherwise                     -> approve exactly what is swapped, then swap
 */

const cl = require("./collector-logic");

const RESULT = {
  HANDED_BACK: "handed-back",
  SWAPPED: "swapped",
  SKIPPED_BUDGET: "skipped-budget",
  FAILED: "failed",
};

async function convertFeeToken({
  token,               // { address, symbol, decimals }
  balance,             // bigint, what the operator holds of it
  feeTier,             // number | null | undefined
  maxSwap,             // bigint, in the unit of account's decimals
  slippageBps,         // bigint
  weth,                // unit-of-account address (swap output)
  recipient,           // who the router pays (the operator)
  quote,               // async (amountIn) -> bigint  (0n when it cannot be quoted)
  allowanceOf,         // async () -> bigint
  approve,             // async (amount) -> receipt
  swap,                // async ({ tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96 }) -> receipt
  handBack,            // async (reason) -> void   (a transfer back to the owner)
  budget,              // (kind) -> boolean: may we spend gas on one more transaction?
  recordGas = () => {},
  log = () => {},
  fmtUnit = (v) => String(v),
  fmtToken = (v) => String(v),
}) {
  const allowed = (kind) => (typeof budget === "function" ? budget(kind) : true);

  if (feeTier === undefined || feeTier === null) {
    if (!allowed("transfer")) return { action: RESULT.SKIPPED_BUDGET, reason: "no fee tier, and the gas budget cannot cover the hand-back" };
    await handBack(`no known fee tier for ${token.symbol}`);
    return { action: RESULT.HANDED_BACK, reason: "no known fee tier" };
  }
  // Before anything is sent: a swap is an approval plus a swap, so require room
  // for both. Without room, the token simply stays put and is reported.
  if (!allowed("swap")) {
    log(`  ! ${token.symbol} left in the operator wallet: the 24h gas budget cannot cover another swap.`);
    return { action: RESULT.SKIPPED_BUDGET, reason: "gas budget exhausted before swap" };
  }

  const quoted = await quote(balance);
  const why = cl.handBackReason({ feeTier, quotedWeth: quoted, maxSwapWeth: maxSwap });
  if (why) {
    if (!allowed("transfer")) {
      log(`  ! ${token.symbol} left in the operator wallet: ${why}, and the gas budget cannot cover the hand-back.`);
      return { action: RESULT.SKIPPED_BUDGET, reason: why };
    }
    await handBack(
      why === "swap over maxSwapValueWeth"
        ? `${token.symbol} swap would be ${fmtUnit(quoted)}, over maxSwapValueWeth`
        : `could not quote ${token.symbol} on a v3 pool`
    );
    return { action: RESULT.HANDED_BACK, reason: why };
  }

  const minOut = (quoted * (10000n - BigInt(slippageBps))) / 10000n;
  try {
    const allowance = await allowanceOf();
    if (allowance < balance) {
      // Exact-amount approval rather than unlimited: the operator is a hot wallet,
      // so a standing infinite allowance is unnecessary risk.
      const arcpt = await approve(balance);
      if (arcpt && arcpt.gasUsed != null && arcpt.gasPrice != null) recordGas(arcpt.gasUsed * arcpt.gasPrice);
    }
    const srcpt = await swap({
      tokenIn: token.address, tokenOut: weth, fee: feeTier, recipient,
      amountIn: balance, amountOutMinimum: minOut, sqrtPriceLimitX96: 0,
    });
    log(`swap ${fmtToken(balance)} ${token.symbol} -> unit (quote ${fmtUnit(quoted)}, min ${fmtUnit(minOut)})`);
    if (srcpt && srcpt.gasUsed != null && srcpt.gasPrice != null) recordGas(srcpt.gasUsed * srcpt.gasPrice);
    return { action: RESULT.SWAPPED, quoted, minOut };
  } catch (err) {
    // A failed swap leaves the tokens where they are: in the operator wallet,
    // still owed to this pass's owner. Nothing is retried blindly here.
    log(`  ! swap failed for ${token.symbol}: ${err.shortMessage || err.message}`);
    log(`    tokens remain in the operator wallet — swap manually or rerun.`);
    return { action: RESULT.FAILED, reason: err.shortMessage || err.message };
  }
}

module.exports = { convertFeeToken, RESULT };
