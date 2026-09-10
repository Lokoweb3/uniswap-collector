/**
 * agent.js — the one brain behind the LP dashboard: the web chat panel, the
 * Telegram bot and loopback callers all talk to this module.
 *
 * It answers from the same tools the MCP server exposes (lp-mcp.mjs), driven
 * in-process over an in-memory MCP transport, so every front door sees the
 * same data. What a caller may do depends on its CHANNEL ROLE, never on the
 * agent's mood:
 *
 *   read     everything that only reads (the web panel behind the gate)
 *   approve  read + approve_sale / reject and updating the notes (Telegram,
 *            from the allowed chat ids)
 *   full     every tool, record_strategy_proposal included (loopback callers)
 *
 * Memory lives on disk under agent-memory/: one transcript per channel
 * (`web`, `telegram:<chatId>`, `loopback`), last ~40 turns, and
 * brain/notes.md, a short file the agent keeps about the owner's standing
 * decisions and preferences (read into every prompt; editable by the
 * update_notes tool on approve/full channels). Alerts the dashboard sends to
 * a Telegram chat are appended to that chat's transcript (remember()), so
 * "approve it" resolves without pasting an id.
 *
 * Provider (from the environment, secrets stay in .env):
 *   CHAT_PROVIDER=anthropic|ollama, ANTHROPIC_API_KEY, OLLAMA_API_KEY/OLLAMA_HOST, CHAT_MODEL, CHAT_EFFORT
 *
 * Incoming Telegram messages are handled by the VPS agent (LokoClawbot); this
 * module answers the web panel and loopback callers, and keeps the memory.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const PROVIDER = (process.env.CHAT_PROVIDER || (process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OLLAMA_API_KEY || process.env.OLLAMA_HOST ? "ollama" : "anthropic")).toLowerCase();
const OLLAMA_HOST = (process.env.OLLAMA_HOST || (process.env.OLLAMA_API_KEY ? "https://ollama.com" : "http://localhost:11434")).replace(/\/$/, "");
const MODEL = process.env.CHAT_MODEL || (PROVIDER === "ollama" ? "gpt-oss:120b" : "claude-opus-5");
const EFFORT = ["low", "medium", "high"].includes(process.env.CHAT_EFFORT) ? process.env.CHAT_EFFORT : "medium";
const MAX_TOOL_ROUNDS = 8;
const MAX_TURNS = 40;
const MAX_INFLIGHT = 4;
const MAX_MESSAGE_CHARS = 2000;
const MAX_NOTES_CHARS = 4000;

const ROLES = { read: 0, approve: 1, full: 2 };
/** Tools that change something, and the lowest role that may call them. */
const WRITE_TOOLS = { approve_sale: "approve", update_notes: "approve", record_strategy_proposal: "full" };

const BASE_SYSTEM = `You are the assistant built into the LP Dashboard, a Uniswap v3/v4 liquidity-position monitor and fee collector on Robinhood Chain (chain id 4663). You are the same assistant on the website, on Telegram and for local scripts; the notes below are what you remember across all of them.
You answer questions about the owner's positions, watched wallets, collected fees, revenue, portfolio, risk guardian (per-position alert and auto-close rules), the LOKOVault treasury, staking, attribution, the weekly digest, pending fee-token sales, and system health, using the tools. Call a tool before stating any number; never guess figures. Call several tools in one turn when the question spans them.
Reading the data: fees and revenue are in USD unless a token symbol is given. "In range" means the pool price sits inside the position's band and it earns fees; out of range earns nothing. In memecoin_watch, prices are TOKENS PER QUOTE (ETH or USDG), so a larger number means the token is worth less; report priceVsEntryPct as the token's move since entry. Percent changes are already computed; do not invert them.
Alerts the dashboard sent to this chat appear in the conversation as your own earlier messages; "it" or "that sale" in a reply refers to the most recent one.
Style: answer directly in a few short sentences or a bullet list; never use markdown tables or headings. Use $ with two decimals for USD, and the pair name and token id for positions. Say when a value is unpriced or missing rather than filling it in. Do not mention tool names.`;

const ROLE_TEXT = {
  read: `This channel is READ-ONLY: you cannot arm the collector, collect, approve sales, close positions, or change settings or notes. If asked to act, say the dashboard's own controls, Telegram, or the CLI do that, and name which page or command.`,
  approve: `On this channel you may approve or reject a pending fee-token sale (approve_sale) when the owner asks, and update the notes with a decision or preference the owner states. Before approving, confirm which sale (pair, amount, expected proceeds) in your reply. You cannot arm the collector, collect, close positions, or change rules; say what does.`,
  full: `This channel has full access: approve or reject sales, record strategy proposals, update the notes. You still cannot arm the collector, collect, or close positions from here; say which page or command does.`,
};

