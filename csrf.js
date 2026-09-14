"use strict";
// Cross-site request check for the state-changing /api routes.
//
// Every route that changes something trusts loopback, and through the gate every
// request is loopback, so a web page the owner happens to visit could POST to
// 127.0.0.1:8787 (browsers send "simple" cross-site POSTs without asking) and lock
// the collector or flip a rule. Browsers always attach an Origin header to a
// cross-site POST, and usually Sec-Fetch-Site, so the rule is:
//   - no Origin and no Sec-Fetch-Site: a script (curl, the agent, the MCP, the
//     guardian's loopback POSTs) — allowed;
//   - Origin host equals the Host header: the dashboard's own page — allowed;
//   - Origin hostname equals the public (tailnet / funnel) name: the gate or the
//     tailnet-only serve in front of us — allowed;
//   - through the gate with no cross-site marker: the gate's SameSite=Lax cookie
//     already refuses cross-site POSTs, so a gate request that reached us is the
//     owner's page even when the public name cannot be resolved — allowed;
//   - anything else with an Origin: cross-site — refused.
function originHost(origin) {
  try {
    const u = new URL(origin);
    return { host: u.host.toLowerCase(), hostname: u.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * @param {object} h  origin, host, secFetchSite (header values), viaGate (x-lp-gate === "1"),
 *                    publicHost: string | (() => string|null) — resolved only when needed.
 * @returns {boolean} true when the request must be refused.
 */
function isCrossSite({ origin, host, secFetchSite, viaGate, publicHost } = {}) {
  const sfs = String(secFetchSite || "").toLowerCase();
  if (!origin) return sfs === "cross-site";
  if (origin === "null") return true;
  const o = originHost(origin);
  if (!o) return true;
  if (host && o.host === String(host).toLowerCase()) return false;
  const ph = typeof publicHost === "function" ? publicHost() : publicHost;
  if (ph && o.hostname === String(ph).toLowerCase().replace(/\.$/, "")) return false;
  if (viaGate && sfs !== "cross-site") return false;
  return true;
}

/** A browser request with a body must say it is JSON; scripts and empty-body POSTs are exempt. */
function needsJson({ origin, contentType, contentLength, transferEncoding } = {}) {
  if (!origin) return false;
  const hasBody = Number(contentLength) > 0 || !!transferEncoding;
  if (!hasBody) return false;
  return !/^application\/json\b/i.test(String(contentType || ""));
}

module.exports = { isCrossSite, needsJson };
