// node test/claim-fees-core.test.js -- the dependency-free calldata for the browser-wallet "Claim fees" button.
"use strict";
const assert = require("assert");
const { ethers } = require("ethers");
const core = require("../claim-fees-core");

const iface = new ethers.Interface(["function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)", "function ownerOf(uint256) view returns (address)"]);
const MAX = 2n ** 128n - 1n;
const OWNER = "0xaDf94A20558E1E6d64c429F8F9f017169BF3d743";
const expected = (tokenId, owner) => iface.encodeFunctionData("collect", [{ tokenId, recipient: owner, amount0Max: MAX, amount1Max: MAX }]);

// 1. byte-for-byte equal to ethers, for the two real ids and the edges
for (const id of [79371151n, 8905958n, 0n, 2n ** 256n - 1n]) {
  assert.strictEqual(core.collectCalldata({ tokenId: id, owner: OWNER }), expected(id, OWNER), `tokenId ${id}`);
}
assert.strictEqual(core.collectCalldata({ tokenId: "79371151", owner: OWNER.toLowerCase() }), expected(79371151n, OWNER), "digit string, lower-case owner");
assert.strictEqual(core.COLLECT_SELECTOR, iface.getFunction("collect").selector);
assert.strictEqual(core.OWNER_OF_SELECTOR, iface.getFunction("ownerOf").selector);
assert.strictEqual(core.ownerOfCalldata(8905958n), iface.encodeFunctionData("ownerOf", [8905958n]));
assert.strictEqual(core.addressFromWord(ethers.zeroPadValue(OWNER, 32)).toLowerCase(), OWNER.toLowerCase());
assert.strictEqual(core.addressFromWord("0x1234"), null);

// rejects bad input
for (const bad of [
  { tokenId: 1n, owner: "0x123" }, { tokenId: 1n, owner: "" }, { tokenId: 1n }, { tokenId: 1n, owner: 5 },
  { tokenId: -1n, owner: OWNER }, { tokenId: 2n ** 256n, owner: OWNER }, { tokenId: 1.5, owner: OWNER }, { tokenId: "1.5", owner: OWNER },
  { tokenId: "abc", owner: OWNER }, { tokenId: "", owner: OWNER }, { tokenId: null, owner: OWNER }, { owner: OWNER }, { tokenId: "9".repeat(80), owner: OWNER },
]) assert.throws(() => core.collectCalldata(bad), `rejects ${JSON.stringify(bad, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
assert.throws(() => core.collectCalldata(), "no argument");

// 2. extra fields have no effect
const base = core.collectCalldata({ tokenId: 5n, owner: OWNER });
assert.strictEqual(core.collectCalldata({ tokenId: 5n, owner: OWNER, recipient: "0x000000000000000000000000000000000000dEaD", amount0Max: 1n, amount1Max: 1n, manager: "0x1" }), base);
assert.strictEqual(core.collectCalldata.length, 1, "one parameter");

// helpers
assert.ok(core.sameAddress(OWNER, OWNER.toLowerCase()) && !core.sameAddress(OWNER, "0x000000000000000000000000000000000000dEaD") && !core.sameAddress(OWNER, "nope"));
assert.ok(core.isTxHash("0x" + "ab".repeat(32)) && !core.isTxHash('0x"><script>') && !core.isTxHash("0x" + "ab".repeat(31)));
assert.strictEqual(core.safeExplorer("https://basescan.org/"), "https://basescan.org");
for (const bad of ["javascript:alert(1)", "http://basescan.org", "https://x.org/\"><script>", "//x.org", null, 'https://a b.org']) assert.strictEqual(core.safeExplorer(bad), null, String(bad));
assert.strictEqual(core.shortAddr(OWNER), "0xaDf9...d743");
console.log("claim-fees-core tests passed");
