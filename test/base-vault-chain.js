// Test helper (not a test): a small in-memory Base chain with the LOKOVault contracts' behaviour, an EIP-1193 wallet
// over it that records every request, and an ethers provider over it. No network, no keys, nothing is ever signed.
"use strict";
const { ethers } = require("ethers");
const core = require("../tools/base-vault-core");
const flow = require("../tools/base-vault/flow");

const art = core.loadArtifact();
const MAIN = core.MAIN;
const REG = core.REGISTRY;
const nftI = new ethers.Interface([...flow.NFT_ABI, "function name() view returns (string)", "function symbol() view returns (string)", "function paused() view returns (bool)", "function FEE_SPLIT_MAX() view returns (uint256)"]);
const tbaI = new ethers.Interface(["function token() view returns (uint256,address,uint256)", "function owner() view returns (address)"]);
const regI = new ethers.Interface(flow.REG_ABI);
const lc = (a) => String(a).toLowerCase();
const REGISTRY_FAKE_CODE = "0x6080604052" + "ab".repeat(40);

class Chain {
  constructor({ chainId = 8453, mainNonce = 0 } = {}) {
    this.chainId = chainId;
    this.code = {}; this.nonce = { [lc(MAIN)]: mainNonce }; this.pendingExtra = 0;
    this.nfts = {}; this.tbas = {}; this.regAccounts = {}; this.receipts = {}; this.txs = [];
    this.code[lc(REG)] = REGISTRY_FAKE_CODE;
    this.counter = 0; this.deployTweak = {}; this.receiptDelay = 0; this.receiptOverride = {};
  }
  putImpl(addr, runtime = art.account.runtime) { this.code[lc(addr)] = runtime; }
  putNft(addr, { impl, registry = REG, chainName = "Base", owner = MAIN, split = 10, runtime } = {}) {
    this.code[lc(addr)] = runtime || core.expectedRuntime("nft", registry, art).hex;
    this.nfts[lc(addr)] = { impl, registry, chainName, owner, owner1: null, tba: ethers.ZeroAddress, split, paused: false, max: 20 };
  }
  doMint(nft, to) {
    const s = this.nfts[lc(nft)];
    const tba = ethers.getAddress("0x" + ethers.keccak256(ethers.toUtf8Bytes(`tba${lc(nft)}${lc(s.impl)}`)).slice(26));
    s.owner1 = to; s.tba = tba;
    this.code[lc(tba)] = flow.proxyCode(s.impl, ethers.ZeroHash, this.chainId, nft, 1);
    this.tbas[lc(tba)] = { owner: to, token: [BigInt(this.chainId), nft, 1n] };
    this.regAccounts[[lc(s.impl), this.chainId, lc(nft), 1].join("|")] = tba;
    return tba;
  }
  /** A fully created vault at explicit addresses (as if Main had deployed and minted). */
  seedVault(impl, nft, { split = 20 } = {}) {
    this.putImpl(impl); this.putNft(nft, { impl, split }); return this.doMint(nft, MAIN);
  }
  getCode(a) { return this.code[lc(a)] || "0x"; }
  ethCall(to, data) {
    const t = lc(to); const sel = data.slice(0, 10);
    const nft = this.nfts[t];
    const enc = (iface, fn, vals) => iface.encodeFunctionResult(fn, vals);
    if (nft) {
      const f = nftI.getFunction(sel);
      if (!f) throw new Error("execution reverted");
      switch (f.name) {
        case "implementation": return enc(nftI, f.name, [nft.impl]);
        case "REGISTRY": return enc(nftI, f.name, [nft.registry]);
        case "chainName": return enc(nftI, f.name, [nft.chainName]);
        case "owner": return enc(nftI, f.name, [nft.owner]);
        case "ownerOf": if (nft.owner1 === null) throw new Error("execution reverted"); return enc(nftI, f.name, [nft.owner1]);
        case "tbaAddress": return enc(nftI, f.name, [nft.tba]);
        case "feeSplitPct": return enc(nftI, f.name, [BigInt(nft.split)]);
        case "name": return enc(nftI, f.name, ["LOKOVault"]);
        case "symbol": return enc(nftI, f.name, ["LKVAULT"]);
        case "paused": return enc(nftI, f.name, [nft.paused]);
        case "FEE_SPLIT_MAX": return enc(nftI, f.name, [BigInt(nft.max)]);
        default: throw new Error("execution reverted");
      }
    }
    if (this.tbas[t]) {
      const f = tbaI.getFunction(sel);
      if (!f) throw new Error("execution reverted");
      return f.name === "owner" ? enc(tbaI, "owner", [this.tbas[t].owner]) : enc(tbaI, "token", this.tbas[t].token);
    }
    if (t === lc(REG) && sel === regI.getFunction("account").selector) {
      const [impl, , cid, nftA, tid] = regI.decodeFunctionData("account", data);
      const hit = this.regAccounts[[lc(impl), Number(cid), lc(nftA), Number(tid)].join("|")];
      return enc(regI, "account", [hit || ethers.ZeroAddress]);
    }
    throw new Error("execution reverted");
  }
  /** Apply a transaction (the wallet's, never signed here) and mine it at once. */
  applyTx(tx) {
    const from = lc(tx.from); const n = this.nonce[from] || 0;
    this.nonce[from] = n + 1; this.counter++;
    const hash = ethers.keccak256(ethers.toUtf8Bytes("tx" + this.counter));
    const rec = { status: "0x1", from: tx.from, to: tx.to || null, contractAddress: null, transactionHash: hash };
    this.txs.push(tx);
    if (!tx.to) {
      const addr = ethers.getCreateAddress({ from: tx.from, nonce: n });
      const tw = this.deployTweak[this.txs.length] || {};
      const where = tw.at || addr;
      rec.contractAddress = where;
      if (tx.data.startsWith(art.account.initCode)) this.putImpl(where, tw.runtime || art.account.runtime);
      else if (tx.data.startsWith(art.nft.initCode)) {
        const [impl, registry, chainName] = ethers.AbiCoder.defaultAbiCoder().decode(["address", "address", "string"], "0x" + tx.data.slice(art.nft.initCode.length));
        this.putNft(where, { impl, registry, chainName, owner: tx.from, runtime: tw.runtime });
      }
    } else if (tx.data.startsWith(flow.SELECTORS.mint)) this.doMint(tx.to, ethers.getAddress("0x" + tx.data.slice(34, 74)));
    else if (tx.data.startsWith(flow.SELECTORS.setFeeSplitPct)) this.nfts[lc(tx.to)].split = Number(BigInt("0x" + tx.data.slice(10)));
    Object.assign(rec, this.receiptOverride[this.txs.length] || {});
    this.receipts[hash] = rec;
    return hash;
  }
}