// ---- memory ----------------------------------------------------------------
function memoryStore(dir) {
  const MEM_DIR = path.join(dir, "agent-memory");
  const NOTES = path.join(dir, "brain", "notes.md"); // shared with the VPS agent's brain folder
  try { fs.mkdirSync(MEM_DIR, { recursive: true }); fs.mkdirSync(path.dirname(NOTES), { recursive: true }); } catch {}
  // An older agent-notes.md moves into brain/notes.md once.
  try { const old = path.join(dir, "agent-notes.md"); if (fs.existsSync(old) && !fs.existsSync(NOTES)) fs.renameSync(old, NOTES); } catch {}
  const file = (channel) => path.join(MEM_DIR, `${String(channel).replace(/[^A-Za-z0-9_.:-]/g, "_").replace(/:/g, "-")}.json`);
  const channels = new Map(); // channel -> { messages, provider, at, busy }
  function channel(name) {
    let s = channels.get(name);
    if (s) return s;
    s = { messages: [], provider: PROVIDER, at: 0, busy: false };
    try {
      const j = JSON.parse(fs.readFileSync(file(name), "utf8"));
      if (j && j.provider === PROVIDER && Array.isArray(j.messages)) { s.messages = j.messages; s.at = j.at || 0; }
    } catch {}
    channels.set(name, s);
    return s;
  }
  function persist(name) {
    const s = channels.get(name);
    if (!s) return;
    s.at = Date.now();
    try { fs.writeFileSync(file(name), JSON.stringify({ provider: s.provider, at: s.at, messages: s.messages })); } catch {}
  }
  function forget(name) { channels.delete(name); try { fs.unlinkSync(file(name)); } catch {} }
  function notes() { try { return fs.readFileSync(NOTES, "utf8"); } catch { return ""; } }
  function writeNotes(text) { fs.writeFileSync(NOTES, String(text).slice(0, MAX_NOTES_CHARS)); }
  function list() { return [...channels.keys()].map((name) => ({ channel: name, turns: channels.get(name).messages.length, at: channels.get(name).at })); }
  return { channel, persist, forget, notes, writeNotes, list, NOTES, MEM_DIR };
}

function status() {
  const configured = PROVIDER === "ollama"
    ? Boolean(process.env.OLLAMA_API_KEY) || /localhost|127\.0\.0\.1/.test(OLLAMA_HOST)
    : Boolean(process.env.ANTHROPIC_API_KEY);
  return { ok: true, configured, provider: PROVIDER, model: MODEL, host: PROVIDER === "ollama" ? OLLAMA_HOST : "api.anthropic.com" };
}

// ---- tools: the MCP server in-process, plus the notes tools ------------------
let mcp = null;
async function mcpTools(port) {
  if (mcp) return mcp;
  if (!process.env.LP_DASHBOARD_URL) process.env.LP_DASHBOARD_URL = `http://127.0.0.1:${port}`;
  const { createServer } = await import(path.join(__dirname, "lp-mcp.mjs"));
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  const client = new Client({ name: "lp-dashboard-agent", version: "2.0.0" });
  await client.connect(clientSide);
  const { tools: list } = await client.listTools();
  const defs = list.map((t) => ({ name: t.name, description: t.description || t.title || t.name, input_schema: t.inputSchema || { type: "object", properties: {} } }));
  const run = async (name, args) => {
    const r = await client.callTool({ name, arguments: args || {} });
    const txt = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (r.isError) return { error: txt || "tool failed" };
    try { return JSON.parse(txt); } catch { return { text: txt }; }
  };
  mcp = { defs, run };
  return mcp;
}

