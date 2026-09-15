// node test/close-position.test.js — the fund-path v3 close:
//  1. closeV3 sends ONE multicall carrying decreaseLiquidity + collect in that order,
//     with collect's recipient = the position OWNER (never the operator), so the
//     collector's collect(MAX_UINT128) can't slip between them and take principal.
//  2. lockCollector defers when the collector holds .collector.lock (acquired == null)
//     and re-acquires once it is released.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { buildV3CloseCalldatas, lockCollector } = require("../close-position");
const { ethers } = require("ethers");

const NPM_IFACE = new ethers.Interface([
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256 amount0,uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256 amount0,uint256 amount1)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);
const MAX_U128 = (1n << 128n) - 1n;

// 1. buildV3CloseCalldatas encodes exactly two calls, in order, to the OWNER.
{
  const owner = "0x00000000000000000000000000000000000000aa";
  const calldatas = buildV3CloseCalldatas({
    tokenId: "42", liquidity: 1000n,
    amount0Min: 990n, amount1Min: 980n,
    amount0Max: MAX_U128, amount1Max: MAX_U128,
    deadline: 1_800_000_000, owner,
  });
  assert.strictEqual(calldatas.length, 2, "exactly two calldatas in one multicall");

  // First: decreaseLiquidity(all), the whole liquidity with minus-1% mins.
  const d0 = NPM_IFACE.parseTransaction({ data: calldatas[0] });
  assert.strictEqual(d0.name, "decreaseLiquidity");
  assert.strictEqual(d0.args[0].tokenId, 42n);
  assert.strictEqual(d0.args[0].liquidity, 1000n, "decreases the FULL liquidity");
  assert.strictEqual(d0.args[0].amount0Min, 990n);
  assert.strictEqual(d0.args[0].amount1Min, 980n);

  // Second: collect(max) straight to the OWNER, not the operator.
  const d1 = NPM_IFACE.parseTransaction({ data: calldatas[1] });
  assert.strictEqual(d1.name, "collect");
  assert.strictEqual(d1.args[0].tokenId, 42n);
  assert.strictEqual(d1.args[0].recipient.toLowerCase(), owner, "collect pays the position's owner");
  assert.strictEqual(d1.args[0].amount0Max, MAX_U128);
  assert.strictEqual(d1.args[0].amount1Max, MAX_U128);

  // The two are wrapped by the caller in NPM.multicall([...]) in this exact order.
  const mc = NPM_IFACE.encodeFunctionData("multicall", [calldatas]);
  const m = NPM_IFACE.parseTransaction({ data: mc });
  assert.strictEqual(m.name, "multicall");
  assert.deepStrictEqual(Array.from(m.args[0]), calldatas, "multicall wraps both, order preserved");
}

// 2. lockCollector defers while the collector holds the lock, acquires when free.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-"));
  fs.writeFileSync(path.join(dir, ".collector.lock"), "");

  // Free lock -> acquired.
  return (async () => {
    const free = await lockCollector({ dir });
    assert.strictEqual(typeof free, "function", "free lock is acquired");
    free();
    await new Promise((r) => setTimeout(r, 150));

    // Collector's lock (fd-9 flock, exactly like run-collector.sh) -> deferred.
    const lockFile = path.join(dir, ".collector.lock");
    const holder = spawn("bash", ["-c", `exec 9>"${lockFile}"; flock -n 9; echo HELD; sleep 30`], { stdio: ["ignore", "ignore", "ignore"] });
    await new Promise((r) => setTimeout(r, 250));
    const held = await lockCollector({ dir });
    assert.strictEqual(held, null, "close defers while the collector holds the lock (no waiting, no nonce race)");
    holder.kill();
    await new Promise((r) => setTimeout(r, 300));

    // Released -> acquired again.
    const again = await lockCollector({ dir });
    assert.strictEqual(typeof again, "function", "re-acquires once the collector releases");
    again();
  })().then(() => console.log("close-position: v3 multicall closes to the owner in one tx + lock defers under the collector's lock"));
}
