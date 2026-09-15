"use strict";
const assert = require("assert/strict"), fs = require("fs"), vm = require("vm"), path = require("path");
const { build } = require("../insights");
const now = Date.now(), since = now - 2 * 3600000;
const result = build({ positions: { at: now, owner: "main", operatorGas: { low: true, eth: 0.001 } } }, { now, since });
result.attention[0].title = '<img src=x onerror="bad()">';
const elements = new Map(), events = {}, store = new Map([["lp:insights:last-visit:v1", String(since)]]);
class Element {
  constructor() { this.children = []; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, fn) { this[name] = fn; }
  set innerHTML(_) { throw new Error("insights must render external text using DOM text nodes"); }
}
const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
let failed = false, calls = [];
const context = {
  document: { getElementById: element, createElement: () => new Element(), hidden: false,
    addEventListener(name, fn) { events[name] = fn; } },
  window: { addEventListener(name, fn) { events[name] = fn; } },
  localStorage: { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) },
  location: { pathname: "/" }, Date, AbortSignal, setInterval() {},
  fetch: async url => { calls.push(url); if (failed) throw new Error("fixture failure"); return { ok: true, json: async () => result }; },
};
(async () => {
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../insights-view.js"), "utf8"), context);
  await new Promise(setImmediate);
  assert.equal(calls[0], "/api/insights?since=" + since);
  assert.equal(element("attentionitems").children[0].children[0].textContent, result.attention[0].title);
  assert.equal(element("weektable").children[0].children[1].children.length, 9);
  assert.equal(store.get("lp:insights:last-visit:v1"), String(since), "refresh does not consume visit baseline");
  await element("reload").click();
  assert.equal(calls[1], calls[0]);
  events.pagehide();
  assert.equal(store.get("lp:insights:last-visit:v1"), String(now));
  failed = true;
  await element("reload").click();
  assert.match(element("insightsfresh").textContent, /unavailable.*stale/);
  assert.match(element("weekstatus").textContent, /previous update/);
  console.log("insights UI: safe text, weekly table, fixed baseline, save-on-leave and request failure passed");
})().catch(e => { console.error(e); process.exitCode = 1; });
