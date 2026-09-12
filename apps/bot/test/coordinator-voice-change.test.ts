import { test } from "node:test";
import assert from "node:assert/strict";
import { MusicCoordinator, type PlaybackBackend } from "../src/audio/coordinator.js";
import { entryFor, type Session } from "../src/audio/model.js";
import type { MusicStorage } from "../src/storage/types.js";

async function fixture(playing = true) {
  const sessions = new Map<string, Session>();
  const store: MusicStorage = { loadSessions: () => [], saveSession: s => { sessions.set(s.guildId, structuredClone(s)); }, getValue: () => undefined, setValue: () => {}, close: () => {} };
  const starts: Array<{ session: Session; id: string; signal: AbortSignal }> = [], stops: boolean[] = [];
  const backend: PlaybackBackend = { start: async (session, id, signal) => { starts.push({ session, id, signal }); }, stop: async (_g, disconnect) => { stops.push(disconnect); }, pause: async () => {}, seek: async () => {}, volume: async () => {} };
  const music = new MusicCoordinator(store, backend);
  for (const title of ["Current", "Next"]) await music.enqueue("g", entryFor({ query: title, requestedBy: "u", source: "auto" }, { identifier: title, uri: "https://soundcloud.com/artist/" + title, title, author: "Artist", source: "soundcloud", durationMs: 180000, isStream: false, isSeekable: true }), "old-voice", "text");
  if (playing) { const attemptId = music.attemptId("g")!; await music.event("g", { type: "start", attemptId }); await music.event("g", { type: "update", attemptId, positionMs: 30000, connected: true, time: Date.now() }); }
  return { music, starts, stops };
}
test("external removal holds the same request without rejoining until an explicit Resume", async t => {
  t.mock.method(console, "info", () => {});
  for (const paused of [false, true]) {
    const h = await fixture(); if (paused) await h.music.pause("g"); const before = h.music.snapshot("g");
    await h.music.externalVoiceChange("g"); const held = h.music.snapshot("g");
    assert.equal(held.state, "suspended"); assert.equal(held.voiceChannelId, undefined); assert.equal(held.failure?.scope, "environment"); assert.equal(held.failure?.deadline, undefined);
    assert.equal(held.resumePaused ?? false, paused); assert.equal(held.positionMs, before.positionMs); assert.equal(held.current?.id, before.current?.id);
    assert.deepEqual(held.queue, before.queue); assert.deepEqual(held.history, before.history); assert.equal(h.starts[0].signal.aborted, true); assert.equal(h.stops.at(-1), true);
    await h.music.event("g", { type: "failure", attemptId: h.starts[0].id, reason: "late Voice closed", reconnect: true }); await h.music.tick(); assert.equal(h.starts.length, 1);
    await h.music.resume("g", "new-voice", "text"); assert.equal(h.starts.at(-1)?.session.voiceChannelId, "new-voice"); assert.equal(h.starts.at(-1)?.session.current?.id, before.current?.id);
  }
});
test("external move preserves healthy playback and paused intent in the actual destination", async t => {
  t.mock.method(console, "info", () => {});
  for (const paused of [false, true]) {
    const h = await fixture(); if (paused) await h.music.pause("g"); const before = h.music.snapshot("g"), stops = h.stops.length;
    await h.music.externalVoiceChange("g", "new-voice");
    assert.equal(h.music.snapshot("g").voiceChannelId, "new-voice"); assert.equal(h.music.snapshot("g").state, before.state);
    assert.equal(h.music.attemptId("g"), h.starts[0].id); assert.equal(h.starts[0].signal.aborted, false); assert.equal(h.stops.length, stops);
    assert.deepEqual(h.music.snapshot("g").queue, before.queue); assert.equal(h.music.snapshot("g").positionMs, before.positionMs);
  }
});
test("moving an in-flight start cancels the old destination and restarts the same entry safely", async t => {
  t.mock.method(console, "info", () => {});
  const h = await fixture(false); const before = h.music.snapshot("g");
  await h.music.externalVoiceChange("g", "new-voice");
  assert.equal(h.starts[0].signal.aborted, true); assert.equal(h.starts.length, 2);
  assert.equal(h.starts[1].session.voiceChannelId, "new-voice"); assert.equal(h.starts[1].session.current?.id, before.current?.id);
  assert.notEqual(h.starts[0].id, h.starts[1].id); assert.deepEqual(h.music.snapshot("g").queue, before.queue); assert.equal(h.music.snapshot("g").history.length, 0);
});
