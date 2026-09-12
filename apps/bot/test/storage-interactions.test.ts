import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteMusicStorage } from "../src/storage/sqlite-storage.js";
import { newSession, entryFor } from "../src/audio/model.js";
import { InteractionState, parsePosition } from "../src/commands/interaction-state.js";
import { reserveRestart } from "../src/commands/service-admin.js";

test("SQLite retains session and restart cooldown across a close/reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "music-storage-")); const path = join(dir, "music.sqlite");
  try {
    let store = new SqliteMusicStorage(path); const s = newSession("guild");
    s.current = entryFor({ query: "Bubbles", source: "soundcloud", requestedBy: "user" }, { identifier: "bubbles", title: "Bubbles", author: "Yosi Horikawa", uri: "https://soundcloud.com/yosi-horikawa/bubbles", source: "soundcloud", durationMs: 347508, isStream: false, isSeekable: true });
    s.positionMs = 30000; s.state = "paused"; store.saveSession(s); reserveRestart(store, "audio", "mod", 1_000_000); store.close();
    store = new SqliteMusicStorage(path); assert.deepEqual(store.loadSessions(), [s]);
    assert.throws(() => reserveRestart(store, "bot", "mod", 1_020_000), /restarted recently/); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("legacy queue migration creates a backup and retains selected URLs without trusting encoded data", () => {
  const dir = mkdtempSync(join(tmpdir(), "music-migration-")); const path = join(dir, "music.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE queued_tracks(guild_id TEXT, position INTEGER, title TEXT, author TEXT, uri TEXT, source_name TEXT, requested_by_user_id TEXT); INSERT INTO queued_tracks VALUES ('g',1,'Bubbles','Yosi Horikawa','https://soundcloud.com/yosi-horikawa/bubbles','soundcloud','u');"); legacy.close();
    const store = new SqliteMusicStorage(path); const s = store.loadSessions()[0]; assert.equal(s.state, "suspended"); assert.equal(s.queue[0].recording.title, "Bubbles");
    assert.ok(readdirSync(dir).some(name => name.includes("before-v3"))); store.close();
    const reopened = new SqliteMusicStorage(path); assert.equal(reopened.loadSessions()[0].queue.length, 1); reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("newer database schema is refused instead of downgraded", () => {
  const dir = mkdtempSync(join(tmpdir(), "music-newer-")); const path = join(dir, "music.sqlite");
  try { const db = new DatabaseSync(path); db.exec("PRAGMA user_version=99"); db.close(); assert.throws(() => new SqliteMusicStorage(path), /newer/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
test("picker ownership, expiry, guild binding and exactly-once consumption", () => {
  let now = 0; const state = new InteractionState<string>(() => now); const id = state.create("alice", "guild", "song");
  assert.throws(() => state.read(id, "bob", "guild", true), /Only the person/);
  assert.throws(() => state.read(id, "alice", "other", true), /Only the person/);
  assert.equal(state.read(id, "alice", "guild", true), "song"); assert.throws(() => state.read(id, "alice", "guild"), /expired/);
  const second = state.create("alice", "guild", "song"); now = 120_001; assert.throws(() => state.read(second, "alice", "guild"), /expired/);
});
test("position parsing rejects malformed values", () => {
  assert.equal(parsePosition("1:28"), 88000); assert.equal(parsePosition("1:01:02"), 3662000); assert.equal(parsePosition("88"), 88000);
  for (const value of ["-1", "1:99", "oops", "1.5", "1:2", "1:00:00:00"]) assert.throws(() => parsePosition(value));
});
