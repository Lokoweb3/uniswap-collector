/**
 * Auto-compound: put collected fees back into the position they came from.
 *
 * Used by the collector's --compound flag. Per in-range position the vault's
 * share (feeSplitPct % of each fee token) is left to the normal swap-and-sweep
 * pipeline, which then delivers all of its USDG output to the LOKOVault; the
 * remaining share of both tokens is added back to the same position. Whatever
 * the increase cannot use (the unbalanced side) is sent to the owner as-is.
 *
 * v3: NonfungiblePositionManager.increaseLiquidity after exact-amount
 * approvals. v4: the PositionManager settles through Permit2 and native ETH,
 * which the operator has no allowances for; v4 positions are reported as
 * "not compounded" and their fees go through the normal sweep instead.
 * Every attempt is logged to compound-log.json.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const LOG_FILE = path.join(__dirname, "compound-log.json");
const NPM_INCREASE_ABI = [
  "function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

function appendLog(entry) {
  let rows = [];
  try {
    rows = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
  } catch {}
  rows.push(entry);
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(rows, null, 1));
  } catch {}
}

/** Split each fee token into the vault's share and the share to reinvest. */
function plan(sim, splitPct) {
  const bp = BigInt(Math.round((splitPct || 0) * 100));
  const v0 = (sim.amount0 * bp) / 10000n, v1 = (sim.amount1 * bp) / 10000n;
  return {
    tokenId: String(sim.tokenId),
    version: sim.version === 4 ? 4 : 3,
    vault0: v0,
    vault1: v1,
    reinvest0: sim.amount0 - v0,
    reinvest1: sim.amount1 - v1,
    t0: sim.t0,
    t1: sim.t1,
    inRange: sim.inRange !== false,
  };
}

/**
 * Reinvest `plan.reinvest0/1` into the v3 position. Returns
 * { ok, liquidity, used0, used1, leftover0, leftover1, txHash } and sends the
 * leftovers to `owner`.
 */
async function compoundV3({ wallet, npmAddress, plan: pl, owner, log = () => {}, slippageBps = 100n }) {
  const npm = new ethers.Contract(npmAddress, NPM_INCREASE_ABI, wallet);
  const res = { tokenId: pl.tokenId, ok: false, txHash: null, used0: 0n, used1: 0n, leftover0: 0n, leftover1: 0n, liquidity: 0n };
  if (pl.reinvest0 === 0n && pl.reinvest1 === 0n) return { ...res, ok: true, note: "nothing to reinvest" };
  for (const [t, amt] of [[pl.t0, pl.reinvest0], [pl.t1, pl.reinvest1]]) {
    if (amt === 0n) continue;
    const c = new ethers.Contract(t.address, ERC20_ABI, wallet);
    const allowance = await c.allowance(wallet.address, npmAddress);
    if (allowance < amt) {
      const atx = await c.approve(npmAddress, amt);
      log(`approve ${t.symbol} for increaseLiquidity -> ${atx.hash}`);
      await atx.wait();
    }
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  // The manager takes what the current ratio allows; the minimums only guard
  // against a price move between quote and inclusion.
  const min = (x) => (x * (10000n - slippageBps)) / 10000n;
  const args = { tokenId: BigInt(pl.tokenId), amount0Desired: pl.reinvest0, amount1Desired: pl.reinvest1, amount0Min: 0n, amount1Min: 0n, deadline };
  // Which side binds is unknown up front, so mins stay at zero but the static
  // call below rejects a reverting increase before anything is sent.
  const sim = await npm.increaseLiquidity.staticCall(args);
  res.liquidity = sim.liquidity;
  res.used0 = sim.amount0;
  res.used1 = sim.amount1;
  if (sim.amount0 < min(pl.reinvest0) && sim.amount1 < min(pl.reinvest1)) {
    return { ...res, note: "increase would use almost nothing (price outside the range?)" };
  }
  const tx = await npm.increaseLiquidity(args);
  log(`compound #${pl.tokenId}: increaseLiquidity ${ethers.formatUnits(pl.reinvest0, pl.t0.decimals)} ${pl.t0.symbol} + ${ethers.formatUnits(pl.reinvest1, pl.t1.decimals)} ${pl.t1.symbol} -> ${tx.hash}`);
  const rcpt = await tx.wait();
  res.txHash = tx.hash;
  res.ok = true;
  res.gasUsed = rcpt.gasUsed * rcpt.gasPrice;
  // Leftovers (the unbalanced side) go to the owner untouched.
  res.leftover0 = pl.reinvest0 - res.used0;
  res.leftover1 = pl.reinvest1 - res.used1;
  for (const [t, amt] of [[pl.t0, res.leftover0], [pl.t1, res.leftover1]]) {
    if (amt <= 0n) continue;
    try {
      const c = new ethers.Contract(t.address, ERC20_ABI, wallet);
      const held = await c.balanceOf(wallet.address);
      const send = held < amt ? held : amt;
      if (send > 0n) {
        const ttx = await c.transfer(owner, send);
        log(`  leftover ${ethers.formatUnits(send, t.decimals)} ${t.symbol} -> ${owner} -> ${ttx.hash}`);
        await ttx.wait();
      }
    } catch (err) {
      log(`  ! leftover transfer failed for ${t.symbol}: ${err.shortMessage || err.message}`);
    }
  }
  return res;
}

module.exports = { plan, compoundV3, appendLog, NPM_INCREASE_ABI };
