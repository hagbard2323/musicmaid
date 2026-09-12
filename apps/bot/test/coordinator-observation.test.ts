import { test } from "node:test";
import assert from "node:assert/strict";
import { MusicCoordinator, type PlaybackBackend } from "../src/audio/coordinator.js";
import { entryFor, type Session } from "../src/audio/model.js";
import type { MusicStorage } from "../src/storage/types.js";

async function fixture() {
  let now = 1000000, failing = false;
  const sessions = new Map<string, Session>();
  const store: MusicStorage = { loadSessions: () => [], saveSession: s => { if (failing) throw new Error("fixture storage busy"); sessions.set(s.guildId, structuredClone(s)); }, getValue: () => undefined, setValue: () => {}, close: () => {} };
  const starts: AbortSignal[] = [];
  const backend: PlaybackBackend = { start: async (_s, _id, signal) => { starts.push(signal); }, stop: async () => {}, pause: async () => {}, seek: async () => {}, volume: async () => {} };
  const music = new MusicCoordinator(store, backend, { now: () => now });
  await music.enqueue("g", entryFor({ query: "Song", requestedBy: "u", source: "soundcloud" }, { identifier: "song", uri: "https://soundcloud.com/fixture/song", title: "Selected title", author: "Artist", source: "soundcloud", durationMs: 180000, isStream: false, isSeekable: true }), "voice", "text");
  return { music, starts, sessions, fail: (value: boolean) => { failing = value; }, step: (ms: number) => { now += ms; }, now: () => now };
}

test("a rejected start checkpoint does not consume recording metadata or a paused-start event", async t => {
  t.mock.method(console, "info", () => {});
  for (const paused of [false, true]) {
    const h = await fixture();
    if (paused) {
      let attemptId = h.music.attemptId("g")!; await h.music.event("g", { type: "start", attemptId }); h.step(1000);
      await h.music.event("g", { type: "update", attemptId, time: h.now(), positionMs: 5000, connected: true }); await h.music.pause("g");
      await h.music.retry("g", h.music.snapshot("g").current!.id);
    }
    const attemptId = h.music.attemptId("g")!, before = h.music.snapshot("g");
    const recording = { ...before.current!.recording, title: "Verified resolved title" };
    h.fail(true); await assert.rejects(h.music.event("g", { type: "start", attemptId, recording }), /storage busy/);
    assert.deepEqual(h.music.snapshot("g"), before); h.fail(false);
    await h.music.event("g", { type: "start", attemptId, recording });
    assert.equal(h.music.snapshot("g").current?.recording.title, recording.title);
    assert.equal(h.music.snapshot("g").state, paused ? "paused" : "starting");
  }
});

test("a rejected progress checkpoint can be replayed with its identical event timestamp", async t => {
  t.mock.method(console, "info", () => {});
  const h = await fixture(); const attemptId = h.music.attemptId("g")!;
  await h.music.event("g", { type: "start", attemptId }); h.step(1000);
  const event = { type: "update" as const, attemptId, positionMs: 5000, time: h.now(), connected: true }, before = h.music.snapshot("g");
  h.fail(true); await assert.rejects(h.music.event("g", event), /storage busy/); assert.deepEqual(h.music.snapshot("g"), before);
  h.fail(false); await h.music.event("g", event);
  assert.equal(h.music.snapshot("g").positionMs, 5000); assert.equal(h.music.snapshot("g").state, "playing");
  assert.equal(h.starts[0].aborted, false);
});

test("failed progress persistence cannot clear an existing recovery deadline", async t => {
  t.mock.method(console, "info", () => {});
  const h = await fixture(); let attemptId = h.music.attemptId("g")!;
  await h.music.event("g", { type: "failure", attemptId, reason: "Voice connection lost", reconnect: true });
  h.step(1000); await h.music.tick(); attemptId = h.music.attemptId("g")!; await h.music.event("g", { type: "start", attemptId });
  h.step(15000); h.fail(true);
  await assert.rejects(h.music.event("g", { type: "update", attemptId, positionMs: 5000, time: h.now(), connected: true }), /storage busy/);
  h.fail(false); h.step(15000); await h.music.tick();
  assert.equal(h.music.snapshot("g").state, "suspended"); assert.equal(h.music.snapshot("g").failure?.scope, "environment");
});
