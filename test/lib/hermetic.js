// Hermetic child processes for tests that start server.js, chain-router.js or a tool.
// The child gets an allow-listed environment, every credential-looking name set to ""
// (dotenv never overrides a variable that is already set), an empty cwd (no .env to
// find), a fresh HOME (so ~/.lp-collector is never the real one) and a guard that refuses
// non-loopback network use. NODE_OPTIONS carries the guard (--require PRELOAD) into node
// grandchildren the server spawns; a non-node grandchild is protected only by the scrubbed env.
// Temp dirs made here are removed when the test process exits.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const PRELOAD = path.join(__dirname, "..", "fixtures", "no-network.js");
const ALLOW = ["PATH", "HOME", "TMPDIR", "LANG", "NODE_PATH", "SystemRoot", "STUB_LOG", "NO_NETWORK_LOG"];
const SECRET_NAMES = ["TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_AGENT_TOKEN", "TELEGRAM_TREASURY_CHAT_ID", "TELEGRAM_GROUP_CHAT_ID",
  "BLOCKSCOUT_API_KEY", "LP_BLOCKSCOUT_KEY", "LP_BASE_RPC_URL", "LP_PULSE_RPC_URL", "BASE_RPC", "BASE_LOGS_RPC", "PULSE_RPC", "ANTHROPIC_API_KEY", "OLLAMA_API_KEY", "LP_KEYSTORE_PATH", "LP_KEYSTORE_PASS"];
const SECRET_RE = /(TOKEN|SECRET|PASSPHRASE|PASS|API_KEY|_KEY$|KEYSTORE|RPC_URL|CHAT_ID|^TELEGRAM_|^OLLAMA_|^ANTHROPIC_|BLOCKSCOUT)/i;

const made = [];
process.on("exit", () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
function tempDir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; }
const nodeOptions = () => `--require "${PRELOAD.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Environment for a child: allow-list from process.env, secrets blanked, `extra` last. */
function hermeticEnv(extra = {}) {
  const env = {};
  for (const k of ALLOW) if (process.env[k] !== undefined && !SECRET_RE.test(k)) env[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (SECRET_RE.test(k)) env[k] = "";
  for (const k of SECRET_NAMES) env[k] = "";
  const home = tempDir("lp-home-");
  env.HOME = home;
  env.LP_KEYSTORE_PATH = path.join(home, "no-such-keystore", "operator-keystore.json");
  env.NODE_OPTIONS = nodeOptions();
  return { ...env, ...extra };
}

/**
 * For the live smoke test only: the full parent env, but messaging, AI and keystore credentials blanked
 * (RPC and explorer settings are kept because the smoke test talks to the real chain by design).
 */
function scrubbedEnv(base = process.env) {
  const env = { ...base };
  for (const k of Object.keys(env)) if (/^TELEGRAM_|^OLLAMA_|^ANTHROPIC_|KEYSTORE|PASSPHRASE|PASS|CHAT_ID|TOKEN/i.test(k)) env[k] = "";
  for (const k of ["TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_AGENT_TOKEN", "TELEGRAM_TREASURY_CHAT_ID", "TELEGRAM_GROUP_CHAT_ID", "LP_KEYSTORE_PATH", "LP_KEYSTORE_PASS", "ANTHROPIC_API_KEY", "OLLAMA_API_KEY"]) env[k] = "";
  return env;
}

/** A fresh empty directory to use as the child's cwd (dotenv finds no .env there). */
function hermeticCwd() {
  return tempDir("lp-hermetic-");
}

module.exports = { hermeticEnv, scrubbedEnv, hermeticCwd, PRELOAD };
