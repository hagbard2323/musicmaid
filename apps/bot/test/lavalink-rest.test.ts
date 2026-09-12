import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Client } from 'discord.js';
import { LoadType, type Shoukaku } from 'shoukaku';
import { CancellableRest, lavalinkInfo, lavalinkJson, loadResult } from '../src/audio/lavalink-rest.js';
import { LavalinkBackend } from '../src/audio/player-service.js';
import type { Loader } from '../src/audio/sources.js';
import type { Recording } from '../src/audio/model.js';
import type { YoutubeResolver } from '../src/audio/youtube.js';
import type { SpotifyOriginalAudio } from '../src/audio/spotify-direct.js';

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Lavalink HTTP fixture did not settle.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture(timeoutMs = 2000) {
  const responses = new Set<ServerResponse>(); let received = 0;
  let mode: 'stall' | 'large' | 'redirect' | 'auth' | 'normal' = 'stall';
  const server = createServer((request, response) => {
    received++; responses.add(response); response.on('close', () => responses.delete(response));
    assert.equal(request.headers.authorization, 'FIXTURE_PRIVATE_AUTH');
    const path = new URL(request.url!, 'http://fixture').pathname;
    if (mode === 'redirect') { response.writeHead(302, { Location: 'http://127.0.0.1:9/private-target' }).end(); return; }
    if (mode === 'auth') { response.writeHead(401, { 'Content-Type': 'application/json' }); response.write('{"private":"FIXTURE_PRIVATE_AUTH'); return; }
    if (mode === 'normal') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(path === '/v4/info' ? { version: { semver: '4.2.2' }, plugins: [] } : { loadType: 'empty', data: null })); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.write(mode === 'large' ? 'x'.repeat(256) : '{"incomplete":');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const authority = '127.0.0.1:' + (server.address() as AddressInfo).port;
  const rest = new CancellableRest({ manager: { options: { restTimeout: timeoutMs / 1000 } } }, { name: 'fixture', url: authority, auth: 'FIXTURE_PRIVATE_AUTH', secure: false });
  return { rest, base: 'http://' + authority + '/v4', responses, received: () => received, mode: (value: typeof mode) => { mode = value; }, close: () => { server.closeAllConnections(); server.close(); } };
}

test('Lavalink caller cancellation closes headers-then-stalled JSON for both loadtracks and info', async () => {
  const f = await fixture(5000);
  try {
    for (const path of ['loadtracks', 'info']) {
      const abort = new AbortController(), before = f.received();
      const pending = assert.rejects(path === 'loadtracks' ? f.rest.resolve('scsearch:PRIVATE_QUERY', abort.signal) : lavalinkInfo(f.rest, abort.signal), error => {
        assert.match(String(error), /^Error: Lavalink lookup failed:/);
        assert.doesNotMatch(String(error), /PRIVATE|http:|127\.0\.0\.1/); return true;
      });
      await until(() => f.received() > before); const canceledAt = Date.now(); abort.abort(new Error('PRIVATE_ABORT_REASON'));
      await pending; await until(() => f.responses.size === 0);
      assert.ok(Date.now() - canceledAt < 1000, 'Abort must cancel the actual body read, not wait for the 5-second deadline.');
    }
  } finally { f.close(); }
});

test('Lavalink response deadline also closes a stalled JSON body after headers arrive', async () => {
  const f = await fixture(80);
  try {
    const started = Date.now();
    await assert.rejects(f.rest.resolve('scsearch:Fixture'), /canceled or timed out/);
    await until(() => f.responses.size === 0);
    assert.ok(Date.now() - started < 1200);
    await assert.rejects(lavalinkInfo(f.rest), /canceled or timed out/);
    await until(() => f.responses.size === 0);
  } finally { f.close(); }
});

test('Lavalink rejects oversized bodies, credential-bearing errors and redirects while releasing responses', async () => {
  const f = await fixture();
  try {
    f.mode('large');
    await assert.rejects(lavalinkJson('/info', undefined, { base: f.base, authorization: 'FIXTURE_PRIVATE_AUTH', maxBytes: 64 }), /size limit/);
    await until(() => f.responses.size === 0);
    f.mode('auth');
    await assert.rejects(lavalinkInfo(f.rest), error => { assert.match(String(error), /HTTP 401/); assert.doesNotMatch(String(error), /PRIVATE_AUTH|http:/); return true; });
    await until(() => f.responses.size === 0);
    f.mode('redirect');
    await assert.rejects(lavalinkInfo(f.rest), error => { assert.doesNotMatch(String(error), /PRIVATE_AUTH|private-target|127\.0\.0\.1/); return true; });
  } finally { f.close(); }
});

test('load response validation preserves all v4 load types including null empty data and nullable exception text', () => {
  const track = { encoded: 'fixture', pluginInfo: {}, info: { identifier: 'fixture', title: 'Fixture', author: 'Artist', sourceName: 'soundcloud', uri: 'https://soundcloud.com/artist/track', length: 2000, position: 0, isStream: false, isSeekable: true } };
  for (const value of [
    { loadType: LoadType.TRACK, data: track },
    { loadType: LoadType.SEARCH, data: [track] },
    { loadType: LoadType.PLAYLIST, data: { info: { name: 'Fixture', selectedTrack: -1 }, pluginInfo: {}, tracks: [track] } },
    { loadType: LoadType.EMPTY, data: null },
    { loadType: LoadType.EMPTY, data: {} },
    { loadType: LoadType.ERROR, data: { message: null, severity: 'fault', cause: 'fixture' } },
    { loadType: LoadType.ERROR, data: { severity: 'common', cause: null } }
  ]) assert.equal(loadResult(value).loadType, value.loadType);
  const error = loadResult({ loadType: 'error', data: { message: 'unavailable https://private.example/PRIVATE_TOKEN', severity: 'common', cause: 'Authorization: Bearer PRIVATE_AUTH', causeStackTrace: 'PRIVATE_STACK' } });
  assert.equal(error.loadType, 'error'); assert.doesNotMatch(JSON.stringify(error), /PRIVATE|https?:|Bearer/);
  for (const invalid of [null, {}, { loadType: 'unknown', data: {} }, { loadType: 'track', data: { ...track, info: { ...track.info, title: {} } } }, { loadType: 'search', data: {} }]) assert.throws(() => loadResult(invalid), /invalid load response/);
});

test('every backend source passes cancellation into real Lavalink HTTP and backend close aborts unowned lookups', async () => {
  const f = await fixture(5000);
  const gateway = { nodes: new Map([['fixture', { state: 1, rest: f.rest }]]) } as unknown as Shoukaku;
  const backend = new LavalinkBackend({} as Client, () => gateway, () => {});
  backend['youtube'] = { resolve: (_uri: string, load: Loader, signal: AbortSignal) => load('https://fixture.googlevideo.com/private-audio', signal) } as unknown as YoutubeResolver;
  backend['spotify'] = { resolve: (_recording: unknown, load: Loader, signal: AbortSignal) => load('http://127.0.0.1:32000/spotify/private.ogg', signal), close: () => {} } as unknown as SpotifyOriginalAudio;
  const spotify: Recording = { identifier: '0NTMtAO2BV4tnGvw9EgBVq', uri: 'https://open.spotify.com/track/0NTMtAO2BV4tnGvw9EgBVq', source: 'spotify', title: 'Fixture', author: 'Artist', durationMs: 2000, isStream: false, isSeekable: true };
  try {
    for (const identifier of ['scsearch:Fixture', 'https://www.youtube.com/watch?v=2I3PLVuKNtw', spotify.uri]) {
      const abort = new AbortController(), before = f.received();
      const pending = assert.rejects(backend['resolve'](identifier, abort.signal, 0, identifier === spotify.uri ? spotify : undefined), /Lavalink lookup failed:/);
      await until(() => f.received() > before); abort.abort(); await pending; await until(() => f.responses.size === 0);
    }
    const before = f.received(), pending = assert.rejects(backend.load('scsearch:Fixture'), /Lavalink lookup failed:/);
    await until(() => f.received() > before); backend.close(); await pending; await until(() => f.responses.size === 0);
  } finally { backend.close(); f.close(); }
});
