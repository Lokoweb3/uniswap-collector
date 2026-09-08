// node test/token-health.test.js — scoring, ABI and bytecode scanning with mock data.
const assert = require("assert");
const { ethers } = require("ethers");
const { score, scanBytecode, scanAbi } = require("../token-health");

// 1. NET-like token: tax on, mint, guardian, verified → Risk with the tax + guardian notes.
let s = score({ verified: true, holders: 7000, ageDays: 40, powers: { mint: ["mint(address,uint256)"], tax: ["taxEnabled()"], admin: ["guardian()"] }, live: { taxEnabled: true, guardian: "0x00000000000000000000000000000000000000aa" } });
assert.strictEqual(s.level, "risk");
assert.ok(s.notes.includes("transfer tax on"), "tax note");
assert.ok(s.notes.includes("guardian role"), "guardian note");
assert.ok(s.notes.includes("mint function"));

// 2. Plain verified token, old, many holders → Safe.
s = score({ verified: true, holders: 5000, ageDays: 120, powers: {}, live: {} });
assert.strictEqual(s.level, "safe");
assert.deepStrictEqual(s.notes, ["verified, no admin powers found"]);

// 3. Owner-controlled with pause but not paused → Caution.
s = score({ verified: true, holders: 900, ageDays: 60, powers: { pause: ["pause()", "paused()"], admin: ["owner()"] }, live: { owner: "0x00000000000000000000000000000000000000bb", paused: false } });
assert.strictEqual(s.level, "caution");
assert.ok(s.notes.includes("pausable") && s.notes.includes("owner-controlled"));

// 4. Paused right now → Risk.
s = score({ verified: true, holders: 900, ageDays: 60, powers: { pause: ["pause()"] }, live: { paused: true } });
assert.strictEqual(s.level, "risk");

// 5. Unverified with mint → Risk; unverified without powers → Caution.
assert.strictEqual(score({ verified: false, holders: 300, ageDays: 20, powers: { mint: ["mint(uint256)"] }, live: {} }).level, "risk");
assert.strictEqual(score({ verified: false, holders: 300, ageDays: 60, powers: {}, live: {} }).level, "caution");

// 6. Very new with few holders → Risk; new but popular → Caution.
assert.strictEqual(score({ verified: true, holders: 20, ageDays: 1, powers: {}, live: {} }).level, "risk");
assert.strictEqual(score({ verified: true, holders: 5000, ageDays: 1, powers: {}, live: {} }).level, "caution");

// 7. Pinned core token → Safe regardless.
s = score({ verified: false, holders: 1, ageDays: 0.1, powers: { mint: ["mint(address,uint256)"] }, live: {}, pinnedSafe: true });
assert.strictEqual(s.level, "safe");

// 8. Metadata unavailable is not treated as unverified.
s = score({ verified: null, metaOk: false, holders: null, ageDays: null, powers: {}, live: {} });
assert.strictEqual(s.level, "safe");
assert.ok(s.notes.includes("verification unknown"));

// 9. Bytecode selector scan: fabricate a "dispatcher" with PUSH4 selectors.
const sel = (sig) => ethers.id(sig).slice(2, 10);
const fakeCode = "0x6080604052" + "63" + sel("mint(address,uint256)") + "14" + "63" + sel("paused()") + "14" + "63" + sel("owner()") + "5b";
const found = scanBytecode(fakeCode);
assert.deepStrictEqual(found.mint, ["mint(address,uint256)"]);
assert.deepStrictEqual(found.pause, ["paused()"]);
assert.deepStrictEqual(found.admin, ["owner()"]);
assert.strictEqual(found.tax, undefined);
assert.deepStrictEqual(scanBytecode("0x"), {});

// 10. ABI scan: names win, tax patterns matched, feeGrowth-style names ignored.
const abi = [
  { type: "function", name: "mintTokens", inputs: [{ type: "address" }, { type: "uint256" }] },
  { type: "function", name: "setBuyTax", inputs: [{ type: "uint256" }] },
  { type: "function", name: "feeGrowthGlobal0X128", inputs: [] },
  { type: "function", name: "transferOwnership", inputs: [{ type: "address" }] },
  { type: "function", name: "blacklist", inputs: [{ type: "address" }] },
];
const fa = scanAbi(abi);
assert.deepStrictEqual(fa.mint, ["mintTokens(address,uint256)"]);
assert.deepStrictEqual(fa.tax, ["setBuyTax(uint256)"]);
assert.deepStrictEqual(fa.admin, ["transferOwnership(address)"]);
assert.deepStrictEqual(fa.blacklist, ["blacklist(address)"]);

console.log("token-health: scoring, bytecode and ABI scans — all assertions passed");
