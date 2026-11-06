/**
 * login-throttle.mjs - shared passphrase-login throttle for lp-gate.mjs and
 * lp-mcp-remote.mjs. Pure: no I/O, injectable clock, so it is unit-testable.
 *
 * - clientKey(req): the throttle key for a request. The server sockets are
 *   loopback (a local tunnel/proxy in front), so the real client is the LAST
 *   X-Forwarded-For entry (the one appended by the trusted hop), and only when
 *   the socket peer is loopback. The first entry is client-controlled and is
 *   never used. IPv6 keys on the /64 prefix.
 * - createThrottle(): per-key lockout (5 failures -> 15 min), TTL expiry,
 *   bounded storage that never clear()s, and a global failure budget.
 */
import net from "node:net";

const stripV4Mapped = (a) => a.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");

function normalize(addr) {
  let a = String(addr || "").trim().toLowerCase();
  a = a.replace(/%.*$/, ""); // zone id
  return stripV4Mapped(a);
}

export function isLoopback(addr) {
  const a = normalize(addr);
  return /^127\.\d+\.\d+\.\d+$/.test(a) && net.isIPv4(a) || a === "::1";
}

/** First four 16-bit groups of an IPv6 address, as a /64 prefix string. */
function v6Prefix(a) {
  let s = a;
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) { const p = m[2].split(".").map(Number); s = m[1] + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16); }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.slice(0, 4).map((g) => (g || "0").replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

function keyOf(addr) {
  const a = normalize(addr);
  return net.isIPv6(a) ? v6Prefix(a) : a;
}

/** Last entry of the XFF chain (one [..] wrapper and one :port stripped), or "" when absent/invalid. */
function lastXff(header) {
  const raw = Array.isArray(header) ? header.join(",") : String(header ?? "");
  let last = raw.split(",").pop().trim();
  const br = /^\[([^\]]*)\](?::\d{1,5})?$/.exec(last);
  if (br) last = br[1];
  else {
    const v4 = /^(\d+\.\d+\.\d+\.\d+):\d{1,5}$/.exec(last);
    if (v4) last = v4[1];
  }
  const a = normalize(last);
  return net.isIP(a) ? a : "";
}

/** The normalized client address (no /64 folding): last XFF entry from a trusted loopback peer, else the peer. */
export function clientAddr(req, opts = {}) {
  const trust = opts.trust ?? process.env.LP_GATE_TRUST_PROXY !== "0";
  const peer = normalize(req.socket && req.socket.remoteAddress) || "?";
  if (trust && isLoopback(peer)) {
    const x = lastXff(req.headers && req.headers["x-forwarded-for"]);
    if (x) return x;
  }
  return peer;
}

/** The throttle key: clientAddr, with IPv6 folded to its /64. */
export function clientKey(req, opts = {}) {
  const a = clientAddr(req, opts);
  return a === "?" ? a : keyOf(a);
}

/** Integer/finite env value within [min, max], else the default (warns without echoing the value). */
function envNum(name, def, min, max, integer) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    console.warn(`${name} is invalid or out of range (${min}..${max}); using default ${def}`);
    return def;
  }
  return n;
}

/**
 * One passphrase attempt. Throttle is checked before reading the body AND again
 * after it: bodies arrive later, so N parallel requests could all pass the first
 * check. After the second check nothing awaits before checkPassphrase and fail().
 * Returns { status: "throttled", reason } | { status: "bad", form } | { status: "ok", form }.
 */
export async function loginAttempt({ throttle, ip, readForm, checkPassphrase }) {
  let gate = throttle.check(ip);
  if (!gate.ok) return { status: "throttled", reason: gate.reason };
  const form = await readForm();
  gate = throttle.check(ip);
  if (!gate.ok) return { status: "throttled", reason: gate.reason };
  if (!checkPassphrase(form.p || "")) { throttle.fail(ip); return { status: "bad", form }; }
  throttle.success(ip);
  return { status: "ok", form };
}

export function createThrottle(o = {}) {
  const now = o.now || Date.now;
  const cap = o.cap ?? 5000;
  const maxFails = o.maxFails ?? 5;
  const lockMs = o.lockMs ?? 15 * 60_000;
  const ttlMs = o.ttlMs ?? lockMs;
  const globalMax = o.globalMax ?? envNum("LP_GATE_GLOBAL_MAX", 60, 1, 10000, true);
  const globalWindowMs = o.globalWindowMs ?? envNum("LP_GATE_GLOBAL_WINDOW_MS", 15 * 60_000, 60_000, 86_400_000, false);
  let announced = false; // "global budget engaged" is reported once per engagement
  const recs = new Map(); // key -> { count, lockedUntil, expires }
  let globalFails = []; // timestamps, oldest first, at most globalMax kept

  function sweep() {
    const t = now();
    for (const [k, r] of recs) if (r.expires <= t) recs.delete(k);
    while (globalFails.length && globalFails[0] <= t - globalWindowMs) globalFails.shift();
  }
  const isLocked = (r, t) => !!r && r.lockedUntil > t;
  function room(t) {
    if (recs.size < cap) return true;
    let victim = null;
    for (const [k, r] of recs) if (!isLocked(r, t) && (!victim || r.expires < recs.get(victim).expires)) victim = k;
    if (victim === null) return false;
    recs.delete(victim);
    return true;
  }

  return {
    /** { ok: true } or { ok: false, reason: "global" | "locked" | "full" } */
    check(key) {
      sweep();
      const t = now();
      if (globalFails.length >= globalMax) {
        if (!announced) { announced = true; if (o.onEngage) o.onEngage(); }
        return { ok: false, reason: "global" };
      }
      announced = false;
      const r = recs.get(key);
      if (isLocked(r, t)) return { ok: false, reason: "locked" };
      if (!r && recs.size >= cap && ![...recs.values()].some((x) => !isLocked(x, t))) return { ok: false, reason: "full" };
      return { ok: true };
    },
    fail(key) {
      sweep();
      const t = now();
      globalFails.push(t);
      if (globalFails.length > globalMax) globalFails.shift();
      let r = recs.get(key);
      if (!r) {
        if (!room(t)) return { ok: false, reason: "full" };
        r = { count: 0, lockedUntil: 0, expires: 0 };
        recs.set(key, r);
      }
      if (isLocked(r, t)) return { ok: false, reason: "locked" };
      r.count++;
      r.expires = t + ttlMs;
      if (r.count >= maxFails) { r.lockedUntil = t + lockMs; r.count = 0; r.expires = r.lockedUntil; }
      return { ok: true };
    },
    /** Clears only this key; the global counter is untouched. */
    success(key) { recs.delete(key); },
    size() { sweep(); return recs.size; },
    globalEngaged() { sweep(); return globalFails.length >= globalMax; },
  };
}
