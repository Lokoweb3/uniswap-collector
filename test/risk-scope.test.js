// node test/risk-scope.test.js — the Risk panel follows the wallet picker, and a
// guardian entry's claim history is read for that position's own owner.
// Functions are lifted out of dashboard.js / server.js as test/analytics-scope.test.js does.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const dash = fs.readFileSync(path.join(ROOT, "dashboard.js"), "utf8");
const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

function lift(src, head) {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `${head} not found`);
  let d = 0, j = src.indexOf("{", i);
  for (; j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}" && --d === 0) break; }
  return src.slice(i, j + 1);
}

const MAIN = "0x1111111111111111111111111111111111111111";
const TRADING = "0xaDf94A20558E1E6d64c429F8F9f017169BF3d743";
const LPR = "0xA9b614f3Bc599D684c44D97d8486ECAad9AC1A51";
const riskInScope = new Function(`${lift(dash, "function riskInScope")}; return riskInScope;`)();
const P = [
  { tokenId: "1", wallet: "Main", walletAddress: MAIN },
  { tokenId: "4183851", wallet: "LP Rewards", walletAddress: LPR },
  { tokenId: "3", wallet: "Trading", walletAddress: TRADING },
];
const ids = (l) => l.map((p) => p.tokenId).join(",");

assert.strictEqual(ids(riskInScope(P, "all", MAIN)), "1,4183851,3");
assert.strictEqual(ids(riskInScope(P, "owner", MAIN)), "1");
assert.strictEqual(ids(riskInScope(P, "owner", MAIN.toUpperCase().replace("0X", "0x"))), "1");
assert.strictEqual(ids(riskInScope(P, TRADING.toLowerCase(), MAIN)), "3", "Trading must not show LP Rewards' #4183851");
assert.strictEqual(ids(riskInScope(P, TRADING, MAIN)), "3");
assert.strictEqual(ids(riskInScope(P, LPR.toLowerCase(), MAIN)), "4183851");
assert.strictEqual(ids(riskInScope(P, "0x0000000000000000000000000000000000000009", MAIN)), "");
assert.strictEqual(ids(riskInScope([{ tokenId: "9" }], "owner", MAIN)), "9", "no address means the main wallet");

assert.strictEqual(ids(riskInScope(P.concat([{ tokenId: "9" }]), "owner", null)), "9", "unknown owner shows only address-less entries");
assert.ok(/ownerChanged[\s\S]{0,120}lastMain = d;\s*if \(ownerChanged && PAGE !== 'analytics'\) loadRisk\(\)/.test(dash), "risk panel reloads only when the owner became known or changed");

// the note reflects the filtered count
const body = lift(dash, "async function loadRisk");
assert.ok(/riskInScope\(/.test(body) && /\$\{shown\.length\} of \$\{d\.watching\}/.test(body), "note shows 'N of M'");
assert.ok(/pfScopeEl\.addEventListener\('change'[^\n]*loadRisk\(\)/.test(dash), "scope change reloads the risk panel");

// claim history owner
const riskClaimOwner = new Function("cfg", "ethers", `${lift(server, "function riskClaimOwner")}; return riskClaimOwner;`)({ ownerAddress: MAIN }, require("ethers").ethers);
assert.strictEqual(riskClaimOwner({ walletAddress: LPR }), LPR, "a watched wallet's position uses its own owner");
assert.strictEqual(riskClaimOwner({ walletAddress: MAIN }), MAIN);
assert.strictEqual(riskClaimOwner({}), MAIN, "main's (no address) still uses main");
assert.strictEqual(riskClaimOwner({ walletAddress: "0xnotanaddress" }), MAIN, "malformed address falls back to main");
assert.ok(/owner: riskClaimOwner\(p\)/.test(server), "/api/risk passes the position's owner");
assert.ok(!/p\.claimed = claimedSummary\([^\n]*owner: cfg\.ownerAddress/.test(server));

console.log("risk scope: panel filtered by all/owner/address with 'N of M' note; claim owner is the position's own wallet");
