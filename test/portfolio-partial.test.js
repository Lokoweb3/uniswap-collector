// node test/portfolio-partial.test.js — a sustained missing price stays partial (TASK-81):
// every point in an outage is flagged against the last COMPLETE point, a recovered point
// clears, and a token that was sold (amount 0) never flags.
const assert = require("assert");
const { markPartial } = require("../portfolio");

const ETH = "eth", X = "0x00000000000000000000000000000000000000bb";
const H = 3600 * 1000, t0 = 1_800_000_000_000;
const pt = (i, p, a, total) => ({ t: t0 + i * H, total, p, a });

// 1. complete -> two unpriced hours -> recovered: both outage points partial, recovery not.
{
  const s = markPartial([
    pt(0, { [ETH]: 2000, [X]: 1 }, { [ETH]: 1, [X]: 100 }, 2100),
    pt(1, { [X]: 1 }, { [ETH]: 1, [X]: 100 }, 100),          // ETH unpriced (1st hour)
    pt(2, { [X]: 1 }, { [ETH]: 1, [X]: 100 }, 100),          // ETH still unpriced (2nd hour)
    pt(3, { [ETH]: 2050, [X]: 1 }, { [ETH]: 1, [X]: 100 }, 2150), // recovered
  ]);
  assert.equal(s[1].partial, true, "first outage hour is partial");
  assert.equal(s[2].partial, true, "second outage hour stays partial (baseline = last complete point)");
  assert.deepEqual(s[2].unpriced, [ETH]);
  assert.ok(!s[3].partial, "recovered point is complete");
}

// 2. a sold token (amount 0 now) does not flag, even though it was priced before.
{
  const s = markPartial([
    pt(0, { [ETH]: 2000, [X]: 1 }, { [ETH]: 1, [X]: 100 }, 2100),
    pt(1, { [ETH]: 2000 }, { [ETH]: 1, [X]: 0 }, 2000),      // X sold: no price, no holding
    pt(2, { [ETH]: 2000 }, { [ETH]: 1 }, 2000),              // X gone from the amounts entirely: still fine
  ]);
  assert.ok(!s[1].partial, "a sold token does not mark the point partial");
  assert.ok(!s[2].partial, "nor later points");
}

// 3. a tiny unpriced holding (< 1 % of total) never flags; a large one does.
{
  const s = markPartial([
    pt(0, { [ETH]: 2000, [X]: 1 }, { [ETH]: 1, [X]: 5 }, 2005),
    pt(1, { [ETH]: 2000 }, { [ETH]: 1, [X]: 5 }, 2000),
  ]);
  assert.ok(!s[1].partial, "an unpriced holding under the share threshold is not a gap");
}
console.log("portfolio-partial: sustained outage stays partial against the last complete point, recovery clears, sold tokens never flag");
