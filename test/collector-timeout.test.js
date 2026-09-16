// Exercise the actual timeout function with controlled process events and timers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(require.resolve('../memecoin-collect'), 'utf8');
const body = source.slice(source.indexOf('  function runCollector()'), source.indexOf('  /** Telegram.'));
async function scenario(timeout) {
  const child = new EventEmitter();
  child.pid = 123; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const timers = new Map(), signals = [];
  const run = vm.runInNewContext(body + '\nrunCollector', {
    spawn: () => child, path: require('node:path'), dir: '/fixture', log() {},
    COLLECTOR_TIMEOUT_MS: 100,
    process: { env: {}, kill: (pid, sig) => signals.push([pid, sig]) },
    setTimeout: (fn, ms) => { timers.set(ms, fn); return ms; },
    clearTimeout: id => timers.delete(id),
  });
  const result = run();
  if (timeout) timers.get(100)();
  // A shell may exit on TERM while a descendant ignores it and retains the flock.
  child.emit('exit', timeout ? null : 0, timeout ? 'SIGTERM' : null);
  const value = await result;
  if (timeout) {
    assert.equal(value.timedOut, true);
    assert.ok(signals.some(([pid, sig]) => pid === -123 && sig === 'SIGKILL'),
      'shell exit must not cancel cleanup of surviving descendants');
  } else {
    assert.equal(value.code, 0);
    assert.deepEqual(signals, [], 'normal exit requires no process signals');
  }
  assert.equal(timers.size, 0);
}
(async () => { await scenario(false); await scenario(true); console.log('collector-timeout: early shell exit still cleans up timed-out descendants'); })()
.catch(e => { console.error(e); process.exitCode = 1; });
