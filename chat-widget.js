/* Floating chat panel for the LP dashboard. Talks to POST /api/chat; the
   answers come from the same read-only tools the MCP server exposes.
   Self-contained (injects its own styles) so it works on every page. */
(function () {
  'use strict';
  if (window.__lpChat) return;
  window.__lpChat = true;

  const css = `
.lpc-fab{position:fixed;right:18px;bottom:18px;z-index:9000;width:52px;height:52px;border-radius:50%;border:1px solid var(--glass-border,rgba(255,255,255,.12));
  background:linear-gradient(135deg,rgba(34,211,238,.28),rgba(57,255,136,.18)),var(--card,#0d131b);color:var(--bright,#fff);font-size:22px;cursor:pointer;
  box-shadow:0 8px 28px rgba(0,0,0,.45),0 0 18px rgba(34,211,238,.25);display:flex;align-items:center;justify-content:center;transition:transform .15s}
.lpc-fab:hover{transform:translateY(-2px)}
.lpc-fab.open{display:none}
.lpc{position:fixed;right:18px;bottom:18px;z-index:9001;width:min(400px,calc(100vw - 24px));height:min(600px,calc(100vh - 36px));display:none;flex-direction:column;
  background:var(--card,#0d131b);border:1px solid var(--glass-border,rgba(255,255,255,.12));border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.55);overflow:hidden;
  font:13.5px/1.45 var(--font-ui,system-ui,sans-serif);color:var(--ink,#c9d4de)}
.lpc.open{display:flex}
.lpc-head{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--glass-border,rgba(255,255,255,.1));background:var(--glass,rgba(255,255,255,.035))}
.lpc-head b{color:var(--bright,#fff);font-weight:600}
.lpc-head .lpc-model{font-size:11px;color:var(--muted,#7b8a99);margin-left:auto;font-family:var(--font-mono,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}
.lpc-head button{background:none;border:0;color:var(--muted,#7b8a99);font-size:16px;cursor:pointer;padding:2px 4px;line-height:1}
.lpc-head button:hover{color:var(--bright,#fff)}
.lpc-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}
.lpc-msg{max-width:88%;padding:9px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word}
.lpc-msg.user{align-self:flex-end;background:rgba(34,211,238,.14);border:1px solid rgba(34,211,238,.28);color:var(--bright,#fff);border-bottom-right-radius:4px}
.lpc-msg.bot{align-self:flex-start;background:var(--glass-strong,rgba(255,255,255,.06));border:1px solid var(--glass-border,rgba(255,255,255,.1));border-bottom-left-radius:4px}
.lpc-msg.err{align-self:flex-start;background:rgba(255,77,109,.12);border:1px solid rgba(255,77,109,.4);color:#ffb3c1}
.lpc-msg.wait{color:var(--muted,#7b8a99);font-style:italic}
.lpc-msg code{font-family:var(--font-mono,monospace);font-size:12.5px;color:var(--neon-cyan,#22d3ee)}
.lpc-msg strong{color:var(--bright,#fff)}
.lpc-hints{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 8px}
.lpc-hints button{font:inherit;font-size:11.5px;color:var(--ink,#c9d4de);background:var(--glass,rgba(255,255,255,.035));border:1px solid var(--glass-border,rgba(255,255,255,.12));
  border-radius:999px;padding:4px 10px;cursor:pointer}
.lpc-hints button:hover{border-color:var(--neon-cyan,#22d3ee);color:var(--bright,#fff)}
.lpc-form{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--glass-border,rgba(255,255,255,.1));background:var(--glass,rgba(255,255,255,.035))}
.lpc-form textarea{flex:1;resize:none;min-height:38px;max-height:120px;font:inherit;color:var(--bright,#fff);background:var(--paper,#05070b);border:1px solid var(--rule,#26313d);border-radius:10px;padding:8px 10px;outline:none}
.lpc-form textarea:focus{border-color:var(--neon-cyan,#22d3ee)}
.lpc-form button{font:inherit;font-weight:600;color:#06121a;background:var(--neon-cyan,#22d3ee);border:0;border-radius:10px;padding:0 14px;cursor:pointer}
.lpc-form button:disabled{opacity:.5;cursor:default}
@media (max-width:600px){.lpc{right:0;bottom:0;width:100vw;height:100dvh;border-radius:0}.lpc-fab{right:14px;bottom:14px}}
@media print{.lpc,.lpc-fab{display:none!important}}
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Light markdown: **bold**, `code`, bullet lines.
  const md = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^\s*[-*] /gm, '• ');

  let sid = '';
  try { sid = localStorage.getItem('lpChatSid') || ''; } catch {}
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sid)) {
    sid = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('lpChatSid', sid); } catch {}
  }

  const fab = document.createElement('button');
  fab.className = 'lpc-fab';
  fab.title = 'Ask the dashboard';
  fab.setAttribute('aria-label', 'Open chat');
  fab.textContent = '💬';

  const panel = document.createElement('div');
  panel.className = 'lpc';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Dashboard chat');
  panel.innerHTML = `
    <div class="lpc-head"><span>🤖</span><b>Ask the dashboard</b><span class="lpc-model" id="lpc-model"></span>
      <button type="button" id="lpc-reset" title="New conversation">↺</button>
      <button type="button" id="lpc-close" title="Close">✕</button></div>
    <div class="lpc-log" id="lpc-log"></div>
    <div class="lpc-hints" id="lpc-hints"></div>
    <form class="lpc-form" id="lpc-form">
      <textarea id="lpc-in" rows="1" placeholder="Ask about positions, fees, wallets…" maxlength="2000"></textarea>
      <button type="submit" id="lpc-send">Send</button>
    </form>`;
  document.body.appendChild(fab);
  document.body.appendChild(panel);

  const log = panel.querySelector('#lpc-log');
  const input = panel.querySelector('#lpc-in');
  const send = panel.querySelector('#lpc-send');
  const form = panel.querySelector('#lpc-form');
  const hints = panel.querySelector('#lpc-hints');
  const modelEl = panel.querySelector('#lpc-model');

  const HINTS = ['How are my positions doing?', 'What did I collect this week?', 'Which wallet earned the most?', 'Is anything out of range?', 'How is the vault doing?', 'Is everything healthy?'];

  function add(kind, text, html) {
    const el = document.createElement('div');
    el.className = 'lpc-msg ' + kind;
    if (html) el.innerHTML = html; else el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  function showHints() {
    hints.innerHTML = '';
    for (const h of HINTS) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = h;
      b.addEventListener('click', () => { input.value = h; form.requestSubmit(); });
      hints.appendChild(b);
    }
  }
  function greet() {
    log.innerHTML = '';
    add('bot', '', 'Hi! I can read your positions, collects, revenue, wallets, guardian, exit rules, vault, staking and health. Ask me anything about them. I only read; arming and collecting stay on the dashboard.');
    showHints();
  }

  let busy = false;
  async function ask(q) {
    if (busy) return;
    busy = true; send.disabled = true; hints.innerHTML = '';
    add('user', q);
    const wait = add('bot wait', 'Reading the dashboard…');
    try {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sid, message: q }) });
      const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      wait.remove();
      if (!r.ok || !j.ok) add('err', j.error || `HTTP ${r.status}`);
      else add('bot', '', md(j.reply));
    } catch (e) {
      wait.remove();
      add('err', 'Could not reach the dashboard: ' + e.message);
    } finally {
      busy = false; send.disabled = false; input.focus();
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = ''; input.style.height = '';
    ask(q);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', () => { input.style.height = ''; input.style.height = Math.min(120, input.scrollHeight) + 'px'; });

  let statusLoaded = false;
  async function open() {
    panel.classList.add('open'); fab.classList.add('open');
    if (!statusLoaded) {
      statusLoaded = true;
      try {
        const st = await (await fetch('/api/chat')).json();
        modelEl.textContent = st.model || '';
        modelEl.title = `${st.provider || ''} · ${st.model || ''}`;
        if (!st.configured) add('err', st.provider === 'ollama'
          ? 'Chat is not configured yet: add OLLAMA_API_KEY to .env on the dashboard machine and restart.'
          : 'Chat is not configured yet: add ANTHROPIC_API_KEY (or OLLAMA_API_KEY) to .env on the dashboard machine and restart.');
      } catch {}
    }
    input.focus();
  }
  function close() { panel.classList.remove('open'); fab.classList.remove('open'); }
  fab.addEventListener('click', open);
  panel.querySelector('#lpc-close').addEventListener('click', close);
  panel.querySelector('#lpc-reset').addEventListener('click', async () => {
    try { await fetch('/api/chat/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sid }) }); } catch {}
    greet();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('open')) close(); });

  greet();
  if (location.hash === '#chat') open();
})();
