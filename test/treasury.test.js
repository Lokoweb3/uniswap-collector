// node test/treasury.test.js — the split percentage in force survives a failed on-chain read.
const assert = require("assert");
const { ethers } = require("ethers");
const { effectiveSettings } = require("../treasury");
const NFT = "0x00000000000000000000000000000000000000f1", TBA = "0x00000000000000000000000000000000000000f2";
const cfg = { treasuryNFT: NFT, treasuryTBA: TBA, feeSplitPct: 10, feeSplitMax: 20 };
const twenty = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [20]);
let fail = false;
const runner = { call: async () => { if (fail) throw new Error("server response 403 Forbidden"); return twenty; } };
(async () => {
  let s = await effectiveSettings(cfg, runner);
  assert.strictEqual(s.pct, 20); assert.strictEqual(s.pctSource, "on-chain"); assert.strictEqual(s.enabled, true);
  // The RPC refuses: the last on-chain value stays in force, marked as cached, not the config default.
  fail = true;
  s = await effectiveSettings(cfg, runner);
  assert.strictEqual(s.pct, 20); assert.strictEqual(s.pctSource, "on-chain (cached)"); assert.ok(s.pctReadAt > 0);
  // A vault never read successfully falls back to settings.json.
  s = await effectiveSettings({ ...cfg, treasuryNFT: "0x00000000000000000000000000000000000000f9" }, runner);
  assert.strictEqual(s.pct, 10); assert.strictEqual(s.pctSource, "config");
  // No NFT configured: settings.json, capped by feeSplitMax.
  s = await effectiveSettings({ treasuryTBA: TBA, feeSplitPct: 50, feeSplitMax: 20 }, runner);
  assert.strictEqual(s.pct, 20); assert.strictEqual(s.pctSource, "config");
  console.log("treasury: on-chain split cached across failed reads, config fallback only when never read — all assertions passed");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
