import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntimeWatchdog, type Notify } from '../src/runtime/watchdog.js';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function scheduler() {
  let callback = () => {}, interval = 0, cancelled = 0;
  return {
    schedule: (tick: () => void, milliseconds: number) => { callback = tick; interval = milliseconds; return () => { cancelled++; }; },
    tick: () => callback(), interval: () => interval, cancelled: () => cancelled
  };
}

test('runtime watchdog reports readiness then recurring heartbeats with no provider or account environment', async () => {
  const timer = scheduler(), calls: { fields: readonly string[]; environment: NodeJS.ProcessEnv }[] = [];
  const stop = startRuntimeWatchdog({ environment: { NOTIFY_SOCKET: '/run/fixture-notify', WATCHDOG_USEC: '60000000', WATCHDOG_PID: String(process.pid), DISCORD_TOKEN: 'private-discord', SPOTIFY_CLIENT_SECRET: 'private-spotify', HTTPS_PROXY: 'private-proxy', PATH: '/untrusted/path' }, schedule: timer.schedule,
    notify: async (fields, environment) => { calls.push({ fields, environment }); } });
  try {
    await flush(); timer.tick(); await flush(); timer.tick(); await flush();
    assert.deepEqual(calls.map(call => call.fields), [['READY=1', 'WATCHDOG=1'], ['WATCHDOG=1'], ['WATCHDOG=1']]);
    assert.equal(timer.interval(), 10000);
    for (const { environment } of calls) assert.deepEqual(environment, { NOTIFY_SOCKET: '/run/fixture-notify', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' });
    assert.equal(JSON.stringify(calls).includes('private-'), false);
  } finally { stop(); }
});

test('watchdog permits only one outstanding notification and stop aborts it and cancels ticks', async () => {
  const timer = scheduler(); let calls = 0, active = 0, maximum = 0, signal!: AbortSignal, finish!: () => void;
  const notify: Notify = async (_fields, _environment, currentSignal) => {
    calls++; maximum = Math.max(maximum, ++active); signal = currentSignal;
    await new Promise<void>(resolve => { finish = resolve; }); active--;
  };
  const stop = startRuntimeWatchdog({ environment: { NOTIFY_SOCKET: '/run/fixture', WATCHDOG_USEC: '1000000' }, schedule: timer.schedule, notify });
  assert.equal(calls, 1);
  for (let index = 0; index < 20; index++) timer.tick();
  assert.equal(calls, 1); assert.equal(maximum, 1);
  stop(); assert.equal(signal.aborted, true); assert.equal(timer.cancelled(), 1);
  finish(); await flush(); timer.tick(); await flush();
  assert.equal(calls, 1, 'A completion or queued tick after stop cannot renew the watchdog.');
});

test('failed readiness notifications retry READY until success and suppress only repeated incident noise', async () => {
  const timer = scheduler(), calls: string[][] = []; let failures = 0, failing = true;
  const stop = startRuntimeWatchdog({ environment: { NOTIFY_SOCKET: '/run/fixture', WATCHDOG_USEC: '60000000' }, schedule: timer.schedule,
    notify: async fields => { calls.push([...fields]); if (failing) throw new Error('fixture notify failure'); }, onFailure: () => { failures++; } });
  try {
    await flush(); timer.tick(); await flush();
    assert.equal(failures, 1);
    assert.deepEqual(calls, [['READY=1', 'WATCHDOG=1'], ['READY=1', 'WATCHDOG=1']]);
    failing = false; timer.tick(); await flush(); timer.tick(); await flush();
    assert.deepEqual(calls[2], ['READY=1', 'WATCHDOG=1']); assert.deepEqual(calls[3], ['WATCHDOG=1']);
    failing = true; timer.tick(); await flush(); assert.equal(failures, 2, 'A new failure after recovery is reported again.');
    assert.deepEqual(calls[4], ['WATCHDOG=1']);
  } finally { stop(); }
});

test('watchdog is inert outside systemd and sends only readiness when watchdog PID does not match', async () => {
  let calls = 0;
  const inert = startRuntimeWatchdog({ environment: { WATCHDOG_USEC: '60000000' }, notify: async () => { calls++; }, schedule: () => { assert.fail('A non-systemd process must not schedule service notifications.'); } });
  inert(); assert.equal(calls, 0);
  const timer = scheduler(), notifications: string[][] = [];
  const stop = startRuntimeWatchdog({ environment: { NOTIFY_SOCKET: '/run/fixture', WATCHDOG_USEC: '60000000', WATCHDOG_PID: String(process.pid + 1) }, schedule: timer.schedule,
    notify: async fields => { notifications.push([...fields]); } });
  try { await flush(); timer.tick(); await flush(); assert.deepEqual(notifications, [['READY=1']]); }
  finally { stop(); }
});

test('the real heartbeat timer cannot advance while the Node event loop is blocked', async () => {
  let calls = 0;
  const stop = startRuntimeWatchdog({ environment: { NOTIFY_SOCKET: '/run/fixture', WATCHDOG_USEC: '200000' }, notify: async () => { calls++; } });
  try {
    await flush(); assert.equal(calls, 1);
    // Deliberately block this test process briefly. No systemd helper is run.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    assert.equal(calls, 1, 'An external timer/worker must not impersonate a responsive bot.');
    await new Promise(resolve => setTimeout(resolve, 130));
    assert.ok(calls >= 2, 'Heartbeats resume once the bot event loop runs again.');
  } finally { stop(); }
});
