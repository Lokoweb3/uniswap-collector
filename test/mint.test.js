// node test/mint.test.js — mint / move math and calldata (mint.js), no network.
const assert = require("assert");
const { ethers } = require("ethers");
const M = require("../mint");
const u = require("../univ3");

const Q96 = 2n ** 96n;
const coder = ethers.AbiCoder.defaultAbiCoder();
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", WETH = "0x4200000000000000000000000000000000000006", TOK = "0x76Ed1E2A8Fc3873FcB5c514688Ca2Fe8A3600b7F";
const ME = "0x00000000000000000000000000000000000000AA", POSM = "0x58daec3116aae6d93017baaea7749052e8a04fa7", NPM = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";

// Ticks round outward to the spacing and stay inside the pool's bounds.
assert.strictEqual(M.alignTick(-197809, 200, -1), -198000);
assert.strictEqual(M.alignTick(-197809, 200, +1), -197800);
assert.strictEqual(M.alignTick(123, 60, -1), 120); assert.strictEqual(M.alignTick(123, 60, +1), 180);
assert.strictEqual(M.alignTick(-9999999, 60, -1), Math.ceil(M.MIN_TICK / 60) * 60);
assert.strictEqual(M.alignTick(9999999, 60, +1), Math.floor(M.MAX_TICK / 60) * 60);
// Price -> tick -> price round trip (ETH/USDG: 18 and 6 decimals, ~2568 USDG per ETH is tick -197809).
const t = M.tickFromPrice(2568.6856, 18, 6);
assert.ok(Math.abs(t - (-197809)) <= 1, "tick " + t);
assert.ok(Math.abs(u.priceAtTick(t, 18, 6) - 2568.6856) / 2568.6856 < 2e-4);
assert.throws(() => M.tickFromPrice(0, 18, 6));

// Liquidity for amounts at price 1 in a symmetric range: both sides bind equally.
const sqrtP = Q96, sqrtA = u.getSqrtRatioAtTick(-6000), sqrtB = u.getSqrtRatioAtTick(6000);
const L = M.liquidityForAmounts(sqrtP, sqrtA, sqrtB, 10n ** 18n, 10n ** 18n);
const back = u.getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, L);
assert.ok(back.amount0 <= 10n ** 18n && back.amount0 > (10n ** 18n * 999n) / 1000n, "amount0 " + back.amount0);
assert.ok(back.amount1 <= 10n ** 18n && back.amount1 > (10n ** 18n * 999n) / 1000n, "amount1 " + back.amount1);
// A lopsided deposit: the scarce side binds and the other is mostly unused.
const L2 = M.liquidityForAmounts(sqrtP, sqrtA, sqrtB, 10n ** 18n, 10n ** 16n);
const back2 = u.getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, L2);
assert.ok(back2.amount1 <= 10n ** 16n && back2.amount0 < 2n * 10n ** 16n);
// Out of range: only one side goes in.
assert.strictEqual(u.getAmountsForLiquidity(sqrtP, u.getSqrtRatioAtTick(1000), u.getSqrtRatioAtTick(2000), M.liquidityForAmounts(sqrtP, u.getSqrtRatioAtTick(1000), u.getSqrtRatioAtTick(2000), 10n ** 18n, 0n)).amount1, 0n);
// Rounded-up amounts never come up short.
const up = M.amountsForLiquidityUp(sqrtP, sqrtA, sqrtB, L);
assert.ok(up.amount0 >= back.amount0 + 1n && up.amount1 >= back.amount1 + 1n);
assert.strictEqual(M.withSlippage(10000n, 100, true), 10100n); assert.strictEqual(M.withSlippage(10000n, 100, false), 9900n);

// v4 mint calldata: modifyLiquidities(unlockData, deadline) with MINT_POSITION, SETTLE_PAIR, SWEEP (native side), value = amount0Max.
const key = { currency0: ethers.ZeroAddress, currency1: USDG, fee: 10000, tickSpacing: 200, hooks: ethers.ZeroAddress };
const mint = M.buildV4Mint({ posm: POSM, key, tickLower: -199600, tickUpper: -196000, liquidity: 123456789n, amount0Max: 10n ** 17n, amount1Max: 250n * 10n ** 6n, owner: ME, deadline: 999n });
assert.strictEqual(mint.to, POSM); assert.strictEqual(mint.value, 10n ** 17n);
const posmIface = new ethers.Interface(["function modifyLiquidities(bytes unlockData, uint256 deadline) payable"]);
let dec = posmIface.decodeFunctionData("modifyLiquidities", mint.data);
assert.strictEqual(dec[1], 999n);
let [actions, params] = coder.decode(["bytes", "bytes[]"], dec[0]);
assert.strictEqual(actions, "0x020d14"); assert.strictEqual(params.length, 3);
const mp = coder.decode(["tuple(address,address,uint24,int24,address)", "int24", "int24", "uint256", "uint128", "uint128", "address", "bytes"], params[0]);
assert.strictEqual(mp[0][1], USDG); assert.strictEqual(Number(mp[1]), -199600); assert.strictEqual(Number(mp[2]), -196000); assert.strictEqual(mp[3], 123456789n); assert.strictEqual(mp[4], 10n ** 17n); assert.strictEqual(mp[5], 250n * 10n ** 6n); assert.strictEqual(mp[6], ME); assert.strictEqual(mp[7], "0x");
assert.deepStrictEqual([...coder.decode(["address", "address"], params[1])], [ethers.ZeroAddress, USDG]);
assert.deepStrictEqual([...coder.decode(["address", "address"], params[2])], [ethers.ZeroAddress, ME]);
// ERC-20 / ERC-20 pool: no SWEEP, no value.
const mint2 = M.buildV4Mint({ posm: POSM, key: { ...key, currency0: USDG, currency1: TOK }, tickLower: 0, tickUpper: 200, liquidity: 1n, amount0Max: 1n, amount1Max: 1n, owner: ME, deadline: 1n });
assert.strictEqual(mint2.value, 0n);
[actions] = coder.decode(["bytes", "bytes[]"], posmIface.decodeFunctionData("modifyLiquidities", mint2.data)[0]);
assert.strictEqual(actions, "0x020d");

