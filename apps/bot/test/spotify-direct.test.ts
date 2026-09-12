import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LoadType } from 'shoukaku';
import { SpotifyOriginalAudio, audioRange, vorbisQuality, type OriginalRecording } from '../src/audio/spotify-direct.js';
import { spotifyRecording } from '../src/audio/spotify.js';
import { searchTracks, resolveSelected } from '../src/audio/sources.js';
import { env } from '../src/config/env.js';
const recording: OriginalRecording = { id: '0NTMtAO2BV4tnGvw9EgBVq', title: 'Fixture', artists: ['Artist'], durationMs: 2000 };
const fixture = () => readFile(new URL('fixtures/stereo-vorbis.ogg', import.meta.url));
test('original Spotify transport handles byte ranges and verifies actual Vorbis format', async () => {
  const bytes = await fixture(); const quality = vorbisQuality(bytes);
  assert.equal(quality.codec, 'vorbis'); assert.equal(quality.sampleRateHz, 44100); assert.equal(quality.bitrateKbps, 320);
  assert.deepEqual(audioRange('bytes=20-29', 100), { start: 20, end: 29, partial: true });
  assert.deepEqual(audioRange('bytes=-10', 100), { start: 90, end: 99, partial: true });
  assert.deepEqual(audioRange('bytes=90-', 100), { start: 90, end: 99, partial: true });
  for (const bad of ['bytes=100-', 'bytes=4-2', 'bytes=0-1,4-5', 'bytes=-0', 'bytes=999999999999999999999-', 'bytes=-']) assert.equal(audioRange(bad, 100), undefined);
  assert.throws(() => vorbisQuality(Buffer.from('not audio')));
});
test('private Spotify stream supports real GET/HEAD/range reads and retains only canonical identity', async () => {
  const bytes = await fixture(); const abort = new AbortController(); let uri = '';
  const service = new SpotifyOriginalAudio('fixture', 'fixture', async () => ({ bytes, recording, quality: vorbisQuality(bytes) }));
  try {
    const result = await service.resolve(recording, async url => {
      uri = url;
      const head = await fetch(url, { method: 'HEAD' }); assert.equal(Number(head.headers.get('content-length')), bytes.length);
      const response = await fetch(url, { headers: { Range: 'bytes=0-31' } }); assert.equal(response.status, 206);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(0, 32));
      const bad = await fetch(url, { headers: { Range: 'bytes=999999999-' } }); assert.equal(bad.status, 416); await bad.body?.cancel();
      const full = await fetch(url); assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
      return { loadType: LoadType.TRACK, data: { encoded: 'private-http-encoding', pluginInfo: {}, info: { identifier: url, uri: url, title: 'HTTP', author: '', length: 2000, position: 0, isStream: false, isSeekable: true, sourceName: 'http' } } };
    }, abort.signal);
    assert.equal(result.loadType, LoadType.TRACK);
    if (result.loadType !== LoadType.TRACK) assert.fail('expected a track');
    assert.equal(result.data.info.uri, 'https://open.spotify.com/track/' + recording.id); assert.equal(result.data.info.sourceName, 'spotify');
    assert.ok(!JSON.stringify(result.data.info).includes('/spotify/'));
    abort.abort(); const removed = await fetch(uri); assert.equal(removed.status, 404); await removed.body?.cancel();
  } finally { service.close(); }
});
test('Spotify original audio refuses mismatched IDs, incomplete durations and cancelled work', async () => {
  const bytes = await fixture(); let calls = 0;
  const service = new SpotifyOriginalAudio('fixture', 'fixture', async (_binary, _file, _recording, signal) => { calls++; signal.throwIfAborted(); return { bytes, recording: { ...recording, id: 'xxxxxxxxxxxxxxxxxxxxxx' }, quality: vorbisQuality(bytes) }; });
  try {
    const abort = new AbortController(); abort.abort();
    await assert.rejects(service.resolve(recording, async () => undefined, abort.signal)); assert.equal(calls, 0);
    await assert.rejects(service.resolve(recording, async () => { assert.fail('wrong recording must not reach audio service'); }), /verified/);
  } finally { service.close(); }
});
test('a selected Spotify recording never resolves to a YouTube substitute', async () => {
  const selected = spotifyRecording({ id: recording.id, name: 'Fixture', artists: ['Artist'], durationMs: 2000 });
  await assert.rejects(resolveSelected(async () => ({ loadType: LoadType.TRACK, data: { encoded: '', pluginInfo: {}, info: { identifier: recording.id, uri: selected.uri, title: 'Fixture', author: 'Artist', sourceName: 'youtube', isStream: false, isSeekable: true, position: 0, length: 2000 } } }), selected), /no other source was substituted/);
});
test('enabled Spotify links select the original ID without issuing a mirror search', async t => {
  const previous = env.spotifyDirectEnabled; env.spotifyDirectEnabled = true;
  const { spotifyRecording } = await import('../src/audio/spotify.js');
  try {
    t.mock.method(globalThis, 'fetch', async (input: string | URL) => String(input).includes('/api/token') ? Response.json({ access_token: 'fixture', expires_in: 3600 }) : Response.json({ id: recording.id, name: 'Bitch Better Have My Money', artists: [{ name: 'Rihanna' }], duration_ms: 219305, explicit: true }));
    const oldId = env.spotifyClientId, oldSecret = env.spotifyClientSecret; env.spotifyClientId = 'fixture'; env.spotifyClientSecret = 'fixture';
    try {
      const result = await searchTracks(async () => { assert.fail('must not search for a mirror'); }, { query: 'https://open.spotify.com/track/' + recording.id, source: 'auto', requestedBy: 'user' });
      assert.equal(result.direct, true); assert.equal(result.candidates[0].source, 'spotify'); assert.equal(result.candidates[0].identifier, recording.id);
      assert.equal(spotifyRecording({ id: recording.id, name: 'Fixture', artists: ['Artist'], durationMs: 2000 }).uri, 'https://open.spotify.com/track/' + recording.id);
    } finally { env.spotifyClientId = oldId; env.spotifyClientSecret = oldSecret; }
  } finally { env.spotifyDirectEnabled = previous; }
});

