// Preloaded into a test child (node --require): any non-loopback destination throws
// Error("no-network: <host>") and is appended as JSON to $NO_NETWORK_LOG when set.
// Wraps fetch, http(s).request/get, http.ClientRequest, net.connect, net.Socket.prototype.connect
// (which tls, http agents and undici all end up calling), tls.connect and dns lookup/resolve*.
// Composable with the
// stub-*.js preloads: load this first, the stub's fetch replacement then wins for fetch.
"use strict";
const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const dns = require("dns");

const LOOP = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);
const isLoop = (h) => LOOP.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h);
const note = (o) => { if (process.env.NO_NETWORK_LOG) { try { fs.appendFileSync(process.env.NO_NETWORK_LOG, JSON.stringify(o) + "\n"); } catch { /* ignore */ } } };
function guard(kind, host) {
  const h = String(host || "").replace(/:\d+$/, "").toLowerCase();
  if (isLoop(h) || isLoop(String(host || "").toLowerCase())) return;
  note({ kind, host: String(host) });
  throw new Error(`no-network: ${host}`);
}
function hostOfArgs(a) {
  const [first, second] = a;
  const opt = second && typeof second === "object" && !(second instanceof URL) ? second : null;
  // (url, options): options.hostname / options.host win over the URL, as in node's own request()
  if (opt && (opt.hostname || opt.host) && (typeof first === "string" || first instanceof URL)) return opt.hostname || opt.host;
  if (typeof first === "string") { try { return new URL(first).hostname; } catch { return first; } }
  if (first instanceof URL) return first.hostname;
  const o = first && typeof first === "object" ? first : opt || {};
  return o.hostname || o.host || "localhost";
}

const realFetch = global.fetch;
if (realFetch) {
  global.fetch = async (url, init) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.href : url && url.url;
    let host = u; try { host = new URL(u).hostname; } catch { /* keep raw */ }
    guard("fetch", host);
    return realFetch(url, init);
  };
}
for (const [mod, kind] of [[http, "http"], [https, "https"]]) {
  for (const fn of ["request", "get"]) {
    const orig = mod[fn];
    mod[fn] = function (...a) { guard(kind, hostOfArgs(a)); return orig.apply(this, a); };
  }
}
/** Destination host of net.connect-style arguments, or null for a unix-socket path. */
function netHost(a) {
  const first = a[0];
  if (first !== null && typeof first === "object" && !Array.isArray(first)) return first.path ? null : first.host || "localhost";
  if (typeof first === "string" && !(first.trim() !== "" && Number.isFinite(Number(first)))) return null;   // a pipe name; a numeric string is a port
  return typeof a[1] === "string" ? a[1] : "localhost";
}
const netConnect = net.connect;
net.connect = net.createConnection = function (...a) {
  const h = netHost(a); if (h !== null) guard("net", h);
  return netConnect.apply(this, a);
};
const sockConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) {
  const h = netHost(a); if (h !== null) guard("socket", h);
  return sockConnect.apply(this, a);
};
const RealClientRequest = http.ClientRequest;
http.ClientRequest = new Proxy(RealClientRequest, {
  construct(t, a, nt) { guard("http", hostOfArgs(a)); return Reflect.construct(t, a, nt); },
});
const tlsConnect = tls.connect;
tls.connect = function (...a) {
  const o = a[0];
  if (typeof o === "number") guard("tls", typeof a[1] === "string" ? a[1] : "localhost");
  else if (o && typeof o === "object") guard("tls", o.host || o.servername || "localhost");
  return tlsConnect.apply(this, a);
};

// DNS: a lookup or resolve of a non-loopback name is refused (an IP literal counts as a name here).
const dnsHost = (h) => { if (h) guard("dns", h); };
const lookup = dns.lookup;
dns.lookup = function (h, ...r) { dnsHost(h); return lookup.call(this, h, ...r); };
const plookup = dns.promises.lookup;
dns.promises.lookup = function (h, ...r) { dnsHost(h); return plookup.call(this, h, ...r); };
for (const target of [dns, dns.Resolver.prototype, dns.promises, dns.promises.Resolver.prototype]) {
  for (const k of Object.getOwnPropertyNames(target)) {
    if (!/^resolve/.test(k) || typeof target[k] !== "function") continue;
    const orig = target[k];
    target[k] = function (h, ...r) { dnsHost(h); return orig.call(this, h, ...r); };
  }
}
