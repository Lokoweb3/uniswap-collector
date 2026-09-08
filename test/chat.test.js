// chat.js: provider selection and request validation, without any network.
const assert = require("assert");
for (const k of ["ANTHROPIC_API_KEY", "OLLAMA_API_KEY", "OLLAMA_HOST", "CHAT_PROVIDER", "CHAT_MODEL"]) delete process.env[k];
const chat = require("../chat");

(async () => {
  const st = chat.status();
  assert.strictEqual(st.configured, false);
  assert.strictEqual(st.provider, "anthropic");
  assert.strictEqual(st.model, "claude-opus-5");

  const bot = chat.create({ port: 1 });
  await assert.rejects(bot.chat({ sessionId: "abcdefgh1234", message: "hi" }), (e) => e.status === 503 && /not configured/.test(e.message));

  process.env.ANTHROPIC_API_KEY = "test-only-placeholder";
  assert.strictEqual(chat.status().configured, true);
  await assert.rejects(bot.chat({ sessionId: "short", message: "hi" }), (e) => e.status === 400 && /session/.test(e.message));
  await assert.rejects(bot.chat({ sessionId: "abcdefgh1234", message: "   " }), (e) => e.status === 400 && /empty/.test(e.message));
  await assert.rejects(bot.chat({ sessionId: "abcdefgh1234", message: "x".repeat(2001) }), (e) => e.status === 400 && /too long/.test(e.message));
  assert.deepStrictEqual(bot.reset("abcdefgh1234"), { ok: true });
  assert.ok(/read-only/i.test(bot.SYSTEM) && /TOKENS PER ETH/.test(bot.SYSTEM));
  delete process.env.ANTHROPIC_API_KEY;
  console.log("chat.test.js: ok");
})().catch((e) => { console.error(e); process.exit(1); });
