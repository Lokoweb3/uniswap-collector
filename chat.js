/**
 * In-site chat for the LP dashboard.
 *
 * Answers questions from the same read-only tools the MCP server exposes
 * (lp-mcp.mjs), driven in-process over an in-memory MCP transport, so the
 * chat and the claude.ai connector always see identical data. Nothing here
 * can arm, collect, or close: the tool set has no write actions.
 *
 * Provider (picked from the environment, all secrets stay in .env):
 *   CHAT_PROVIDER=anthropic|ollama   explicit choice (optional)
 *   ANTHROPIC_API_KEY                Claude via @anthropic-ai/sdk (default when set)
 *   OLLAMA_API_KEY / OLLAMA_HOST     Ollama Cloud (https://ollama.com) or a local Ollama
 *   CHAT_MODEL                       override the model (claude-opus-5 / gpt-oss:120b)
 *   CHAT_EFFORT                      Claude effort: low|medium|high (default medium)
 *
 * Sessions live in RAM (per browser tab id), expire after two hours, and keep
 * the last ~40 turns. One request at a time per session, four in flight overall.
 */
"use strict";

const path = require("path");

const PROVIDER = (process.env.CHAT_PROVIDER || (process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OLLAMA_API_KEY || process.env.OLLAMA_HOST ? "ollama" : "anthropic")).toLowerCase();
const OLLAMA_HOST = (process.env.OLLAMA_HOST || (process.env.OLLAMA_API_KEY ? "https://ollama.com" : "http://localhost:11434")).replace(/\/$/, "");
const MODEL = process.env.CHAT_MODEL || (PROVIDER === "ollama" ? "gpt-oss:120b" : "claude-opus-5");
const EFFORT = ["low", "medium", "high"].includes(process.env.CHAT_EFFORT) ? process.env.CHAT_EFFORT : "medium";
const MAX_TOOL_ROUNDS = 8;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_TURNS = 40;
const MAX_INFLIGHT = 4;
const MAX_MESSAGE_CHARS = 2000;

const SYSTEM = `You are the assistant built into the LP Dashboard, a Uniswap v3/v4 liquidity-position monitor and fee collector on Robinhood Chain (chain id 4663).
You answer questions about the owner's positions, watched wallets, collected fees, revenue, portfolio, risk guardian (per-position alert and auto-close rules), the LOKOVault treasury, staking, attribution, the weekly digest, and system health, using the tools. Call a tool before stating any number; never guess figures. Call several tools in one turn when the question spans them.
You are read-only: you cannot arm the collector, collect, close positions, or change settings. If asked to act, say the dashboard's own controls or the CLI do that, and name which page or command.
Reading the data: fees and revenue are in USD unless a token symbol is given. "In range" means the pool price sits inside the position's band and it earns fees; out of range earns nothing. In memecoin_watch, prices are TOKENS PER ETH, so a larger number means the token is worth less; report tokenValueVsEntryPct as the token's move since entry. Percent changes are already computed; do not invert them.
Style: answer directly in a few short sentences or a bullet list; the panel is narrow, so never use markdown tables or headings. Use $ with two decimals for USD, and the pair name and token id for positions. Say when a value is unpriced or missing rather than filling it in. Do not mention tool names.`;

const sessions = new Map();
let inflight = 0;

function status() {
  const configured = PROVIDER === "ollama"
    ? Boolean(process.env.OLLAMA_API_KEY) || /localhost|127\.0\.0\.1/.test(OLLAMA_HOST)
    : Boolean(process.env.ANTHROPIC_API_KEY);
  return { ok: true, configured, provider: PROVIDER, model: MODEL, host: PROVIDER === "ollama" ? OLLAMA_HOST : "api.anthropic.com" };
}

