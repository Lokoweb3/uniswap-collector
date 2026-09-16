// Execute the real router and tab scripts without sockets or wallet access.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../wallet.html'), 'utf8');
const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
function element(id = '') {
  return { id, hidden: true, style: {}, dataset: {}, value: '', options: [],
    classList: { toggle() {} }, addEventListener() {}, querySelectorAll() { return []; },
    querySelector() { return element(); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  for (const initial of ['arm', 'vault', 'sell', 'mint', 'invalid', '']) {
    const calls = [], listeners = {}, ids = ['arm', 'vault', 'sell', 'mint'];
    const sections = ids.map(id => element('sec-' + id));
    const tabs = ids.map(id => Object.assign(element(), { dataset: { tab: id }, textContent: id }));
    const context = {
      location: { hostname: 'localhost', hash: initial ? '#' + initial : '' },
      document: { getElementById: id => sections.find(s => s.id === id) || (id.startsWith('sec-') ? null : element(id)),
        querySelectorAll: selector => selector === '#tabs a' ? tabs : sections },
      addEventListener: (name, fn) => { listeners[name] = fn; },
      setInterval() {}, setTimeout() {}, clearTimeout() {},
      fetch: async url => { calls.push(url); return { json: async () => ({ ok: false, error: 'fixture' }) }; },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(scripts.find(s => s.includes("querySelectorAll('#tabs a')")), context);
    for (const id of ['arm', 'sell', 'mint']) {
      vm.runInContext(scripts.find(s => s.includes("getElementById('sec-" + id + "')")), context);
    }
    await flush();
    const active = ids.includes(initial) ? initial : 'arm';
    const routes = { arm: '/api/arm/status', sell: '/api/sell/tokens', mint: '/api/mint/context' };
    assert.deepEqual(calls, routes[active] ? [routes[active]] : [], initial + ': only active tab fetches');
    for (const id of [...ids, ...ids]) {
      context.location.hash = '#' + id; listeners.hashchange(); await flush();
      assert.deepEqual(sections.filter(s => !s.hidden).map(s => s.id), ['sec-' + id]);
    }
    for (const route of Object.values(routes)) assert.equal(calls.filter(url => url === route).length, 1, 'initialise once across repeated hash changes');
  }
  console.log('wallet-tabs: active-only requests, fallback and repeat navigation pass');
})().catch(e => { console.error(e); process.exitCode = 1; });
