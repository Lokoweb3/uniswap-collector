// node test/table-filter-duplication.test.js — one filter bar per table, however many
// times the table is re-rendered.
//
// The dashboard rewrites tables with innerHTML on every refresh, which replaces the
// table element and takes its data-tfid with it. The control bar was looked up by
// that id, found nothing, and built another — while the previous bar stayed behind,
// because it is a sibling of the table rather than a child of it. Every refresh added
// one, and the page ended up carrying twenty-one identical "Filter rows" boxes, each
// claiming "Showing 12 of 32 rows".
//
// dashboard.js is browser code and there is no DOM here, so this builds the smallest
// document the control needs: enough to place elements, find them by class, and
// replace a table the way a refresh does.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---- the smallest DOM this control needs -------------------------------------
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.className = "";
    this.dataset = {};
    this.hidden = false;
    this.textContent = "";
    this.rows = [];
    this._listeners = {};
  }
  get classes() { return String(this.className).split(/\s+/).filter(Boolean); }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parentElement = this;
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    return c;
  }
  remove() {
    if (!this.parentElement) return;
    const i = this.parentElement.children.indexOf(this);
    if (i >= 0) this.parentElement.children.splice(i, 1);
    this.parentElement = null;
  }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  get descendants() { return this.children.flatMap((c) => [c, ...c.descendants]); }
  // Enough CSS for the selectors this control uses: comma groups, "tag.class"
  // compounds, and descendant steps like ".etablewrap table".
  matchesStep(step) {
    // [data-tfilter="tf1"] matters: it is how the control used to find its bar, and
    // a shim that matched it against everything would hide the very bug under test.
    const attrs = [...step.matchAll(/\[([\w-]+)="([^"]*)"\]/g)];
    const bare = step.replace(/\[[^\]]*\]/g, "");
    const tag = (bare.match(/^[a-zA-Z]+/) || [""])[0];
    const classes = (bare.match(/\.[\w-]+/g) || []).map((c) => c.slice(1));
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (!classes.every((c) => this.classes.includes(c))) return false;
    return attrs.every(([, name, value]) => {
      const key = name.startsWith("data-")
        ? name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        : null;
      return key ? this.dataset[key] === value : false;
    });
  }
  matches(sel) {
    return sel.split(",").map((s) => s.trim()).filter(Boolean).some((group) => {
      const steps = group.split(/\s+/);
      if (!this.matchesStep(steps[steps.length - 1])) return false;
      let node = this.parentElement;
      for (let i = steps.length - 2; i >= 0; i--) {
        while (node && !node.matchesStep(steps[i])) node = node.parentElement;
        if (!node) return false;
        node = node.parentElement;
      }
      return true;
    });
  }
  querySelectorAll(sel) { return this.descendants.filter((d) => d.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) {
    let n = this;
    while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentElement; }
    return null;
  }
  // The control sets innerHTML once, with a string this test knows the shape of.
  set innerHTML(html) {
    this.children = [];
    for (const [re, tag, cls] of [
      [/<label[^>]*>/, "label", ""], [/<input[^>]*>/, "input", ""],
      [/class="tcount"/, "span", "tcount"], [/class="tnone"/, "span", "tnone"],
      [/class="tmore"/, "button", "tmore"],
    ]) if (re.test(html)) { const e = new El(tag); e.className = cls; e.setAttribute = () => {}; this.appendChild(e); }
  }
  get innerHTML() { return ""; }
  setAttribute() {}
}

function makeDoc(rowCount) {
  const doc = new El("body");
  doc.readyState = "complete";
  const wrap = new El("div"); wrap.className = "etablewrap";
  doc.appendChild(wrap);
  const mkTable = () => {
    const t = new El("table"); t.className = "etable";
    const tbody = new El("tbody"); t.appendChild(tbody);
    t.rows = Array.from({ length: rowCount }, () => { const r = new El("tr"); r.parentElement = tbody; r.textContent = "x"; return r; });
    return t;
  };
  doc.createElement = (tag) => new El(tag);
  return { doc, wrap, mkTable };
}

// ---- run the control against it ----------------------------------------------
const src = fs.readFileSync(path.join(__dirname, "..", "dashboard.js"), "utf8");
const start = src.indexOf("(function longTableDisclosure(){");
assert.ok(start >= 0, "longTableDisclosure is gone from dashboard.js");
const end = src.indexOf("\n})();", start) + "\n})();".length;
const iife = src.slice(start, end);

function run(rowCount) {
  const { doc, wrap, mkTable } = makeDoc(rowCount);
  let observerCb = null;
  const document = {
    readyState: "complete",
    createElement: (t) => new El(t),
    querySelectorAll: (sel) => doc.querySelectorAll(sel),
    addEventListener: () => {},
    body: doc,
    documentElement: doc,
  };
  const sandbox = {
    document,
    requestAnimationFrame: (fn) => fn(),          // scan synchronously
    MutationObserver: class { constructor(cb) { observerCb = cb; } observe() {} disconnect() {} },
  };
  let table = mkTable();
  wrap.appendChild(table);
  new Function("document", "requestAnimationFrame", "MutationObserver", iife)(
    sandbox.document, sandbox.requestAnimationFrame, sandbox.MutationObserver);
  const rerender = () => {                        // what innerHTML does to a table
    table.remove();
    table = mkTable();
    (doc.querySelector(".etablewrap") || wrap).appendChild(table);
    // The real observer ignores its own writes and only reschedules on a record it
    // did not cause, so an empty list would do nothing: hand it a childList change
    // on the wrapper, which is what replacing a table actually produces.
    if (observerCb) observerCb([{ type: "childList", target: wrap }]);
  };
  const bars = () => doc.querySelectorAll(".tfilter");
  const notes = () => doc.querySelectorAll(".tscope");
  return { doc, bars, notes, rerender, table: () => table };
}

// ---- 1. a long table gets exactly one set of controls -------------------------
{
  const t = run(32);
  assert.strictEqual(t.bars().length, 1, "one filter bar");
  assert.strictEqual(t.notes().length, 1, "and one scope note");
}

// ---- 2. re-rendering the table does not add another ---------------------------
{
  const t = run(32);
  for (let i = 0; i < 20; i++) t.rerender();
  assert.strictEqual(t.bars().length, 1,
    `still one filter bar after twenty refreshes, not ${t.bars().length}`);
  assert.strictEqual(t.notes().length, 1, "and still one scope note");
  // The controls must be pointing at the table that is actually on the page now,
  // or they would filter a detached one and appear to do nothing.
  assert.strictEqual(t.bars()[0]._table, t.table(), "the bar follows the current table");
  assert.strictEqual(t.bars()[0].dataset.tfilter, t.table().dataset.tfid, "and is tied to its id");
}

// ---- 3. a short table has no controls at all ----------------------------------
{
  const t = run(4);
  assert.strictEqual(t.bars().length, 0, "a table below the threshold gets no filter");
  for (let i = 0; i < 5; i++) t.rerender();
  assert.strictEqual(t.bars().length, 0, "and still none after refreshes");
}

console.log("table filter: one set of controls per table, kept and re-pointed across re-renders rather than stacked");
