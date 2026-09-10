// agent.js (chat.js): provider selection, request validation, channel roles, memory on disk — no network.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
for (const k of ["ANTHROPIC_API_KEY", "OLLAMA_API_KEY", "OLLAMA_HOST", "CHAT_PROVIDER", "CHAT_MODEL"]) delete process.env[k];
const chat = require("../chat");
const agentMod = require("../agent");

(async () => {
  const st = chat.status();
  assert.strictEqual(st.configured, false);
  assert.strictEqual(st.provider, "anthropic");
  assert.strictEqual(st.model, "claude-opus-5");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-"));
  const bot = chat.create({ port: 1, dir });
  await assert.rejects(bot.chat({ channel: "web", message: "hi" }), (e) => e.status === 503 && /not configured/.test(e.message));

  process.env.ANTHROPIC_API_KEY = "test-only-placeholder";
  assert.strictEqual(chat.status().configured, true);
  await assert.rejects(bot.chat({ channel: "bad channel!", message: "hi" }), (e) => e.status === 400 && /channel/.test(e.message));
  await assert.rejects(bot.chat({ channel: "web", message: "   " }), (e) => e.status === 400 && /empty/.test(e.message));
  await assert.rejects(bot.chat({ channel: "web", message: "x".repeat(2001) }), (e) => e.status === 400 && /too long/.test(e.message));
  assert.ok(/same assistant on the website, on Telegram/.test(bot.SYSTEM) && /TOKENS PER QUOTE/.test(bot.SYSTEM));
  assert.ok(/READ-ONLY/.test(bot.ROLE_TEXT.read) && /approve_sale/.test(bot.ROLE_TEXT.approve) && /full access/.test(bot.ROLE_TEXT.full));

  // roles gate the write tools: read sees none, approve sees approve_sale + update_notes, full sees all
  const all = { defs: [{ name: "positions" }, { name: "approve_sale" }, { name: "record_strategy_proposal" }].map((d) => ({ ...d, description: d.name, input_schema: { type: "object", properties: {} } })), run: async (n) => ({ ran: n }) };
  const names = (role) => bot.toolsFor(all, role, { notes: () => "", writeNotes() {} }).defs.map((d) => d.name).sort();
  assert.deepStrictEqual(names("read"), ["positions", "read_notes"]);
  assert.deepStrictEqual(names("approve"), ["approve_sale", "positions", "read_notes", "update_notes"]);
  assert.deepStrictEqual(names("full"), ["approve_sale", "positions", "read_notes", "record_strategy_proposal", "update_notes"]);
  const readTools = bot.toolsFor(all, "read", { notes: () => "n", writeNotes() { throw new Error("must not write"); } });
  assert.match((await readTools.run("approve_sale", {})).error, /not allowed/);
  assert.deepStrictEqual(await readTools.run("read_notes", {}), { notes: "n" });
  let written = null;
  const fullTools = bot.toolsFor(all, "full", { notes: () => "", writeNotes(t) { written = t; } });
  assert.deepStrictEqual(await fullTools.run("update_notes", { text: "vault target $1000" }), { ok: true, chars: 18 });
  assert.strictEqual(written, "vault target $1000");
  assert.deepStrictEqual(await fullTools.run("record_strategy_proposal", {}), { ran: "record_strategy_proposal" });

  // remember(): an alert lands in the Telegram channel's transcript, on disk, and survives a new agent instance
  bot.remember("telegram:123", "assistant", "💱 Sale pending #abc 28,525 Bucket ≈ $98");
  const f = path.join(dir, "agent-memory", "telegram-123.json");
  assert.ok(fs.existsSync(f), "transcript persisted");
  const bot2 = agentMod.create({ port: 1, dir });
  bot2.remember("telegram:123", "user", "approve it");
  const saved = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.strictEqual(saved.provider, "anthropic");
  assert.ok(saved.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("Sale pending #abc")));
  assert.strictEqual(saved.messages[saved.messages.length - 1].role, "user");
  // Anthropic transcripts alternate roles: a second alert in a row gets a marker turn between
  bot2.remember("telegram:123", "assistant", "⌛ expired");
  const alt = JSON.parse(fs.readFileSync(f, "utf8")).messages;
  for (let i = 1; i < alt.length; i++) assert.notStrictEqual(alt[i].role, alt[i - 1].role, "roles alternate");
  assert.deepStrictEqual(bot2.channels().map((c) => c.channel), ["telegram:123"]);
  assert.deepStrictEqual(bot2.reset("telegram:123"), { ok: true });
  assert.ok(!fs.existsSync(f));
  delete process.env.ANTHROPIC_API_KEY;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("chat.test.js: agent provider, validation, roles, notes and memory ok");
})().catch((e) => { console.error(e); process.exit(1); });
