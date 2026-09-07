/**
 * Parse the collector's log into "what did the last run do", per wallet.
 *
 * The collector logs one pass per owner:
 *   [ts] === mode=full chainId=4663 ===
 *   [ts] Owners in this run: Main, Trading, LP Rewards
 *   [ts] --- Main (0x…) ---
 *   [ts] collect #1030190 -> 0x…
 *   [ts]   ! collect failed for #…: …        (v3)
 *   [ts]   ! v4 collect failed for #…: …
 *   [ts]   ! LP Rewards: …                   (whole pass threw)
 *   [ts]   ! treasury split failed: …
 *   [ts] === LP Rewards: done ===
 *   [ts] === done ===
 * and, when the RAM cache is empty, a bare "locked, skipping" line instead.
 */
"use strict";

/** Parse the last run out of collector.log lines (newest last). Returns null when there is none. */
function parseLastRun(lines) {
  let start = -1;
  let locked = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (start < 0 && /=== mode=/.test(lines[i])) start = i;
    if (locked < 0 && /locked, skipping/.test(lines[i])) locked = i;
    if (start >= 0 && locked >= 0) break;
  }
  if (locked > start) {
    return { t: (lines[locked].match(/^(\S+)/) || [])[1] || null, mode: "collect", result: "locked — skipped", failures: [], owners: [] };
  }
  if (start < 0) return null;

  const mm = lines[start].match(/^\[([^\]]+)\] === mode=(\w+)/);
  const rest = lines.slice(start + 1);
  const collects = rest.filter((l) => / collect(?: v4)? #\d+ -> /.test(l)).length;

  // Walk the passes: failures are attributed to the owner whose pass is open.
  const owners = [];
  const perOwner = new Map();
  let current = "Main";
  const failLine = /^\S+\s+! (collect failed for #|v4 collect failed for #|treasury split failed|swap failed for|sweep failed|WETH -> \S+ swap failed|\S.* transfer failed)/;
  for (const raw of rest) {
    const l = raw.replace(/^\[[^\]]+\]\s*/, "");
    const pass = l.match(/^--- (.+?) \(0x[0-9a-fA-F]{40}\) ---$/);
    if (pass) {
      current = pass[1];
      if (!owners.includes(current)) owners.push(current);
      continue;
    }
    const passErr = l.match(/^\s*! (.+?): (.+)$/);
    let failed = false;
    if (/^\s*! (collect failed for #|v4 collect failed for #|treasury split failed|swap failed for|sweep failed|.*swap failed|.*transfer failed)/.test(l)) failed = true;
    else if (passErr && owners.includes(passErr[1]) && !/collect failed|swap failed|transfer failed|split failed/.test(l)) {
      // "  ! LP Rewards: <error>" — the whole pass threw.
      current = passErr[1];
      failed = true;
    }
    if (failed) perOwner.set(current, (perOwner.get(current) || 0) + 1);
  }
  const failures = [...perOwner].map(([wallet, count]) => ({ wallet, count }));
  const fails = failures.reduce((s, f) => s + f.count, 0);

  let result;
  if (collects) result = `collected ${collects} position${collects === 1 ? "" : "s"}`;
  else if (rest.some((l) => /Nothing above threshold/.test(l))) result = "nothing above threshold";
  else if (rest.some((l) => /Done\.|Simulate mode|=== done ===/.test(l))) result = "done";
  else result = "in progress or aborted";
  if (fails) result += `, ${fails} failed`;
  return { t: mm ? mm[1] : null, mode: mm ? mm[2] : "?", result, failures, owners };
}

module.exports = { parseLastRun };
