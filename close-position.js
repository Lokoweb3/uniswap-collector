/**
 * Close a liquidity position: withdraw all liquidity and pay everything,
 * principal and fees, to the position's OWNER wallet. The operator only signs;
 * nothing is ever paid to it.
 *
 *   closeV4({ provider, cfg, tokenId, owner, wallet })  Uniswap v4 PositionManager
 *   closeV3({ provider, cfg, tokenId, owner, wallet })  v3 NonfungiblePositionManager
 *   dryRun(...)                                           eth_call as `from`, no key
 *
 * Both static-call the exact transaction first and refuse to send if it would
 * revert. Amount minimums are the current amounts minus 1% (slippage guard).
 *
 * The operator key comes from the keystore, decrypted with the passphrase the
 * collector's RAM cache holds while the collector is armed
 * (/dev/shm/.lp-collector-<uid>, see run-collector.sh); `operatorWallet()`
 * returns null when not armed.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { ethers } = require("ethers");
const v4 = require("./univ4");
const u = require("./univ3");

const ACTION_DECREASE_LIQUIDITY = 0x01;
const ACTION_TAKE_PAIR = 0x11;
const MAX_UINT128 = (1n << 128n) - 1n;

const POSM_ABI = [...v4.POSM_ABI, "function modifyLiquidities(bytes unlockData, uint256 deadline) payable"];
const NPM_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function ownerOf(uint256 tokenId) view returns (address)",
];

const minus1pct = (x) => (x * 99n) / 100n;
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);

/** Operator signer from the keystore + armed RAM cache; null when the collector is locked. */
async function operatorWallet(provider) {
  const cache = `/dev/shm/.lp-collector-${process.getuid()}`;
  try {
    const ttl = Number(fs.readFileSync(`${cache}.ttl`, "utf8"));
    if (!(ttl > Date.now() / 1000)) return null;
    const pass = fs.readFileSync(cache, "utf8");
    const ksPath = process.env.LP_KEYSTORE_PATH || path.join(process.env.HOME || "", ".lp-collector", "operator-keystore.json");
    const w = await ethers.Wallet.fromEncryptedJson(fs.readFileSync(ksPath, "utf8"), pass);
    return w.connect(provider);
  } catch {
    return null;
  }
}

/** Build the v4 close: decrease the whole liquidity, then take both currencies to `owner`. */
async function buildV4({ provider, cfg, tokenId, owner }) {
  const posm = new ethers.Contract(cfg.contracts.v4.positionManager, POSM_ABI, provider);
  const stateView = new ethers.Contract(cfg.contracts.v4.stateView, v4.STATE_VIEW_ABI, provider);
  const p = await v4.loadPosition({ provider, posm, stateView, cfg: { ...cfg, ownerAddress: owner } }, tokenId);
  if (p.gone) throw new Error(`#${tokenId} is not owned by ${owner}`);
  if (p.closed) throw new Error(`#${tokenId} has no liquidity`);
  const { key } = await posm.getPoolAndPositionInfo(BigInt(tokenId));
  const liquidity = BigInt(p.liquidity);
  const a0 = BigInt(p.amounts.amount0), a1 = BigInt(p.amounts.amount1);
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const actions = ethers.concat([new Uint8Array([ACTION_DECREASE_LIQUIDITY]), new Uint8Array([ACTION_TAKE_PAIR])]);
  const params = [
    abi.encode(["uint256", "uint256", "uint128", "uint128", "bytes"], [BigInt(tokenId), liquidity, minus1pct(a0), minus1pct(a1), "0x"]),
    abi.encode(["address", "address", "address"], [key.currency0, key.currency1, owner]),
  ];
  const unlockData = abi.encode(["bytes", "bytes[]"], [actions, params]);
  return { posm, unlockData, position: p, expect: { amount0: a0 + BigInt(p.fees.amount0), amount1: a1 + BigInt(p.fees.amount1) } };
}

/** eth_call the v4 close as `from` (owner or approved operator). No key needed. */
async function dryRunV4({ provider, cfg, tokenId, owner, from }) {
  const { posm, unlockData, position, expect } = await buildV4({ provider, cfg, tokenId, owner });
  try {
    await posm.modifyLiquidities.staticCall(unlockData, deadline(), { from: from || owner });
    const gas = await provider.estimateGas({ from: from || owner, to: posm.target, data: posm.interface.encodeFunctionData("modifyLiquidities", [unlockData, deadline()]) }).catch(() => null);
    // The exact bytes that passed, handed back so the caller can send those rather
    // than build a second set.
    return { ok: true, gas, expect, position, posm, unlockData };
  } catch (err) {
    return { ok: false, error: err.shortMessage || err.message, position };
  }
}

/** Send the v4 close from the operator wallet. Returns { hash, block, amounts } on success. */
async function closeV4({ provider, cfg, tokenId, owner, wallet }) {
  const dry = await dryRunV4({ provider, cfg, tokenId, owner, from: wallet.address });
  if (!dry.ok) throw new Error(`close would revert: ${dry.error}`);
  // The dry run's own calldata, not a rebuild. buildV4 reads the position's current
  // liquidity and fees, so a second build between the check and the send produces
  // different amounts -- fees accrue every block -- and what was sent was never the
  // thing that was proven not to revert.
  const { posm, unlockData, position, expect } = dry;
  const tx = await posm.connect(wallet).modifyLiquidities(unlockData, deadline());
  const rcpt = await tx.wait();
  return { hash: tx.hash, block: rcpt.blockNumber, gasWei: rcpt.gasUsed * rcpt.gasPrice, expect, position };
}