// v4 close (move step 1): DECREASE_LIQUIDITY + TAKE_PAIR to the owner, same layout as close-position.js.
const close = M.buildV4Close({ posm: POSM, key, tokenId: "2302341", liquidity: 555n, amount0Min: 1n, amount1Min: 2n, owner: ME, deadline: 5n });
dec = posmIface.decodeFunctionData("modifyLiquidities", close.data);
[actions, params] = coder.decode(["bytes", "bytes[]"], dec[0]);
assert.strictEqual(actions, "0x0111"); assert.strictEqual(close.value, 0n);
const cp = coder.decode(["uint256", "uint256", "uint128", "uint128", "bytes"], params[0]);
assert.strictEqual(cp[0], 2302341n); assert.strictEqual(cp[1], 555n); assert.strictEqual(cp[2], 1n); assert.strictEqual(cp[3], 2n);
assert.deepStrictEqual([...coder.decode(["address", "address", "address"], params[1])], [ethers.ZeroAddress, USDG, ME]);

// v3 mint: plain mint() for two ERC-20s; multicall(mint, refundETH) with value when the WETH side is paid as ETH.
const npmIface = new ethers.Interface([
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable",
  "function multicall(bytes[] data) payable", "function refundETH() payable",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable",
]);
const v3 = M.buildV3Mint({ npm: NPM, weth: WETH, token0: TOK, token1: USDG, fee: 3000, tickLower: -60, tickUpper: 60, amount0Desired: 10n, amount1Desired: 20n, amount0Min: 9n, amount1Min: 19n, recipient: ME, deadline: 7n, payEth: true });
assert.strictEqual(v3.value, 0n);
let p3 = npmIface.decodeFunctionData("mint", v3.data)[0];
assert.strictEqual(p3.token0, TOK); assert.strictEqual(p3.fee, 3000n); assert.strictEqual(p3.amount1Desired, 20n); assert.strictEqual(p3.recipient, ME);
const v3e = M.buildV3Mint({ npm: NPM, weth: WETH, token0: WETH, token1: USDG, fee: 500, tickLower: -10, tickUpper: 10, amount0Desired: 10n ** 17n, amount1Desired: 20n, amount0Min: 1n, amount1Min: 1n, recipient: ME, deadline: 7n, payEth: true });
assert.strictEqual(v3e.value, 10n ** 17n);
const calls = npmIface.decodeFunctionData("multicall", v3e.data)[0];
assert.strictEqual(calls.length, 2); assert.strictEqual(calls[1], npmIface.encodeFunctionData("refundETH", []));
assert.strictEqual(npmIface.decodeFunctionData("mint", calls[0])[0].token0, WETH);
// payEth off: the wallet spends WETH it already holds.
assert.strictEqual(M.buildV3Mint({ npm: NPM, weth: WETH, token0: WETH, token1: USDG, fee: 500, tickLower: -10, tickUpper: 10, amount0Desired: 5n, amount1Desired: 20n, amount0Min: 1n, amount1Min: 1n, recipient: ME, deadline: 7n, payEth: false }).value, 0n);

// v3 close (move step 1): one multicall of decreaseLiquidity(all) + collect(max) to the wallet.
const c3 = M.buildV3Close({ npm: NPM, tokenId: "1075870", liquidity: 42n, amount0Min: 1n, amount1Min: 2n, recipient: ME, deadline: 9n });
const cc = npmIface.decodeFunctionData("multicall", c3.data)[0];
const d3 = npmIface.decodeFunctionData("decreaseLiquidity", cc[0])[0], k3 = npmIface.decodeFunctionData("collect", cc[1])[0];
assert.strictEqual(d3.tokenId, 1075870n); assert.strictEqual(d3.liquidity, 42n); assert.strictEqual(d3.deadline, 9n);
assert.strictEqual(k3.recipient, ME); assert.strictEqual(k3.amount0Max, (1n << 128n) - 1n);

// The v4 action bytes match the periphery's Actions library.
assert.deepStrictEqual(M.ACT, { DECREASE_LIQUIDITY: 0x01, MINT_POSITION: 0x02, SETTLE_PAIR: 0x0d, TAKE_PAIR: 0x11, SWEEP: 0x14 });
console.log("mint: tick rounding, price<->tick, liquidity math, v4 mint/close and v3 mint/close calldata — all assertions passed");
