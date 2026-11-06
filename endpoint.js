/**
 * endpoint.js -- what may be configured as an RPC / explorer URL, and how a URL
 * (which may carry a provider key in its path or query) is kept out of anything
 * a person can read: HTTP bodies, logs, error text.
 *
 *   validateEndpoint(url)   https only, no userinfo, no localhost / loopback /
 *                           private / link-local / metadata host. Throws an Error
 *                           whose text never contains the URL's path or query.
 *   redactUrl(url)          "https://host" -- origin only.
 *   redactText(text)        every registered secret-bearing URL and every
 *                           "proapi_..." key in free text, replaced.
 *   registerEndpoint(url)   remember a URL whose path/query is a secret, so that
 *                           redactText can find it even inside an ethers error.
 *   publicRpc(cfg)          what a browser may be told about the RPC endpoint.
 *
 * Nothing here reads a request: the URLs come from settings.json and the
 * environment only, never from a route parameter.
 */
"use strict";
const net = require("net");
const util = require("util");

const PROTECTED = new Set();       // secret strings (full URLs, path+query parts)
const KEY_RE = /proapi_[A-Za-z0-9_-]+/g;

const BLOCKED_NAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /^metadata$/i, /^metadata\.google\.internal$/i];

function v4Blocked(ip) {
  const p = ip.split(".").map(Number);
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && p[2] === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** Eight 16-bit groups of an IPv6 literal (with or without a trailing dotted IPv4), or null. */
function expandV6(s) {
  let str = s;
  const dotted = str.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[2].split(".").map(Number);
    if (p.some((n) => n > 255)) return null;
    str = dotted[1] + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return all.length === 8 && all.every((n) => Number.isFinite(n)) ? all : null;
}

/** True for an IPv6 literal (no brackets) that is loopback, private, link-local, mapped-private or metadata. */
function v6Blocked(ip) {
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Blocked(mapped[1]);
  const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return v4Blocked(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // Expand to eight groups to inspect the prefix and any embedded IPv4.
  const groups = expandV6(s);
  if (groups) {
    const embedded = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    // ::/96 (IPv4-compatible, deprecated) with an embedded IPv4: ::127.0.0.1, ::a00:1
    if (groups.slice(0, 6).every((g) => g === 0)) return true;
    // 64:ff9b::/96 (NAT64) and 64:ff9b:1::/48 (local-use NAT64): never a public RPC
    if (groups[0] === 0x64 && groups[1] === 0xff9b && (groups.slice(2, 6).every((g) => g === 0) || groups[2] === 1)) return true;
    // 2002::/16 (6to4): blocked when the embedded IPv4 is private
    if (groups[0] === 0x2002 && v4Blocked(embedded(groups[1], groups[2]))) return true;
    // ::ffff:0:0/96 mapped, in any spelling
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff && v4Blocked(embedded(groups[6], groups[7]))) return true;
  }
  const first = parseInt(s.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00      // fc00::/7 unique local
    || (first & 0xffc0) === 0xfe80        // fe80::/10 link local
    || (first & 0xff00) === 0xff00        // multicast
    || (first & 0xffc0) === 0xfec0        // fec0::/10 site local (deprecated)
    || s === "fd00:ec2::254";             // AWS metadata
}

/**
 * The URL, normalised, or throws. `what` names the setting ("chain.rpcUrl") in the
 * error; the URL itself is never echoed.
 */
function validateEndpoint(url, what = "endpoint") {
  const fail = (why) => { throw new Error(`${what} rejected: ${why}`); };
  if (typeof url !== "string" || !url.trim()) fail("it is empty");
  let u;
  try { u = new URL(url.trim()); } catch { fail("it is not a valid URL"); }
  if (u.protocol !== "https:") fail("only https:// is allowed");
  if (u.username || u.password) fail("credentials in the URL are not allowed");
  let host = u.hostname;
  if (!host) fail("it has no host");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  // "localhost." and "127.0.0.1." are the same host as without the dot.
  host = host.replace(/\.+$/, "");
  if (!host) fail("it has no host");
  const kind = net.isIP(host);
  if (kind === 4 && v4Blocked(host)) fail("a loopback, private, link-local or metadata address is not allowed");
  if (kind === 6 && v6Blocked(host)) fail("a loopback, private, link-local or metadata address is not allowed");
  if (!kind) {
    if (BLOCKED_NAMES.some((re) => re.test(host))) fail("a local or internal host name is not allowed");
    // A bare numeric-looking name that the URL parser did not fold into an IPv4 literal.
    if (/^[0-9.x]+$/i.test(host)) fail("a numeric host must be a plain IP literal");
  }
  return u.toString();
}

/** Origin only: scheme and host, no path, no query, no credentials. Never throws. */
function redactUrl(url) {
  try {
    const u = new URL(String(url));
    return u.origin === "null" ? "[url]" : u.origin;
  } catch {
    return "[url]";
  }
}

/**
 * Remember a URL whose path or query may be a secret. A URL that is only an origin is not one.
 *
 * Either way the whole URL and key-like segments / query values are registered: 16+ characters
 * of [A-Za-z0-9_-], or (env URLs) 12+ characters mixing digits and letters. A short word such as
 * "ethereum" stays readable. `{ env: true }` (a keyed URL by definition) also registers the
 * path+query tail, every query value of 8+ characters, secret-named query parameters and the last
 * path segment, whatever their characters.
 */
function registerEndpoint(url, { env = false } = {}) {
  if (!url) return;
  try {
    const u = new URL(String(url));
    const tail = u.pathname.replace(/\/+$/, "") + u.search;
    if (!tail && !u.username && !u.password) return;
    PROTECTED.add(String(url));
    PROTECTED.add(u.toString());
    const keyLike = (v) => v.length >= 16 && /^[A-Za-z0-9_-]+$/.test(v);
    const mixed = (v) => v.length >= 12 && /^[A-Za-z0-9_-]+$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v);
    const wanted = env ? (v) => keyLike(v) || mixed(v) : keyLike;
    if (env && tail.length >= 6) PROTECTED.add(tail);
    for (const seg of u.pathname.split("/")) { if (wanted(seg)) PROTECTED.add(seg); const d = safeDecode(seg); if (d !== seg && wanted(d)) PROTECTED.add(d); }
    for (const [, v] of u.searchParams) if (wanted(v)) PROTECTED.add(v);
    if (env) {
      // An env URL is a keyed URL by definition: whatever its charset, every query value of 8+
      // characters, any value of a key/token/secret/auth-named parameter (4+), and the last path
      // segment (8+) is treated as the secret.
      for (const [k, v] of u.searchParams) if (v.length >= 8 || (/key|token|secret|auth|apikey/i.test(k) && v.length >= 4)) PROTECTED.add(v);
      const segs = u.pathname.split("/").filter(Boolean);
      const last = segs.length ? segs[segs.length - 1] : "";
      if (last.length >= 8) PROTECTED.add(last);
      const dl = safeDecode(last);
      if (dl !== last && dl.length >= 8) PROTECTED.add(dl);
    }
    if (u.password.length >= 4) PROTECTED.add(u.password);
  } catch { /* not a URL */ }
}
const safeDecode = (x) => { try { return decodeURIComponent(x); } catch { return x; } };

/** Free text with every registered secret and every Blockscout PRO key removed. */
function redactText(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  if (out.includes("proapi_")) out = out.replace(KEY_RE, "proapi_[hidden]");
  if (PROTECTED.size) {
    // Longest first, so a full URL goes before the path fragment inside it.
    for (const s of [...PROTECTED].sort((a, b) => b.length - a.length)) {
      if (!out.includes(s)) continue;
      out = out.split(s).join(/^https?:/i.test(s) ? redactUrl(s) : "[hidden]");
    }
  }
  return out;
}

/** An Error (and what it wraps) with its text and request info redacted, in place. */
function scrubError(err, depth = 0) {
  if (!err || typeof err !== "object" || depth > 4) return err;
  for (const k of ["message", "shortMessage", "reason"]) {
    if (typeof err[k] === "string") { try { err[k] = redactText(err[k]); } catch { /* read-only */ } }
  }
  if (err.info && typeof err.info === "object" && typeof err.info.requestUrl === "string") err.info.requestUrl = redactUrl(err.info.requestUrl);
  if (err.request && typeof err.request === "object" && typeof err.request.url === "string") { try { err.request.url = redactUrl(err.request.url); } catch { /* frozen */ } }
  if (typeof err.stack === "string") { try { err.stack = redactText(err.stack); } catch { /* ignore */ } }
  // ethers keeps the raw HTTP answer (which can echo the URL) on err.info.responseBody, and a body on err.body.
  for (const k of ["info", "body", "data", "response"]) if (err[k] && typeof err[k] === "object") scrubValue(err[k], 0);
  if (typeof err.body === "string") { try { err.body = redactText(err.body); } catch { /* read-only */ } }
  if (err.error) scrubError(err.error, depth + 1);
  if (err.cause) scrubError(err.cause, depth + 1);
  return err;
}

/** Redact every string inside a plain object / array, in place (bounded depth). */
function scrubValue(v, depth) {
  if (!v || typeof v !== "object" || depth > 4) return;
  for (const k of Object.keys(v)) {
    try {
      if (typeof v[k] === "string") v[k] = redactText(v[k]);
      else if (v[k] && typeof v[k] === "object") scrubValue(v[k], depth + 1);
    } catch { /* read-only property */ }
  }
}

/**
 * What the browser is told about the RPC. Always an origin, never a path or key.
 * When the live endpoint came from the environment, the (public) one written in
 * settings.json is shown instead, or null if there is none.
 */
function publicRpc(cfg) {
  const shown = cfg && cfg.rpcPublic !== undefined ? cfg.rpcPublic : cfg && cfg.rpcUrl;
  if (!shown) return null;
  const o = redactUrl(shown);
  return o === "[url]" ? null : o;
}

/** A response chunk (string, Buffer or Uint8Array) with registered secrets removed; anything else is returned as is. */
function redactChunk(chunk) {
  if (typeof chunk === "string") return redactText(chunk);
  if (chunk instanceof Uint8Array) {
    const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8");
    const red = redactText(text);
    return red === text ? chunk : Buffer.from(red, "utf8");
  }
  return chunk;
}

let consolePatched = false;
/** Redact string arguments of console.log/info/warn/error. Idempotent; only touches text that holds a secret. */
function installConsoleRedaction() {
  if (consolePatched) return;
  consolePatched = true;
  for (const m of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[m].bind(console);
    console[m] = (...args) => orig(...args.map((a) => {
      if (typeof a === "string") return redactText(a);
      if (a instanceof Error) return scrubError(a);
      if (a && typeof a === "object") {
        // Objects (a response, an options bag) are rendered as node would, then redacted.
        let shown;
        try { shown = util.inspect(a, { depth: 4 }); } catch { return a; }
        const red = redactText(shown);
        return red === shown ? a : red;
      }
      return a;
    }));
  }
}

module.exports = { validateEndpoint, redactUrl, redactText, registerEndpoint, scrubError, redactChunk, publicRpc, installConsoleRedaction, _protected: PROTECTED };
