// node test/base-vault-flow.test.js -- the signing flow (tools/base-vault/flow.js) against an in-memory chain and a mock EIP-1193 wallet.
"use strict";
const assert = require("assert");
const { ethers } = require("ethers");
const core = require("../tools/base-vault-core");
const Flow = require("../tools/base-vault/flow");
const { Chain, wallet, art, MAIN } = require("./base-vault-chain");

const plan = core.buildPlan(art);
const ALLOWED = new Set(["eth_requestAccounts", "eth_accounts", "eth_chainId", "wallet_switchEthereumChain", "eth_sendTransaction", "eth_call", "eth_getCode", "eth_getTransactionReceipt", "eth_getTransactionCount"]);
const allMethods = new Set();
const WRONG = "0x000000000000000000000000000000000000dEaD";

function mk(chain, wal) {
  const states = [];
  const f = Flow.create({ getEthereum: () => wal, plan, ethers, render: (s) => states.push(s), sleep: async () => {}, maxPolls: 3 });
  const done = () => { for (const m of wal.methods()) allMethods.add(m); };
  return { f, states, done, last: () => states[states.length - 1] };
}
const step = (s, n) => s.steps.find((x) => x.n === n);
const impl0 = (nonce = 0) => ethers.getCreateAddress({ from: MAIN, nonce });

