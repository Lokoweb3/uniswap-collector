/**
 * "Claim fees" for Aerodrome Slipstream positions, signed by the user's own browser wallet.
 * This file is the ONLY place that asks a wallet to send a transaction. The server never signs:
 * it answers GET /api/claim-fees/target (manager from the settings allowlist, the NFT's on-chain
 * owner, a fee estimate) and nothing else, and no text field exists, so the manager and the
 * recipient (always the owner) cannot be edited.
 *
 * Flow: open(protocol, id) fetches the target and shows a confirmation panel; send() asks the
 * wallet for accounts, makes sure it is on Base (offering a switch), checks that the connected
 * account is the NFT's owner and that the wallet's own ownerOf read agrees, then sends
 * collect(...) to the manager. UMD: require() in tests, global ClaimFees in the page.
 */
"use strict";
(function (root, factory) {
  const core = typeof module === "object" && module && module.exports ? require("./claim-fees-core") : root.ClaimFeesCore;
  const api = factory(core);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.ClaimFees = api;
    if (root.document) api.attach(root);
  }
})(globalThis, function (core) {
  const esc = (x) => String(x == null ? "" : x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x) || x === 0) return "0";
    return x < 0.0001 ? x.toExponential(2) : String(Number(x.toFixed(6)));
  };
  const usd = (n) => (n == null || !Number.isFinite(Number(n)) ? "price unavailable" : `$${Number(n).toFixed(2)}`);
  const errCode = (e) => (e && (e.code != null ? e.code : e.error && e.error.code != null ? e.error.code : e.data && e.data.originalError && e.data.originalError.code));
  const errText = (e) => String((e && (e.shortMessage || e.message)) || e || "unknown error").slice(0, 200);

  /**
   * env: { fetch (a window.fetch-like function), getEthereum() -> EIP-1193 provider | null, render(html|null) }
   */
  function create(env) {
    const st = { phase: "idle", target: null, busy: false, message: "", hash: null, protocol: null, id: null };
    let subscribed = null;

    function panel() {
      const t = st.target;
      let body = "";
      if (t) {
        const fees = t.feesOk === true
          ? `${esc(num(t.fee0))} ${esc(t.symbol0)} + ${esc(num(t.fee1))} ${esc(t.symbol1)} (${esc(usd(t.feesUsd))}) <span class="muted">estimate, at current prices</span>`
          : `<span class="muted">fee read unavailable</span>`;
        body = `<h3>Claim fees: ${esc(t.symbol0)} / ${esc(t.symbol1)} #${esc(t.tokenId)}</h3>` +
          `<dl><dt>Manager</dt><dd class="mono" title="${esc(t.manager)}">${esc(core.shortAddr(t.manager))}</dd>` +
          `<dt>Fees go to the owner</dt><dd class="mono" title="${esc(t.owner)}">${esc(t.owner)}</dd>` +
          `<dt>Estimated fees</dt><dd>${fees}</dd></dl>`;
      } else body = `<h3>Claim fees</h3>`;
      const canSend = st.phase === "ready" && !st.busy;
      return `<div class="cfbox" role="dialog" aria-label="Claim fees">${body}` +
        `<p class="cfmsg" role="status">${esc(st.message)}</p>` +
        `${st.hash ? panelHash() : ""}` +
        `<div class="cfbtns"><button type="button" data-cf-act="send"${canSend ? "" : " disabled"}>Send in wallet</button> <button type="button" data-cf-act="close">Close</button></div></div>`;
    }
    function panelHash() {
      const t = st.target;
      if (!core.isTxHash(st.hash)) return "";
      const base = t && core.safeExplorer(t.explorer);
      const url = base ? `${base}/tx/${st.hash}` : null;
      return `<div class="cfhash">Transaction <span class="mono">${esc(st.hash)}</span>${url ? ` <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` : ""}</div>`;
    }
    const draw = () => env.render(panel());
    const say = (msg, phase) => { st.message = msg; if (phase) st.phase = phase; draw(); };

    function close() {
      st.phase = "idle"; st.target = null; st.hash = null; st.message = ""; st.busy = false;
      unsubscribe();
      env.render(null);
    }
    function unsubscribe() {
      if (subscribed && subscribed.eth.removeListener) { subscribed.eth.removeListener("accountsChanged", subscribed.fn); subscribed.eth.removeListener("chainChanged", subscribed.fn); }
      subscribed = null;
    }
    function subscribe() {
      unsubscribe();
      const eth = env.getEthereum();
      if (!eth || !eth.on) return;
      // our own account request / chain switch fire these too: only an idle panel is closed by them
      // after the tx was sent (phase "sent") the panel stays open so the hash remains visible
      const fn = () => { if (!st.busy && st.phase !== "idle" && st.phase !== "sent") close(); };
      eth.on("accountsChanged", fn); eth.on("chainChanged", fn);
      subscribed = { eth, fn };
    }

    async function open(protocol, id) {
      close();
      st.protocol = String(protocol); st.id = String(id);
      st.phase = "loading";
      say("Reading the position...");
      let t;
      try {
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(st.protocol) || !/^\d{1,78}$/.test(st.id)) throw new Error("bad position reference");
        const res = await env.fetch(`/api/claim-fees/target?protocol=${encodeURIComponent(st.protocol)}&id=${encodeURIComponent(st.id)}`);
        t = await res.json();
        if (!t || t.ok !== true) throw new Error((t && t.error) || "the dashboard could not describe this position");
        if (!core.isAllowedManager(t.manager)) throw new Error("the dashboard named a manager that is not a known Base position manager");
        if (!core.isAddress(t.manager) || !core.isAddress(t.owner) || String(t.tokenId) !== st.id || Number(t.chainId) !== core.BASE_CHAIN_ID) throw new Error("the dashboard's answer does not describe a Base position");
      } catch (e) {
        st.target = null;
        say(`Cannot claim: ${errText(e)}`, "error");
        return st;
      }
      st.target = t;
      if (t.staked) say("Staked in the gauge: trading fees go to the gauge's voters. Rewards are claimed through the gauge, not here.", "blocked");
      else if (t.feesOk !== true) say("Fee read unavailable: nothing is sent while the fees cannot be read.", "blocked");
      else if (!(Number(t.fee0) > 0 || Number(t.fee1) > 0)) say("Nothing to collect right now.", "blocked");
      else { st.phase = "ready"; subscribe(); say("Check the details, then send. Your wallet will ask you to confirm."); }
      return st;
    }

    async function send() {
      const t = st.target;
      if (st.busy || st.phase !== "ready" || !t) return st;
      if (!core.isAllowedManager(t.manager)) { say("Refused: the manager is not a known Base position manager. Nothing was sent.", "error"); return st; }
      st.busy = true; st.phase = "pending"; st.hash = null;
      try {
        const eth = env.getEthereum();
        if (!eth || typeof eth.request !== "function") { say("No browser wallet found. Open this page in a browser with Rabby or MetaMask.", "ready"); return st; }
        say("Waiting for the wallet to connect...");
        const accounts = await eth.request({ method: "eth_requestAccounts", params: [] });
        const account = Array.isArray(accounts) ? accounts[0] : null;
        if (!core.isAddress(account)) { say("The wallet did not share an account.", "ready"); return st; }

        let chain = await eth.request({ method: "eth_chainId", params: [] });
        if (String(chain).toLowerCase() !== core.BASE_CHAIN_HEX) {
          say("Switch your wallet to Base in the wallet prompt.");
          try {
            await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: core.BASE_CHAIN_HEX }] });
            chain = await eth.request({ method: "eth_chainId", params: [] });
          } catch (e) {
            say(errCode(e) === 4001 ? "Network switch rejected in the wallet. Nothing changed." : "Could not switch the wallet to Base. Switch it to Base (chain 8453) manually and try again.", "ready");
            return st;
          }
          if (String(chain).toLowerCase() !== core.BASE_CHAIN_HEX) { say("The wallet is not on Base (chain 8453). Switch it manually and try again.", "ready"); return st; }
        }

        if (!core.sameAddress(account, t.owner)) {
          say(`Connected account ${core.shortAddr(account)} does not own this position. The owner is ${core.shortAddr(t.owner)}: connect that account in the wallet.`, "ready");
          return st;
        }
        const raw = await eth.request({ method: "eth_call", params: [{ to: t.manager, data: core.ownerOfCalldata(BigInt(t.tokenId)) }, "latest"] });
        const chainOwner = core.addressFromWord(raw);
        if (!core.sameAddress(chainOwner, t.owner) || !core.sameAddress(chainOwner, account)) {
          say("The wallet's own read of the position owner does not match the dashboard. Nothing was sent.", "ready");
          return st;
        }

        // The user may have switched networks while earlier prompts were open: pin Base again right before sending.
        const nowChain = await eth.request({ method: "eth_chainId", params: [] });
        if (String(nowChain).toLowerCase() !== core.BASE_CHAIN_HEX) { say("The wallet is no longer on Base (chain 8453). Nothing was sent.", "ready"); return st; }
        say("Confirm the transaction in your wallet...");
        const hash = await eth.request({ method: "eth_sendTransaction", params: [{ chainId: core.BASE_CHAIN_HEX, from: account, to: t.manager, data: core.collectCalldata({ tokenId: BigInt(t.tokenId), owner: t.owner }), value: "0x0" }] });
        if (!core.isTxHash(hash)) { say("The wallet returned something that is not a transaction hash. Check the wallet's activity before retrying.", "ready"); return st; }
        st.hash = hash;
        st.busy = false;
        say("Sent. The fees arrive in the owner's wallet once the transaction is mined.", "sent");
        return st;
      } catch (e) {
        say(errCode(e) === 4001 ? "Rejected in the wallet. Nothing changed." : `Wallet error: ${errText(e)}`, "ready");
        return st;
      } finally {
        st.busy = false;
        if (st.phase === "pending") st.phase = "ready";
        draw();
      }
    }

    return { open, send, close, state: st, panel };
  }

  /** Page wiring: delegated clicks on .claimbtn[data-protocol][data-id], and the panel container. */
  function attach(win) {
    const doc = win.document;
    let box = null;
    const ctl = create({
      fetch: win.fetch.bind(win),
      getEthereum: () => win.ethereum || null,
      render(html) {
        if (html == null) { if (box) { box.remove(); box = null; } return; }
        if (!box) { box = doc.createElement("div"); box.id = "claimFeesPanel"; box.className = "cfoverlay"; doc.body.appendChild(box); }
        box.innerHTML = html;
      },
    });
    doc.addEventListener("click", (ev) => {
      const t = ev.target && ev.target.closest ? ev.target : null;
      if (!t) return;
      const btn = t.closest("button.claimbtn[data-protocol][data-id]");
      if (btn && !btn.disabled) { ev.preventDefault(); ctl.open(btn.getAttribute("data-protocol"), btn.getAttribute("data-id")); return; }
      const act = t.closest("[data-cf-act]");
      if (act) { const a = act.getAttribute("data-cf-act"); if (a === "send") ctl.send(); else if (a === "close") ctl.close(); }
    });
    return ctl;
  }

  return { create, attach, esc };
});
