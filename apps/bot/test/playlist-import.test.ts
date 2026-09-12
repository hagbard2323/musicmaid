import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoadType } from 'shoukaku';
import { importPlaylist, youtubePlaylistId } from '../src/audio/playlist-import.js';
import { YoutubeResolver } from '../src/audio/youtube.js';
import { sourceRetryAt } from '../src/audio/source-errors.js';
test('playlist imports reject other hosts, credentials and malformed IDs before lookup', async () => {
  for (const input of ['https://evil.test/playlist?list=PL0123456789', 'https://www.youtube.com@evil.test/playlist?list=PL0123456789', 'http://127.0.0.1:2333', 'https://youtube.com/redirect?list=PL0123456789']) assert.equal(youtubePlaylistId(input), undefined);
  assert.equal(youtubePlaylistId('https://www.youtube.com/watch?v=2I3PLVuKNtw&list=PL0123456789'), 'PL0123456789');
  await assert.rejects(importPlaylist(async () => { assert.fail('must not fetch'); }, 'https://evil.test/playlist', 1, 'u', new AbortController().signal), /YouTube or Spotify/);
});
test('YouTube imports preserve order and exact IDs, skip unavailable entries, and report further batches', async () => {
  const resolver = new YoutubeResolver({ binary: 'fixture', cookies: 'fixture' }, async (_o, args) => {
    assert.ok(args.includes('--flat-playlist')); assert.ok(args.includes('--yes-playlist')); assert.ok(args.includes('100'));
    return { title: 'Fixture', playlist_count: 103, entries: [{ id: '2I3PLVuKNtw', title: 'one', duration: 200, channel: 'Artist' }, null, { id: '85CLbxM8gQ8', title: 'two', duration: 180, channel: 'Artist' }] };
  });
  const result = await importPlaylist(async id => { assert.equal(id, 'ytplaylist:1:PL0123456789'); return resolver.playlist('PL0123456789', 1); }, 'https://www.youtube.com/playlist?list=PL0123456789', 1, 'alice', new AbortController().signal);
  assert.deepEqual(result.entries.map(e => e.recording.identifier), ['2I3PLVuKNtw', '85CLbxM8gQ8']); assert.equal(result.skipped, 1); assert.equal(result.hasMore, true); assert.equal(result.nextStart, 101);
  assert.ok(result.entries.every(e => e.request.requestedBy === 'alice' && !('encoded' in e.recording)));
});
test('cancelled playlist import never issues a source request', async () => {
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(importPlaylist(async () => { assert.fail('cancelled'); }, 'https://www.youtube.com/playlist?list=PL0123456789', 1, 'alice', cancel.signal));
});

test('Spotify import paginates account-authorized items, matches actual uploads and reports missing entries', async t => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { env } = await import('../src/config/env.js'); const { spotifyPlaylist } = await import('../src/audio/spotify-playlists.js');
  const dir = await mkdtemp(join(tmpdir(), 'spotify-playlist-'));
  const before = { file: env.spotifyUserTokenFile, id: env.spotifyClientId, secret: env.spotifyClientSecret };
  env.spotifyUserTokenFile = join(dir, 'user.json'); env.spotifyClientId = 'fixture-id'; env.spotifyClientSecret = 'fixture-secret';
  await writeFile(env.spotifyUserTokenFile, JSON.stringify({ refresh_token: 'private-refresh' }), { mode: 0o600 });
  const requests: string[] = []; let mode = 'normal';
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input); requests.push(url);
    if (url.includes('/api/token')) { assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'), 'refresh_token'); return Response.json({ access_token: 'private-access', refresh_token: 'rotated-private', expires_in: 3600 }); }
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer private-access');
    if (mode === 'forbidden') return new Response('', { status: 403 });
    if (mode === 'limited') return new Response('', { status: 429, headers: { 'retry-after': '12' } });
    if (!url.includes('/items')) return Response.json({ name: 'Fixture mix' });
    if (url.includes('offset=50')) return Response.json({ items: [], next: null });
    return Response.json({ items: [{ item: { type: 'track', id: '0NTMtAO2BV4tnGvw9EgBVq', name: 'Bitch Better Have My Money', duration_ms: 219305, artists: [{ name: 'Rihanna' }], external_ids: { isrc: 'QM5FT1500006' } } }, { item: null }], next: 'https://api.spotify.com/v1/playlists/fixture/items?offset=50' });
  });
  try {
    const input = 'https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL';
    const result = await importPlaylist(async id => id.startsWith('ytmsearch:') ? { loadType: LoadType.SEARCH, data: [{ encoded: '', pluginInfo: {}, info: { identifier: 'ukW82Ico4U0', uri: 'https://www.youtube.com/watch?v=ukW82Ico4U0', title: 'Bitch Better Have My Money', author: 'Rihanna', length: 219000, sourceName: 'youtube', isSeekable: true, isStream: false, position: 0 } }] } : { loadType: LoadType.EMPTY, data: {} }, input, 1, 'alice', new AbortController().signal);
    assert.equal(result.entries.length, 1); assert.equal(result.skipped, 1); assert.equal(result.entries[0].request.spotify?.isrc, 'QM5FT1500006');
    assert.equal(result.entries[0].recording.identifier, 'ukW82Ico4U0'); assert.ok(requests.some(url => url.includes('/items?limit=50&offset=50')));
    assert.equal(JSON.parse(await readFile(env.spotifyUserTokenFile, 'utf8')).refresh_token, 'rotated-private');
    mode = 'forbidden'; await assert.rejects(spotifyPlaylist(input, 1, new AbortController().signal), /own it or be a collaborator/);
    mode = 'limited'; await assert.rejects(spotifyPlaylist(input, 1, new AbortController().signal), /12 seconds/);
  } finally { sourceRetryAt('spotify', Date.now() + 13000); env.spotifyUserTokenFile = before.file; env.spotifyClientId = before.id; env.spotifyClientSecret = before.secret; await rm(dir, { recursive: true, force: true }); }
});
