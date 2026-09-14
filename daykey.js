"use strict";
// One calendar for every "day" in the project. Attribution, staking, the watch view and the
// audit each had their own day key (process-local, process-local, process-local, UTC) while
// the daily line-up and the MCP used LP_TZ; they agreed only because this host runs in
// America/New_York. Everything now asks here: LP_TZ when set, else the process's own zone.
const TZ = process.env.LP_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const fmtCache = new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(tz, f);
  }
  return f;
}
function parts(t, tz) {
  const out = {};
  for (const p of fmt(tz).formatToParts(new Date(t))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}
// Offset (ms) such that wall-clock-in-tz = UTC + offset, at instant t.
function offsetMs(t, tz) {
  const p = parts(t, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/** "YYYY-MM-DD" of instant t in tz (default LP_TZ / process zone). */
function dayKey(t, tz = TZ) {
  const p = parts(t, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
/** Epoch ms of local midnight (in tz) of the day containing t. Correct across DST changes. */
function dayStart(t, tz = TZ) {
  const p = parts(t, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day);
  const guess = wall - offsetMs(t, tz);
  return wall - offsetMs(guess, tz); // re-read the offset at the guessed midnight (DST edge)
}
/** Hour of day (0-23) of instant t in tz. */
function hourIn(t, tz = TZ) { return parts(t, tz).hour % 24; }

module.exports = { TZ, dayKey, dayStart, hourIn };