/** An EIP-1193 wallet over a Chain. Records every request method. */
function wallet(chain, o = {}) {
  const w = { calls: [], listeners: {}, chain: o.chain || "0x2105", accounts: o.accounts || [MAIN], rejectSend: false, rejectSwitch: false, rejectConnect: false };
  w.request = async ({ method, params }) => {
    w.calls.push({ method, params });
    switch (method) {
      case "eth_requestAccounts": if (w.rejectConnect) throw Object.assign(new Error("rejected"), { code: 4001 }); return w.accounts;
      case "eth_accounts": return w.accounts;
      case "eth_chainId": return w.chain;
      case "wallet_switchEthereumChain":
        if (w.rejectSwitch) throw Object.assign(new Error("rejected"), { code: 4001 });
        w.chain = params[0].chainId; return null;
      case "eth_getTransactionCount": {
        const n = chain.nonce[lc(params[0])] || 0;
        return "0x" + (params[1] === "pending" ? n + chain.pendingExtra : n).toString(16);
      }
      case "eth_getCode": return chain.getCode(params[0]);
      case "eth_call": return chain.ethCall(params[0].to, params[0].data);
      case "eth_getTransactionReceipt": {
        if (chain.receiptDelay > 0) { chain.receiptDelay--; return null; }
        return chain.receipts[params[0]] || null;
      }
      case "eth_sendTransaction":
        if (w.rejectSend) throw Object.assign(new Error("User rejected"), { code: 4001 });
        return chain.applyTx(params[0]);
      default: throw new Error("unexpected method " + method);
    }
  };
  w.on = (ev, fn) => { (w.listeners[ev] = w.listeners[ev] || []).push(fn); };
  w.emit = async (ev, payload) => { for (const f of w.listeners[ev] || []) await f(payload); };
  w.sent = () => w.calls.filter((c) => c.method === "eth_sendTransaction");
  w.methods = () => new Set(w.calls.map((c) => c.method));
  return w;
}

class FakeProvider extends ethers.AbstractProvider {
  constructor(chain) { super(chain.chainId); this.chain = chain; }
  async _detectNetwork() { return ethers.Network.from(this.chain.chainId); }
  async _perform(req) {
    switch (req.method) {
      case "getCode": return this.chain.getCode(req.address);
      case "call": return this.chain.ethCall(req.transaction.to, req.transaction.data);
      case "getTransactionCount": { const n = this.chain.nonce[lc(req.address)] || 0; return req.blockTag === "pending" ? n + this.chain.pendingExtra : n; }
      case "getBlockNumber": return 1;
      default: throw new Error("unsupported " + req.method);
    }
  }
}

module.exports = { Chain, wallet, FakeProvider, art, MAIN, REG, REGISTRY_FAKE_CODE, nftI };
