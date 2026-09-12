import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoadType, type Track } from 'shoukaku';
import { env } from '../src/config/env.js';
import { importPlaylist } from '../src/audio/playlist-import.js';

const input = 'https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL';
const empty = { loadType: LoadType.EMPTY as const, data: {} };
const track = (title = 'Bitch Better Have My Money', source = 'youtube'): Track => ({
  encoded: '', pluginInfo: {}, info: { identifier: 'ukW82Ico4U0', title, author: 'Rihanna',
    uri: source === 'youtube' ? 'https://www.youtube.com/watch?v=ukW82Ico4U0' : 'https://soundcloud.com/rihanna/money',
    length: 219000, sourceName: source, isSeekable: true, isStream: false, position: 0 }
});
const found = (recording = track()) => ({ loadType: LoadType.SEARCH as const, data: [recording] });
async function fixture(t: TestContext, count = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'musicmaid-playlist-fallback-'));
  const saved = { spotifyUserTokenFile: env.spotifyUserTokenFile, spotifyClientId: env.spotifyClientId,
    spotifyClientSecret: env.spotifyClientSecret, spotifyDirectEnabled: env.spotifyDirectEnabled, youtubeCookies: env.youtubeCookies };
  Object.assign(env, { spotifyUserTokenFile: join(directory, 'grant.json'), spotifyClientId: 'fixture-app',
    spotifyClientSecret: 'fixture-secret', spotifyDirectEnabled: false, youtubeCookies: join(directory, 'cookies.txt') });
  await writeFile(env.spotifyUserTokenFile, JSON.stringify({ refresh_token: 'fixture-refresh' }), { mode: 0o600 });
  t.after(async () => { Object.assign(env, saved); await rm(directory, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', async (address: string | URL) => {
    const url = String(address);
    if (url === 'https://accounts.spotify.com/api/token') return Response.json({ access_token: 'fixture-access', expires_in: 3600 });
    assert.ok(url.startsWith('https://api.spotify.com/v1/playlists/'));
    if (!url.includes('/items?')) return Response.json({ name: 'Fixture playlist' });
    return Response.json({ items: Array.from({ length: count }, () => ({ item: { type: 'track', id: '0NTMtAO2BV4tnGvw9EgBVq',
      name: 'Bitch Better Have My Money', duration_ms: 219305, artists: [{ name: 'Rihanna' }] } })), next: null });
  });
}

test('Spotify playlist import uses authenticated search after catalog failure or an unusable version', async t => {
  await fixture(t);
  for (const catalog of ['failed', 'wrong-version']) {
    const calls: string[] = [];
    const result = await importPlaylist(async (id, signal) => {
      assert.ok(signal); calls.push(id.split(':')[0]);
      if (id.startsWith('ytmsearch:')) { if (catalog === 'failed') throw new Error('catalog client refused'); return found(track('Bitch Better Have My Money (Remix)')); }
      if (id.startsWith('scsearch:')) return empty;
      assert.ok(id.startsWith('ytsearch:')); return found();
    }, input, 1, 'listener', new AbortController().signal);
    assert.deepEqual(calls, ['ytmsearch', 'scsearch', 'ytsearch']);
    assert.equal(result.entries.length, 1); assert.equal(result.skipped, 0);
    assert.equal(result.entries[0].recording.identifier, 'ukW82Ico4U0');
    assert.equal(result.entries[0].request.spotify?.id, '0NTMtAO2BV4tnGvw9EgBVq');
  }
});

test('valid catalog matches and original Spotify playback avoid optional fallback work', async t => {
  await fixture(t);
  const calls: string[] = [];
  const result = await importPlaylist(async id => {
    calls.push(id.split(':')[0]);
    if (id.startsWith('ytmsearch:')) return found();
    assert.ok(id.startsWith('scsearch:')); return empty;
  }, input, 1, 'listener', new AbortController().signal);
  assert.equal(result.entries.length, 1); assert.deepEqual(calls, ['ytmsearch', 'scsearch']);
  env.spotifyDirectEnabled = true;
  const original = await importPlaylist(async () => { assert.fail('original audio needs no matching searches'); }, input, 1, 'listener', new AbortController().signal);
  assert.equal(original.entries[0].recording.source, 'spotify');
});

test('fallback keeps matching safeguards and retains a credible other source when search fails', async t => {
  await fixture(t);
  const unmatched = await importPlaylist(async id => id.startsWith('ytsearch:') ? found(track('Bitch Better Have My Money (Remix)')) : empty,
    input, 1, 'listener', new AbortController().signal);
  assert.equal(unmatched.entries.length, 0); assert.equal(unmatched.unmatched.length, 1);
  const soundcloud = await importPlaylist(async id => {
    if (id.startsWith('ytsearch:')) throw new Error('optional search unavailable');
    return id.startsWith('scsearch:') ? found(track(undefined, 'soundcloud')) : empty;
  }, input, 1, 'listener', new AbortController().signal);
  assert.equal(soundcloud.entries[0].recording.source, 'soundcloud');
});

test('cancel during authenticated fallback stops import without issuing the next track request', async t => {
  await fixture(t, 2);
  const abort = new AbortController(), calls: string[] = [];
  await assert.rejects(importPlaylist(async id => {
    calls.push(id.split(':')[0]);
    if (id.startsWith('ytsearch:')) { abort.abort(); return found(); }
    return empty;
  }, input, 1, 'listener', abort.signal));
  assert.deepEqual(calls, ['ytmsearch', 'scsearch', 'ytsearch']);
});
