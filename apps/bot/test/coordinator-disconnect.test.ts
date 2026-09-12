import { test } from "node:test";
import assert from "node:assert/strict";
import { MusicCoordinator, type PlaybackBackend } from "../src/audio/coordinator.js";
import { entryFor, type Session } from "../src/audio/model.js";
import type { MusicStorage } from "../src/storage/types.js";

async function fixture() {
  let now = 1000000;
  const sessions = new Map<string, Session>();
  const store: MusicStorage = { loadSessions: () => [], saveSession: s => { sessions.set(s.guildId, structuredClone(s)); }, getValue: () => undefined, setValue: () => {}, close: () => {} };
  const starts: Array<{ session: Session; id: string; signal: AbortSignal; reconnect: boolean }> = [];
  const stops: boolean[] = [];
  const backend: PlaybackBackend = {
    start: async (session, id, signal, reconnect) => { starts.push({ session, id, signal, reconnect }); },
    stop: async (_guild, disconnect) => { stops.push(disconnect); }, pause: async () => {}, seek: async () => {}, volume: async () => {}
  };
  const music = new MusicCoordinator(store, backend, { now: () => now });
  for (const title of ["Current", "Next"]) await music.enqueue("g", entryFor({ query: title, source: "auto", requestedBy: "u" }, {
    identifier: title, title, author: "Artist", source: "soundcloud", uri: "https://soundcloud.com/artist/" + title, durationMs: 180000, isStream: false, isSeekable: true
  }), "voice", "text");
  const id = music.attemptId("g")!;
  await music.event("g", { type: "start", attemptId: id });
  const progress = (positionMs: number, connected = true) => music.event("g", { type: "update", attemptId: id, positionMs, connected, time: now });
  now += 5000; await progress(5000);
  return { music, starts, stops, id, progress, step: (ms: number) => { now += ms; } };
}

test("a brief voice-gateway reconnect retains the same attempt and queue", async t => {
  t.mock.method(console, "info", () => {});
  const h = await fixture(); const before = h.music.snapshot("g"), stops = h.stops.length;
  h.step(1000); await h.progress(6000, false);
  h.step(5000); await h.progress(11000, true); await h.music.tick();
  assert.equal(h.music.snapshot("g").state, "playing"); assert.equal(h.music.attemptId("g"), h.id);
  assert.equal(h.starts.length, 1); assert.equal(h.starts[0].signal.aborted, false); assert.equal(h.stops.length, stops);
  assert.deepEqual(h.music.snapshot("g").history, before.history); assert.deepEqual(h.music.snapshot("g").queue, before.queue);
  h.step(1001); await h.music.tick(); assert.equal(h.music.snapshot("g").state, "playing");
});

test("persistent gateway loss recovers after six seconds from the last verified position", async t => {
  t.mock.method(console, "info", () => {});
  const h = await fixture(); const entryId = h.music.snapshot("g").current!.id;
  h.step(1000); await h.progress(6000, false);
  h.step(5999); await h.music.tick(); assert.equal(h.music.snapshot("g").state, "playing");
  h.step(1); await h.music.tick(); assert.equal(h.music.snapshot("g").state, "recovering");
  assert.equal(h.starts[0].signal.aborted, true); assert.equal(h.music.snapshot("g").positionMs, 5000);
  assert.equal(h.music.snapshot("g").history.length, 0);
  h.step(1000); await h.music.tick();
  assert.equal(h.starts.length, 2); assert.equal(h.starts[1].session.current?.id, entryId);
  assert.equal(h.starts[1].session.positionMs, 5000); assert.equal(h.starts[1].reconnect, true);
});

test("repeated disconnected updates cannot renew the reconnect grace period", async t => {
  t.mock.method(console, "info", () => {});
  const h = await fixture(); h.step(1000); await h.progress(6000, false);
  for (const position of [8000, 10000, 12000]) { h.step(2000); await h.progress(position, false); }
  await h.music.tick(); assert.equal(h.music.snapshot("g").state, "recovering");
  assert.equal(h.music.snapshot("g").positionMs, 5000); assert.equal(h.starts[0].signal.aborted, true);
});

test("an explicit playback failure bypasses the reconnect grace immediately", async t => {
  t.mock.method(console, "info", () => {});
  const h = await fixture(); h.step(1000); await h.progress(6000, false);
  await h.music.event("g", { type: "failure", attemptId: h.id, reason: "Voice closed", reconnect: true });
  assert.equal(h.music.snapshot("g").state, "recovering"); assert.equal(h.starts[0].signal.aborted, true);
  h.step(1000); await h.music.tick(); assert.equal(h.starts.length, 2);
});

test("Stop and Skip still act immediately during the reconnect grace", async t => {
  t.mock.method(console, "info", () => {});
  for (const action of ["stop", "skip"] as const) {
    const h = await fixture(); h.step(1000); await h.progress(6000, false);
    await h.music[action]("g", h.music.snapshot("g").current!.id);
    assert.equal(h.starts[0].signal.aborted, true);
    if (action === "stop") {
      assert.equal(h.music.snapshot("g").state, "idle"); assert.equal(h.music.snapshot("g").queue.length, 0);
      h.step(10000); await h.music.tick(); assert.equal(h.starts.length, 1); assert.equal(h.stops.at(-1), true);
    } else {
      assert.equal(h.music.snapshot("g").current?.recording.title, "Next"); assert.equal(h.starts.length, 2);
    }
  }
});

test("pausing cancels the grace countdown and explicit Resume starts a fresh connection check", async t => {
  t.mock.method(console, "info", () => {});
  const h = await fixture(); h.step(1000); await h.progress(6000, false); await h.music.pause("g");
  h.step(60000); await h.music.tick(); assert.equal(h.music.snapshot("g").state, "paused");
  assert.equal(h.starts[0].signal.aborted, false);
  await h.music.resume("g", "voice", "text"); await h.music.tick(); assert.equal(h.music.snapshot("g").state, "playing");
  h.step(1); await h.progress(5000, false); h.step(6000); await h.music.tick();
  assert.equal(h.music.snapshot("g").state, "recovering"); assert.equal(h.music.snapshot("g").resumePaused, false);
});

test("brief gateway changes cannot hide a track whose audio position has stalled", async t => {
  t.mock.method(console, "info", () => {});
  const h = await fixture();
  for (let n = 0; n < 4; n++) { h.step(2000); await h.progress(5000, false); h.step(3000); await h.progress(5000, true); await h.music.tick(); }
  assert.equal(h.music.snapshot("g").state, "recovering");
  assert.equal(h.music.snapshot("g").failure?.reason, "Playback made no progress");
});
