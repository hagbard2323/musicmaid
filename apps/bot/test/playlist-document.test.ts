import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { entryFor } from '../src/audio/model.js';
import { SqliteMusicStorage } from '../src/storage/sqlite-storage.js';
import { canonicalPlaylistReference, exportPlaylistDocument, fetchPlaylistAttachment, parsePlaylistDocument, playlistDocumentEntries, playlistDocumentMaxBytes } from '../src/storage/playlist-document.js';
import { resolveSelected } from '../src/audio/sources.js';
import { LoadType } from 'shoukaku';

const youtube = '2I3PLVuKNtw', spotify = '0NTMtAO2BV4tnGvw9EgBVq';
const entries = () => [
  { source: 'youtube' as const, identifier: youtube, uri: `https://youtu.be/${youtube}?si=tracking&t=15`, title: 'Sastanàqqàm', author: 'Tinariwen', durationMs: 205000 },
  { source: 'spotify' as const, identifier: spotify, uri: `https://open.spotify.com/intl-de/track/${spotify}?si=tracking`, title: 'Bitch Better Have My Money', author: 'Rihanna', durationMs: 219305 },
  { source: 'soundcloud' as const, identifier: '123456789', uri: 'https://soundcloud.com/artist/track?utm_source=clipboard', title: 'Track', author: 'Artist', durationMs: 180000 }
].map(recording => ({ ...entryFor({ source: recording.source, query: 'private-request-secret', requestedBy: 'private-member-id' }, { ...recording, isStream: false, isSeekable: true, artworkUrl: 'https://private.example/account-secret', audioQuality: { codec: 'opus' } }), requestId: 'private-loop-id' }));
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

test('playlist export is a versioned songs-only document with public canonical links', () => {
  const result = exportPlaylistDocument({ name: 'Shared favourites', entries: entries() });
  assert.deepEqual(Object.keys(result.document), ['format', 'version', 'name', 'tracks']);
  for (const track of result.document.tracks) assert.deepEqual(Object.keys(track).sort(), ['author', 'durationMs', 'identifier', 'source', 'title', 'uri']);
  assert.deepEqual(result.document.tracks.map(track => track.uri), [`https://www.youtube.com/watch?v=${youtube}`, `https://open.spotify.com/track/${spotify}`, 'https://soundcloud.com/artist/track']);
  assert.equal(result.document.tracks[2].identifier, 'artist/track');
  for (const secret of ['private-request-secret', 'private-member-id', 'private-loop-id', 'account-secret', 'tracking', '123456789', 'audioQuality', 'requestedBy']) {
    assert.equal(result.json.includes(secret), false, secret); assert.equal(result.links.includes(secret), false, secret);
  }
  assert.match(result.links.toString(), /1\. Sastanàqqàm — Tinariwen/);
});

