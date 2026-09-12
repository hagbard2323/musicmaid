import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { SqliteMusicStorage } from "../src/storage/sqlite-storage.js";
import { MusicCoordinator, type PlaybackBackend } from "../src/audio/coordinator.js";
import { failureScope, isRecordingFailure } from "../src/audio/diagnostics.js";
import { entryFor, type FailureScope, type RecordingSource, type Session } from "../src/audio/model.js";
import { markSourceFailure, trackFailure } from "../src/audio/track-health.js";
import type { MusicStorage } from "../src/storage/types.js";

class MemoryStore implements MusicStorage {
  sessions = new Map<string, Session>(); fail = false;
  loadSessions() { return [...this.sessions.values()].map(s => structuredClone(s)); }
  saveSession(session: Session) { if (this.fail) throw new Error("disk full"); this.sessions.set(session.guildId, structuredClone(session)); }
  getValue() { return undefined; } setValue() {} close() {}
}
async function fixture(count = 5, source: RecordingSource = "soundcloud") {
  let now = Date.now(), startError: string | undefined, controlError = false, desiredVolume = 100;
  const store = new MemoryStore();
  const starts: Array<{ session: Session; id: string; signal: AbortSignal; reconnect: boolean }> = [], stops: boolean[] = [];
  const failures: Array<{ scope: FailureScope; reason: string }> = [];
  let volume: (value: number) => Promise<void> = async () => {};
  const backend: PlaybackBackend = {
    start: async (session, id, signal, reconnect) => { starts.push({ session, id, signal, reconnect }); if (startError) throw new Error(startError); },
    stop: async (_guild, disconnect) => { stops.push(disconnect); },
    pause: async () => { if (controlError) throw new Error("Lavalink REST HTTP 500"); },
    seek: async () => { if (controlError) throw new Error("Lavalink REST HTTP 500"); },
    volume: async (_guild, value) => { desiredVolume = value; await volume(value); },
    restoreVolumeIntent: (_guild, attempted, previous) => { if (desiredVolume === attempted) desiredVolume = previous; }
  };
  const music = new MusicCoordinator(store, backend, { now: () => now, onFailure: (entry, reason, scope) => {
    failures.push({ scope, reason });
    if (isRecordingFailure(reason, scope)) markSourceFailure(entry.recording.source, entry.recording.uri, reason, now);
  } });
  for (let n = 0; n < count; n++) {
    const identifier = randomUUID().replaceAll("-", "").slice(0, source === "youtube" ? 11 : 22);
    const uri = source === "youtube" ? "https://www.youtube.com/watch?v=" + identifier : source === "spotify" ? "https://open.spotify.com/track/" + identifier : "https://soundcloud.com/fixture/" + identifier;
    await music.enqueue("g", entryFor({ query: "Song " + n, requestedBy: "u", source: "auto" }, {
      identifier, uri, title: "Song " + n, author: "Artist", source, durationMs: 180000, isStream: false, isSeekable: true
    }, now), "voice", "text");
  }
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const playing = async (positionMs = 5000) => {
    const attemptId = music.attemptId("g")!;
    await music.event("g", { type: "start", attemptId }); now += 1000;
    await music.event("g", { type: "update", attemptId, positionMs, time: now, connected: true });
  };
  if (count) await playing();
  return { music, store, backend, starts, stops, failures, settle, playing,
    step: (ms: number) => { now += ms; }, now: () => now,
    outage: (reason?: string) => { startError = reason; }, rejectControls: () => { controlError = true; },
    volumeWork: (work: typeof volume) => { volume = work; }, desiredVolume: () => desiredVolume };
}
const serviceDown = "The audio service is disconnected. A mod can use /music-admin repair.";

