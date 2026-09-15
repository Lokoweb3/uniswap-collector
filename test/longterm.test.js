// node test/longterm.test.js — the long-term "value at open" basis is the deposit priced at
// its own hour, never today's price (TASK-82); priceAt reads the price-log hour at or before t.
const assert = require("assert");
const lt = require("../longterm");

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const now = 1_800_000_000_000, OPEN = now - 10 * DAY;
const WETH = "0x00000000000000000000000000000000000000ee", USDG = "0x00000000000000000000000000000000000000dd";
const OWNER = "0x00000000000000000000000000000000000000a1";

// priceAt: the hour at or before t within 36 h; null when nothing that recent, unknown token, or 0.
{
  const hours = { [String(OPEN - 2 * HOUR)]: { [WETH]: 100, [USDG]: 1 }, [String(OPEN + 5 * HOUR)]: { [WETH]: 150 } };
  assert.equal(lt.priceAt(hours, WETH, OPEN), 100, "hour at or before t");
  assert.equal(lt.priceAt(hours, WETH.toUpperCase(), OPEN + 6 * HOUR), 150, "case-insensitive, newest hour before t");
  assert.equal(lt.priceAt(hours, USDG, OPEN + 6 * HOUR), null, "token absent from that hour -> null");
  assert.equal(lt.priceAt(hours, WETH, OPEN + 3 * DAY), null, "nothing within 36 h -> null");
  assert.equal(lt.priceAt({ [String(OPEN)]: { [WETH]: 0 } }, WETH, OPEN), null, "a zero price is unknown");
}

// The open basis: legs.deposited is today's valuation (HODL comparator); legs.depositedAtOpen is the basis.
function pos(legs) {
  return { p: { tokenId: "7", version: 3, pair: "WETH / USDG", pnlSince: OPEN, valueUsd: 210, feesUsd: 5, pnlUsd: 15, pnlLegs: legs }, walletAddress: OWNER };
}
{
  // Price doubled since open: deposited (today) $200, depositedAtOpen $100. Basis must stay $100.
  const r = lt.compute({ open: [pos({ deposited: 200, depositedAtOpen: 100, collected: 0, uncollected: 5 })], collects: [], values: {}, now }).get(`${OWNER}:7`);
  assert.equal(r.sinceOpen.basis, "open");
  assert.equal(r.sinceOpen.basisUsd, 100, `basis is the deposit at open, got ${r.sinceOpen.basisUsd}`);
  const rec = lt.openRecord(pos({ deposited: 200, depositedAtOpen: 100 }).p, OWNER);
  assert.equal(rec.depositedUsd, 100); assert.equal(rec.depositedTodayUsd, 200);
}
{
  // No price at open and no value ledger: basis null (never today's $200), APR null.
  const r = lt.compute({ open: [pos({ deposited: 200, depositedAtOpen: null, collected: 0, uncollected: 5 })], collects: [], values: {}, now }).get(`${OWNER}:7`);
  assert.equal(r.sinceOpen.basis, null, "no price at open -> no basis");
  assert.equal(r.sinceOpen.basisUsd, null);
  assert.equal(r.sinceOpen.feeAprPct, null);
}
{
  // With a value ledger covering the window the TWA wins regardless.
  const vals = []; for (let t = OPEN; t <= now; t += 6 * HOUR) vals.push({ t, usd: 120, fees: 0 });
  const r = lt.compute({ open: [pos({ deposited: 200, depositedAtOpen: null })], collects: [], values: { [`${OWNER}:7`]: vals }, now }).get(`${OWNER}:7`);
  assert.equal(r.sinceOpen.basis, "twa"); assert.equal(r.sinceOpen.basisUsd, 120);
}
console.log("longterm: priceAt hour lookup; open basis is the deposit priced at open, null without a price, twa when the ledger covers the window");