test('export/reimport persists order and duplicate songs with fresh IDs and importer ownership', () => {
  const directory = mkdtempSync(join(tmpdir(), 'musicmaid-playlist-file-')), path = join(directory, 'music.sqlite');
  try {
    let store = new SqliteMusicStorage(path);
    const tracks = entries();
    for (const track of tracks) track.recording.uri = canonicalPlaylistReference(track.recording.source, track.recording.uri).uri;
    tracks.push(structuredClone(tracks[0]));
    const original = store.library.create('guild', 'alice', 'Original', tracks);
    const parsed = parsePlaylistDocument(exportPlaylistDocument(original).json);
    const imported = store.library.create('guild', 'bob', 'Imported copy', playlistDocumentEntries(parsed, 'bob'));
    assert.notEqual(imported.id, original.id); assert.equal(imported.creatorId, 'bob');
    assert.equal(new Set(imported.entries.map(entry => entry.id)).size, 4);
    assert.ok(imported.entries.every(entry => !original.entries.some(before => before.id === entry.id) && entry.request.requestedBy === 'bob' && entry.requestId === undefined));
    assert.deepEqual(imported.entries.map(entry => entry.recording.title), original.entries.map(entry => entry.recording.title));
    assert.equal(imported.entries[2].recording.identifier, imported.entries[2].recording.uri);
    assert.equal(store.library.stats('guild', 0).requests, 0); assert.deepEqual(store.loadSessions(), []);
    assert.throws(() => store.library.update('guild', imported.id, imported.revision, 'alice', false, list => { list.name = 'Stolen'; }), /creator/);
    assert.throws(() => store.library.create('guild', 'alice', 'Imported copy', playlistDocumentEntries(parsed, 'alice')), /already exists/);
    assert.equal(store.library.list('guild').length, 2);
    store.close(); store = new SqliteMusicStorage(path);
    assert.deepEqual(store.library.get('guild', imported.id), imported);
    store.library.update('guild', imported.id, imported.revision, 'moderator', true, list => { list.name = 'Moderated'; });
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('playlist documents reject account fields, malformed schemas, cross-source IDs and credential URLs', () => {
  const original = exportPlaylistDocument({ name: 'Safe', entries: entries() }).document;
  const malicious: unknown[] = [
    { ...original, token: 'credential' }, { ...original, version: 2 }, { ...original, name: 'two\nlines' }, { ...original, name: 'x'.repeat(61) },
    { ...original, tracks: [{ ...original.tracks[0], request: { requestedBy: 'other' } }] },
    { ...original, tracks: [{ ...original.tracks[0], identifier: '11111111111' }] },
    { ...original, tracks: [{ ...original.tracks[0], source: 'spotify' }] },
    { ...original, tracks: [{ ...original.tracks[0], source: 'http', uri: 'http://127.0.0.1:2333/secret' }] },
    { ...original, tracks: [{ ...original.tracks[0], uri: `https://www.youtube.com/watch?v=${youtube}&access_token=private` }] },
    { ...original, tracks: [{ ...original.tracks[2], identifier: 'different/track' }] },
    { ...original, tracks: [{ ...original.tracks[2], uri: 'https://soundcloud.com/artist/track/s-private' }] },
    { ...original, tracks: [{ ...original.tracks[2], uri: 'https://soundcloud.com/artist/track?secret_token=s-private' }] },
    { ...original, tracks: [{ ...original.tracks[2], uri: 'https://user:secret@soundcloud.com/artist/track' }] },
    { ...original, tracks: [{ ...original.tracks[0], durationMs: 0 }] },
    { ...original, tracks: [{ ...original.tracks[0], durationMs: 86400001 }] }
  ];
  for (const document of malicious) assert.throws(() => parsePlaylistDocument(bytes(document)));
  assert.throws(() => parsePlaylistDocument(Buffer.from('{')));
  assert.throws(() => parsePlaylistDocument(Buffer.from([0xff, 0xfe])));
  assert.throws(() => parsePlaylistDocument(Buffer.alloc(playlistDocumentMaxBytes + 1)), /2 MiB/);
  const hidden = entries(); hidden[2].recording.uri += '&secret_token=s-private';
  assert.throws(() => exportPlaylistDocument({ name: 'Private', entries: hidden }), /Private.*SoundCloud/);
  assert.throws(() => canonicalPlaylistReference('soundcloud', 'https://soundcloud.com/artist/sets'));
});

test('file import respects 500-song/50-playlist limits without partial mutation', () => {
  const store = new SqliteMusicStorage(':memory:');
  try {
    const document = exportPlaylistDocument({ name: 'Maximum', entries: entries() }).document;
    document.tracks = Array.from({ length: 500 }, () => document.tracks[0]);
    const parsed = parsePlaylistDocument(bytes(document));
    const created = store.library.create('guild', 'alice', parsed.name, playlistDocumentEntries(parsed, 'alice'));
    assert.equal(created.entries.length, 500);
    assert.throws(() => parsePlaylistDocument(bytes({ ...document, tracks: [...document.tracks, document.tracks[0]] })));
    for (let index = 1; index < 50; index++) store.library.create('guild', 'alice', 'List ' + index);
    assert.throws(() => store.library.create('guild', 'bob', 'Over capacity', playlistDocumentEntries(parsed, 'bob')), /50 playlists/);
    assert.equal(store.library.list('guild').length, 50); assert.equal(store.library.get('guild', created.id).entries.length, 500);
  } finally { store.close(); }
});

test('imported SoundCloud metadata remains a hint and playback requires the exact public permalink', async () => {
  const document = exportPlaylistDocument({ name: 'Exact', entries: [entries()[2]] }).document;
  const selected = playlistDocumentEntries(document, 'alice')[0].recording;
  const actual = { encoded: 'fixture-audio', pluginInfo: {}, info: { identifier: '123456789', sourceName: 'soundcloud', uri: selected.uri, title: 'Provider title', author: 'Provider artist', length: selected.durationMs, isStream: false, isSeekable: true, position: 0 } };
  assert.equal((await resolveSelected(async () => ({ loadType: LoadType.TRACK, data: actual }), selected)).info.title, 'Provider title');
  await assert.rejects(resolveSelected(async () => ({ loadType: LoadType.TRACK, data: { ...actual, info: { ...actual.info, uri: 'https://soundcloud.com/artist/different' } } }), selected), /selected upload/);
});

test('playlist upload fetches only the actual Discord attachment and enforces byte identity and redirect refusal', async () => {
  const content = exportPlaylistDocument({ name: 'Download', entries: entries() }).json;
  const attachment = { id: '20000001', name: 'playlist.json', size: content.length, url: 'https://cdn.discordapp.com/ephemeral-attachments/10000001/20000001/playlist.json?ex=abc&is=def&hm=123' };
  let fetched = 0;
  const fetcher: typeof fetch = async (input, options) => { fetched++; assert.equal(String(input), attachment.url); assert.equal(options?.redirect, 'error'); assert.ok(options?.signal); return new Response(content, { headers: { 'Content-Length': String(content.length) } }); };
  assert.equal((await fetchPlaylistAttachment(attachment, undefined, fetcher)).tracks.length, 3);
  assert.equal((await fetchPlaylistAttachment(attachment, undefined, async () => new Response(content, { headers: { 'Content-Encoding': 'gzip', 'Content-Length': '5' } }))).tracks.length, 3, 'Content-Length may describe compressed transfer bytes; decoded bytes still must match the attachment.');
  for (const url of ['http://127.0.0.1/private', 'https://evil.example/playlist.json', attachment.url.replace('20000001/playlist', '30000001/playlist'), attachment.url + '&redirect=https://evil.example']) await assert.rejects(fetchPlaylistAttachment({ ...attachment, url }, undefined, fetcher));
  assert.equal(fetched, 1);
  await assert.rejects(fetchPlaylistAttachment(attachment, undefined, async () => new Response(content, { headers: { 'Content-Length': String(content.length + 1) } })), /size/);
  await assert.rejects(fetchPlaylistAttachment(attachment, undefined, async () => new Response(content.subarray(0, 5))), /incomplete/);
  await assert.rejects(fetchPlaylistAttachment({ ...attachment, size: 3 }, undefined, async () => new Response(content)), /allowed size/);
  await assert.rejects(fetchPlaylistAttachment(attachment, undefined, async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/playlist.json' } })), /unavailable/);
});
