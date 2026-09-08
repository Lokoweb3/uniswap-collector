/**
 * Approval audit: everything a wallet has granted that lets someone else move
 * its assets.
 *
 *  - ERC-20 allowances: every Approval(owner, spender, value) the wallet ever
 *    emitted (topic-filtered log query over the whole chain, which this RPC
 *    answers for topic1), then the live allowance(owner, spender) so the row
 *    shows what stands now. Unlimited (≥ 2^255) and old (> 90 days) ones are
 *    flagged.
 *  - Operator approvals on the v3 and v4 position managers (ApprovalForAll).
 *  - LOKOVault: who holds NFT #1, who administers the NFT contract, and that
 *    the collector's operator has no approval on the vault NFT.
 *
 * Read-only; revoking is signed in the browser by the wallet itself.
 */
"use strict";
const { ethers } = require("ethers");

const APPROVAL_TOPIC = ethers.id("Approval(address,address,uint256)");
const ERC20_ABI = [
  "function allowance(address,address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];
const UNLIMITED = 1n << 255n;
const OLD_MS = 90 * 86400000;
const LOG_FLOOR = 0;

function create({ provider, cfg, approvedOperators, tokenMeta }) {
  const cache = new Map(); // owner -> { at, data }
  const TTL = 5 * 60 * 1000;

  async function blockTime(bn) {
    try {
      return (await provider.getBlock(bn)).timestamp * 1000;
    } catch {
      return null;
    }
  }

  async function allowances(owner) {
    let logs = [];
    try {
      logs = await provider.getLogs({ fromBlock: LOG_FLOOR, toBlock: "latest", topics: [APPROVAL_TOPIC, ethers.zeroPadValue(owner, 32)] });
    } catch (err) {
      return { ok: false, error: err.shortMessage || err.message, rows: [] };
    }
    // Latest event per token+spender, then the live value.
    const latest = new Map();
    for (const l of logs) {
      if (l.topics.length < 3) continue; // ERC-721 Approval has 4 topics; ERC-20 has 3
      if (l.topics.length !== 3) continue;
      const key = `${l.address.toLowerCase()}:${l.topics[2]}`;
      const prev = latest.get(key);
      if (!prev || l.blockNumber > prev.blockNumber) latest.set(key, l);
    }
    const rows = [];
    const blockCache = new Map();
    for (const l of latest.values()) {
      const token = ethers.getAddress(l.address);
      const spender = ethers.getAddress("0x" + l.topics[2].slice(26));
      const c = new ethers.Contract(token, ERC20_ABI, provider);
      let value = null, symbol = null, decimals = 18;
      try {
        value = await c.allowance(owner, spender);
      } catch {
        continue; // not an ERC-20 after all
      }
      if (value === 0n) continue;
      const meta = tokenMeta ? await tokenMeta(token).catch(() => null) : null;
      if (meta) { symbol = meta.symbol; decimals = meta.decimals; }
      else {
        try { symbol = await c.symbol(); decimals = Number(await c.decimals()); } catch {}
      }
      if (!blockCache.has(l.blockNumber)) blockCache.set(l.blockNumber, await blockTime(l.blockNumber));
      const t = blockCache.get(l.blockNumber);
      rows.push({
        token, symbol, spender, spenderLabel: labelFor(spender),
        value: value.toString(),
        amount: value >= UNLIMITED ? null : Number(ethers.formatUnits(value, decimals)),
        unlimited: value >= UNLIMITED,
        grantedAt: t, old: t != null && Date.now() - t > OLD_MS,
        tx: l.transactionHash,
      });
    }
    rows.sort((a, b) => (b.unlimited - a.unlimited) || ((b.grantedAt || 0) - (a.grantedAt || 0)));
    return { ok: true, rows };
  }

  function labelFor(addr) {
    const a = addr.toLowerCase();
    const c = cfg.contracts || {};
    const known = {
      [String(c.positionManager).toLowerCase()]: "Uniswap v3 PositionManager",
      [String(c.swapRouter02).toLowerCase()]: "Uniswap SwapRouter02",
      [String(c.quoterV2).toLowerCase()]: "Uniswap QuoterV2",
      [String(c.v4 && c.v4.positionManager).toLowerCase()]: "Uniswap v4 PositionManager",
      [String(c.v4 && c.v4.poolManager).toLowerCase()]: "Uniswap v4 PoolManager",
      [String(cfg.treasuryTBA).toLowerCase()]: "LOKOVault TBA",
      [String(cfg.treasuryNFT).toLowerCase()]: "LOKOVault NFT",
      "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2",
    };
    for (const t of (cfg.staking && cfg.staking.tokens) || []) if (t.stakingContract) known[String(t.stakingContract).toLowerCase()] = `${t.label || "staking"} contract`;
    return known[a] || null;
  }

  async function operators(owner, operator) {
    const out = [];
    const mgrs = [["v3", cfg.contracts.positionManager], ["v4", cfg.contracts.v4 && cfg.contracts.v4.positionManager]];
    for (const [v, mgr] of mgrs) {
      if (!mgr) continue;
      const list = await approvedOperators(provider, mgr, owner).catch(() => []);
      for (const o of list) if (o.approved) out.push({ version: v, manager: ethers.getAddress(mgr), operator: o.address, isCollector: !!operator && o.address.toLowerCase() === operator.toLowerCase() });
    }
    return out;
  }

  async function vault(operator) {
    if (!cfg.treasuryNFT) return null;
    try {
      const nft = new ethers.Contract(cfg.treasuryNFT, [
        "function ownerOf(uint256) view returns (address)",
        "function owner() view returns (address)",
        "function getApproved(uint256) view returns (address)",
        "function isApprovedForAll(address,address) view returns (bool)",
        "function feeSplitPct() view returns (uint256)",
        "function paused() view returns (bool)",
      ], provider);
      const [holder, admin, approved, pct, paused] = await Promise.all([nft.ownerOf(1), nft.owner(), nft.getApproved(1).catch(() => ethers.ZeroAddress), nft.feeSplitPct().catch(() => null), nft.paused().catch(() => null)]);
      const opAll = operator ? await nft.isApprovedForAll(holder, operator).catch(() => null) : null;
      return {
        nft: ethers.getAddress(cfg.treasuryNFT), tba: cfg.treasuryTBA || null, holder, admin,
        tokenApproved: approved, operatorApprovedForAll: opAll,
        operatorHasVaultPower: (!!operator && approved.toLowerCase() === operator.toLowerCase()) || opAll === true,
        feeSplitPct: pct == null ? null : Number(pct), paused,
      };
    } catch (err) {
      return { error: err.shortMessage || err.message };
    }
  }

  async function audit(owner, operator) {
    const key = owner.toLowerCase();
    const c = cache.get(key);
    if (c && Date.now() - c.at < TTL) return c.data;
    const [al, ops, v] = await Promise.all([allowances(owner), operators(owner, operator), vault(operator)]);
    const data = { ok: true, at: Date.now(), owner, operator: operator || null, allowances: al.rows, allowancesOk: al.ok, allowancesError: al.error || null, operators: ops, vault: v };
    cache.set(key, { at: Date.now(), data });
    return data;
  }

  return { audit, labelFor, UNLIMITED };
}

module.exports = { create };
