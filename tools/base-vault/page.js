/* Wiring only: the wallet, the DOM and clicks. Every decision is in flow.js. Browser script, no build step. */
"use strict";
(function () {
  const doc = globalThis.document;
  const $ = (id) => doc.getElementById(id);
  const text = (el, s) => { el.textContent = s == null ? "" : String(s); return el; };
  const mk = (tag, cls, s) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (s != null) e.textContent = s; return e; };

  function render(state) {
    text($("status"), state.error || state.message || (state.connected ? "" : "Not connected."));
    text($("warning"), state.warning || "");
    $("switch").hidden = !state.needSwitch;
    const box = $("steps");
    box.textContent = "";
    for (const s of state.steps) {
      const d = mk("div", "step " + s.status);
      d.appendChild(mk("strong", null, `Step ${s.n}: ${s.name}`));
      d.appendChild(mk("div", null, `Status: ${s.status}${s.reason ? " (" + s.reason + ")" : ""}`));
      if (s.hash) d.appendChild(mk("div", "mono", "tx " + s.hash));
      const b = mk("button", null, s.status === "verified" ? "Done" : "Send in wallet");
      b.type = "button";
      b.disabled = !s.can.ok;
      b.title = s.can.ok ? "" : (s.can.reason || "");
      b.addEventListener("click", () => { flow.send(s.n); });
      d.appendChild(b);
      if (!s.can.ok && s.status !== "verified") d.appendChild(mk("div", null, s.can.reason || ""));
      if (s.n === 4 && s.status !== "verified" && !state.skip4) {
        const k = mk("button", null, "Skip (split stays 10%)");
        k.type = "button";
        k.addEventListener("click", () => { flow.skipFeeSplit(); });
        d.appendChild(k);
      }
      box.appendChild(d);
    }
    const fin = $("final");
    fin.textContent = "";
    if (state.finished) {
      fin.appendChild(mk("h2", null, "Done"));
      fin.appendChild(mk("p", null, state.splitNote || ""));
      for (const [k, v] of [["Implementation", state.impl], ["NFT", state.nft], ["Token-bound account", state.tba]]) fin.appendChild(mk("p", "mono", `${k}: ${v}`));
      fin.appendChild(mk("p", "mono", `Next: node tools/verify-base-vault.js --nft=${state.nft}`));
    }
  }

  let flow;
  fetch("/plan.json").then((r) => r.json()).then((plan) => {
    text($("main"), plan.constants.main);
    flow = globalThis.BaseVaultFlow.create({ getEthereum: () => globalThis.ethereum || null, plan, ethers: globalThis.ethers, render });
    $("connect").addEventListener("click", () => { flow.connect(); });
    $("switch").addEventListener("click", () => { flow.switchChain(); });
    $("refresh").addEventListener("click", () => { flow.refresh(); });
    render({ steps: [1, 2, 3, 4].map((n) => ({ n, name: globalThis.BaseVaultFlow.STEP_NAMES[n], status: "todo", can: { ok: false, reason: "Connect your wallet first." } })), message: "Connect your wallet to begin." });
  }).catch((e) => { text($("status"), "Could not load the plan: " + e.message); });
})();
