// node test/collector-scope.test.js — every identifier the collector reads is in scope.
//
// On 2026-09-18 a one-line cosmetic change ("gas … ETH" -> the chain's own currency)
// used nat() and NATIVE inside runOwner(). Both are declared in main(). That is valid
// syntax, passes `node --check`, and throws ReferenceError the first time a collect
// succeeds — after the transaction is mined. The collect was recorded as a failure,
// its fee tokens were never swapped, and 99.4 ARGUS sat in the operator wallet until
// it was swept by hand.
//
// A text search cannot catch it: `nat` IS declared in the file, just in a scope that
// does not reach the use site. So this walks the real syntax tree, builds the scope
// chain, and fails on any read that resolves to nothing.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const walk = require("acorn-walk");

const ROOT = path.join(__dirname, "..");
// Discovered, not listed. A hand-kept list only protects the files someone
// remembered to add, and the bug this exists for was in a file that was on the list
// only because it had already bitten. Every .js the repo ships is checked.
const IGNORE = /^(node_modules|backups|themes|\.claude|vm|brain|agent-memory|test)\//;
function discover(dir = ".", out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir === "." ? e.name : `${dir}/${e.name}`;
    if (IGNORE.test(rel + "/") || e.name.startsWith(".")) continue;
    if (e.isDirectory()) discover(rel, out);
    else if (e.name.endsWith(".js") && !e.name.endsWith(".min.js")) out.push(rel);
  }
  return out;
}
const FILES = discover().sort();

// One source of truth for what a global is: the lint config the repo already has.
const lintConfig = require("../eslint.config.js");
const globalsFor = (file) => {
  const names = new Set(Object.getOwnPropertyNames(globalThis));
  for (const block of lintConfig) {
    const pats = block.files || [];
    const applies = !block.files || pats.some((p) => p === file || (p === "**/*.js" && file.endsWith(".js")) || (p === "**/*.mjs" && file.endsWith(".mjs")));
    if (applies && block.languageOptions && block.languageOptions.globals) {
      for (const g of Object.keys(block.languageOptions.globals)) names.add(g);
    }
  }
  return names;
};

/** Declarations introduced directly by a node, into the scope it belongs to. */
function patternNames(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case "Identifier": out.push(node.name); break;
    case "ObjectPattern": for (const p of node.properties) patternNames(p.type === "RestElement" ? p.argument : p.value, out); break;
    case "ArrayPattern": for (const e of node.elements) patternNames(e, out); break;
    case "AssignmentPattern": patternNames(node.left, out); break;
    case "RestElement": patternNames(node.argument, out); break;
    default: break;
  }
  return out;
}