/**
 * Build the two v3 close calldatas for one atomic multicall (see `closeV3`).
 * Pure: no chain calls. Exported so the test can assert the exact calldatas and
 * their order without a live RPC.
 *
 *   calldatas[0] = decreaseLiquidity({ tokenId, liquidity, amount0Min, amount1Min, deadline })
 *   calldatas[1] = collect({ tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 })
 */
function buildV3CloseCalldatas({ tokenId, liquidity, amount0Min, amount1Min, amount0Max = MAX_UINT128, amount1Max = MAX_UINT128, deadline, owner }) {
  const npmIface = new ethers.Interface(NPM_ABI);
  return [
    npmIface.encodeFunctionData("decreaseLiquidity", [{ tokenId: BigInt(tokenId), liquidity, amount0Min, amount1Min, deadline }]),
    npmIface.encodeFunctionData("collect", [{ tokenId: BigInt(tokenId), recipient: owner, amount0Max, amount1Max }]),
  ];
}

/**
 * v3: decrease 100% then collect everything to the owner, in ONE multicall so the
 * two steps can never be interleaved by the collector's own collect(MAX_UINT128)
 * landing between them and taking principal + fees to the operator. The same
 * layout mint.js' buildV3Close already uses for the move flow: one signature,
 * one transaction, both calldatas atomic.
 *
 * multicall calldata order (encoded by buildV3CloseCalldatas):
 *   1. decreaseLiquidity({ tokenId, liquidity, amount0Min, amount1Min, deadline })
 *   2. collect({ tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 })
 * Inside one multicall on NonfungiblePositionManager the decrease is applied first and
 * its owed balances are then collectable, so fees (and the just-freed principal) all
 * leave to the OWNER - never to the operator.
 */
async function closeV3({ provider, cfg, tokenId, owner, wallet, dryRun = false }) {
  const npm = new ethers.Contract(cfg.contracts.positionManager, NPM_ABI, provider);
  const pos = await npm.positions(BigInt(tokenId));
  if ((await npm.ownerOf(BigInt(tokenId))).toLowerCase() !== owner.toLowerCase()) throw new Error(`#${tokenId} is not owned by ${owner}`);
  if (pos.liquidity === 0n) throw new Error(`#${tokenId} has no liquidity`);
  const factory = new ethers.Contract(cfg.contracts.factory, ["function getPool(address,address,uint24) view returns (address)"], provider);
  const poolAddr = await factory.getPool(pos.token0, pos.token1, pos.fee);
  const pool = new ethers.Contract(poolAddr, u.POOL_ABI, provider);
  const slot0 = await pool.slot0();
  const { amount0, amount1 } = u.getAmountsForLiquidity(slot0.sqrtPriceX96, u.getSqrtRatioAtTick(Number(pos.tickLower)), u.getSqrtRatioAtTick(Number(pos.tickUpper)), pos.liquidity);
  const from = wallet ? wallet.address : owner;
  const calldatas = buildV3CloseCalldatas({
    tokenId, liquidity: pos.liquidity,
    amount0Min: minus1pct(amount0), amount1Min: minus1pct(amount1),
    deadline: deadline(), owner,
  });
  // dry-run the whole multicall exactly as sent (as `from`), so a revert (e.g. a
  // blocklist or a stale slippage) blocks the send the same way the old two-step path did.
  await npm.multicall.staticCall(calldatas, { from });
  if (dryRun || !wallet) return { ok: true, dryRun: true, expect: { amount0, amount1 } };
  const w = npm.connect(wallet);
  const tx = await w.multicall(calldatas);
  const rcpt = await tx.wait();
  return { hash: tx.hash, block: rcpt.blockNumber, gasWei: rcpt.gasUsed * rcpt.gasPrice, expect: { amount0, amount1 } };
}

/*
 * Try to hold the SAME exclusive lock the collector takes in run-collector.sh
 * (`.collector.lock`, flock(2)-ed on fd 9, non-blocking). We replicate that exact
 * shell dance in a child: `exec 9> file; flock -n 9`, then hold the child (and
 * thus the fd + lock) until release. `flock -n` fails immediately (exit 1)
 * when the collector already holds the lock — so we can tell acquired vs deferred
 * with no waiting and no race on the operator's nonce.
 *
 * Resolves to a release function when the lock is acquired, or null when the
 * collector holds it (the caller retries on the next guardian cycle). Never waits.
 */
function lockCollector({ dir = __dirname } = {}) {
  const lockFile = path.join(dir, ".collector.lock");
  return new Promise((resolve) => {
    try {
      fs.closeSync(fs.openSync(lockFile, "a"));
    } catch (_) {
      resolve(null);
      return;
    }
    // Holding the lock with `exec sleep 3600` outlived the process that wanted it:
    // the release below kills the child, but a SIGKILLed Node never runs it, and the
    // collector stayed blocked for up to an hour with nothing holding it on purpose.
    //
    // The child now waits on a pipe this process holds open. Releasing closes it and
    // `read` returns at once; if this process dies by any means, including SIGKILL,
    // the kernel closes the pipe and the child sees the same EOF. A polling loop on
    // the parent would also survive a kill, but bash defers a signal until its
    // foreground `sleep` returns, which made an ordinary release take seconds.
    const shell = `exec 9>"$1"; if flock -n 9; then echo LOCKED; read -r _ <&0; else exit 1; fi`;
    const child = execFile("/bin/bash", ["-c", shell, "bash", lockFile], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("LOCKED")) resolve(() => {
        // Closing the pipe is the release; the kill is belt and braces for a child
        // that has somehow stopped reading.
        try { child.stdin.end(); } catch (_) {}
        try { child.kill(); } catch (_) {}
      });
    });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => { if (code !== 0 && !out.includes("LOCKED")) resolve(null); });
    child.unref();
  });
}

module.exports = { operatorWallet, buildV4, dryRunV4, closeV4, closeV3, buildV3CloseCalldatas, lockCollector };

