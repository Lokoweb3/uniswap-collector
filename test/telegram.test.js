// telegram.js: allowed chats, commands, split replies and no polling, with a fake Telegram API and a fake agent.
const assert = require("assert");
const T = require("../telegram");

(async () => {
  const sent = [];
  const calls = { chat: [] };
  const agent = {
    chat: async ({ channel, role, message }) => { calls.chat.push({ channel, role, message }); if (/fail/.test(message)) throw new Error("model down"); return { reply: `echo:${message}` }; },
    reset: (c) => { calls.reset = c; return { ok: true }; },
    status: () => ({ provider: "anthropic", model: "m", configured: true }),
    channels: () => [{ channel: "telegram:529787973", turns: 2 }],
  };
    const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (/sendMessage$/.test(url)) { sent.push(body); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    throw new Error("unexpected " + url);
  };
  const log = { lines: [], log(m) { this.lines.push(m); }, error(m) { this.lines.push("E " + m); } };
  const tg = T.create({ token: "t", agent, allowed: { "529787973": "approve" }, log, fetchImpl });

  // an allowed chat gets an answer on its own channel with its role
  assert.strictEqual(await tg.handle({ chat: { id: 529787973 }, text: " what's pending? " }), "echo:what's pending?");
  assert.deepStrictEqual(calls.chat[0], { channel: "telegram:529787973", role: "approve", message: "what's pending?" });
  assert.strictEqual(sent[0].chat_id, 529787973); assert.strictEqual(sent[0].text, "echo:what's pending?");
  // a stranger is ignored, never answered
  assert.strictEqual(await tg.handle({ chat: { id: 1 }, text: "hello" }), null);
  assert.strictEqual(sent.length, 1); assert.ok(log.lines.some((l) => /ignored/.test(l)));
  // commands
  assert.match(await tg.handle({ chat: { id: 529787973 }, text: "/reset" }), /Forgot/); assert.strictEqual(calls.reset, "telegram:529787973");
  assert.match(await tg.handle({ chat: { id: 529787973 }, text: "/status" }), /anthropic · m · role approve · telegram:529787973: 2 turns/);
  // a model failure becomes a polite reply
  assert.match(await tg.handle({ chat: { id: 529787973 }, text: "fail please" }), /Sorry — model down/);
  // long replies are split
  agent.chat = async () => ({ reply: "x".repeat(9000) });
  await tg.handle({ chat: { id: 529787973 }, text: "long" });
  assert.strictEqual(sent.slice(-3).length, 3); assert.strictEqual(sent[sent.length - 1].text.length, 1000);
  // no polling: nothing in this module calls getUpdates; health says so
  assert.strictEqual(tg.health().polling, false); assert.strictEqual(tg.health().chats, 1);
  assert.strictEqual(typeof tg.start, "undefined", "the long-poll loop is gone");
  // send without a token is a no-op
  assert.strictEqual(await T.create({ token: "", agent, allowed: {}, log, fetchImpl }).send(1, "x"), false);
  console.log("telegram: allowed chats, commands, split replies and no-polling assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