test("a three-minute audio outage retains every queue entry and resumes its environment hold", async t => {
  t.mock.method(console, "info", () => {});
  const h = await fixture(); const before = h.music.snapshot("g"); h.outage(serviceDown);
  await h.music.event("g", { type: "failure", attemptId: h.music.attemptId("g")!, reason: serviceDown });
  for (let n = 0; n < 180; n++) { h.step(1000); await h.music.tick(); await h.settle(); }
  const held = h.music.snapshot("g");
  assert.equal(held.state, "suspended"); assert.equal(held.failure?.scope, "environment"); assert.equal(held.failure?.deadline, undefined);
  assert.equal(held.current?.id, before.current?.id); assert.equal(held.positionMs, before.positionMs);
  assert.deepEqual(held.queue, before.queue); assert.deepEqual(held.history, before.history); assert.equal(h.starts.length, 3);
  for (const entry of [held.current!, ...held.queue]) assert.equal(trackFailure(entry.recording.uri, h.now()), undefined);
  h.outage(); await h.music.resume("g", "voice", "text"); await h.playing(6000);
  assert.equal(h.music.snapshot("g").state, "playing"); assert.equal(h.music.snapshot("g").current?.id, before.current?.id);
  assert.equal(h.starts.at(-1)?.session.positionMs, before.positionMs);
});

test("permission denial holds immediately and legacy environment failures resume after restart", async t => {
  t.mock.method(console, "info", () => {});
  const h = await fixture(); const before = h.music.snapshot("g");
  await h.music.event("g", { type: "failure", attemptId: h.music.attemptId("g")!, reason: "Voice: MusicMaid needs Connect and Speak." });
  h.step(300000); await h.music.tick();
  assert.equal(h.music.snapshot("g").state, "suspended"); assert.equal(h.starts.length, 1);
  assert.deepEqual(h.music.snapshot("g").queue, before.queue); assert.equal(h.music.snapshot("g").history.length, 0);
  const legacy = h.store.loadSessions()[0]; legacy.failure = { reason: serviceDown, incidentId: "legacy", deadline: h.now() + 60000 }; h.store.saveSession(legacy);
  const restored = new MusicCoordinator(h.store, h.backend);
  assert.equal(restored.snapshot("g").failure?.scope, "environment"); assert.equal(restored.snapshot("g").failure?.deadline, undefined);
  await restored.resume("g", "voice", "text"); assert.equal(restored.snapshot("g").state, "starting");
  assert.equal(h.starts.at(-1)?.session.current?.id, before.current?.id);
});