// ---- tools: the MCP server, in-process ------------------------------------
let mcp = null;
async function tools(port) {
  if (mcp) return mcp;
  if (!process.env.LP_DASHBOARD_URL) process.env.LP_DASHBOARD_URL = `http://127.0.0.1:${port}`;
  const { createServer } = await import(path.join(__dirname, "lp-mcp.mjs"));
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  const client = new Client({ name: "lp-dashboard-chat", version: "1.0.0" });
  await client.connect(clientSide);
  const { tools: list } = await client.listTools();
  const defs = list.map((t) => ({ name: t.name, description: t.description || t.title || t.name, input_schema: t.inputSchema || { type: "object", properties: {} } }));
  const run = async (name, args) => {
    if (!defs.some((d) => d.name === name)) return { error: `unknown tool ${name}` };
    const r = await client.callTool({ name, arguments: args || {} });
    const txt = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (r.isError) return { error: txt || "tool failed" };
    try { return JSON.parse(txt); } catch { return { text: txt }; }
  };
  mcp = { defs, run };
  return mcp;
}

// ---- sessions --------------------------------------------------------------
function session(id) {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.at > SESSION_TTL_MS) sessions.delete(k);
  let s = sessions.get(id);
  if (!s) { s = { messages: [], at: now, busy: false }; sessions.set(id, s); }
  s.at = now;
  return s;
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
async function claudeChat(s, t) {
  if (!anthropic) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropic = new Anthropic();
  }
  const toolDefs = t.defs.map((d) => ({ name: d.name, description: d.description, input_schema: d.input_schema }));
  let text = "";
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: { effort: EFFORT },
      tools: toolDefs,
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
async function ollamaChat(s, t) {
  const headers = { "content-type": "application/json" };
  if (process.env.OLLAMA_API_KEY) headers.authorization = `Bearer ${process.env.OLLAMA_API_KEY}`;
  const toolDefs = t.defs.map((d) => ({ type: "function", function: { name: d.name, description: d.description, parameters: d.input_schema } }));
  let text = "";
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST", headers, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ model: MODEL, stream: false, tools: toolDefs, options: { temperature: 0.2 }, messages: [{ role: "system", content: SYSTEM }, ...s.messages] }),
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
function create({ port }) {
  async function chat({ sessionId, message }) {
    const st = status();
    if (!st.configured) {
      const err = new Error(PROVIDER === "ollama"
        ? "Chat is not configured: set OLLAMA_API_KEY (ollama.com) in .env and restart."
        : "Chat is not configured: set ANTHROPIC_API_KEY (or OLLAMA_API_KEY) in .env and restart.");
      throw Object.assign(err, { status: 503 });
    }
    if (typeof message !== "string" || !message.trim()) throw Object.assign(new Error("empty message"), { status: 400 });
    if (message.length > MAX_MESSAGE_CHARS) throw Object.assign(new Error(`message too long (max ${MAX_MESSAGE_CHARS} characters)`), { status: 400 });
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) throw Object.assign(new Error("bad session id"), { status: 400 });
    const s = session(sessionId);
    if (s.busy) throw Object.assign(new Error("still answering the previous question"), { status: 429 });
    if (inflight >= MAX_INFLIGHT) throw Object.assign(new Error("chat is busy, try again in a moment"), { status: 429 });
    s.busy = true; inflight++;
    try {
      const t = await tools(port);
      const isToolResult = PROVIDER === "ollama"
        ? (m) => m.role === "tool"
        : (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result");
      s.messages.push({ role: "user", content: message.trim() });
      trim(s.messages, isToolResult);
      const started = Date.now();
      const reply = PROVIDER === "ollama" ? await ollamaChat(s, t) : await claudeChat(s, t);
      return { ok: true, reply, model: MODEL, provider: PROVIDER, ms: Date.now() - started };
    } catch (e) {
      // Drop the half-finished exchange so the next question starts clean.
      while (s.messages.length && s.messages[s.messages.length - 1].role !== "user") s.messages.pop();
      if (s.messages.length && s.messages[s.messages.length - 1].role === "user" && !isToolResultMsg(s.messages[s.messages.length - 1])) s.messages.pop();
      if (e && e.status === 401) throw Object.assign(new Error(PROVIDER === "ollama" ? e.message : "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in .env."), { status: 401 });
      if (e && e.status === 429) throw Object.assign(new Error("The model is rate limited right now. Try again in a minute."), { status: 429 });
      throw e;
    } finally {
      s.busy = false; inflight--;
    }
  }
  const isToolResultMsg = (m) => m.role === "tool" || (Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
  function reset(sessionId) { sessions.delete(String(sessionId)); return { ok: true }; }
  return { chat, reset, status, SYSTEM };
}

module.exports = { create, status };
