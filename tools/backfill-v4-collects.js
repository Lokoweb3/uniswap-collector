#!/usr/bin/env node
/**
 * Rebuild v4-collects.json from collector.log.
 *
 * v4 collects leave no Collect event on the v3 position manager, so before the
 * collector started writing v4-collects.json (2026-09-08) the only record of
 * them is the log. Each sent collect appears as three lines inside an owner
 * pass:
 *
 *   --- <label> (<owner>) ---
 *   v4 #<id> <SYM0>/<SYM1> <fee>%  <amt0> <SYM0> + <amt1> <SYM1>  ≈ <x> WETH
 *   collect v4 #<id> -> <tx>
 *     confirmed in block <n>, gas <g> ETH
 *
 * Amounts in the log are rounded to 6 decimals; the exact figures are read from
 * the transaction receipt when the RPC still has it (ERC20 Transfer from the
 * PoolManager for the token leg; the native leg keeps the logged amount).
 * Existing rows (by tx) are kept. Usage: node tools/backfill-v4-collects.js [--dry]
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const HERE = path.join(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));
const LOG = path.join(HERE, "collector.log");
const OUT = path.join(HERE, "v4-collects.json");
const DRY = process.argv.includes("--dry");

const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
const v4 = require(path.join(HERE, "univ4"));
const POSM = new ethers.Contract(cfg.contracts.v4.positionManager, ["function getPoolAndPositionInfo(uint256) view returns (tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, uint256 info)"], provider);
const TRANSFER = ethers.id("Transfer(address,address,uint256)");

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function main() {
  const lines = fs.readFileSync(LOG, "utf8").split("\n");
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {}
  const have = new Set(existing.map((r) => r.tx));

  let owner = { address: cfg.ownerAddress, label: null, main: true };
  const sims = new Map(); // id -> { amt0, amt1, sym0, sym1 }
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ts = line.slice(1, 25);
    let m;
    if ((m = line.match(/\] --- (.+?) \((0x[0-9a-fA-F]{40})\) ---$/))) {
      const addr = ethers.getAddress(m[2]);
      owner = { address: addr, label: m[1], main: addr.toLowerCase() === cfg.ownerAddress.toLowerCase() };
    } else if ((m = line.match(/\] v4 #(\d+) (\S+)\/(\S+) [\d.]+%\s+([\d.]+) (\S+) \+ ([\d.]+) (\S+)\s+≈/))) {
      sims.set(m[1], { amt0: m[4], sym0: m[5], amt1: m[6], sym1: m[7] });
    } else if ((m = line.match(/\] collect v4 #(\d+) -> (0x[0-9a-fA-F]{64})$/))) {
      const id = m[1], tx = m[2];
      const sim = sims.get(id);
      // The confirmation line usually follows; when runs overlapped (before the
      // collector lock) it may be missing, so the receipt decides below.
      let block = null;
      const b = (lines[i + 1] || "").match(/confirmed in block (\d+)/);
      if (b) block = Number(b[1]);
      if (!sim) { console.log(`skip #${id} ${short(tx)}: no simulation line`); continue; }
      if (have.has(tx)) continue;
      found.push({ id, tx, block, t: Date.parse(ts), owner, sim });
    }
  }
  console.log(`${found.length} new v4 collect(s) in the log (${existing.length} already recorded)`);

  const meta = new Map();
  async function metaFor(id) {
    if (!meta.has(id)) {
      const { key } = await POSM.getPoolAndPositionInfo(BigInt(id));
      const [t0, t1] = await Promise.all([v4.getCurrency(key.currency0, provider), v4.getCurrency(key.currency1, provider)]);
      meta.set(id, { t0, t1 });
    }
    return meta.get(id);
  }
  const tok = (t) => ({ address: t.address, symbol: t.symbol, decimals: Number(t.decimals) });

  const rows = [...existing];
  for (const f of found) {
    const { t0, t1 } = await metaFor(f.id);
    let fee0 = ethers.parseUnits(f.sim.amt0, t0.decimals), fee1 = ethers.parseUnits(f.sim.amt1, t1.decimals);
    let t = f.t, block = f.block, exact = false, rcpt = null;
    try { rcpt = await provider.getTransactionReceipt(f.tx); } catch (err) {
      console.log(`  receipt for ${short(f.tx)} unavailable (${err.shortMessage || err.message}); using logged amounts`);
    }
    if (rcpt === null) { console.log(`  skip ${short(f.tx)}: never mined`); continue; }
    if (rcpt) {
      if (!rcpt.status) { console.log(`  skip ${short(f.tx)}: reverted`); continue; }
      block = rcpt.blockNumber;
      const blk = await provider.getBlock(rcpt.blockNumber).catch(() => null);
      if (blk) t = blk.timestamp * 1000;
      // Token legs: ERC20 Transfer out of the PoolManager in this tx. A zero
      // sum means the fees were already taken by an overlapping run's tx.
      const pm = cfg.contracts.v4.poolManager.toLowerCase();
      let empty = false;
      for (const [tk, set] of [[t0, (v) => (fee0 = v)], [t1, (v) => (fee1 = v)]]) {
        if (tk.address === ethers.ZeroAddress) continue;
        const sum = rcpt.logs
          .filter((l) => l.address.toLowerCase() === tk.address.toLowerCase() && l.topics[0] === TRANSFER && l.topics[1] && `0x${l.topics[1].slice(26)}`.toLowerCase() === pm)
          .reduce((s, l) => s + BigInt(l.data), 0n);
        if (sum === 0n) empty = true;
        set(sum);
        exact = true;
      }
      if (empty) { console.log(`  skip ${short(f.tx)}: collected nothing (fees already taken)`); continue; }
    }
    if (!block) { console.log(`  skip ${short(f.tx)}: no block`); continue; }
    rows.push({
      block, t, tx: f.tx, tokenId: `v4-${f.id}`,
      fee0: fee0.toString(), fee1: fee1.toString(), principal: false,
      wallet: f.owner.address.toLowerCase(), walletLabel: f.owner.main ? null : f.owner.label,
      t0: tok(t0), t1: tok(t1), src: exact ? "backfill+receipt" : "backfill",
    });
    console.log(`  #${f.id} ${t0.symbol}/${t1.symbol} ${new Date(t).toISOString()} ${ethers.formatUnits(fee0, t0.decimals)} ${t0.symbol} + ${ethers.formatUnits(fee1, t1.decimals)} ${t1.symbol} (${f.owner.label || "Main"}) ${short(f.tx)}${exact ? "" : " ~"}`);
  }
  rows.sort((a, b) => a.block - b.block);
  if (DRY) { console.log("dry run: nothing written"); return; }
  fs.writeFileSync(OUT + ".tmp", JSON.stringify(rows));
  fs.renameSync(OUT + ".tmp", OUT);
  console.log(`wrote ${rows.length} row(s) to v4-collects.json`);
}

main().catch((err) => { console.error(err.shortMessage || err.message); process.exit(1); });
