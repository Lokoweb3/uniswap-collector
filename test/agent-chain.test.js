// node test/agent-chain.test.js — the assistant knows which chain it is reading.
//
// One dashboard runs per chain from this same code, and the system prompt named
// "Robinhood Chain (chain id 4663)" as a constant. Asked directly, the Arc
// assistant answered "Robinhood Chain, chain ID 4663" while reading Arc's data —
// an assistant wrong about which chain it is looking at will be confidently wrong
// about every figure it reports, and the two chains hold different money.
//
// It must also not pretend to cover the chain it cannot see: each instance reads
// one chain, and "I don't have that, the other dashboard does" is the honest answer.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "agent.js"), "utf8");
const agent = require("../agent");

// The prompt is built from config, so no chain may be spelled into the source.
{
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(!/Robinhood/.test(code), "no chain name is hardcoded in the agent");
  assert.ok(!/\b4663\b|\b5042\b/.test(code), "no chain id is hardcoded in the agent");
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chain-"));
const systemFor = (chain) => agent.create({ port: 0, dir, chain }).SYSTEM;

// ---- 1. each instance names its own chain -------------------------------------
{
  const arc = systemFor({ id: 5042, name: "Arc" });
  assert.ok(/on Arc \(chain id 5042\)/.test(arc), `Arc names itself: ${arc.slice(0, 160)}`);
  assert.ok(!/Robinhood|4663/.test(arc), "and says nothing about the other chain's identity");

  const rh = systemFor({ id: 4663, name: "Robinhood Chain" });
  assert.ok(/on Robinhood Chain \(chain id 4663\)/.test(rh), "Robinhood names itself");
  assert.ok(!/Arc \(chain|5042/.test(rh), "and not the other");

  // A third chain needs no code change to be described correctly.
  assert.ok(/on Testnet Zero \(chain id 9999\)/.test(systemFor({ id: 9999, name: "Testnet Zero" })));
}

// ---- 2. a chain that cannot name itself is not given a name -------------------
{
  // Guessing here is how the wrong chain got asserted in the first place.
  const unnamed = systemFor({ id: 7777, name: null });
  assert.ok(/on chain id 7777/.test(unnamed), `the id alone is enough: ${unnamed.slice(0, 160)}`);
  assert.ok(!/chain 7777 \(chain id 7777\)/.test(unnamed), "and is not said twice");

  const nothing = systemFor(undefined);
  assert.ok(/has not named it; say so rather than guessing/.test(nothing),
    "with nothing configured it is told to say so, not to pick a chain");
  assert.ok(!/\(chain id \)/.test(nothing), "and no empty id is rendered");
}

// ---- 3. it must not answer for a chain it cannot read --------------------------
{
  const arc = systemFor({ id: 5042, name: "Arc" });
  assert.ok(/cannot see any other chain's positions, wallets or vault/.test(arc),
    "the assistant is told the limits of what it can read");
  assert.ok(/say which chain you cover and that the other has its own dashboard/.test(arc),
    "and what to say when asked about another chain, rather than inventing an answer");
}

// ---- 4. the role text still follows the chain line -----------------------------
{
  const arc = agent.create({ port: 0, dir, chain: { id: 5042, name: "Arc" } });
  assert.ok(arc.SYSTEM.length > 500, "the rest of the prompt survived the change");
  assert.ok(/READ-ONLY/.test(arc.ROLE_TEXT.read), "role text is unchanged");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("agent chain: each instance names the chain it actually reads, an unnamed chain is not guessed at, and the assistant is told it cannot see the others");
