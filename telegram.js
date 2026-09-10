/**
 * telegram.js — the dashboard's outbound Telegram side for the agent.
 *
 * Incoming Telegram messages are handled by the VPS agent (LokoClawbot), which
 * polls the bot; this process never calls getUpdates, so the two do not fight
 * over the token. What stays here:
 *
 *   send(chatId, text)   sendMessage with the bot token, split at 4096 chars
 *   handle(msg)          answer one message through the agent — for a caller
 *                        that receives messages some other way (a webhook, a
 *                        loopback relay); nothing in this process feeds it
 *
 * Token: TELEGRAM_AGENT_TOKEN, else TELEGRAM_TOKEN, from the environment only.
 * Allowed chats and their roles come from settings.json `alerts`
 * (fallbackChat may approve; `agentChats` [{ chat, role }] adds more).
 */
"use strict";

const MAX_REPLY = 4000;

function create({ token = process.env.TELEGRAM_AGENT_TOKEN || process.env.TELEGRAM_TOKEN, agent, allowed = {}, log = console, fetchImpl = fetch } = {}) {
  const api = (method, body, timeoutMs = 20000) => fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeoutMs),
  });
  let handled = 0;
  const roleFor = (chatId) => allowed[String(chatId)] || null;

  async function send(chatId, text) {
    if (!token || chatId == null) return false;
    for (let i = 0; i < text.length; i += MAX_REPLY) {
      const r = await api("sendMessage", { chat_id: chatId, text: text.slice(i, i + MAX_REPLY), disable_web_page_preview: true });
      if (!r.ok) { log.error && log.error(`telegram agent: sendMessage HTTP ${r.status}`); return false; }
    }
    return true;
  }

  /** Answer one incoming message from an allowed chat on its own channel; strangers are ignored. */
  async function handle(msg) {
    const chatId = msg && msg.chat && msg.chat.id;
    const text = msg && typeof msg.text === "string" ? msg.text.trim() : "";
    if (chatId == null || !text) return null;
    const role = roleFor(chatId);
    if (!role) { log.log && log.log(`telegram agent: ignored a message from chat ${String(chatId).slice(0, 4)}… (not allowed)`); return null; }
    const channel = `telegram:${chatId}`;
    let reply;
    if (text === "/reset") { agent.reset(channel); reply = "Forgot this chat's conversation. The notes stay."; }
    else if (text === "/status") { const st = agent.status(); reply = `${st.provider} · ${st.model}${st.configured ? "" : " (not configured)"} · role ${role} · ${agent.channels().map((c) => `${c.channel}: ${c.turns} turns`).join(", ") || "no memory yet"}`; }
    else if (text === "/start") { reply = "I'm the LP dashboard assistant. Ask about positions, fees, the vault or a pending sale; say \"approve it\" to approve the sale I last told you about."; }
    else {
      try {
        const out = await agent.chat({ channel, role, message: text.replace(/^\/ask\s+/i, "") });
        reply = out.reply;
      } catch (err) {
        reply = `Sorry — ${err.message || "that failed"}.`;
      }
    }
    handled++;
    await send(chatId, reply);
    return reply;
  }

  function health() { return { polling: false, handled, chats: Object.keys(allowed).length, note: "incoming Telegram messages are handled by the VPS agent" }; }
  return { send, handle, health };
}

module.exports = { create };
