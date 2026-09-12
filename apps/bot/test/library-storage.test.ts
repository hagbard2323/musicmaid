import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SqliteMusicStorage } from '../src/storage/sqlite-storage.js';
import { entryFor, newSession } from '../src/audio/model.js';
const entry = (title = 'Bubbles', user = 'alice') => entryFor({ query: title, source: 'auto', requestedBy: user }, { title, author: 'Artist', uri: 'https://soundcloud.com/artist/' + title, identifier: title, source: 'soundcloud', durationMs: 180000, isStream: false, isSeekable: true });
test('playlists persist exact recordings; names, ownership, guild scope and revisions are enforced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-library-')); const path = join(dir, 'music.sqlite');
  try {
    let store = new SqliteMusicStorage(path); const list = store.library.create('guild', 'alice', 'Evening', [entry()]);
    assert.throws(() => store.library.create('guild', 'bob', 'EVENING'), /already exists/);
    assert.throws(() => store.library.get('other-guild', list.id), /no longer/);
    assert.throws(() => store.library.update('guild', list.id, 0, 'bob', false, p => p.entries.pop()), /creator/);
    const updated = store.library.update('guild', list.id, 0, 'mod', true, p => { p.name = 'Evening mix'; p.entries.push(entry('Second')); });
    assert.throws(() => store.library.update('guild', list.id, 0, 'alice', false, p => p.entries.pop()), /changed/);
    assert.equal(updated.entries[0].recording.uri, list.entries[0].recording.uri);
    assert.equal(store.library.stats('guild', 0).requests, 0);
    store.close(); store = new SqliteMusicStorage(path); assert.deepEqual(store.library.get('guild', list.id), updated);
    assert.throws(() => store.library.delete('guild', list.id, updated.revision, 'bob', false), /creator/);
    store.library.delete('guild', list.id, updated.revision, 'alice', false); assert.equal(store.library.list('guild').length, 0); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('stats count verified requests once, survive history truncation, and exclude loop-generated entries', () => {
  const store = new SqliteMusicStorage(':memory:'); const s = newSession('guild'); s.current = entry(); s.state = 'starting';
  store.saveSession(s); assert.equal(store.library.stats('guild', 0).played, 0);
  s.state = 'playing'; store.saveSession(s); store.saveSession(s);
  s.history = [{ id: 'done', entry: s.current, outcome: 'finished', at: Date.now() }];
  s.current = { ...entry(), requestId: s.current.id }; store.saveSession(s);
  let stats = store.library.stats('guild', 0); assert.equal(stats.requests, 1); assert.equal(stats.played, 1); assert.equal(stats.finished, 1);
  store.library.tag('guild', s.current.recording.uri, ['Electronica', 'ambient'], 'alice');
  stats = store.library.stats('guild', 0); assert.equal(stats.tagged, 1); assert.equal(stats.genres.length, 2);
  s.history = []; s.current = entry('Second', 'bob'); store.saveSession(s);
  assert.equal(store.library.stats('guild', 0).requests, 2); assert.equal(store.library.stats('other', 0).requests, 0);
  store.close();
});
test('statistics failure rolls back the queue write as well', () => {
  const store = new SqliteMusicStorage(':memory:'); const s = newSession('guild'); store.saveSession(s);
  s.queue = [{ ...entry(), addedAt: NaN }]; assert.throws(() => store.saveSession(s));
  assert.equal(store.loadSessions()[0].queue.length, 0); assert.equal(store.library.stats('guild', 0).requests, 0); store.close();
});
test('v2 migration preserves newer sessions even when legacy queue tables remain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-v3-')); const path = join(dir, 'music.sqlite');
  try {
    const s = newSession('guild'); s.queue = [entry('New queue')];
    const db = new DatabaseSync(path); db.exec('CREATE TABLE music_sessions(guild_id TEXT PRIMARY KEY,snapshot TEXT NOT NULL,updated_at INTEGER NOT NULL); CREATE TABLE music_values(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE queued_tracks(guild_id TEXT,position INTEGER,title TEXT,author TEXT,uri TEXT,source_name TEXT); PRAGMA user_version=2;');
    db.prepare('INSERT INTO music_sessions VALUES (?,?,?)').run('guild', JSON.stringify(s), Date.now());
    db.exec("INSERT INTO queued_tracks VALUES ('guild',0,'OLD','Artist','https://soundcloud.com/artist/old','soundcloud')"); db.close();
    const store = new SqliteMusicStorage(path); assert.equal(store.loadSessions()[0].queue[0].recording.title, 'New queue');
    assert.ok(readdirSync(dir).some(p => p.includes('before-v3'))); assert.equal(store.library.stats('guild', 0).requests, 1); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
