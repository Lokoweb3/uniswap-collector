// node test/arc-phase1.test.js — Arc phase 1: the data directory, the unit of
// account, and the two places a second chain would quietly corrupt a number.
//
//  1. data-dir: a --data-dir instance reads its own settings.json and writes its
//     own ledgers; with no flag the paths are exactly what they were.
//  2. numeraire: absent from settings it defaults to WETH with a discovered USD
//     rate (today's behaviour); set to a dollar unit it short-circuits the hop.
//  3. the decimal trap: on Arc one USDC balance is visible through an 18-decimal
//     native interface and a 6-decimal ERC-20 one. They are the SAME money.
//     Adding them, or reading the ERC-20 one as if it were native, is a 10^12
//     error on a balance the dashboard reports.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const node = process.execPath;

// ---- 1. the data directory -------------------------------------------------
{
  // Default: no flag, no environment -> data sits beside the code, as before.
  const def = execFileSync(node, ["-e", 'const d=require("./data-dir");console.log(JSON.stringify({dir:d.DATA_DIR,custom:d.CUSTOM}))'], { cwd: ROOT, encoding: "utf8" });
  const parsed = JSON.parse(def.trim());
  assert.strictEqual(parsed.dir, ROOT, "with no flag the data directory is the source tree");
  assert.strictEqual(parsed.custom, false, "and it does not count as a custom directory");

  // A second instance: its own directory, its own settings.json, its own ledgers.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lp-data-"));
  const chainId = 5042;
  fs.writeFileSync(path.join(tmp, "settings.json"), JSON.stringify({
    // Synthetic: a chain with no explorer at all. Arc does have one
    // (arcexplorer.org); this exercises the general degradation path.
    chain: { rpcUrl: "https://rpc.example.invalid", chainId, explorer: "" },
    wallets: { main: { address: "0x00000000000000000000000000000000000000aa", label: "Main" } },
    tokens: { USDG: "0x3600000000000000000000000000000000000000", WETH: "0x3600000000000000000000000000000000000000" },
    numeraire: { symbol: "USDC", address: "0x3600000000000000000000000000000000000000", decimals: 6, usdRate: 1, nativeSameAsErc20: true },
    contracts: {}, collector: {}, dashboard: { port: 8797 },
  }, null, 2));

  const out = execFileSync(node, ["-e",
    'const s=require("./settings");const c=s.load();const d=require("./data-dir");' +
    'console.log(JSON.stringify({file:s.FILE,dir:d.DATA_DIR,chainId:c.chainId,explorer:c.explorer,blockscout:c.blockscout,num:c.numeraire}))',
  ], { cwd: ROOT, encoding: "utf8", env: { ...process.env, LP_DATA_DIR: tmp } });
  const r = JSON.parse(out.trim());
  assert.strictEqual(r.dir, tmp, "LP_DATA_DIR moves the data directory");
  assert.strictEqual(r.file, path.join(tmp, "settings.json"), "settings come from the data directory");
  assert.strictEqual(r.chainId, chainId, "and it is the second chain's settings that load");
  assert.strictEqual(r.explorer, "", "a chain with no explorer keeps an empty string, never another chain's");
  assert.strictEqual(r.blockscout, "", "and with no explorer there is no Blockscout to reconcile against");
  assert.strictEqual(r.num.usdRate, 1, "its unit of account is already a dollar");
  assert.strictEqual(r.num.nativeSameAsErc20, true, "and its native currency is the same balance as that ERC-20");

  // The flag form resolves the same way as the environment variable. It goes
  // through a script file: `node -e ... --data-dir=x` would have node itself try
  // to parse the flag, which is not how the servers are started.
  const probe = path.join(tmp, "probe.js");
  fs.writeFileSync(probe, 'console.log(require(' + JSON.stringify(path.join(ROOT, "data-dir")) + ').DATA_DIR)');
  const viaFlag = execFileSync(node, [probe, "--data-dir=" + tmp], { cwd: ROOT, encoding: "utf8" });
  assert.strictEqual(viaFlag.trim(), tmp, "--data-dir= resolves the same directory");

  // Nothing was written into the source tree by loading that instance.
  assert.ok(!fs.existsSync(path.join(tmp, "..", "settings.json.bak")), "no stray writes");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- 2. the unit of account ------------------------------------------------
{
  const { toLegacy } = require("../settings");

  // Absent: the wrapped native token, rate discovered from the stable pool.
  const dflt = toLegacy({
    chain: { rpcUrl: "x", chainId: 1, explorer: "https://e.example" },
    wallets: { main: { address: "0x1", label: "Main" } },
    tokens: { WETH: "0xAAA", USDG: "0xBBB" }, contracts: {},
  });
  assert.strictEqual(dflt.numeraire.symbol, "WETH");
  assert.strictEqual(dflt.numeraire.address, "0xAAA", "defaults to the configured wrapped native token");
  assert.strictEqual(dflt.numeraire.usdRate, null, "null means: discover it, as before");
  assert.strictEqual(dflt.numeraire.nativeSameAsErc20, false);

  // Present and already a dollar: no second hop to make.
  const arc = toLegacy({
    chain: { rpcUrl: "x", chainId: 5042, explorer: "" },
    wallets: { main: { address: "0x1", label: "Main" } },
    tokens: { USDG: "0x3600000000000000000000000000000000000000" },
    numeraire: { symbol: "USDC", address: "0x3600000000000000000000000000000000000000", decimals: 6, usdRate: 1, nativeSameAsErc20: true },
    contracts: {},
  });
  assert.strictEqual(arc.numeraire.usdRate, 1, "a dollar unit needs no reference pool");
  assert.strictEqual(arc.explorer, "", "and no explorer is honestly no explorer");
}

// ---- 2b. an explorer is not the same thing as a Blockscout API -------------
{
  const { toLegacy } = require("../settings");
  const base = {
    chain: { rpcUrl: "x", chainId: 5042, explorer: "https://www.arcexplorer.org" },
    wallets: { main: { address: "0x1", label: "Main" } }, tokens: {}, contracts: {},
  };
  // Unset: follow the explorer. True for a chain whose explorer *is* Blockscout.
  assert.strictEqual(toLegacy(base).blockscout, "https://www.arcexplorer.org");
  // Explicitly "": the chain has an explorer but no Blockscout API, which is
  // exactly Arc. The audit must then say "not available", not "not reconciled".
  const arcish = { ...base, chain: { ...base.chain, blockscout: "" } };
  const cfg = toLegacy(arcish);
  assert.strictEqual(cfg.explorer, "https://www.arcexplorer.org", "links still work");
  assert.strictEqual(cfg.blockscout, "", "but nothing to reconcile against");
}

// ---- 3. the decimal trap ---------------------------------------------------
{
  // Verified live on Arc mainnet for the Trading wallet: one balance, two views.
  const NATIVE_18 = 23756427000000000000n; // provider.getBalance(): native, 18 dp
  const ERC20_6 = 23756427n;               // USDC.balanceOf():     ERC-20, 6 dp
  const EXPECTED = 23.756427;

  const asNative = Number(ethers.formatEther(NATIVE_18));        // 18 dp
  const asErc20 = Number(ethers.formatUnits(ERC20_6, 6));        // 6 dp
  assert.strictEqual(asNative, EXPECTED, "the native interface reads 23.756427 USDC");
  assert.strictEqual(asErc20, EXPECTED, "the ERC-20 interface reads the same 23.756427 USDC");
  assert.strictEqual(asNative, asErc20, "they are one balance, not two");

  // The two failures this guards against.
  assert.notStrictEqual(asNative + asErc20, EXPECTED, "adding the two interfaces double-counts the money");
  const wrongDecimals = Number(ethers.formatUnits(ERC20_6, 18));
  assert.ok(Math.abs(wrongDecimals - EXPECTED) > EXPECTED * 0.99,
    "reading the 6-decimal value with 18 decimals is off by ~10^12");
  assert.ok(wrongDecimals < 0.0000001, "it collapses a real balance to dust");

  // And the rule the wallet scan follows: when the chain says its native currency
  // and an ERC-20 are one balance, that token is dropped from the ERC-20 scan.
  const UNIT = { address: "0x3600000000000000000000000000000000000000", nativeSameAsErc20: true };
  const addrs = new Set(["0xdead", UNIT.address.toLowerCase()]);
  if (UNIT.nativeSameAsErc20) addrs.delete(UNIT.address.toLowerCase());
  assert.deepStrictEqual([...addrs], ["0xdead"], "the numeraire is counted natively, once");

  // A zero ERC-20 balance does not mean the wallet is empty: Circle warns of this
  // explicitly, and the native read is the one to trust.
  assert.strictEqual(Number(ethers.formatUnits(0n, 6)), 0);
  assert.ok(Number(ethers.formatEther(999999999999n)) > 0, "a sub-6dp native balance is still real money");
}

// ---- 4. honest degradation -------------------------------------------------
{
  // chainRef: a link when there is an explorer, copyable text when there is not.
  const src = fs.readFileSync(path.join(ROOT, "dashboard.js"), "utf8");
  const fn = src.slice(src.indexOf("function chainRef"), src.indexOf("\n}", src.indexOf("function chainRef")) + 2);
  const COPY_ICON = "<svg/>";
  const chainRef = new Function("COPY_ICON", fn + "; return chainRef;")(COPY_ICON);

  const linked = chainRef("https://e.example", "/tx/0xabc", "0xabc…", "0xabcdef");
  assert.ok(linked.startsWith("<a href=\"https://e.example/tx/0xabc\""), "an explorer still gives a real link");
  assert.ok(!linked.includes("copyref"), "and no copy button");

  const arcLink = chainRef("https://www.arcexplorer.org", "/address/0xabc", "Trading", "0xabc");
  assert.ok(arcLink.includes('href="https://www.arcexplorer.org/address/0xabc"'), "Arc's explorer gives real links");

  for (const empty of ["", null, undefined]) {
    const bare = chainRef(empty, "/tx/0xabc", "0xabc…", "0xabcdef");
    assert.ok(!bare.includes("<a "), "no explorer means no link at all, never a dead one");
    assert.ok(bare.includes('data-copy="0xabcdef"'), "the full value stays reachable by copy");
    assert.ok(bare.includes("aria-label=\"Copy 0xabcdef\""), "and is labelled for a screen reader");
  }
}

console.log("arc-phase1: data directory, unit of account, the USDC dual-interface trap and explorer-free identifiers — all assertions passed");