test("SQLite preserves an environment hold across restart and Resume starts the same request without a choice timer", async t => {
  t.mock.method(console, "info", () => {});
  const directory = mkdtempSync("/tmp/musicmaid-environment-sqlite-");
  let storage: SqliteMusicStorage | undefined;
  let now = Date.now();
  const starts: Session[] = [];
  const backend: PlaybackBackend = { start: async session => { starts.push(session); }, stop: async () => {}, pause: async () => {}, seek: async () => {}, volume: async () => {} };
  try {
    storage = new SqliteMusicStorage(directory + "/music.sqlite");
    const music = new MusicCoordinator(storage, backend, { now: () => now });
    for (let n = 0; n < 5; n++) await music.enqueue("g", entryFor({ query: "Song " + n, source: "auto", requestedBy: "u" }, {
      identifier: "sqlite-song-" + n, uri: "https://soundcloud.com/fixture/sqlite-song-" + n, title: "Song " + n, author: "Artist", source: "soundcloud", durationMs: 180000, isStream: false, isSeekable: true
    }, now), "voice", "text");
    let attemptId = music.attemptId("g")!; await music.event("g", { type: "start", attemptId }); now += 1000;
    await music.event("g", { type: "update", attemptId, positionMs: 30000, connected: true, time: now });
    const before = music.snapshot("g");
    for (let n = 0; n < 3; n++) {
      attemptId = music.attemptId("g")!;
      await music.event("g", { type: "failure", attemptId, reason: serviceDown });
      now += 4000; await music.tick();
    }
    assert.equal(music.snapshot("g").state, "suspended");
    storage.close(); storage = undefined;
    storage = new SqliteMusicStorage(directory + "/music.sqlite");
    const saved = storage.loadSessions()[0];
    assert.equal(saved.failure?.scope, "environment"); assert.equal(Object.hasOwn(saved.failure!, "deadline"), false);
    const restored = new MusicCoordinator(storage, backend, { now: () => now });
    assert.equal(restored.snapshot("g").state, "suspended"); assert.deepEqual(restored.snapshot("g").queue, before.queue);
    await restored.resume("g", "voice", "text");
    assert.equal(restored.snapshot("g").state, "starting"); assert.equal(restored.snapshot("g").failure, undefined);
    assert.equal(starts.at(-1)?.current?.id, before.current?.id); assert.equal(starts.at(-1)?.positionMs, 30000);
    assert.deepEqual(restored.snapshot("g").queue, before.queue); assert.deepEqual(restored.snapshot("g").history, before.history);
    const stats = storage.library.stats("g", 0); assert.equal(stats.requests, 5); assert.equal(stats.failed, 0);
  } finally { storage?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("paused environment outages preserve pause intent, and explicit Skip is not a recording failure", async t => {
  t.mock.method(console, "info", () => {});
  const h = await fixture(); await h.music.pause("g"); h.outage(serviceDown);
  await h.music.event("g", { type: "failure", attemptId: h.music.attemptId("g")!, reason: serviceDown });
  for (let n = 0; n < 40; n++) { h.step(1000); await h.music.tick(); await h.settle(); }
  assert.equal(h.music.snapshot("g").state, "suspended"); assert.equal(h.music.snapshot("g").resumePaused, true);
  assert.ok(h.starts.slice(1).every(attempt => attempt.session.resumePaused));
  h.outage(); await h.music.skip("g"); assert.equal(h.music.snapshot("g").history[0].outcome, "skipped");
});

test("real truncation and version mismatch retain the explicit choice deadline and failed advance", async t => {
  t.mock.method(console, "info", () => {});
  for (const mismatch of [false, true]) {
    const h = await fixture(); const original = h.music.snapshot("g").current!;
    if (mismatch) await h.music.event("g", { type: "failure", attemptId: h.music.attemptId("g")!, reason: "Version mismatch: this is a remix." });
    else await h.music.event("g", { type: "end", attemptId: h.music.attemptId("g")!, reason: "finished" });
    assert.equal(h.music.snapshot("g").state, "awaiting_choice"); assert.equal(h.music.snapshot("g").failure?.scope, "recording");
    assert.equal(h.music.snapshot("g").failure?.deadline, h.now() + 60000);
    h.step(60000); await h.music.tick(); assert.equal(h.music.snapshot("g").history[0].entry.id, original.id);
    assert.equal(h.music.snapshot("g").history[0].outcome, "failed"); assert.equal(h.music.snapshot("g").queue.length, 3);
  }
});

test("volume rejection preserves audio and restores the same attempt's durable and backend volume intent", async t => {
  t.mock.method(console, "info", () => {});
  const h = await fixture(); const before = h.music.snapshot("g"), stops = h.stops.length;
  h.volumeWork(async () => { throw new Error("HTTP 500"); });
  await assert.rejects(h.music.setVolume("g", 25), /Playback continues/);
  assert.equal(h.music.snapshot("g").state, "playing"); assert.equal(h.music.attemptId("g"), h.starts[0].id);
  assert.equal(h.starts[0].signal.aborted, false); assert.equal(h.stops.length, stops); assert.equal(h.starts.length, 1);
  assert.equal(h.music.snapshot("g").volume, 100); assert.equal(h.store.loadSessions()[0].volume, 100); assert.equal(h.desiredVolume(), 100);
  assert.deepEqual(h.music.snapshot("g").history, before.history); assert.deepEqual(h.failures, []);
  assert.equal(trackFailure(before.current!.recording.uri, h.now()), undefined);
});

test("a late volume failure cannot overwrite a newer request or a successor attempt", async t => {
  t.mock.method(console, "info", () => {});
  for (const successor of [false, true]) {
    const h = await fixture(); let reject!: (error: Error) => void, called!: () => void;
    const pending = new Promise<void>(resolve => { called = resolve; });
    h.volumeWork(value => value === 25 ? (called(), new Promise<void>((_resolve, fail) => { reject = fail; })) : Promise.resolve());
    const changing = h.music.setVolume("g", 25); const rejected = assert.rejects(changing, /Playback continues/); await pending;
    if (successor) await h.music.skip("g"); else await h.music.setVolume("g", 75);
    reject(new Error("late HTTP 500")); await rejected;
    assert.equal(h.music.snapshot("g").volume, successor ? 25 : 75); assert.equal(h.desiredVolume(), successor ? 25 : 75);
    assert.equal(h.failures.length, 0);
  }
});

test("pause and seek control failures reconcile the same recording without source-health penalties", async t => {
  t.mock.method(console, "info", () => {});
  for (const action of ["pause", "seek"] as const) {
    const h = await fixture(); const original = h.music.snapshot("g").current!; h.rejectControls();
    if (action === "pause") await h.music.pause("g"); else await h.music.seek("g", 60000);
    await h.settle(); assert.equal(h.music.snapshot("g").state, "recovering"); assert.equal(h.music.snapshot("g").failure?.scope, "control");
    assert.equal(trackFailure(original.recording.uri, h.now()), undefined); assert.equal(h.music.snapshot("g").history.length, 0);
    h.step(1000); await h.music.tick(); assert.equal(h.starts.at(-1)?.session.current?.id, original.id);
    assert.equal(h.starts.at(-1)?.session.resumePaused ?? false, action === "pause");
    assert.equal(h.starts.at(-1)?.session.positionMs, action === "seek" ? 60000 : 5000);
  }
});

test("failure scope keeps ordinary missing uploads separate from control and environment faults", () => {
  assert.equal(failureScope("404 stream missing"), "recording");
  assert.equal(failureScope("Voice connection lost"), "environment");
  assert.equal(failureScope("Playback made no progress"), "environment");
  assert.equal(isRecordingFailure("HTTP 500", "control"), false);
  assert.equal(isRecordingFailure("Version mismatch: remix"), false);
});

test("known voice, account, setup and shared capacity outages hold the queue without blaming its recordings", async t => {
  t.mock.method(console, "info", () => {});
  const cases: Array<[RecordingSource, string]> = [
    ["soundcloud", "The voice connection is not established due to missing session id"],
    ["soundcloud", "The voice connection is not established due to missing connection endpoint"],
    ["soundcloud", "The voice connection is not established in 15 seconds"],
    ["soundcloud", "No available nodes to move to"],
    ["youtube", "YouTube session expired or was refused. A server operator must refresh the dedicated account session."],
    ["youtube", "YouTube account session is not configured on this server."],
    ["youtube", "YouTube session file must be private (mode 0600)."],
    ["youtube", "YouTube decoder cache must be a private directory."],
    ["youtube", "YouTube is rate-limiting this connection. Try again later."],
    ["youtube", "YouTube searches are busy. Try again shortly."],
    ["spotify", "Spotify: the original-audio account is not connected. A server operator must reconnect it."],
    ["spotify", "Spotify: direct-audio authorization expired or was refused. Refresh the account authorization."],
    ["spotify", "Spotify: invalid account token response."],
    ["spotify", "Spotify: account changed during authorization. Retry the request."],
    ["spotify", "Spotify: account login was refused"],
    ["spotify", "Spotify: Premium could not be confirmed for this account"],
    ["spotify", "Spotify: original audio is disabled. Choose another recording explicitly or ask a mod to enable the tested integration."],
    ["spotify", "Spotify: audio preparation is busy. Try again shortly."],
    ["spotify", "Spotify: active audio buffers are full. Finish another request first."],
    ["spotify", "Spotify: the original-audio helper could not start. A mod can run Diagnose."],
    ["spotify", "Spotify: private audio transport could not start."],
    ["spotify", "Spotify: private audio transport has no address."],
    ["spotify", "Spotify is not configured yet. A mod needs to configure a Spotify developer app owned by a Premium subscriber."],
    ["spotify", "Spotify access was refused. A mod should check the developer credentials and the app owner’s Premium subscription."],
    ["spotify", "Spotify is unavailable (HTTP 503). Try again later."],
    ["spotify", "Spotify token response was missing access_token/expires_in."],
    ["spotify", "spotify is rate-limiting requests. Try again in 3600 seconds."],
    ["spotify", "spotify is cooling down. Try again in 3600 seconds."]
  ];
  for (const [source, reason] of cases) {
    const h = await fixture(3, source); const before = h.music.snapshot("g"); h.outage(reason);
    await h.music.event("g", { type: "failure", attemptId: h.music.attemptId("g")!, reason });
    for (let n = 0; n < 180; n++) { h.step(1000); await h.music.tick(); await h.settle(); }
    const held = h.music.snapshot("g");
    assert.equal(held.state, "suspended", reason); assert.equal(held.failure?.scope, "environment", reason); assert.equal(held.failure?.deadline, undefined, reason);
    assert.equal(held.current?.id, before.current?.id, reason); assert.equal(held.positionMs, before.positionMs, reason);
    assert.deepEqual(held.queue, before.queue, reason); assert.deepEqual(held.history, before.history, reason);
    assert.ok(h.starts.length <= 3, reason);
    for (const entry of [held.current!, ...held.queue]) assert.equal(trackFailure(entry.recording.uri, h.now()), undefined, reason);
  }
});

test("upload availability, previews, track-size limits and identity mismatches still require a recording choice", async t => {
  t.mock.method(console, "info", () => {});
  const cases: Array<[RecordingSource, string]> = [
    ["youtube", "This YouTube upload is unavailable or restricted."],
    ["youtube", "YouTube returned a different upload; playback was refused."],
    ["youtube", "YouTube returned an incomplete or different-length stream; playback was refused."],
    ["spotify", "That Spotify track is unavailable in the configured market."],
    ["spotify", "Spotify: the exact requested recording is unavailable in this market."],
    ["spotify", "Spotify: The exact Spotify recording is unavailable for this account"],
    ["spotify", "Spotify: recording metadata is unavailable for this account"],
    ["spotify", "Spotify: this catalog entry is not playable through the current integration. Search by artist and title, or choose another recording."],
    ["spotify", "Spotify: this recording exceeds the temporary audio buffer limit."],
    ["spotify", "Spotify: full audio or exact recording identity could not be verified."],
    ["soundcloud", "This upload only provides a preview."],
    ["soundcloud", "Version mismatch: this upload is a remix."]
  ];
  for (const [source, reason] of cases) {
    const h = await fixture(3, source); const before = h.music.snapshot("g"); h.outage(reason);
    await h.music.event("g", { type: "failure", attemptId: h.music.attemptId("g")!, reason });
    for (let n = 0; n < 6; n++) { h.step(1000); await h.music.tick(); await h.settle(); }
    const choice = h.music.snapshot("g");
    assert.equal(choice.state, "awaiting_choice", reason); assert.equal(choice.failure?.scope, "recording", reason);
    assert.ok(choice.failure?.deadline! > h.now(), reason); assert.equal(choice.current?.id, before.current?.id, reason);
    h.step(60000); await h.music.tick();
    assert.equal(h.music.snapshot("g").history[0].entry.id, before.current?.id, reason);
    assert.equal(h.music.snapshot("g").history[0].outcome, "failed", reason);
  }
});
