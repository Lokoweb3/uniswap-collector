/**
 * telegram.js — the agent's Telegram front door.
 *
 * Long-polls getUpdates with the bot token and hands every message from an
 * allowed chat to agent.chat({ channel: "telegram:<chatId>", role }). Replies
 * go back to the same chat (split at Telegram's 4096-character limit).
 * Messages from any other chat are ignored, never answered.
 *
 * Token: TELEGRAM_AGENT_TOKEN, else TELEGRAM_TOKEN (the alert bot) — from the
 * environment only. Allowed chats and their roles come from settings.json
 * `alerts`: fallbackChat (the owner's personal chat) may approve sales;
 * `agentChats` [{ chat, role }] adds more.
 *
 * Only one process may poll a bot token. When Telegram answers 409 Conflict
 * (another poller, typically the VPS agent using the same bot), this backs
 * off for a minute and says so in the log once every ten minutes, without
 * ever answering on that bot's behalf. Set TELEGRAM_AGENT_TOKEN to a second
 * bot to run both.
 *
 * Commands: /reset (forget this chat's transcript), /status (provider, model, memory).
 */
"use strict";

const POLL_TIMEOUT_S = 30;
const CONFLICT_BACKOFF_MS = 60 * 1000;
const MAX_REPLY = 4000;

function create({ token = process.env.TELEGRAM_AGENT_TOKEN || process.env.TELEGRAM_TOKEN, agent, allowed = {}, log = console, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const api = (method, body, timeoutMs = 20000) => fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeoutMs),
  });
  let running = false, offset = 0, conflictNoticeAt = 0, lastPollAt = 0, handled = 0, startedAt = 0;
  const roleFor = (chatId) => allowed[String(chatId)] || null;

  async function send(chatId, text) {
    for (let i = 0; i < text.length; i += MAX_REPLY) {
      const r = await api("sendMessage", { chat_id: chatId, text: text.slice(i, i + MAX_REPLY), disable_web_page_preview: true });
      if (!r.ok) { log.error && log.error(`telegram agent: sendMessage HTTP ${r.status}`); return false; }
    }
    return true;
  }

  /** Answer one incoming message. Exported for tests. */
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

  async function poll() {
    const r = await api("getUpdates", { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["message"] }, (POLL_TIMEOUT_S + 10) * 1000);
    if (r.status === 409) {
      if (now() - conflictNoticeAt > 10 * 60 * 1000) { conflictNoticeAt = now(); log.log && log.log("telegram agent: another process is polling this bot token (409 Conflict) — the VPS agent? Set TELEGRAM_AGENT_TOKEN to a second bot to run both. Retrying every minute."); }
      return CONFLICT_BACKOFF_MS;
    }
    if (r.status === 401) { log.error && log.error("telegram agent: the bot token was rejected (401); stopping"); running = false; return 0; }
    if (!r.ok) { log.error && log.error(`telegram agent: getUpdates HTTP ${r.status}`); return 15000; }
    const j = await r.json();
    lastPollAt = now();
    for (const u of j.result || []) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg) continue;
      if (startedAt && msg.date && msg.date * 1000 < startedAt - 60000) continue; // backlog from before this process started
      try { await handle(msg); } catch (err) { log.error && log.error(`telegram agent: ${err.message}`); }
    }
    return 0;
  }

  async function start() {
    if (!token) { log.log && log.log("telegram agent: no bot token (TELEGRAM_AGENT_TOKEN / TELEGRAM_TOKEN); not started"); return false; }
    if (!Object.keys(allowed).length) { log.log && log.log("telegram agent: no allowed chats (settings alerts.fallbackChat / agentChats); not started"); return false; }
    running = true; startedAt = now();
    // Skip whatever queued up while nobody was listening.
    try { const r = await api("getUpdates", { offset: -1, timeout: 0 }); if (r.ok) { const j = await r.json(); const last = (j.result || []).pop(); if (last) offset = last.update_id + 1; } } catch {}
    log.log && log.log(`telegram agent: listening for ${Object.keys(allowed).length} chat(s)`);
    (async () => {
      while (running) {
        let wait = 1000;
        try { wait = (await poll()) || 1000; } catch (err) { log.error && log.error(`telegram agent: ${err.name === "TimeoutError" ? "poll timed out" : err.message}`); wait = 10000; }
        if (running && wait) await new Promise((res) => setTimeout(res, wait));
      }
    })();
    return true;
  }
  function stop() { running = false; }
  function health() { return { running, lastPollAt, handled, chats: Object.keys(allowed).length, conflict: conflictNoticeAt > 0 && now() - conflictNoticeAt < 11 * 60 * 1000 }; }
  return { start, stop, handle, health, send };
}

module.exports = { create };