(async () => {
  // ---- happy path, one step at a time -------------------------------------------------------------------------
  {
    const chain = new Chain(); const w = wallet(chain); const t = mk(chain, w);
    let s = await t.f.connect();
    assert.ok(step(s, 1).can.ok && !step(s, 2).can.ok && !step(s, 3).can.ok && !step(s, 4).can.ok);
    assert.ok(/Step 1/.test(step(s, 2).can.reason));
    let r = await t.f.send(1); assert.ok(r.ok, r.reason);
    s = t.last(); assert.strictEqual(step(s, 1).status, "verified"); assert.strictEqual(s.impl, impl0(0));
    assert.ok(step(s, 2).can.ok);
    r = await t.f.send(2); assert.ok(r.ok, r.reason);
    s = t.last(); assert.strictEqual(s.nft, impl0(1));
    r = await t.f.send(3); assert.ok(r.ok, r.reason);
    s = t.last(); assert.ok(step(s, 3).status === "verified" && s.tba && !s.finished);
    r = await t.f.send(4); assert.ok(r.ok, r.reason);
    s = t.last(); assert.ok(s.finished && /20%/.test(s.splitNote));
    assert.strictEqual(w.sent().length, 4);
    const [t1, t2, t3, t4] = w.sent().map((c) => c.params[0]);
    for (const tx of [t1, t2, t3, t4]) { assert.strictEqual(tx.from, MAIN); assert.strictEqual(tx.value, "0x0"); assert.strictEqual(tx.chainId, "0x2105"); assert.deepStrictEqual(Object.keys(tx).sort().filter((k) => k !== "to"), ["chainId", "data", "from", "value"]); }
    assert.ok(!("to" in t1) && !("to" in t2));
    assert.strictEqual(t1.data, art.account.initCode);
    assert.strictEqual(t2.data, art.nft.initCode + ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "string"], [impl0(0), core.REGISTRY, "Base"]).slice(2));
    assert.strictEqual(t3.to, impl0(1)); assert.strictEqual(t3.data, "0x6a627842" + MAIN.slice(2).toLowerCase().padStart(64, "0"));
    assert.strictEqual(t4.data, "0xbf9e114a" + "14".padStart(64, "0"));
    // a verified step cannot be sent again
    const again = await t.f.send(1); assert.ok(!again.ok); assert.strictEqual(w.sent().length, 4);
    t.done();
  }

  // ---- skip step 4 ------------------------------------------------------------------------------------------------
  {
    const chain = new Chain(); const w = wallet(chain); const t = mk(chain, w);
    await t.f.connect(); await t.f.send(1); await t.f.send(2); await t.f.send(3);
    await t.f.skipFeeSplit();
    assert.ok(t.last().finished && /10%/.test(t.last().splitNote));
    t.done();
  }

  // ---- 6. wrong chain ---------------------------------------------------------------------------------------------
  {
    const chain = new Chain(); const w = wallet(chain, { chain: "0x1" }); w.rejectSwitch = true; const t = mk(chain, w);
    let s = await t.f.connect();
    assert.ok(s.needSwitch && !step(s, 1).can.ok);
    let r = await t.f.send(1); assert.ok(!r.ok);
    assert.strictEqual(w.sent().length, 0);
    s = await t.f.switchChain();
    assert.deepStrictEqual(w.calls.filter((c) => c.method === "wallet_switchEthereumChain").map((c) => c.params[0].chainId), ["0x2105"]);
    assert.ok(s.needSwitch, "switch rejected, still not on Base");
    r = await t.f.send(1); assert.ok(!r.ok); assert.strictEqual(w.sent().length, 0);
    w.rejectSwitch = false;
    s = await t.f.switchChain();
    assert.ok(!s.needSwitch && step(s, 1).can.ok);
    // chainChanged mid-flow disables again
    w.chain = "0x1"; await w.emit("chainChanged", "0x1");
    s = t.last(); assert.ok(s.needSwitch && !step(s, 1).can.ok);
    r = await t.f.send(1); assert.ok(!r.ok); assert.strictEqual(w.sent().length, 0);
    t.done();
  }

  // ---- 7. wrong account ---------------------------------------------------------------------------------------------
  {
    const chain = new Chain(); const w = wallet(chain, { accounts: [WRONG] }); const t = mk(chain, w);
    let s = await t.f.connect();
    assert.ok(!step(s, 1).can.ok);
    assert.ok(s.message.includes(WRONG) && s.message.includes(MAIN), "names both addresses");
    let r = await t.f.send(1); assert.ok(!r.ok); assert.strictEqual(w.sent().length, 0);
    // Main in other case is accepted
    w.accounts = [MAIN.toLowerCase()]; await w.emit("accountsChanged", w.accounts);
    assert.ok(step(t.last(), 1).can.ok);
    // accountsChanged to a wrong account re-disables
    w.accounts = [WRONG]; await w.emit("accountsChanged", w.accounts);
    assert.ok(!step(t.last(), 1).can.ok);
    r = await t.f.send(1); assert.ok(!r.ok); assert.strictEqual(w.sent().length, 0);
    // the account changing after the page last looked is caught right before sending
    w.accounts = [MAIN];
    t.done();
  }

  // ---- 8. order, double click, mempool -----------------------------------------------------------------------------
  {
    const chain = new Chain(); const w = wallet(chain); const t = mk(chain, w);
    await t.f.connect();
    for (const n of [2, 3, 4]) { const r = await t.f.send(n); assert.ok(!r.ok); }
    assert.strictEqual(w.sent().length, 0);
    const [a, b] = await Promise.all([t.f.send(1), t.f.send(1)]);
    assert.strictEqual(w.sent().length, 1);
    assert.ok(a.ok !== b.ok, "exactly one click went through");
    chain.pendingExtra = 1; await t.f.refresh();
    assert.ok(!step(t.last(), 2).can.ok && /mempool/.test(step(t.last(), 2).can.reason));
    const r = await t.f.send(2); assert.ok(!r.ok); assert.strictEqual(w.sent().length, 1);
    chain.pendingExtra = 0;
    t.done();
  }

  // ---- 8b. user rejection and RPC failure -----------------------------------------------------------------------
  {
    const chain = new Chain(); const w = wallet(chain); const t = mk(chain, w);
    await t.f.connect(); w.rejectSend = true;
    const r = await t.f.send(1); assert.ok(!r.ok && /Rejected/.test(r.reason));
    assert.strictEqual(step(t.last(), 1).status, "todo");
    assert.strictEqual(chain.txs.length, 0);
    w.rejectSend = false;
    const orig = w.request; w.request = async (a) => { if (a.method === "eth_getCode") throw new Error("rpc down"); return orig(a); };
    const s = await t.f.refresh();
    assert.ok(s.error && !step(s, 1).can.ok);
    const r2 = await t.f.send(1); assert.ok(!r2.ok); assert.strictEqual(chain.txs.length, 0);
    w.request = orig;
    // connect rejected
    const w2 = wallet(chain); w2.rejectConnect = true; const t2 = mk(chain, w2);
    const s2 = await t2.f.connect(); assert.ok(/rejected/.test(s2.message) && !s2.connected);
    t.done(); t2.done();
  }

  // ---- 9. verification failures --------------------------------------------------------------------------------------
  {
    // wrong deployed code hash
    let chain = new Chain(); let w = wallet(chain); let t = mk(chain, w);
    chain.deployTweak[1] = { runtime: "0x6000" };
    await t.f.connect(); let r = await t.f.send(1);
    assert.ok(!r.ok); assert.strictEqual(step(t.last(), 1).status, "failed"); assert.ok(!step(t.last(), 2).can.ok);
    t.done();
    // reverted receipt
    chain = new Chain(); w = wallet(chain); t = mk(chain, w);
    chain.receiptOverride[1] = { status: "0x0" };
    await t.f.connect(); r = await t.f.send(1);
    assert.ok(!r.ok && /reverted/.test(r.reason)); assert.strictEqual(step(t.last(), 1).status, "failed"); t.done();
    // receipt from someone else
    chain = new Chain(); w = wallet(chain); t = mk(chain, w);
    chain.receiptOverride[1] = { from: WRONG };
    await t.f.connect(); r = await t.f.send(1);
    assert.ok(!r.ok && /not Main/.test(r.reason)); assert.strictEqual(step(t.last(), 1).status, "failed"); t.done();
    // receipt address differs from the prediction: step 2 uses the receipt's address
    chain = new Chain(); w = wallet(chain); t = mk(chain, w);
    const ELSEWHERE = "0x1234567890123456789012345678901234567890";
    chain.deployTweak[1] = { at: ELSEWHERE };
    await t.f.connect(); r = await t.f.send(1);
    assert.ok(r.ok, r.reason); assert.strictEqual(t.last().impl, ELSEWHERE); assert.ok(/differs from the predicted/.test(t.last().warning));
    r = await t.f.send(2); assert.ok(r.ok, r.reason);
    const d2 = w.sent()[1].params[0].data;
    assert.ok(d2.toLowerCase().includes(ELSEWHERE.slice(2).toLowerCase().padStart(64, "0")), "constructor arg is the receipt address");
    assert.ok(!d2.toLowerCase().includes(impl0(0).slice(2).toLowerCase().padStart(64, "0")));
    t.done();
    // step 2: NFT with a different chain name is not verified
    chain = new Chain(); w = wallet(chain); t = mk(chain, w);
    const origPut = chain.putNft.bind(chain); chain.putNft = (a, o) => origPut(a, { ...o, chainName: "Other" });
    await t.f.connect(); await t.f.send(1); r = await t.f.send(2);
    assert.ok(!r.ok && /chainName/.test(r.reason)); assert.ok(!step(t.last(), 3).can.ok); t.done();
    // step 3 variants
    const variants = {
      "ownerOf != Main": (c, nft, tba) => { c.nfts[nft.toLowerCase()].owner1 = WRONG; },
      "TBA has no code": (c, nft, tba) => { delete c.code[tba.toLowerCase()]; },
      "registry.account disagrees": (c) => { for (const k of Object.keys(c.regAccounts)) c.regAccounts[k] = WRONG; },
      "TBA.owner != Main": (c, nft, tba) => { c.tbas[tba.toLowerCase()].owner = WRONG; },
      "wrong proxy code": (c, nft, tba) => { c.code[tba.toLowerCase()] = Flow.proxyCode(WRONG, ethers.ZeroHash, 8453, nft, 1); },
    };
    for (const [name, tamper] of Object.entries(variants)) {
      chain = new Chain(); w = wallet(chain); t = mk(chain, w);
      const orig = chain.doMint.bind(chain);
      chain.doMint = (nft, to) => { const tba = orig(nft, to); tamper(chain, nft, tba); return tba; };
      await t.f.connect(); await t.f.send(1); await t.f.send(2); r = await t.f.send(3);
      assert.ok(!r.ok, name); assert.strictEqual(step(t.last(), 3).status, "failed", name); assert.ok(!step(t.last(), 4).can.ok, name); t.done();
    }
    // step 4 not verified if feeSplitPct != 20
    chain = new Chain(); w = wallet(chain); t = mk(chain, w);
    const apply = chain.applyTx.bind(chain);
    chain.applyTx = (tx) => { const h = apply(tx); if (tx.data.startsWith("0xbf9e114a")) chain.nfts[tx.to.toLowerCase()].split = 10; return h; };
    await t.f.connect(); await t.f.send(1); await t.f.send(2); await t.f.send(3); r = await t.f.send(4);
    assert.ok(!r.ok && /feeSplitPct/.test(r.reason)); assert.strictEqual(step(t.last(), 4).status, "failed"); assert.ok(!t.last().finished); t.done();
  }

  // ---- 10. reload derives state from the chain only --------------------------------------------------------------------
  {
    const chain = new Chain({ mainNonce: 7 });
    const impl = impl0(3); const nft = impl0(4);
    chain.putImpl(impl); chain.putNft(nft, { impl });
    const w = wallet(chain); const t = mk(chain, w);
    const s = await t.f.connect();
    assert.strictEqual(step(s, 1).status, "verified"); assert.strictEqual(step(s, 2).status, "verified");
    assert.ok(step(s, 3).can.ok && !step(s, 4).can.ok); assert.strictEqual(s.impl, impl); assert.strictEqual(s.nft, nft);
    const r = await t.f.send(3); assert.ok(r.ok, r.reason);
    // a fresh page after the mint
    const t2 = mk(chain, wallet(chain)); const s2 = await t2.f.connect();
    assert.strictEqual(step(s2, 3).status, "verified"); assert.ok(step(s2, 4).can.ok);
    t.done();
    // a wrong contract at the candidate address does not count
    const chain3 = new Chain({ mainNonce: 2 });
    chain3.code[impl0(0).toLowerCase()] = "0x6080604052deadbeef";
    const t3 = mk(chain3, wallet(chain3)); const s3 = await t3.f.connect();
    assert.strictEqual(step(s3, 1).status, "todo"); assert.ok(step(s3, 1).can.ok && !step(s3, 2).can.ok);
    // an NFT whose implementation() is not a verified impl does not count
    const chain4 = new Chain({ mainNonce: 6 });
    chain4.putImpl(impl0(1)); chain4.putNft(impl0(2), { impl: WRONG });
    const t4 = mk(chain4, wallet(chain4)); const s4 = await t4.f.connect();
    assert.strictEqual(step(s4, 1).status, "verified"); assert.strictEqual(step(s4, 2).status, "todo");
    // beyond the window: cannot locate, fails closed (impl at nonce 0, Main nonce 20)
    const chain5 = new Chain({ mainNonce: 20 }); chain5.putImpl(impl0(0));
    const t5 = mk(chain5, wallet(chain5)); const s5 = await t5.f.connect();
    assert.strictEqual(step(s5, 1).status, "todo");
  }

  // ---- 11. only allowed wallet methods ------------------------------------------------------------------------------------
  for (const m of allMethods) assert.ok(ALLOWED.has(m), "unexpected wallet method " + m);
  assert.ok(allMethods.has("eth_sendTransaction"));
  console.log("base-vault-flow: ok");
})().catch((e) => { console.error(e); process.exit(1); });
