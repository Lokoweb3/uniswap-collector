"use strict";
/**
 * Lint config with one job: catch identifiers that are read but never bound.
 *
 * On 2026-09-18 a cosmetic edit used nat() and NATIVE inside runOwner(); both are
 * declared in main(). Valid syntax, clean `node --check`, and a ReferenceError the
 * first time a collect succeeded -- after the transaction was mined. Three more of
 * the same shape were already in the file. Nothing in the repo could have found
 * them, because a text search sees the declaration and cannot tell it is out of
 * reach.
 *
 * So no-undef is the point, and everything else is off: this is a safety net, not a
 * style pass on 20k lines of working code.
 */
const NODE_GLOBALS = {
  require: "readonly", module: "writable", exports: "writable", process: "readonly",
  console: "readonly", Buffer: "readonly", __dirname: "readonly", __filename: "readonly",
  setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly",
  setImmediate: "readonly", queueMicrotask: "readonly", fetch: "readonly", URL: "readonly",
  URLSearchParams: "readonly", TextEncoder: "readonly", TextDecoder: "readonly", AbortController: "readonly",
  structuredClone: "readonly", performance: "readonly", global: "readonly", globalThis: "readonly",
  AbortSignal: "readonly", crypto: "readonly", Response: "readonly", Request: "readonly",
};
// The four files the server hands to the page run in a browser, with ethers loaded
// from a script tag rather than required.
const BROWSER_GLOBALS = {
  window: "readonly", document: "readonly", location: "readonly", navigator: "readonly",
  fetch: "readonly", console: "readonly", localStorage: "readonly", sessionStorage: "readonly",
  setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly",
  requestAnimationFrame: "readonly", cancelAnimationFrame: "readonly", alert: "readonly",
  confirm: "readonly", prompt: "readonly", URL: "readonly", URLSearchParams: "readonly",
  Blob: "readonly", File: "readonly", FileReader: "readonly", FormData: "readonly", Image: "readonly",
  MouseEvent: "readonly", Event: "readonly", CustomEvent: "readonly", HTMLAnchorElement: "readonly",
  getComputedStyle: "readonly", matchMedia: "readonly", structuredClone: "readonly",
  ethers: "readonly", QRCode: "readonly", Chart: "readonly", globalThis: "readonly",
  MutationObserver: "readonly", ResizeObserver: "readonly", IntersectionObserver: "readonly",
  crypto: "readonly", self: "readonly", AbortSignal: "readonly", AbortController: "readonly",
  Node: "readonly", HTMLElement: "readonly", SVGElement: "readonly", DOMParser: "readonly",
};

module.exports = [
  {
    ignores: ["node_modules/**", "backups/**", "themes/**", ".claude/**", "vm/**", "brain/**", "agent-memory/**", "**/*.min.js"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: NODE_GLOBALS,
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: { "no-undef": "error" },
  },
  {
    files: ["dashboard.js", "chat-widget.js", "insights-view.js", "qr.js"],
    languageOptions: { sourceType: "script", globals: BROWSER_GLOBALS },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { sourceType: "module", globals: NODE_GLOBALS },
  },
];
