// node test/sell-v4.test.js — v4 sell policy math and router calldata, no network.
const assert = require("assert");
const { ethers } = require("ethers");
const S = require("../sell-v4");

// spot: price 1 (sqrtP = 2^96) -> out == in both ways
const Q96 = 2n ** 96n;
assert.strictEqual(S.spotOut(Q96, true, 1000n), 1000n);
assert.strictEqual(S.spotOut(Q96, false, 1000n), 1000n);
// price 4 (sqrtP = 2 * 2^96): token0 -> token1 gets 4x, token1 -> token0 gets 1/4
assert.strictEqual(S.spotOut(2n * Q96, true, 1000n), 4000n);
assert.strictEqual(S.spotOut(2n * Q96, false, 1000n), 250n);

// impact: with a 1% pool fee, a quote exactly at spot*(1-fee) is 0% impact; 5% below that is 5%
assert.ok(Math.abs(S.impactPct(990n, 1000n, 10000) - 0) < 1e-6);
assert.ok(Math.abs(S.impactPct(9405n, 10000n, 10000) - 5) < 0.01);

(async () => {
  // fitSlice: impact grows 1% per 1000 units; 5000 is 5% -> trimmed to ~3000 under a 3% cap
  const quote = async (amt) => (amt * (10000n - amt / 10n)) / 10000n; // 1000 units -> 1% impact
  const spot = (amt) => amt;
  const fit = await S.fitSlice({ quote, spot, feePips: 0, amount: 5000n, maxImpactPct: 3 });
  assert.ok(fit && fit.amountIn <= 3000n && fit.amountIn >= 2800n, "slice " + (fit && fit.amountIn));
  assert.ok(fit.impactPct <= 3);
  const full = await S.fitSlice({ quote, spot, feePips: 0, amount: 1000n, maxImpactPct: 3 });
  assert.strictEqual(full.amountIn, 1000n);
  const none = await S.fitSlice({ quote: async () => 0n, spot, feePips: 0, amount: 1000n, maxImpactPct: 3 });
  assert.strictEqual(none, null);

  // calldata: the layout the Uniswap app used on this chain (tx 0xf4b88693…, 2026-09-10):
  // V4_SWAP with SWAP_EXACT_IN (extra empty bytes before the amounts), SETTLE(currency, 0, payerIsUser), TAKE(currency, recipient, 0)
  const key = { currency0: ethers.ZeroAddress, currency1: "0x76Ed1E2A8Fc3873FcB5c514688Ca2Fe8A3600b7F", fee: 50000, tickSpacing: 200, hooks: ethers.ZeroAddress };
  const who = "0x00000000000000000000000000000000000000AA";
  const call = S.buildSwapCalldata({ key, zeroForOne: false, amountIn: 10n ** 22n, minOut: 123n, deadline: 999n, recipient: who });
  const iface = new ethers.Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
  const dec = iface.decodeFunctionData("execute", call.data);
  assert.strictEqual(dec[0], "0x10"); assert.strictEqual(dec[2], 999n); assert.strictEqual(call.value, 0n);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const [actions, params] = coder.decode(["bytes", "bytes[]"], dec[1][0]);
  assert.strictEqual(actions, "0x070b0e"); assert.strictEqual(params.length, 3);
  // raw word layout (matches the app's tx): tuple offset, currencyIn, path offset, extra-bytes offset, amountIn, amountOutMinimum
  const words = params[0].slice(2).match(/.{64}/g).map((w) => BigInt("0x" + w));
  assert.strictEqual(words[0], 32n); assert.strictEqual(words[1], BigInt(key.currency1)); assert.strictEqual(words[4], 10n ** 22n); assert.strictEqual(words[5], 123n);
  const [p0] = coder.decode(["tuple(address currencyIn,tuple(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,bytes extra,uint128 amountIn,uint128 amountOutMinimum)"], params[0]);
  assert.strictEqual(p0.path.length, 1); assert.strictEqual(p0.path[0].intermediateCurrency, ethers.ZeroAddress); assert.strictEqual(Number(p0.path[0].fee), 50000); assert.strictEqual(p0.extra, "0x");
  const [settleCur, settleAmt, payerIsUser] = coder.decode(["address", "uint256", "bool"], params[1]);
  assert.strictEqual(settleCur, key.currency1); assert.strictEqual(settleAmt, 0n); assert.strictEqual(payerIsUser, true);
  const [takeCur, takeTo, takeAmt] = coder.decode(["address", "address", "uint256"], params[2]);
  assert.strictEqual(takeCur, ethers.ZeroAddress); assert.strictEqual(takeTo.toLowerCase(), who.toLowerCase()); assert.strictEqual(takeAmt, 0n);
  // selling the native side carries value
  const buy = S.buildSwapCalldata({ key, zeroForOne: true, amountIn: 5n, minOut: 1n, deadline: 1n });
  assert.strictEqual(buy.value, 5n);

  // settings: off unless enabled, hold list lower-cased, defaults
  const st = S.settings({ contracts: { v4: {} }, memecoinSell: { enabled: true, hold: ["LAPTOP"] } });
  assert.ok(st.hold.has("laptop")); assert.strictEqual(st.minUsd, 25); assert.strictEqual(st.maxImpactPct, 3);
  assert.strictEqual(S.settings({}).enabled, false);
  assert.strictEqual(st.nativeQuoteOnly, false, "ERC-20-quoted pools allowed by default");
  console.log("sell-v4: spot, impact, slice fitting, calldata and settings assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
