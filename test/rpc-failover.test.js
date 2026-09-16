// node test/rpc-failover.test.js — failing over between a chain's public RPCs.
//
// Real local HTTP servers, not mocks: the point is to exercise the provider's
// own send path, including what ethers does with a dead socket and with a
// JSON-RPC error body. No network, no keys.
//
//  1. a dead endpoint falls through to the next one
//  2. an endpoint on the wrong chain is refused and never used
//  3. a revert is an ANSWER: it must not move us off a working endpoint
//  4. with a single URL nothing changes — the plain retrying provider is used
"use strict";
const assert = require("assert");
const http = require("http");
const { createProvider, RetryingProvider, FailoverProvider, chainIdOf } = require("../rpc");

const CHAIN = 5042;
const HEX = "0x" + CHAIN.toString(16);

/** A JSON-RPC server that answers from `handler(method, params)`. */
function serve(handler) {
  const hits = { count: 0, methods: [] };
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let payload; try { payload = JSON.parse(body); } catch { payload = {}; }
      const one = (p) => {
        hits.count++; hits.methods.push(p.method);
        const r = handler(p.method, p.params || []);
        if (r && r.__drop) { res.destroy(); return null; }         // dead socket
        if (r && r.__status) { res.writeHead(r.__status); res.end("nope"); return null; }
        if (r && r.__rpcError) return { jsonrpc: "2.0", id: p.id, error: r.__rpcError };
        return { jsonrpc: "2.0", id: p.id, result: r };
      };
      if (Array.isArray(payload)) {
        const out = payload.map(one);
        if (out.includes(null)) return;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(out));
      }
      const out = one(payload);
      if (out === null) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    resolve({ url: `http://127.0.0.1:${srv.address().port}`, hits, close: () => srv.close() });
  }));
}

const BLOCK = "0x141f48f";
const good = (method) => {
  if (method === "eth_chainId") return HEX;
  if (method === "eth_blockNumber") return BLOCK;
  return "0x0";
};

(async () => {
  // ---- 1. a dead endpoint falls through -----------------------------------
  {
    const dead = await serve(() => ({ __drop: true }));   // accepts, then kills the socket
    const alive = await serve(good);
    const logs = [];
    const p = createProvider(
      { rpcUrl: dead.url, rpcUrls: [dead.url, alive.url], chainId: CHAIN },
      { log: (m) => logs.push(m) },
    );
    assert.ok(p instanceof FailoverProvider, "two urls give a failover provider");

    const n = await p.getBlockNumber();
    assert.strictEqual(n, Number(BigInt(BLOCK)), "the read succeeds from the second endpoint");
    assert.strictEqual(p.rpcStats.failovers, 1, "exactly one failover");
    assert.strictEqual(p.rpcStats.endpoint, alive.url, "and it is now on the live endpoint");
    assert.ok(logs.some((l) => l.includes("failing over to") && l.includes(alive.url)),
      "the move is logged, naming where it went: an outage must be visible");
    assert.ok(alive.hits.methods.includes("eth_chainId"),
      "the fallback was asked what chain it is before being used");
    dead.close(); alive.close();
  }

  // ---- 2. the wrong chain is refused --------------------------------------
  {
    const dead = await serve(() => ({ __drop: true }));
    const wrongChain = await serve((m) => (m === "eth_chainId" ? "0x1" : BLOCK)); // mainnet, not Arc
    const right = await serve(good);
    const logs = [];
    const p = createProvider(
      { rpcUrls: [dead.url, wrongChain.url, right.url], chainId: CHAIN },
      { log: (m) => logs.push(m) },
    );

    const n = await p.getBlockNumber();
    assert.strictEqual(n, Number(BigInt(BLOCK)));
    assert.strictEqual(p.rpcStats.endpoint, right.url, "it skipped the impostor and landed on the right chain");
    assert.ok(logs.some((l) => l.includes("refusing") && l.includes(wrongChain.url) && l.includes("expected " + CHAIN)),
      "and said which endpoint it refused, and why");
    // The wrong-chain endpoint answered eth_chainId and then was never used again.
    assert.ok(!wrongChain.hits.methods.includes("eth_blockNumber"),
      "no read was ever served by the endpoint on the wrong chain");

    // And it stays refused: a later outage must not send us back to probe it.
    const probesBefore = wrongChain.hits.count;
    p._active = 0;                       // pretend we are back on the dead primary
    await p._failover("a second outage");
    assert.strictEqual(wrongChain.hits.count, probesBefore,
      "a refused endpoint is not re-probed on a later failure — the rejection sticks");
    assert.strictEqual(p.rpcStats.endpoint, right.url, "and we land on the good endpoint again");
    dead.close(); wrongChain.close(); right.close();
  }

  // ---- 3. a revert is an answer, not an outage -----------------------------
  {
    const reverting = await serve((m) => {
      if (m === "eth_chainId") return HEX;
      if (m === "eth_call") return { __rpcError: { code: 3, message: "execution reverted", data: "0x" } };
      return BLOCK;
    });
    const spare = await serve(good);
    const logs = [];
    const p = createProvider({ rpcUrls: [reverting.url, spare.url], chainId: CHAIN }, { log: (m) => logs.push(m) });

    await assert.rejects(
      () => p.call({ to: "0x" + "11".repeat(20), data: "0x12345678" }),
      "the revert reaches the caller",
    );
    assert.strictEqual(p.rpcStats.failovers, 0, "a revert never moves us off a working endpoint");
    assert.strictEqual(p.rpcStats.endpoint, reverting.url, "still on the first endpoint");
    assert.strictEqual(spare.hits.count, 0, "the spare was never touched");
    assert.ok(!logs.some((l) => l.includes("failing over")), "and nothing was logged as an outage");
    // Nor is it retried: a revert is a settled answer, so asking again only
    // costs time and can look like load to the endpoint.
    assert.strictEqual(p.rpcStats.retries, 0, "a revert is not retried");
    assert.strictEqual(
      reverting.hits.methods.filter((m) => m === "eth_call").length, 1,
      "the reverting call was made exactly once",
    );
    reverting.close(); spare.close();
  }

  // ---- 4. one url behaves exactly as before -------------------------------
  {
    const only = await serve(good);
    const p = createProvider({ rpcUrl: only.url, chainId: CHAIN });
    assert.ok(p instanceof RetryingProvider && !(p instanceof FailoverProvider),
      "a single endpoint keeps the plain retrying provider: unchanged behaviour");
    assert.strictEqual(await p.getBlockNumber(), Number(BigInt(BLOCK)));
    only.close();

    // An empty or absent rpcUrls falls back to rpcUrl, not to nothing.
    const q = createProvider({ rpcUrl: "http://127.0.0.1:1", rpcUrls: [], chainId: CHAIN });
    assert.ok(!(q instanceof FailoverProvider));
  }

  // ---- 5. chainIdOf is honest about an endpoint that will not answer -------
  {
    assert.strictEqual(await chainIdOf("http://127.0.0.1:1", 1500), null,
      "an endpoint that refuses the connection reports no chain id, never a guess");
  }

  console.log("rpc-failover: dead endpoint falls through, wrong chain refused, a revert never fails over, single url unchanged — all assertions passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