/** The tool set a role may use: MCP tools filtered by WRITE_TOOLS, plus the notes tools. */
const INTENT = /\b(approve|approved|yes|go ahead|do it|confirm|ok(ay)?|sell it|reject|rejected|no|cancel|don'?t|decline)\b/i;
function toolsFor(all, role, mem, userMessage = "") {
  const level = ROLES[role] ?? 0;
  const allowed = (name) => !(name in WRITE_TOOLS) || level >= ROLES[WRITE_TOOLS[name]];
  const defs = all.defs.filter((d) => allowed(d.name)).map((d) => ({ name: d.name, description: d.description, input_schema: d.input_schema }));
  defs.push({ name: "read_notes", description: "The notes you keep about the owner's standing decisions and preferences (already in your prompt; call this only to re-check after an update).", input_schema: { type: "object", properties: {} } });
  if (allowed("update_notes")) defs.push({ name: "update_notes", description: "Replace the notes you keep (max 4000 characters). Keep them short: standing decisions, thresholds the owner chose, preferences, open questions. Include everything worth keeping; the previous text is replaced.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } });
  const run = async (name, args) => {
    if (name === "read_notes") return { notes: mem.notes() || "(no notes yet)" };
    if (name === "update_notes") { if (!allowed(name)) return { error: "this channel may not change the notes" }; mem.writeNotes(args && args.text ? args.text : ""); return { ok: true, chars: (args && args.text || "").length }; }
    if (!defs.some((d) => d.name === name)) return { error: `unknown or not allowed on this channel: ${name}` };
    // A sale is only ever decided on the owner's explicit say-so in the message being answered, never on an alert's wording.
    if (name === "approve_sale" && !INTENT.test(userMessage)) return { error: "the owner has not said approve or reject in this message; ask them" };
    return all.run(name, { ...(args || {}), ...(name === "approve_sale" ? { by: `agent` } : {}) });
  };
  return { defs, run };
}

/** Keep the tail of the transcript, never starting on a tool result. */
function trim(messages, isToolResult) {
  while (messages.length > MAX_TURNS) {
    messages.shift();
    while (messages.length && (messages[0].role !== "user" || isToolResult(messages[0]))) messages.shift();
  }
}

// ---- Anthropic -------------------------------------------------------------
let anthropic = null;
async function claudeChat(s, t, system) {
  if (!anthropic) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropic = new Anthropic();
  }
  let text = "";
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      output_config: { effort: EFFORT },
      tools: t.defs,
      messages: s.messages,
    });
    s.messages.push({ role: "assistant", content: res.content });
    text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (res.stop_reason === "refusal") { text = text || "I can't help with that one."; break; }
    const uses = res.content.filter((b) => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || !uses.length) break;
    const results = [];
    for (const u of uses) {
      let out;
      try { out = await t.run(u.name, u.input); } catch (e) { out = { error: e.message }; }
      results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out), is_error: Boolean(out && out.error) });
    }
    s.messages.push({ role: "user", content: results });
  }
  return text || "I ran out of steps before finishing. Try a narrower question.";
}

// ---- Ollama (ollama.com cloud or local) -------------------------------------
async function ollamaChat(s, t, system) {
  const headers = { "content-type": "application/json" };
  if (process.env.OLLAMA_API_KEY) headers.authorization = `Bearer ${process.env.OLLAMA_API_KEY}`;
  const toolDefs = t.defs.map((d) => ({ type: "function", function: { name: d.name, description: d.description, parameters: d.input_schema } }));
  let text = "";
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST", headers, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ model: MODEL, stream: false, tools: toolDefs, options: { temperature: 0.2 }, messages: [{ role: "system", content: system }, ...s.messages] }),
    });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error("Ollama rejected the API key. Set OLLAMA_API_KEY in .env."), { status: 401 });
    if (res.status === 404 && /localhost|127\.0\.0\.1/.test(OLLAMA_HOST)) throw Object.assign(new Error(`Model "${MODEL}" not found on the local Ollama. Run: ollama pull ${MODEL}`), { status: 502 });
    if (!res.ok) throw Object.assign(new Error(`Ollama error ${res.status}: ${(await res.text()).slice(0, 300)}`), { status: 502 });
    const out = await res.json();
    const msg = out.message || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    s.messages.push({ role: "assistant", content: msg.content || "", ...(calls.length ? { tool_calls: calls } : {}) });
    text = (msg.content || "").trim();
    if (!calls.length) break;
    for (const c of calls) {
      const name = c.function && c.function.name;
      let args = (c.function && c.function.arguments) || {};
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
      let result;
      try { result = JSON.stringify(await t.run(name, args)); } catch (e) { result = JSON.stringify({ error: e.message }); }
      s.messages.push({ role: "tool", tool_name: name, content: result });
    }
  }
  return text || "I ran out of steps before finishing. Try a narrower question.";
}