test('a Spotify source offset keeps full duration while validating the remaining audio', async () => {
  const bytes = await fixture(); const full = { ...recording, durationMs: 122000 }; const abort = new AbortController();
  const service = new SpotifyOriginalAudio('fixture', 'fixture', async (_b, _a, r, _s, _m, startMs) => { assert.equal(startMs, 120000); return { bytes, recording: r, startMs, quality: vorbisQuality(bytes) }; });
  try {
    const result = await service.resolve(full, async url => ({ loadType: LoadType.TRACK, data: { encoded: 'private', pluginInfo: {}, info: { identifier: url, uri: url, title: 'tail', author: '', length: 2000, position: 0, sourceName: 'http', isSeekable: true, isStream: false } } }), abort.signal, 120000);
    if (result.loadType !== LoadType.TRACK) assert.fail('expected track');
    assert.equal(result.data.info.length, 122000); assert.equal((result.data.pluginInfo as { spotifyOffsetMs: number }).spotifyOffsetMs, 120000);
  } finally { abort.abort(); service.close(); }
});

test('direct authorization stays private, rotates safely and can invalidate a cached token', async t => {
  const { mkdtemp, writeFile, readFile, chmod, rm } = await import('node:fs/promises');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const { spotifyDirectToken, invalidateSpotifyDirectToken, SPOTIFY_DEVICE_CLIENT_ID } = await import('../src/audio/spotify-direct-auth.js');
  const dir = await mkdtemp(join(tmpdir(), 'musicmaid-direct-auth-')); const path = join(dir, 'auth.json');
  try {
    await writeFile(path, JSON.stringify({ version: 1, clientId: SPOTIFY_DEVICE_CLIENT_ID, deviceId: 'a'.repeat(40), refreshToken: 'private', scope: 'streaming user-read-private' }), { mode: 0o600 });
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url: string | URL, options?: RequestInit) => {
      calls++; assert.equal(options?.redirect, 'error'); assert.equal(new URLSearchParams(String(options?.body)).get('grant_type'), 'refresh_token');
      return Response.json({ access_token: 'short-lived-' + calls, refresh_token: 'rotated', expires_in: 3600 });
    });
    assert.equal((await spotifyDirectToken(path)).accessToken, 'short-lived-1');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).refreshToken, 'rotated');
    await spotifyDirectToken(path); assert.equal(calls, 1);
    invalidateSpotifyDirectToken(path); await spotifyDirectToken(path); assert.equal(calls, 2);
    await chmod(path, 0o644); await assert.rejects(spotifyDirectToken(path), /account is not connected/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
