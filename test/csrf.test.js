"use strict";
const assert = require("assert");
const { isCrossSite, needsJson } = require("../csrf");

const PUB = "lp-dashboard.example.ts.net";
const cases = [
  ["script, no headers", {}, false],
  ["script through the gate", { viaGate: true }, false],
  ["own page on 127.0.0.1", { origin: "http://127.0.0.1:8787", host: "127.0.0.1:8787" }, false],
  ["own page on localhost", { origin: "http://localhost:8787", host: "localhost:8787", secFetchSite: "same-origin" }, false],
  ["other host", { origin: "https://evil.example", host: "127.0.0.1:8787", secFetchSite: "cross-site" }, true],
  ["other host, no sec-fetch", { origin: "https://evil.example", host: "127.0.0.1:8787" }, true],
  ["other port on loopback", { origin: "http://127.0.0.1:3847", host: "127.0.0.1:8787" }, true],
  ["null origin (sandboxed frame)", { origin: "null", host: "127.0.0.1:8787" }, true],
  ["malformed origin", { origin: "not a url", host: "127.0.0.1:8787" }, true],
  ["sec-fetch cross-site without origin", { secFetchSite: "cross-site" }, true],
  ["gate: public host origin, host rewritten", { origin: `https://${PUB}:8443`, host: "127.0.0.1:8787", viaGate: true, publicHost: PUB }, false],
  ["gate: public host resolved lazily", { origin: `https://${PUB}:8443`, host: "127.0.0.1:8787", viaGate: true, publicHost: () => PUB + "." }, false],
  ["gate: public host unknown, not cross-site", { origin: `https://${PUB}:8443`, host: "127.0.0.1:8787", viaGate: true, publicHost: null }, false],
  ["gate: public host unknown, cross-site marker", { origin: "https://evil.example", host: "127.0.0.1:8787", viaGate: true, secFetchSite: "cross-site", publicHost: null }, true],
  ["tailnet serve on 8444 (no gate)", { origin: `https://${PUB}:8444`, host: `${PUB}:8444`, publicHost: PUB }, false],
  ["tailnet name as origin, host loopback (serve rewrote it)", { origin: `https://${PUB}:8444`, host: "127.0.0.1:8787", publicHost: PUB }, false],
];
for (const [name, h, want] of cases) assert.equal(isCrossSite(h), want, `isCrossSite: ${name}`);

assert.equal(needsJson({}), false, "script: no content-type needed");
assert.equal(needsJson({ origin: "http://127.0.0.1:8787" }), false, "browser, empty body (lock/collect buttons)");
assert.equal(needsJson({ origin: "http://127.0.0.1:8787", contentLength: "12", contentType: "application/json" }), false, "browser json");
assert.equal(needsJson({ origin: "http://127.0.0.1:8787", contentLength: "12", contentType: "application/json; charset=utf-8" }), false, "browser json with charset");
assert.equal(needsJson({ origin: "http://127.0.0.1:8787", contentLength: "12", contentType: "text/plain" }), true, "browser text/plain body");
assert.equal(needsJson({ origin: "http://127.0.0.1:8787", transferEncoding: "chunked" }), true, "browser chunked body, no type");

console.log("csrf: origin / sec-fetch-site / gate / json-body assertions passed");