function analyse(file, host = new Set(Object.getOwnPropertyNames(globalThis))) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8").replace(/^#![^\n]*\n/, "\n");
  const ast = acorn.parse(src, { ecmaVersion: 2023, sourceType: "script", locations: true, allowReturnOutsideFunction: true });

  // scope: { parent, names:Set, node }
  const scopes = new Map();
  const makeScope = (node, parent) => { const s = { parent, names: new Set(), node }; scopes.set(node, s); return s; };
  const root = makeScope(ast, null);

  const isFn = (n) => n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression";
  const scopeOf = (ancestors) => {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const s = scopes.get(ancestors[i]);
      if (s) return s;
    }
    return root;
  };

  // Scopes are built in pre-order, with the current scope carried as the walk state.
  // acorn-walk's ancestor() fires visitors AFTER a node's children, so building them
  // there gave every nested scope the wrong parent and made parameters look unbound.
  const enter = (node, st) => makeScope(node, st);
  const descend = (node, st, c) => walk.base[node.type](node, st, c);
  const fnScope = (node, st, c) => {
    if (node.id) st.names.add(node.id.name);
    const s = enter(node, st);
    for (const p of node.params) for (const n of patternNames(p)) s.names.add(n);
    s.names.add("arguments");
    descend(node, s, c);
  };
  const blockScope = (node, st, c) => descend(node, enter(node, st), c);

  walk.recursive(ast, root, {
    FunctionDeclaration: fnScope,
    FunctionExpression: fnScope,
    ArrowFunctionExpression: fnScope,
    BlockStatement: blockScope,
    ForStatement: blockScope,
    ForOfStatement: blockScope,
    ForInStatement: blockScope,
    CatchClause(node, st, c) {
      const s = enter(node, st);
      for (const n of patternNames(node.param)) s.names.add(n);
      descend(node, s, c);
    },
    VariableDeclaration(node, st, c) {
      // var hoists to the nearest function scope; let/const stay in this block.
      let s = st;
      if (node.kind === "var") while (s.parent && !isFn(s.node) && s.node.type !== "Program") s = s.parent;
      for (const d of node.declarations) for (const n of patternNames(d.id)) s.names.add(n);
      descend(node, st, c);
    },
    ClassDeclaration(node, st, c) { if (node.id) st.names.add(node.id.name); descend(node, st, c); },
  });

  // Second pass: every identifier that is read, resolved up the chain.
  const unresolved = [];
  walk.ancestor(ast, {
    Identifier(node, _st, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      if (!parent) return;
      // Skip anything that is not a variable read.
      if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return;
      if (parent.type === "Property" && parent.key === node && !parent.computed) return;
      if (parent.type === "MethodDefinition" && parent.key === node) return;
      if ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression" || parent.type === "ClassDeclaration") && parent.id === node) return;
      if (parent.type === "VariableDeclarator" && parent.id === node) return;
      if (parent.type === "AssignmentPattern" && parent.left === node) return;
      if (parent.type === "Property" && parent.value === node && ancestors.some((a) => a.type === "ObjectPattern")) return;
      if (ancestors.some((a) => a.type === "ObjectPattern" || a.type === "ArrayPattern")) return;
      if (isFn(parent) && parent.params.includes(node)) return;
      if (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") return;

      let s = scopeOf(ancestors.slice(0, -1));
      for (; s; s = s.parent) if (s.names.has(node.name)) return;
      if (host.has(node.name)) return;
      unresolved.push(`${node.name} (${file}:${node.loc.start.line})`);
    },
  });
  return unresolved;
}

let checked = 0;
for (const file of FILES) {
  const bad = analyse(file, globalsFor(file));
  checked++;
  assert.deepStrictEqual(bad, [], `${file} reads identifiers that are not in scope there:\n  ${bad.join("\n  ")}`);
}

// The check has to be able to see the original bug, or it proves nothing.
{
  const tmp = path.join(ROOT, ".scope-probe.js");
  fs.writeFileSync(tmp, `
function main() { const nat = (v) => String(v); const NATIVE = "USDC"; return runOwner(); }
function runOwner() { console.log(\`gas \${nat(1n)} \${NATIVE}\`); }
`);
  try {
    const found = analyse(".scope-probe.js");
    assert.ok(found.some((f) => f.startsWith("nat ")) && found.some((f) => f.startsWith("NATIVE ")),
      `the check missed the very bug it exists for: ${JSON.stringify(found)}`);
  } finally { fs.unlinkSync(tmp); }
}

// And the receipt line is now a function of its arguments.
{
  const { gasLine } = require("../collector-logic");
  assert.strictEqual(gasLine(21442248, 2504276420692992n, { nativeCurrency: { symbol: "USDC", decimals: 18 } }),
    "  confirmed in block 21442248, gas 0.002504276420692992 USDC", "Arc pays gas in USDC and the receipt says so");
  assert.match(gasLine(1, 1000000000000000n, {}), /0\.001 ETH$/, "an unverified native asset falls back to ether");
  const collector = fs.readFileSync(path.join(ROOT, "collector.js"), "utf8");
  // Only the gas variant is the one that reached for another function's locals;
  // plain "confirmed in block N" lines carry no currency and are fine inline.
  assert.ok(!/confirmed in block \$\{[^}]*\}, gas/.test(collector), "no inline gas-receipt line survives in collector.js");
  assert.strictEqual((collector.match(/cl\.gasLine\(/g) || []).length, 2, "both receipt sites call the shared function");
}

console.log(`collector scope: ${checked} discovered file(s) — every identifier resolves in the scope that reads it (checked against the original bug), and the gas receipt takes its arguments`);
