/**
 * Signing flow for creating a LOKOVault on Base, driven by the user's own browser wallet (Rabby).
 * UMD: require() in tests and in base-vault-core, global BaseVaultFlow in the page.
 *
 * Every decision lives here; the page only wires window.ethereum, renders state and forwards clicks.
 * The only method that sends is eth_sendTransaction. State is derived from the chain on every
 * refresh (Main's nonce, the CREATE addresses of its recent transactions, their code hashes), never
 * from browser storage. Nothing here signs a message, adds a chain, or holds a key.
 */
"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.BaseVaultFlow = api;
})(globalThis, function () {
  const STEP_NAMES = { 1: "Deploy TreasuryAccount (implementation)", 2: "Deploy TreasuryNFT (LOKOVault)", 3: "Mint #1 to Main (creates the token-bound account)", 4: "Set fee split to 20% (optional)" };
  const SELECTORS = { mint: "0x6a627842", setFeeSplitPct: "0xbf9e114a" };
  const NFT_ABI = [
    "function implementation() view returns (address)", "function REGISTRY() view returns (address)", "function chainName() view returns (string)",
    "function owner() view returns (address)", "function ownerOf(uint256) view returns (address)", "function tbaAddress() view returns (address)",
    "function feeSplitPct() view returns (uint256)", "function mint(address to)", "function setFeeSplitPct(uint256 pct)",
  ];
  const REG_ABI = ["function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) view returns (address)"];
  const TBA_ABI = ["function owner() view returns (address)"];

  const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
  const same = (a, b) => isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
  const isTxHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
  const hexToNum = (h) => Number(BigInt(h));
  const pad32 = (hexNo0x) => hexNo0x.toLowerCase().padStart(64, "0");
  const errCode = (e) => (e && (e.code != null ? e.code : e.error && e.error.code != null ? e.error.code : e.data && e.data.originalError && e.data.originalError.code));
  const errText = (e) => String((e && (e.shortMessage || e.message)) || e || "unknown error").slice(0, 200);

  /** Runtime hex with the 32-byte immutable word(s) set to the left-padded registry. */
  function fillImmutables(runtimeHex, refs, registry) {
    if (!isAddress(registry)) throw new Error("registry must be an address");
    let b = runtimeHex.slice(2).toLowerCase();
    for (const r of refs) {
      if (r.length !== 32 || (r.start + r.length) * 2 > b.length) throw new Error("bad immutable reference");
      b = b.slice(0, r.start * 2) + pad32(registry.slice(2)) + b.slice((r.start + r.length) * 2);
    }
    return "0x" + b;
  }

  /** The 173-byte ERC-6551 (v0.3) proxy runtime for an implementation and binding. */
  function proxyCode(impl, salt, chainId, nft, tokenId) {
    return ("0x363d3d373d3d3d363d73" + impl.slice(2) + "5af43d82803e903d91602b57fd5bf3" +
      salt.slice(2).padStart(64, "0") + BigInt(chainId).toString(16).padStart(64, "0") + pad32(nft.slice(2)) + BigInt(tokenId).toString(16).padStart(64, "0")).toLowerCase();
  }
  /** Parse exactly that shape (nothing else) into { impl, salt, chainId, nft, tokenId }, or null. */
  function parseProxy(code) {
    if (typeof code !== "string") return null;
    const c = code.toLowerCase();
    const m = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3([0-9a-f]{64})([0-9a-f]{64})([0-9a-f]{64})([0-9a-f]{64})$/.exec(c);
    if (!m) return null;
    if (m[4].slice(0, 24) !== "0".repeat(24)) return null;
    return { impl: "0x" + m[1], salt: "0x" + m[2], chainId: BigInt("0x" + m[3]), nft: "0x" + m[4].slice(24), tokenId: BigInt("0x" + m[5]) };
  }

  /**
   * env = { getEthereum() -> EIP-1193 provider | null, plan, ethers, render(state), sleep?(ms), maxPolls? }
   */
  function create(env) {
    const plan = env.plan;
    const K = plan.constants.K || 8;
    const C = plan.constants;
    const ethers = env.ethers;
    const nftI = new ethers.Interface(NFT_ABI);
    const regI = new ethers.Interface(REG_ABI);
    const tbaI = new ethers.Interface(TBA_ABI);
    const sleep = env.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const maxPolls = env.maxPolls || 150;
    const render = env.render || (() => {});

    const nftRuntimeHash = (registry) => ethers.keccak256(fillImmutables(plan.nft.runtime, plan.nft.immutableReferences, registry));
    const session = { connected: false, busy: false, pending: null, failed: {}, known: [], skip4: false, message: "", warning: "", subscribed: false, hashes: {}, derived: null, ctx: null };

    function eth() {
      const e = env.getEthereum();
      if (!e || typeof e.request !== "function") throw new Error("No wallet found (window.ethereum). Open this page in the browser with Rabby.");
      return e;
    }
    const req = (method, params) => eth().request(params === undefined ? { method } : { method, params });

    async function tryCall(to, iface, fn, args) {
      try {
        const res = await req("eth_call", [{ to, data: iface.encodeFunctionData(fn, args || []) }, "latest"]);
        return iface.decodeFunctionResult(fn, res)[0];
      } catch (e) { return null; }
    }
    const codeHash = async (addr) => { const c = await req("eth_getCode", [addr, "latest"]); return c && c !== "0x" ? ethers.keccak256(c) : null; };

    // ---- the one place the environment (chain, account) is judged -------------------------------------
    async function readEnv(accountsOverride) {
      const chainId = String(await req("eth_chainId")).toLowerCase();
      const accounts = Array.isArray(accountsOverride) ? accountsOverride : await req("eth_accounts");
      const account = Array.isArray(accounts) && accounts.length ? accounts[0] : null;
      return { chainId, chainOk: chainId === C.chainIdHex, account, accountOk: same(account, C.main) };
    }
    function envProblem(e) {
      if (!session.connected) return "Connect your wallet first.";
      if (!e.chainOk) return `Wallet is on chain ${e.chainId}; switch to Base (${C.chainIdHex}).`;
      if (!e.account) return "No account is connected.";
      if (!e.accountOk) return `Connected account ${e.account} is not Main ${C.main}. Switch the wallet to Main.`;
      return null;
    }

    // ---- verifications (reads through the wallet's own provider) ---------------------------------------
    async function verifyImpl(addr) {
      const h = await codeHash(addr);
      return h === plan.account.runtimeKeccak ? { ok: true } : { ok: false, reason: `code hash ${h} at ${addr} is not the pinned TreasuryAccount` };
    }
    async function verifyNft(addr, impl) {
      const h = await codeHash(addr);
      const want = nftRuntimeHash(C.registry);
      if (h !== want) return { ok: false, reason: `code hash ${h} at ${addr} is not the expected TreasuryNFT` };
      const [i, r, n, o] = await Promise.all([tryCall(addr, nftI, "implementation"), tryCall(addr, nftI, "REGISTRY"), tryCall(addr, nftI, "chainName"), tryCall(addr, nftI, "owner")]);
      if (!same(i, impl)) return { ok: false, reason: `implementation() is ${i}, not ${impl}` };
      if (!same(r, C.registry)) return { ok: false, reason: `REGISTRY() is ${r}` };
      if (n !== C.chainName) return { ok: false, reason: `chainName() is ${n}` };
      if (!same(o, C.main)) return { ok: false, reason: `owner() is ${o}, not Main` };
      return { ok: true };
    }
    async function verifyMint(nft, impl) {
      const owner1 = await tryCall(nft, nftI, "ownerOf", [C.tokenId]);
      if (!same(owner1, C.main)) return { ok: false, reason: `ownerOf(1) is ${owner1}, not Main` };
      const tba = await tryCall(nft, nftI, "tbaAddress");
      if (!isAddress(tba) || same(tba, ethers.ZeroAddress)) return { ok: false, reason: "tbaAddress() is not set" };
      const code = await req("eth_getCode", [tba, "latest"]);
      if (!code || code === "0x") return { ok: false, reason: `token-bound account ${tba} has no code` };
      if (String(code).toLowerCase() !== proxyCode(impl, C.salt, C.chainId, nft, C.tokenId)) return { ok: false, reason: "token-bound account code is not the expected proxy for (impl, salt 0, 8453, nft, 1)" };
      const derived = await tryCall(C.registry, regI, "account", [impl, C.salt, C.chainId, nft, C.tokenId]);
      if (!same(derived, tba)) return { ok: false, reason: `registry.account(...) is ${derived}, not ${tba}` };
      const to = await tryCall(tba, tbaI, "owner");
      if (!same(to, C.main)) return { ok: false, reason: `TBA.owner() is ${to}, not Main` };
      return { ok: true, tba };
    }
    async function verifySplit(nft) {
      const p = await tryCall(nft, nftI, "feeSplitPct");
      return p !== null && BigInt(p) === BigInt(C.targetSplit) ? { ok: true } : { ok: false, reason: `feeSplitPct() is ${p}, not ${C.targetSplit}` };
    }

    // ---- state from the chain only ----------------------------------------------------------------------
    async function derive() {
      const main = C.main;
      const latest = hexToNum(await req("eth_getTransactionCount", [main, "latest"]));
      const pending = hexToNum(await req("eth_getTransactionCount", [main, "pending"]));
      const cands = [];
      for (let i = Math.max(0, latest - K); i <= latest; i++) cands.push(ethers.getCreateAddress({ from: main, nonce: i }));
      for (const k of session.known) if (!cands.some((c) => same(c, k))) cands.push(k);
      const hashes = [];
      for (const c of cands) hashes.push(await codeHash(c));
      const nftHash = nftRuntimeHash(C.registry);
      const impls = cands.filter((c, i) => hashes[i] === plan.account.runtimeKeccak);
      let nft = null; let impl = null;
      for (let i = cands.length - 1; i >= 0 && !nft; i--) {
        if (hashes[i] !== nftHash) continue;
        const ni = await tryCall(cands[i], nftI, "implementation");
        const hit = impls.find((x) => same(x, ni));
        if (hit) { nft = cands[i]; impl = hit; }
      }
      if (!impl && impls.length) impl = impls[impls.length - 1];
      const d = { latest, pending, impl, nft, tba: null, v: { 1: !!impl, 2: false, 3: false, 4: false }, reasons: {} };
      if (nft) {
        const v2 = await verifyNft(nft, impl);
        d.v[2] = v2.ok; if (!v2.ok) d.reasons[2] = v2.reason;
        if (d.v[2]) {
          const v3 = await verifyMint(nft, impl);
          d.v[3] = v3.ok; if (v3.ok) d.tba = v3.tba; else d.reasons[3] = v3.reason;
          if (d.v[3]) { const v4 = await verifySplit(nft); d.v[4] = v4.ok; if (!v4.ok) d.reasons[4] = v4.reason; }
        }
      }
      return d;
    }

    function canSend(n, e, d, inSend) {
      const no = (reason) => ({ ok: false, reason });
      const problem = envProblem(e);
      if (problem) return no(problem);
      if (!d) return no("Chain state is not readable (failing closed).");
      if ((session.busy && !inSend) || (session.pending && !inSend)) return no("Another step is in progress.");
      if (d.latest !== d.pending) return no("Main has a transaction still in the mempool (pending nonce is ahead). Wait for it.");
      if (d.v[n]) return no(session.failed[n] ? "This step failed its receipt check; investigate, then reload the page." : "This step is already verified on chain.");
      for (let i = 1; i < n; i++) {
        if (i === 4) continue;
        if (!d.v[i] || session.failed[i]) return no(`Step ${i} is not verified yet.`);
      }
      return { ok: true };
    }

    function snapshot(e, d, extra) {
      const steps = [1, 2, 3, 4].map((n) => {
        const verified = !!(d && d.v[n]);
        const status = session.pending === n ? "pending" : session.failed[n] ? "failed" : verified ? "verified" : "todo";
        return { n, name: STEP_NAMES[n], optional: n === 4, status, hash: session.hashes[n] || null, reason: (session.failed[n] || (d && d.reasons[n])) || null, can: canSend(n, e || {}, d) };
      });
      const done3 = !!(d && d.v[3]);
      return Object.assign({
        connected: session.connected, account: e ? e.account : null, chainId: e ? e.chainId : null, chainOk: !!(e && e.chainOk), accountOk: !!(e && e.accountOk),
        needSwitch: !!(session.connected && e && !e.chainOk), main: C.main,
        message: session.message, warning: session.warning, steps, impl: d ? d.impl : null, nft: d ? d.nft : null, tba: d ? d.tba : null,
        nonce: d ? { latest: d.latest, pending: d.pending } : null, skip4: session.skip4,
        finished: done3 && (!!d.v[4] || session.skip4), splitNote: done3 ? (d.v[4] ? `Fee split is ${C.targetSplit}%.` : session.skip4 ? "Fee split step skipped: the split stays at the contract default of 10%." : null) : null,
      }, extra || {});
    }
    const emit = (s) => { session.last = s; try { render(s); } catch (_e) { /* a render failure must never affect the flow */ } return s; };

    async function refresh(accountsOverride) {
      let e = null; let d = null; let error = null;
      try {
        e = await readEnv(accountsOverride);
        if (session.connected && e.chainOk && e.accountOk) d = await derive();
      } catch (err) { error = `Could not read the chain (failing closed): ${errText(err)}`; d = null; }
      const prob = e && session.connected ? envProblem(e) : null;
      if (prob && !session.pending) session.message = prob;
      return emit(snapshot(e, d, error ? { error } : {}));
    }

    async function connect() {
      try {
        const accts = await req("eth_requestAccounts");
        session.connected = true;
        session.message = "";
        const e = eth();
        if (!session.subscribed && typeof e.on === "function") {
          session.subscribed = true;
          e.on("accountsChanged", (a) => refresh(Array.isArray(a) ? a : undefined).catch(() => {}));
          e.on("chainChanged", () => refresh().catch(() => {}));
        }
        return refresh(Array.isArray(accts) ? accts : undefined);
      } catch (err) {
        session.message = errCode(err) === 4001 ? "Connection request rejected in the wallet. Nothing was changed." : `Could not connect: ${errText(err)}`;
        return emit(snapshot(null, null));
      }
    }

    async function switchChain() {
      try {
        await req("wallet_switchEthereumChain", [{ chainId: C.chainIdHex }]);
        session.message = "";
      } catch (err) {
        session.message = errCode(err) === 4001 ? "Network switch rejected in the wallet." : `Could not switch to Base: ${errText(err)}. Add Base (chain id 8453) in the wallet yourself, then retry.`;
      }
      return refresh();
    }

    function skipFeeSplit() { session.skip4 = true; return refresh(); }

    function buildTx(n, d) {
      const base = { from: C.main, value: "0x0", chainId: C.chainIdHex };
      if (n === 1) return Object.assign(base, { data: plan.account.initCode });
      if (n === 2) return Object.assign(base, { data: plan.nft.initCode + ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "string"], [d.impl, C.registry, C.chainName]).slice(2) });
      if (n === 3) return Object.assign(base, { to: d.nft, data: nftI.encodeFunctionData("mint", [C.main]) });
      return Object.assign(base, { to: d.nft, data: nftI.encodeFunctionData("setFeeSplitPct", [C.targetSplit]) });
    }

    async function send(n) {
      if (![1, 2, 3, 4].includes(n)) return { ok: false, reason: "unknown step" };
      if (session.busy) return { ok: false, reason: "busy" };
      session.busy = true;
      let sent = false;
      try {
        const e = await readEnv();
        const prob0 = envProblem(e);
        if (prob0) { session.message = prob0; return { ok: false, reason: prob0 }; }
        const d = await derive();
        const can = canSend(n, e, d, true);
        if (!can.ok) { session.message = can.reason; return { ok: false, reason: can.reason }; }
        const tx = buildTx(n, d);
        // last look, immediately before the wallet is asked: chain, account and nonces again
        const e2 = await readEnv();
        const p = envProblem(e2);
        const l2 = hexToNum(await req("eth_getTransactionCount", [C.main, "latest"]));
        const p2 = hexToNum(await req("eth_getTransactionCount", [C.main, "pending"]));
        if (p || l2 !== p2 || l2 !== d.latest) { const r = p || "Main's nonce changed or a transaction is pending; reload state."; session.message = r; return { ok: false, reason: r }; }
        const predicted = ethers.getCreateAddress({ from: C.main, nonce: d.latest });
        delete session.failed[n];
        session.message = "Confirm the transaction in your wallet.";
        let hash;
        session.pending = n; emit(snapshot(e2, d));
        try {
          sent = true;
          hash = await req("eth_sendTransaction", [tx]);
        } catch (err) {
          sent = false; session.pending = null;
          session.message = errCode(err) === 4001 ? "Rejected in the wallet. Nothing was sent; state is unchanged." : `Wallet error: ${errText(err)}`;
          await refresh();
          return { ok: false, reason: session.message };
        }
        if (!isTxHash(hash)) { session.pending = null; session.failed[n] = "wallet returned an invalid transaction hash"; session.message = session.failed[n]; await refresh(); return { ok: false, reason: session.message }; }
        session.hashes[n] = hash;
        session.message = `Transaction ${hash} submitted. Waiting for it to be mined.`;
        emit(snapshot(e2, d));
        let receipt = null;
        for (let i = 0; i < maxPolls && !receipt; i++) {
          receipt = await req("eth_getTransactionReceipt", [hash]);
          if (!receipt) await sleep(2000);
        }
        if (!receipt) { session.pending = null; session.message = `No receipt for ${hash} yet. Reload this page once it is mined; state is re-derived from the chain.`; await refresh(); return { ok: false, reason: "no receipt", hash }; }
        const res = await checkReceipt(n, receipt, d, predicted);
        session.pending = null;
        if (!res.ok) { session.failed[n] = res.reason; session.message = `Step ${n} FAILED: ${res.reason}`; } else { delete session.failed[n]; session.message = `Step ${n} verified on chain.`; }
        await refresh();
        return Object.assign({ hash }, res);
      } catch (err) {
        session.pending = sent ? session.pending : null;
        session.message = `Failed closed: ${errText(err)}`;
        return { ok: false, reason: session.message };
      } finally { session.busy = false; await refresh().catch(() => {}); }
    }

    async function checkReceipt(n, r, d, predicted) {
      if (!r || r.status !== "0x1") return { ok: false, reason: "transaction reverted (receipt status is not 1)" };
      if (!same(r.from, C.main)) return { ok: false, reason: `receipt.from is ${r.from}, not Main` };
      if (n === 1 || n === 2) {
        if (!isAddress(r.contractAddress)) return { ok: false, reason: "receipt has no contractAddress" };
        const v = n === 1 ? await verifyImpl(r.contractAddress) : await verifyNft(r.contractAddress, d.impl);
        if (!v.ok) return v;
        if (!session.known.some((k) => same(k, r.contractAddress))) session.known.push(r.contractAddress);
        session.warning = same(r.contractAddress, predicted) ? "" : `Receipt address ${r.contractAddress} differs from the predicted ${predicted}; the code hash is the authority and was verified.`;
        return { ok: true, address: r.contractAddress };
      }
      if (!same(r.to, d.nft)) return { ok: false, reason: `receipt.to is ${r.to}, not the NFT ${d.nft}` };
      const v = n === 3 ? await verifyMint(d.nft, d.impl) : await verifySplit(d.nft);
      return v;
    }

    return { connect, refresh, switchChain, send, skipFeeSplit, getState: () => session.last || null, _internals: { derive, readEnv } };
  }

  return { create, fillImmutables, proxyCode, parseProxy, SELECTORS, STEP_NAMES, NFT_ABI, REG_ABI, TBA_ABI, isAddress, same };
});