// ---- entry -----------------------------------------------------------------
function create({ port, dir = __dirname } = {}) {
  const mem = memoryStore(dir);
  let inflight = 0;
  const isToolResult = PROVIDER === "ollama"
    ? (m) => m.role === "tool"
    : (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result");
  const systemFor = (role, channel) => {
    const notes = mem.notes().trim();
    return `${BASE_SYSTEM}\n${ROLE_TEXT[role] || ROLE_TEXT.read}\nChannel: ${channel}.\n\nNOTES (what you remember; keep them current with update_notes when allowed):\n${notes || "(nothing yet)"}`;
  };

  /**
   * chat({ channel, role, message }) — one exchange on a channel. Channels:
   * "web", "telegram:<chatId>", "loopback", or anything else a caller names.
   * Returns { ok, reply, model, provider, ms }.
   */
  async function chat({ channel = "web", role = "read", message }) {
    const st = status();
    if (!st.configured) {
      const err = new Error(PROVIDER === "ollama"
        ? "Chat is not configured: set OLLAMA_API_KEY (ollama.com) in .env and restart."
        : "Chat is not configured: set ANTHROPIC_API_KEY (or OLLAMA_API_KEY) in .env and restart.");
      throw Object.assign(err, { status: 503 });
    }
    if (typeof message !== "string" || !message.trim()) throw Object.assign(new Error("empty message"), { status: 400 });
    if (message.length > MAX_MESSAGE_CHARS) throw Object.assign(new Error(`message too long (max ${MAX_MESSAGE_CHARS} characters)`), { status: 400 });
    if (typeof channel !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(channel)) throw Object.assign(new Error("bad channel"), { status: 400 });
    if (!(role in ROLES)) role = "read";
    const s = mem.channel(channel);
    if (s.busy) throw Object.assign(new Error("still answering the previous question"), { status: 429 });
    if (inflight >= MAX_INFLIGHT) throw Object.assign(new Error("chat is busy, try again in a moment"), { status: 429 });
    s.busy = true; inflight++;
    try {
      const t = toolsFor(await mcpTools(port), role, mem, message);
      s.messages.push({ role: "user", content: message.trim() });
      trim(s.messages, isToolResult);
      const started = Date.now();
      const system = systemFor(role, channel);
      const reply = PROVIDER === "ollama" ? await ollamaChat(s, t, system) : await claudeChat(s, t, system);
      mem.persist(channel);
      return { ok: true, reply, model: MODEL, provider: PROVIDER, ms: Date.now() - started, channel, role };
    } catch (e) {
      // Drop the half-finished exchange so the next question starts clean.
      while (s.messages.length && s.messages[s.messages.length - 1].role !== "user") s.messages.pop();
      if (s.messages.length && s.messages[s.messages.length - 1].role === "user" && !isToolResult(s.messages[s.messages.length - 1])) s.messages.pop();
      if (e && e.status === 401) throw Object.assign(new Error(PROVIDER === "ollama" ? e.message : "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in .env."), { status: 401 });
      if (e && e.status === 429) throw Object.assign(new Error("The model is rate limited right now. Try again in a minute."), { status: 429 });
      throw e;
    } finally {
      s.busy = false; inflight--;
    }
  }

  /** Append something that was said on a channel without the model (an alert the dashboard sent there). */
  function remember(channel, roleName, text) {
    if (!text || typeof channel !== "string") return;
    const s = mem.channel(channel);
    const content = String(text).slice(0, 2000);
    if (PROVIDER === "ollama") s.messages.push({ role: roleName === "user" ? "user" : "assistant", content });
    else s.messages.push({ role: roleName === "user" ? "user" : "assistant", content: [{ type: "text", text: content }] });
    // Two assistant messages in a row are fine for Ollama; Anthropic wants alternation, so pad with a marker turn.
    if (PROVIDER !== "ollama") {
      const prev = s.messages[s.messages.length - 2];
      if (prev && prev.role === s.messages[s.messages.length - 1].role) {
        const last = s.messages.pop();
        s.messages.push({ role: last.role === "assistant" ? "user" : "assistant", content: [{ type: "text", text: last.role === "assistant" ? "(dashboard alert follows)" : "(noted)" }] });
        s.messages.push(last);
      }
    }
    trim(s.messages, isToolResult);
    mem.persist(channel);
  }

  function reset(channel) { mem.forget(String(channel || "web")); return { ok: true }; }
  function channels() { return mem.list(); }
  return { chat, remember, reset, status, channels, notes: mem.notes, SYSTEM: BASE_SYSTEM, ROLE_TEXT, toolsFor, WRITE_TOOLS };
}

module.exports = { create, status, ROLES, WRITE_TOOLS };
