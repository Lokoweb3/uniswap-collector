// node test/chain-identity.test.js — the served pages must name the chain they are
// actually on, and never guess its native asset.
//
// The wallet page once hardcoded Robinhood's id, name, RPC and explorer. On the Arc
// instance that meant: a prompt to switch to "Robinhood Chain" while pointing at
// chain 5042; an "add this network" call that would register Arc under Robinhood's
// name with ether as its currency, when Arc's gas is USDC; and a vault tab that read
// balances from Robinhood's RPC entirely. A third chain must not be able to bring
// any of that back, so this checks the sources rather than one instance's output.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// ---- 1. settings: a chain can name itself -------------------------------------
{
  const settings = require("../settings");
  const raw = {
    chain: { name: "Testnet Zero", rpcUrl: "https://rpc.example", chainId: 9999, explorer: "https://exp.example",
      nativeCurrency: { symbol: "TZ", decimals: 9 } },
    wallets: { main: { address: "0x" + "11".repeat(20), label: "Main" } },
  };
  // toLegacy() is the flattening the servers consume.
  const legacy = settings.toLegacy ? settings.toLegacy(raw) : null;
  assert.ok(legacy, "settings.toLegacy is still the flattening the servers use");
  assert.strictEqual(legacy.chainName, "Testnet Zero", "a chain names itself in settings");
  assert.strictEqual(legacy.chainId, 9999);
  assert.deepStrictEqual(legacy.nativeCurrency, { symbol: "TZ", decimals: 9 },
    "a verified native asset is carried through");
  // and an unverified one is not invented
  const bare = settings.toLegacy({ ...raw, chain: { ...raw.chain, nativeCurrency: { symbol: "TZ" } } });
  assert.strictEqual(bare.nativeCurrency, undefined, "half a native-currency declaration is not carried");
}

// ---- 2. both servers answer /api/chain, from config ----------------------------
for (const f of ["server.js", "approve-serve.js"]) {
  const src = read(f);
  assert.ok(/\/api\/chain/.test(src), `${f} serves /api/chain`);
  assert.ok(/chainDisplayName\(\)/.test(src), `${f} names the chain from config, not a literal`);
  assert.ok(/cfg\.chainName \|\| KNOWN_CHAIN_NAMES/.test(src),
    `${f} prefers the configured name, then known ids`);
  // The native currency is passed through only when settings verify it.
  assert.ok(/cfg\.nativeCurrency \?/.test(src), `${f} omits an unverified native currency`);
  assert.ok(!/chainName: "Robinhood Chain"/.test(src), `${f} does not hardcode one chain's name`);
}

// ---- 3. the wallet page carries no chain of its own ----------------------------
{
  const html = read("wallet.html");
  const code = html.replace(/<!--[\s\S]*?-->/g, "").split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))          // drop comment lines
    .join("\n");
  assert.ok(!/4663/.test(code), "no hardcoded chain id in the wallet page");
  assert.ok(!/robinhoodchain\.blockscout|rpc\.mainnet\.chain\.robinhood/.test(code),
    "no hardcoded RPC or explorer in the wallet page");
  assert.ok(!/Robinhood Chain/.test(code), "no hardcoded chain name in the wallet page");
  assert.ok(/fetch\('\/api\/chain'/.test(code), "it asks the instance which chain it is on");
  assert.ok(/nativeCurrency: NATIVE_CURRENCY/.test(code),
    "wallet_addEthereumChain passes the instance's native currency");
  assert.ok(/if \(!cfg\.nativeCurrency\)/.test(code) && /will not guess the chain's native currency/.test(code),
    "and refuses to add a network when that currency is unverified");
  assert.ok(/new ethers\.JsonRpcProvider\(RPC_URL\)/.test(code),
    "the vault tab reads the chain it is served from");
  assert.ok(/ethers\.formatUnits\(ethBal, nat\.decimals\)/.test(code),
    "the native balance is scaled by this chain's decimals, not assumed to be ether");
}

console.log("chain identity: both servers state their own chain, the wallet page hardcodes none, and no native asset is guessed");
