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
// TASK-83: window fees are the window's fees.
{
  const HOURS6 = 6 * HOUR;
  const openAt = now - 40 * DAY; // older than the 30 d window
  const p = { tokenId: "9", version: 3, pair: "WETH / USDG", pnlSince: openAt, valueUsd: 1000, feesUsd: 100, pnlUsd: 0, pnlLegs: { deposited: 1000, depositedAtOpen: 1000, collected: 0, uncollected: 100 } };
  // Ledger: the uncollected balance was already $100 at the window start and never moved.
  const flat = []; for (let t = openAt; t <= now; t += HOURS6) flat.push({ t, usd: 1000, fees: 100 });
  const r1 = lt.compute({ open: [{ p, walletAddress: OWNER }], collects: [], values: { [`${OWNER}:9`]: flat }, now }).get(`${OWNER}:9`);
  assert.equal(r1.d30.feesUsd, 0, `an unchanged $100 opening balance earns $0 in the window, got ${r1.d30.feesUsd}`);
  assert.equal(r1.sinceOpen.feesUsd, 100, "since open the whole balance counts (it was 0 at open)");
  // A fee-only `principal` row (history.js already subtracted the withdrawn principal) counts.
  const collects = [{ t: now - 5 * DAY, usd: 20, principal: true, tokenId: "9", version: 3, walletAddress: OWNER, pair: "WETH / USDG" }];
  const r2 = lt.compute({ open: [{ p, walletAddress: OWNER }], collects, values: { [`${OWNER}:9`]: flat }, now }).get(`${OWNER}:9`);
  assert.equal(r2.d30.feesUsd, 20, `the $20 fee row from a principal tx counts, got ${r2.d30.feesUsd}`);
  // No ledger sample at the window start -> window fees unknown (null), never the whole balance.
  const r3 = lt.compute({ open: [{ p, walletAddress: OWNER }], collects: [], values: {}, now }).get(`${OWNER}:9`);
  assert.equal(r3.d30.feesUsd, null, `no start sample -> unknown, got ${r3.d30.feesUsd}`);
  assert.equal(r3.d30.feeAprPct, null);
  assert.equal(r3.sinceOpen.feesUsd, 100);
}
console.log("longterm: priceAt hour lookup; open basis is the deposit priced at open, null without a price, twa when the ledger covers the window; window fees exclude the opening balance and count fee-only principal rows");
