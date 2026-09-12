import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createViewerServer } from '../../viewer-server/src/server.js';
import type { ViewerSnapshot } from '../src/video/protocol.js';

async function until(condition: () => boolean, milliseconds = 2000) {
  const deadline = Date.now() + milliseconds;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Viewer fixture did not settle.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture() {
  const entryId = randomUUID(), videoId = '2I3PLVuKNtw', guildId = '10000001';
  const snapshot: ViewerSnapshot = { serverTime: Date.now(), runId: 'fixture', voiceChannelId: '30000001', track: { entryId, videoId, title: 'Fixture', artist: 'Artist', durationMs: 205000, positionMs: 0, observedAt: Date.now(), state: 'playing' } };
  const privateUrl = 'https://rr1.googlevideo.com/videoplayback?expire=' + Math.floor(Date.now() / 1000 + 3600) + '&sig=PRIVATE_FIXTURE';
  const active = new Set<AbortSignal>(), signals: AbortSignal[] = [];
  let requests = 0, cancellations = 0, sequence = 0;
  let mode: 'stream' | 'headers-stalled' | '401' | '429' | 'eof' | 'bad-range' = 'stream';
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input);
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: String(new URLSearchParams(String(options?.body)).get('code')), expires_in: 3600, scope: 'identify' });
    if (url.endsWith('/users/@me')) return Response.json({ id: new Headers(options?.headers).get('authorization')!.replace('Bearer fixture-', '') });
    assert.equal(url, privateUrl); requests++;
    const signal = options?.signal!; signals.push(signal); active.add(signal);
    const remove = () => { if (active.delete(signal)) cancellations++; };
    if (mode === 'headers-stalled') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { remove(); reject(new Error('Fixture upstream aborted.')); }, { once: true }));
    if (mode === '401' || mode === '429') return new Response(new ReadableStream({ cancel: remove }), { status: Number(mode) });
    if (mode === 'eof') { active.delete(signal); return new Response('too short', { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '200' } }); }
    if (mode === 'bad-range') return new Response(new ReadableStream({ cancel: remove }), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Length': '8', 'Content-Range': 'invalid' } });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        signal.addEventListener('abort', () => { remove(); controller.error(new Error('Fixture source aborted.')); }, { once: true });
      }, cancel: remove
    }), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '1000' } });
  };
  const server = createViewerServer({ clientId: '12345678', clientSecret: 'fixture-only', publicOrigin: 'https://viewer.example', socketPath: 'unused', assetsDir: '/tmp', fetcher,
    bridge: (async (path: string) => path === '/state' ? snapshot : { id: videoId, url: privateUrl, durationMs: 205000, height: 720, codec: 'avc1', expiresAt: Date.now() + 3600000 }) as never });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const post = (path: string, input: unknown, bearer?: string) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) }, body: JSON.stringify(input) });
  const session = async () => {
    const authResponse = await post('/api/auth', { code: 'fixture-' + String(20000000 + ++sequence), guildId }); assert.equal(authResponse.status, 200);
    const auth = await authResponse.json() as { token: string };
    const response = await post('/api/video', { entryId }, auth.token); assert.equal(response.status, 200);
    const ticket = await response.json() as { path: string };
    return { token: auth.token, url: base + ticket.path };
  };
  return { server, active, signals, session, post, requests: () => requests, cancellations: () => cancellations, mode: (value: typeof mode) => { mode = value; },
    close: () => { server.closeAllConnections(); server.close(); } };
}

test('viewer enforces three streams per session and 24 globally; disconnect returns capacity', async () => {
  const f = await fixture(), aborts: AbortController[] = [];
  try {
    for (let index = 0; index < 8; index++) {
      const session = await f.session();
      for (let connection = 0; connection < 3; connection++) {
        const abort = new AbortController(); aborts.push(abort);
        assert.equal((await fetch(session.url, { signal: abort.signal })).status, 200);
      }
      const denied = await fetch(session.url); assert.equal(denied.status, 429); await denied.body?.cancel();
    }
    assert.equal(f.requests(), 24); assert.equal(f.active.size, 24);
    const next = await f.session(), denied = await fetch(next.url); assert.equal(denied.status, 429); await denied.body?.cancel();
    assert.equal(f.requests(), 24, 'Overload must be rejected before contacting the media source.');
    aborts[0].abort(); await until(() => f.active.size === 23);
    const resumed = new AbortController(); aborts.push(resumed);
    assert.equal((await fetch(next.url, { signal: resumed.signal })).status, 200);
    assert.equal(f.active.size, 24);
  } finally { for (const abort of aborts) abort.abort(); f.close(); await until(() => f.active.size === 0); }
});

test('viewer aborts a stalled upstream header request when its client closes and releases its slot', async () => {
  const f = await fixture(), abort = new AbortController();
  try {
    const session = await f.session(); f.mode('headers-stalled');
    const stopped = assert.rejects(fetch(session.url, { signal: abort.signal }));
    await until(() => f.requests() === 1); abort.abort(); await stopped; await until(() => f.active.size === 0);
    assert.equal(f.signals[0].aborted, true);
    f.mode('stream'); const replacement = new AbortController();
    try { assert.equal((await fetch(session.url, { signal: replacement.signal })).status, 200); }
    finally { replacement.abort(); }
  } finally { abort.abort(); f.close(); await until(() => f.active.size === 0); }
});

test('viewer disposal cancels media readers; rejected authorization/rate/range responses release bodies', async () => {
  const f = await fixture();
  try {
    const session = await f.session();
    for (const mode of ['401', '429', 'bad-range'] as const) {
      f.mode(mode); const response = await fetch(session.url);
      assert.equal(response.status, 502);
      assert.doesNotMatch(await response.text(), /PRIVATE_FIXTURE|googlevideo|fixture-only/);
      assert.equal(f.active.size, 0, 'Rejected upstream response bodies must be canceled.');
    }
    assert.equal(f.cancellations(), 3);
    f.mode('stream'); const response = await fetch(session.url); assert.equal(response.status, 200);
    f.close(); await until(() => f.active.size === 0);
    assert.equal(f.signals.at(-1)?.aborted, true);
    await response.body?.cancel().catch(() => {});
  } finally { f.close(); }
});

test('an early video EOF is visible as incomplete transport and never monopolizes media capacity', async () => {
  const f = await fixture();
  try {
    const session = await f.session(); f.mode('eof');
    const response = await fetch(session.url); assert.equal(response.status, 200);
    await assert.rejects(response.arrayBuffer(), 'A short source body cannot masquerade as the declared complete response.');
    assert.equal(f.active.size, 0);
    f.mode('bad-range'); const retry = await fetch(session.url); assert.equal(retry.status, 502); await retry.body?.cancel();
  } finally { f.close(); }
});
