import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { SqliteMusicStorage } from "../src/storage/sqlite-storage.js";
import { MusicCoordinator, type PlaybackBackend } from "../src/audio/coordinator.js";
import { entryFor } from "../src/audio/model.js";

test("a competing SQLite writer fails promptly without changing queue state and can be retried", async t => {
  t.mock.method(console, "info", () => {});
  const directory = mkdtempSync("/tmp/musicmaid-storage-lock-"); const path = directory + "/music.sqlite";
  const store = new SqliteMusicStorage(path); const writer = new DatabaseSync(path); let locked = false;
  const starts: AbortSignal[] = [];
  const backend: PlaybackBackend = { start: async (_s, _id, signal) => { starts.push(signal); }, stop: async () => {}, pause: async () => {}, seek: async () => {}, volume: async () => {} };
  const music = new MusicCoordinator(store, backend);
  try {
    for (const title of ["Current", "Next"]) await music.enqueue("g", entryFor({ query: title, requestedBy: "u", source: "soundcloud" }, { identifier: title, uri: "https://soundcloud.com/fixture/" + title, title, author: "Artist", source: "soundcloud", durationMs: 180000, isStream: false, isSeekable: true }), "voice", "text");
    const before = music.snapshot("g"), persistedBefore = store.loadSessions()[0], oldAttempt = music.attemptId("g");
    writer.exec("BEGIN IMMEDIATE"); locked = true;
    const began = performance.now(); await assert.rejects(music.skip("g"), /Music storage is busy.*retry/);
    assert.ok(performance.now() - began < 2000, "The synchronous lock wait must stay well below Discord's response deadline");
    assert.deepEqual(music.snapshot("g"), before); assert.deepEqual(store.loadSessions()[0], persistedBefore);
    assert.equal(music.attemptId("g"), oldAttempt); assert.equal(starts[0].aborted, false);
    assert.throws(() => store.setValue("last_service_restart", "123"), /Music storage is busy/);
    assert.equal(store.getValue("last_service_restart"), undefined);
    writer.exec("ROLLBACK"); locked = false;
    await music.skip("g"); assert.equal(music.snapshot("g").current?.recording.title, "Next"); assert.equal(starts[0].aborted, true);
    store.setValue("last_service_restart", "123"); assert.equal(store.getValue("last_service_restart"), "123");
  } finally { if (locked) writer.exec("ROLLBACK"); writer.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
