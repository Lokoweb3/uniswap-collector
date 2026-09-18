// node test/vault-chain-metadata.test.js — a vault token must not lie about its chain,
// and where it does, the page must say so in the right words.
//
// LOKOVault #1 on Arc describes itself as "LOKOVault - LP fee treasury on Robinhood
// Chain", chain 4663, because the first TreasuryNFT wrote those into tokenURI as
// string literals and gave them no setter. Nothing about the money was wrong — mint()
// binds the account with block.chainid, so it is bound to 5042 and answers to its
// holder — but the token's own words were, permanently.
//
// The contract now reads the id from block.chainid and takes the name at deployment.
// That closes the id fault for good and leaves exactly one thing that can still be
// wrong, so the two are reported separately and worded differently.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { chainClaim } = require("../vault-metadata");

const ROOT = path.join(__dirname, "..");
const sol = fs.readFileSync(path.join(ROOT, "TreasuryNFT.sol"), "utf8");

// ---- 1. the contract takes its id from the chain ------------------------------
{
  // tokenURI and the SVG are where the chain is named. Comments may discuss the old
  // literals — the code must not contain them.
  // lastIndexOf: the interface above declares tokenURI too, and slicing from there
  // would sweep in the constructor and count its argument as a use.
  const body = sol.slice(sol.lastIndexOf("function tokenURI"));
  const code = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/Robinhood/.test(code), "no chain name is hardcoded into the metadata or the art");
  assert.ok(!/\b4663\b/.test(code), "no chain id is hardcoded into the metadata or the art");
  assert.ok(/Strings\.toString\(block\.chainid\)/.test(code),
    "the id comes from block.chainid, which cannot disagree with the chain running it");
  assert.strictEqual((code.match(/Strings\.toString\(block\.chainid\)/g) || []).length, 2,
    "in both places a chain id is shown: the metadata trait and the artwork");
  assert.strictEqual((code.match(/chainName/g) || []).length, 3,
    "and the name is used in all three: description, trait, artwork");

  // The name is deployment-time and permanent, so an empty one must be refused
  // rather than minted into every token as a blank.
  const ctor = sol.slice(sol.indexOf("constructor("), sol.indexOf("constructor(") + 600);
  assert.ok(/string memory _chainName/.test(ctor), "the constructor takes a chain name");
  assert.ok(/require\(bytes\(_chainName\)\.length > 0/.test(ctor), "and refuses an empty one");
  // Nothing may quietly change it afterwards: a name that could be edited would make
  // the token's history unreadable, and the whole point is that it is fixed.
  assert.ok(!/function\s+set[A-Za-z]*[Cc]hain/.test(sol), "and no setter can change it later");
}

// ---- 2. a token on another chain: the id is wrong -----------------------------
{
  const meta = { attributes: [{ trait_type: "Chain", value: "Robinhood Chain" }, { trait_type: "Chain ID", value: "4663" }] };
  const c = chainClaim(meta, 5042, "Arc");
  assert.strictEqual(c.mislabelled, true, "the Arc vault's token claims another chain's id");
  assert.strictEqual(c.misnamed, false, "and that is reported once, not twice");
  assert.strictEqual(c.claimedChain, "Robinhood Chain");
  assert.strictEqual(c.claimedChainId, "4663");
}

// ---- 3. a token that agrees with its chain ------------------------------------
{
  const meta = { attributes: [{ trait_type: "Chain", value: "Arc" }, { trait_type: "Chain ID", value: "5042" }] };
  const c = chainClaim(meta, 5042, "Arc");
  assert.strictEqual(c.mislabelled, false);
  assert.strictEqual(c.misnamed, false, "nothing is flagged on a token that is right about itself");
  // Robinhood's own vault is correct where it is, and must stay silent there.
  const rh = chainClaim({ attributes: [{ trait_type: "Chain", value: "Robinhood Chain" }, { trait_type: "Chain ID", value: "4663" }] }, 4663, "Robinhood Chain");
  assert.strictEqual(rh.mislabelled, false);
  assert.strictEqual(rh.misnamed, false, "the same token is right on the chain it was made for");
  // Case and stray spacing are not a disagreement worth warning a reader about.
  assert.strictEqual(chainClaim({ attributes: [{ trait_type: "Chain", value: " arc " }] }, 5042, "Arc").misnamed, false);
}

// ---- 4. the right id, the wrong name ------------------------------------------
{
  // What the new contract can still get wrong: deployed on Arc with the wrong name.
  const meta = { attributes: [{ trait_type: "Chain", value: "Robinhood Chain" }, { trait_type: "Chain ID", value: "5042" }] };
  const c = chainClaim(meta, 5042, "Arc");
  assert.strictEqual(c.mislabelled, false, "the id is right and must not be called wrong");
  assert.strictEqual(c.misnamed, true, "but the name disagrees, and that is permanent too");
}

// ---- 5. saying nothing is not the same as being wrong -------------------------
{
  for (const meta of [null, {}, { attributes: [] }, { attributes: null }, { attributes: [{ trait_type: "Fee Split", value: "20%" }] }]) {
    const c = chainClaim(meta, 5042, "Arc");
    assert.strictEqual(c.mislabelled, false, `no claim, no accusation: ${JSON.stringify(meta)}`);
    assert.strictEqual(c.misnamed, false, `no claim, no accusation: ${JSON.stringify(meta)}`);
    assert.strictEqual(c.claimedChain, null);
  }
  // An id that is not a number is not a claim about an id; reading it as NaN would
  // brand every such token as permanently on the wrong chain.
  assert.strictEqual(chainClaim({ attributes: [{ trait_type: "Chain ID", value: "unknown" }] }, 5042, "Arc").mislabelled, false);
  // An instance that cannot say what it calls its chain accuses nobody of misnaming.
  assert.strictEqual(chainClaim({ attributes: [{ trait_type: "Chain", value: "Arc" }] }, 5042, "").misnamed, false);
  assert.strictEqual(chainClaim({ attributes: [{ trait_type: "Chain", value: "Arc" }] }, 5042, null).misnamed, false);
}

// ---- 6. the pages report both, and differently --------------------------------
{
  const html = fs.readFileSync(path.join(ROOT, "wallet.html"), "utf8");
  assert.ok(/art\.misnamed/.test(html), "the side-by-side cards report a wrong name");
  assert.ok(/info\.art\.misnamed/.test(html), "and so does the single-chain vault view");
  // The two faults must not share one sentence: one says the token is on the wrong
  // chain, the other that only the two names differ.
  assert.ok(/the chain id is right, only the name differs/.test(html),
    "a wrong name is not described as the token being on the wrong chain");
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.ok(/vaultMeta\.chainClaim\(meta, cfg\.chainId, chainDisplayName\(\)\)/.test(server),
    "the server compares against its own chain and its own name for it, not a constant");
}

console.log("vault metadata: the token's chain id comes from the chain, its name is fixed at deployment, and a wrong id and a wrong name are reported as the different things they are");
