// node test/rpc-batching.test.js — a chain can turn JSON-RPC batching off, and
// the switch has to reach every endpoint the failover provider may move to.
//
// Arc's endpoints accept a batched eth_call and answer it wrongly: some entries
// come back with empty data, which ethers reports as "missing revert data", and
// a fee sub-call can come back empty while the rest of the position loads — a
// position that looks fine but claims no uncollected fees. One request per call
// fixes it. Every other chain keeps batching, so this must be opt-in.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rpcbatch-"));
process.env.LP_DATA_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const { createProvider } = require("../rpc");

const ARC = {
  chainId: 5042,
  rpcUrls: ["https://a.example/rpc", "https://b.example/rpc", "https://c.example/rpc"],
};
const ROBINHOOD = { chainId: 4663, rpcUrls: ["https://one.example/rpc", "https://two.example/rpc"] };

// ---- 1. opt in: batching off, and the provider says so ----------------------
{
  const p = createProvider({ ...ARC, rpcBatch: false });
  assert.strictEqual(p._getOption("batchMaxCount"), 1, "rpcBatch:false must send one request per call");
}

// ---- 2. the default is untouched for every other chain ----------------------
{
  const p = createProvider(ROBINHOOD);
  assert.notStrictEqual(p._getOption("batchMaxCount"), 1,
    "a chain that did not ask for it must keep ethers' batching");
  const explicit = createProvider({ ...ROBINHOOD, rpcBatch: true });
  assert.notStrictEqual(explicit._getOption("batchMaxCount"), 1, "rpcBatch:true is the default, not a no-batch flag");
}

// ---- 3. a single-endpoint chain honours it too -------------------------------
{
  const p = createProvider({ chainId: 5042, rpcUrl: "https://solo.example/rpc", rpcBatch: false });
  assert.strictEqual(p._getOption("batchMaxCount"), 1, "the non-failover provider must honour it as well");
}

// ---- 4. it survives a failover to a later endpoint ---------------------------
// FailoverProvider keeps one JsonRpcProvider and swaps the URL in
// _getConnection(). If that ever changes to a provider per endpoint, this fails.
{
  const p = createProvider({ ...ARC, rpcBatch: false });
  const first = p._getConnection().url;
  p._active = 2; // pretend two endpoints have already failed
  const third = p._getConnection().url;
  assert.strictEqual(first, ARC.rpcUrls[0], "starts on the first endpoint");
  assert.strictEqual(third, ARC.rpcUrls[2], "moves to the third");
  assert.strictEqual(p._getOption("batchMaxCount"), 1,
    "batching must stay off after failing over, not just on the first endpoint");
}

// ---- 5. an explicit caller option still wins ---------------------------------
{
  const p = createProvider({ ...ARC, rpcBatch: false }, { batchMaxCount: 5 });
  assert.strictEqual(p._getOption("batchMaxCount"), 5, "a caller that asks for a batch size gets it");
}

// ---- 6. the setting survives the settings loader -----------------------------
// createProvider is handed the flat object settings.js builds, not the raw file.
// A key that is not carried across never reaches the provider — which is exactly
// how the first attempt at this fix did nothing.
{
  const flat = require("../settings").flatten
    ? require("../settings").flatten({ chain: { rpcUrl: "https://x.example", chainId: 5042, rpcBatch: false } })
    : null;
  if (flat) {
    assert.strictEqual(flat.rpcBatch, false, "settings.js must carry rpcBatch into the flat object");
  } else {
    // No exported flatten: assert on the source instead, so the guarantee is still held.
    const src = fs.readFileSync(path.join(__dirname, "..", "settings.js"), "utf8");
    assert.ok(/rpcBatch/.test(src), "settings.js does not mention rpcBatch, so it cannot reach createProvider");
    assert.ok(/chain\.rpcBatch === false/.test(src), "settings.js must pass rpcBatch through explicitly");
  }
}

console.log("rpc batching: a chain can switch it off, it reaches every failover endpoint, and no other chain changes");
