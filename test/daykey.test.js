"use strict";
const assert = require("assert");
const { dayKey, dayStart, hourIn, TZ } = require("../daykey");

const t = Date.UTC(2026, 8, 14, 3, 30); // 2026-09-14 03:30Z = 2026-09-13 23:30 in New York (EDT)
assert.equal(dayKey(t, "UTC"), "2026-09-14");
assert.equal(dayKey(t, "America/New_York"), "2026-09-13", "the same instant is the previous day in New York");
assert.equal(dayStart(t, "UTC"), Date.UTC(2026, 8, 14), "UTC midnight");
assert.equal(dayStart(t, "America/New_York"), Date.UTC(2026, 8, 13, 4), "New York midnight is 04:00Z in September");
assert.equal(hourIn(t, "America/New_York"), 23);
assert.equal(hourIn(t, "UTC"), 3);
// DST: 2026-11-01 02:00 EDT -> 01:00 EST. Midnight on Nov 1 is 04:00Z; midnight on Nov 2 is 05:00Z.
assert.equal(dayStart(Date.UTC(2026, 10, 1, 12), "America/New_York"), Date.UTC(2026, 10, 1, 4), "midnight before the change");
assert.equal(dayStart(Date.UTC(2026, 10, 2, 12), "America/New_York"), Date.UTC(2026, 10, 2, 5), "midnight after the change");
assert.equal(dayKey(Date.UTC(2026, 10, 1, 5, 30), "America/New_York"), "2026-11-01", "01:30 EST on the change day");
// The default zone is LP_TZ or the process zone, and it agrees with the process's own calendar.
const now = Date.now(); const d = new Date(now);
const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
if (!process.env.LP_TZ) assert.equal(dayKey(now), local, `default zone (${TZ}) matches the process calendar`);
console.log(`daykey: UTC vs New York across midnight and DST assertions passed (default zone ${TZ})`);
