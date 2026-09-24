#!/usr/bin/env node
/**
 * Recover the operator keystore passphrase from the sealed copy the Arm tab saved
 * (~/.lp-collector/arm-secret.json), using the owner wallet's signature.
 *
 *   node tools/reveal-passphrase.js
 *
 * It serves one page on 127.0.0.1 (a random port, loopback only), asks the owner
 * wallet to sign the SAME arm message the Wallet page signs, decrypts the sealed copy
 * with that signature exactly as arming does, checks it still opens the keystore, and
 * prints it HERE, in this terminal. The passphrase never goes to the browser, and the
 * server exits after one successful answer or after five minutes.
 *
 * Run it in your own terminal, not through an assistant's shell, so the passphrase
 * is not written into a transcript. Record it, then clear the screen.
 */
"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const { ethers } = require("ethers");
const settings = require("../settings");
const armer = require("../arm");

const cfg = settings.load();
const ORIGIN = `127.0.0.1:${Number(process.env.LP_MAIN_PORT || 8787)}`;   // the origin the arm message names
let msg;
try { msg = armer.currentMessage(cfg, ORIGIN); } catch (e) { console.error(`No sealed passphrase to recover: ${e.message}`); process.exit(1); }
if (!armer.configured().configured) { console.error("No sealed passphrase is saved (~/.lp-collector/arm-secret.json)."); process.exit(1); }

const token = crypto.randomBytes(16).toString("hex");   // this run's page only
const page = `<!doctype html><meta charset="utf-8"><title>Recover passphrase</title>
<body style="font:15px/1.5 system-ui;margin:40px;max-width:640px;background:#0f172a;color:#e2e8f0">
<h1 style="font-size:20px">Recover the operator passphrase</h1>
<p>Sign with the owner wallet <code>${cfg.ownerAddress}</code>. This is the same message the Arm tab signs: no transaction, no gas.</p>
<pre style="white-space:pre-wrap;background:#1e293b;padding:12px;border-radius:8px">${msg.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>
<button id="b" style="font:inherit;padding:8px 16px">Connect and sign</button>
<p id="s"></p>
<script>
const MSG = ${JSON.stringify(msg)};
const s = (t) => { document.getElementById('s').textContent = t; };
document.getElementById('b').onclick = async () => {
  try {
    if (!window.ethereum) return s('No wallet found in this browser.');
    const [acct] = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const hex = '0x' + Array.from(new TextEncoder().encode(MSG)).map((b) => b.toString(16).padStart(2, '0')).join('');
    s('Confirm the signature in your wallet...');
    const signature = await window.ethereum.request({ method: 'personal_sign', params: [hex, acct] });
    const r = await fetch('/reveal?t=${token}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signature }) });
    const j = await r.json();
    s(j.ok ? 'Done. The passphrase is printed in the terminal that ran this tool. You can close this tab.' : 'Failed: ' + j.error);
  } catch (e) { s('Failed: ' + (e.message || e)); }
};
</script></body>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(page); }
  if (req.method === "POST" && url.pathname === "/reveal" && url.searchParams.get("t") === token) {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on("end", async () => {
      const send = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      try {
        const { signature } = JSON.parse(body);
        const pass = armer.decrypt(cfg, signature, ORIGIN);
        await ethers.Wallet.fromEncryptedJson(fs.readFileSync(process.env.LP_KEYSTORE_PATH || `${process.env.HOME}/.lp-collector/operator-keystore.json`, "utf8"), pass);
        send({ ok: true });
        console.log("\nOperator passphrase (opens the keystore; verified):\n");
        console.log(`  ${JSON.stringify(pass)}`);
        console.log("\nThe quotes are not part of it; JSON escaping shows any leading or trailing spaces.");
        console.log("Record it in your password manager, then clear this screen (clear; history is not affected).");
        server.close(); setTimeout(() => process.exit(0), 200);
      } catch (e) {
        send({ ok: false, error: e.message });
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(0, "127.0.0.1", () => {
  console.log(`Open http://127.0.0.1:${server.address().port}/ in the browser that has the owner wallet, then sign.`);
  console.log("Waiting up to 5 minutes...");
});
setTimeout(() => { console.error("Timed out; nothing was revealed."); process.exit(1); }, 5 * 60 * 1000).unref();
