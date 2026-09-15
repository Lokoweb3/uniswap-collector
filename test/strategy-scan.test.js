// node test/strategy-scan.test.js — a disposal whose receipt is unavailable is retried on the
// next scan instead of being skipped for good: the watermark stops before that log (TASK-88).
// Blockscout, the RPC provider and the dashboard are stubbed; nothing leaves the process.
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { ethers } = require("ethers");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-scan88-"));
const owner = "0x00000000000000000000000000000000000000a1", trading = "0x00000000000000000000000000000000000000a2";
const LAPTOP = "0x00000000000000000000000000000000000000c1", ROUTER = "0x00000000000000000000000000000000000000d1";
const TX = "0x" + "44".repeat(32);
fs.writeFileSync(path.join(dir, "collector.log"), [
  `[2026-09-11T20:17:00.000Z] --- Trading (${trading}) ---`,
  `[2026-09-11T20:17:13.187Z]   ! could not quote LAPTOP on a v3 pool; sending 100 LAPTOP to ${trading} as-is`,
  `[2026-09-11T20:17:18.718Z]   sent LAPTOP -> ${trading} -> 0x${"ef".repeat(32)}`, "",
].join("\n"));
fs.writeFileSync(path.join(dir, "price-log.json"), JSON.stringify({ hours: { [String(Date.parse("2026-09-12T20:00:00Z"))]: { eth: 2400, [LAPTOP]: 2.0 } } }));
fs.writeFileSync(path.join(dir, "token-disposals.json"), JSON.stringify({ lastBlock: {}, rows: [] }));
fs.writeFileSync(path.join(dir, "token-sales.json"), "[]");
fs.writeFileSync(path.join(dir, "v4-collects.json"), "[]");

// Stubs: Blockscout getLogs (one outbound transfer at block 11 to a contract), RPC (contract code,
// receipt unavailable on the first scan, empty receipt on the second).
const queries = [];
let receiptAvailable = false;
const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const log11 = { transactionHash: TX, logIndex: "0x1", blockNumber: "0xb", timeStamp: ethers.toBeHex(Math.floor(Date.parse("2026-09-12T20:30:00Z") / 1000)),
  topics: [TRANSFER, ethers.zeroPadValue(trading, 32), ethers.zeroPadValue(ROUTER, 32)], data: ethers.toBeHex(ethers.parseUnits("150", 18), 32) };
require.cache[require.resolve("../blockscout")] = { id: require.resolve("../blockscout"), filename: require.resolve("../blockscout"), loaded: true, exports: {
  bsFetch: async (q) => { queries.push(q); const isSent = /topic1=/.test(q) && !/topic2=/.test(q) && q.includes(ethers.zeroPadValue(trading, 32).slice(2)); const from = Number((q.match(/fromBlock=(\d+)/) || [])[1]);
    return { json: async () => ({ result: isSent && from <= 11 ? [log11] : [] }) }; },
} };
require.cache[require.resolve("../rpc")] = { id: require.resolve("../rpc"), filename: require.resolve("../rpc"), loaded: true, exports: {
  createProvider: () => ({ getCode: async () => "0x6001", getTransactionReceipt: async () => (receiptAvailable ? { logs: [] } : null) }),
} };

const base = { ok: true, rows: [], positions: [{ symbol0: "LAPTOP", token0: { address: LAPTOP, decimals: 18 }, symbol1: "ETH", token1: { address: ethers.ZeroAddress, decimals: 18 } }], wallets: [{ label: "Trading", address: trading, holdings: { tokens: [] }, positions: [] }] };
const srv = http.createServer((req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(base)); });
srv.listen(0, "127.0.0.1", async () => {
  try {
    const cfg = { ownerAddress: owner, contracts: { weth: "0x00000000000000000000000000000000000000ee", positionManager: "0x00000000000000000000000000000000000000f1" }, usdReference: { stable: "0x00000000000000000000000000000000000000dd" } };
    const strategy = require("../strategy").create({ cfg, dir, port: srv.address().port });
    await strategy.scanDisposals({ ownAddresses: [trading] });
    let st = JSON.parse(fs.readFileSync(path.join(dir, "token-disposals.json"), "utf8"));
    const key = `${LAPTOP}:${trading}`;
    console.log("scan 1:", JSON.stringify(st.lastBlock), "rows", st.rows.length, "queries", queries.length, "| first sent query:", (queries.find((q) => /topic1=/.test(q) && !/topic2=/.test(q)) || "none").slice(0, 60));
    assert.strictEqual(st.rows.length, 0, "receipt unavailable: no row yet");
    assert.strictEqual(Number(st.lastBlock[key]), 10, `watermark stops before the unresolved log (block 11), got ${st.lastBlock[key]}`);
    receiptAvailable = true;
    await strategy.scanDisposals({ ownAddresses: [trading] });
    const second = queries.filter((q) => /topic1=/.test(q) && !/topic2=/.test(q) && q.includes(ethers.zeroPadValue(trading, 32).slice(2))).pop();
    assert.match(second, /fromBlock=11&/, "the next scan starts AT the unresolved block");
    st = JSON.parse(fs.readFileSync(path.join(dir, "token-disposals.json"), "utf8"));
    assert.strictEqual(st.rows.length, 1, "exactly one row once the receipt is available");
    assert.strictEqual(st.rows[0].kind, "sent"); assert.strictEqual(st.rows[0].tx, TX);
    assert.strictEqual(Number(st.lastBlock[key]), 11, "watermark advances past it afterwards");
    await strategy.scanDisposals({ ownAddresses: [trading] });
    st = JSON.parse(fs.readFileSync(path.join(dir, "token-disposals.json"), "utf8"));
    assert.strictEqual(st.rows.length, 1, "no duplicate on a third scan");
    console.log("strategy-scan: an unavailable receipt holds the watermark and is retried; exactly one row results");
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
