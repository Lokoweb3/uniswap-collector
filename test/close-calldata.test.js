// node test/close-calldata.test.js — what is sent is what was proven.
//
// closeV4 dry-ran one unlockData, then called buildV4 again and sent the second one.
// buildV4 reads the position's current liquidity and fees, and fees accrue every
// block, so the two builds differ whenever anything happened in between: the bytes
// that went on chain were never the bytes that were checked not to revert. On a
// close that removes 100% of the liquidity and pays out to the owner, that is the
// difference between a proven transaction and a hopeful one.
//
// Also here: the collector lock outliving the process that took it, and a skip
// message that described a chain limitation that no longer exists.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "close-position.js"), "utf8");

// ---- 1. the sent calldata is the dry run's ------------------------------------
{
  const closeV4 = src.slice(src.indexOf("async function closeV4("), src.indexOf("* Build the two v3 close calldatas"));
  assert.match(closeV4, /const \{ posm, unlockData, position, expect \} = dry;/,
    "closeV4 takes the calldata from the dry run");
  assert.ok(!/const \{ posm, unlockData[^=]*\} = await buildV4\(/.test(closeV4),
    "and does not build a second one to send");
  assert.match(src, /return \{ ok: true, gas, expect, position, posm, unlockData \};/,
    "which means the dry run has to hand those bytes back");

  // Order still matters: the check happens before the send.
  assert.ok(closeV4.indexOf("dryRunV4(") < closeV4.indexOf("modifyLiquidities(unlockData"),
    "the dry run still runs first");
  assert.ok(closeV4.indexOf("if (!dry.ok) throw") < closeV4.indexOf("modifyLiquidities(unlockData"),
    "and a failed dry run still stops the send");
}

// ---- 2. the same bytes, demonstrated ------------------------------------------
{
  // buildV4 needs a chain, so the property is shown on the shape the code now has:
  // one build, one object, used for both the check and the send.
  const build = () => ({ posm: { id: Math.random() }, unlockData: "0x" + Math.random().toString(16).slice(2), position: {}, expect: {} });

  // What it used to do.
  const dryOld = build();
  const sentOld = build();
  assert.notStrictEqual(sentOld.unlockData, dryOld.unlockData,
    "two builds produce different bytes whenever the position has moved — which is why sending the second was wrong");

  // What it does now.
  const dryNew = build();
  const sentNew = dryNew;
  assert.strictEqual(sentNew.unlockData, dryNew.unlockData, "one build, checked and sent");
  assert.strictEqual(sentNew.posm, dryNew.posm, "through the same contract object");
}

// ---- 3. the lock does not outlive the process that took it --------------------
{
  const lock = src.slice(src.indexOf("function lockCollector("), src.indexOf("module.exports"));
  // Comments stripped: the prose explains the old `exec sleep 3600`, and matching
  // against it would fail on the explanation rather than on the code.
  const lockCode = lock.replace(/\/\/[^\n]*/g, "");
  assert.ok(!/exec sleep 3600/.test(lockCode),
    "the child no longer sleeps for an hour regardless of whether anyone still wants the lock");
  assert.match(lockCode, /read -r _ <&0/,
    "it waits on a pipe this process holds, so any death of the parent — SIGKILL included — closes it");
  assert.match(lockCode, /stdio: \["pipe", "pipe", "ignore"\]/, "which means stdin has to be a pipe");
  assert.match(lockCode, /child\.stdin\.end\(\)/, "and an ordinary release closes it immediately");
  assert.match(lockCode, /flock -n 9/, "still non-blocking: a second holder fails rather than queueing");
  assert.match(lockCode, /echo LOCKED/, "and still says when it has the lock");
}

// ---- 4. the skip message says something that is true --------------------------
{
  const sell = fs.readFileSync(path.join(ROOT, "sell-v4.js"), "utf8");
  assert.ok(!/this chain's PoolManager rejects router swaps there/.test(sell),
    "the claim that this chain rejects router swaps in ERC-20-quoted pools is gone");
  assert.match(sell, /memecoinSell\.nativeQuoteOnly is on, so only ETH-quoted pools are used/,
    "and the message names the setting that actually caused the skip");
  // That branch is only reachable when the setting is on: the filter excludes
  // ERC-20-quoted pools only then, so the message must not describe a chain limit.
  assert.match(sell, /!st\.nativeQuoteOnly \|\| isNative\(k\.currency0\) \|\| isNative\(k\.currency1\)/,
    "which is what the filter above it does");
  assert.match(sell, /nativeQuoteOnly: s\.nativeQuoteOnly === true, \/\/ off by default/,
    "and it is off by default, because those pools do work");
}

console.log("close calldata: the bytes sent are the bytes the dry run proved, the collector lock dies with its owner, and the ERC-20-quoted skip message names the setting rather than a chain limit that no longer exists");
