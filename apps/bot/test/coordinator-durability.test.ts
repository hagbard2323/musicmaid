import { test } from "node:test";
import assert from "node:assert/strict";
import { MusicCoordinator, type PlaybackBackend } from "../src/audio/coordinator.js";
import { entryFor, type Session } from "../src/audio/model.js";
import type { MusicStorage } from "../src/storage/types.js";

class FaultStore implements MusicStorage {
  sessions = new Map<string, Session>(); writes = 0; failAt = Infinity;
  loadSessions() { return [...this.sessions.values()].map(s => structuredClone(s)); }
  saveSession(session: Session) {
    if (++this.writes === this.failAt) throw new Error("temporary storage failure");
    this.sessions.set(session.guildId, structuredClone(session));
  }
  getValue() { return undefined; } setValue() {} close() {}
}
const song = (title: string) => entryFor({ query: title, source: "auto", requestedBy: "listener" }, {
  identifier: title, uri: "https://soundcloud.com/artist/" + title, title, author: "Artist", source: "soundcloud", durationMs: 180000, isStream: false, isSeekable: true
});
function fixture() {
  const store = new FaultStore();
  const starts: Array<{ session: Session; attemptId: string; signal: AbortSignal }> = [];
  let stops = 0;
  const backend: PlaybackBackend = {
    start: async (session, attemptId, signal) => { starts.push({ session, attemptId, signal }); },
    stop: async () => { stops++; }, pause: async () => {}, volume: async () => {}, seek: async () => {}, requiresReloadForSeek: () => true
  };
  const music = new MusicCoordinator(store, backend);
  const add = (title: string) => music.enqueue("guild", song(title), "voice", "text");
  const playing = async (positionMs = 30000) => {
    const attemptId = music.attemptId("guild")!;
    await music.event("guild", { type: "start", attemptId });
    await music.event("guild", { type: "update", attemptId, connected: true, positionMs, time: Date.now() });
  };
  return { music, store, starts, add, playing, stops: () => stops };
}
type Fixture = ReturnType<typeof fixture>;
const transitions: Array<{ name: string; run: (h: Fixture) => Promise<void> }> = [
  { name: "advance", run: h => h.music.skip("guild") },
  { name: "explicit replacement", run: h => h.music.chooseAlternative("guild", h.music.snapshot("guild").current!.id, song("Replacement"), "voice", "text") },
  { name: "source reload seek", run: h => h.music.seek("guild", 60000) }
];

test("durable playback handoffs launch without a second write after cancelling the old attempt", async t => {
  t.mock.method(console, "info", () => {});
  for (const transition of transitions) {
    const h = fixture(); await h.add("Current"); await h.add("Next"); await h.playing(); await h.music.pause("guild");
    const before = h.music.snapshot("guild"), writes = h.store.writes;
    // A storage outage immediately after the transition must not create a
    // starting session with no active attempt, as the old two-write path did.
    h.store.failAt = writes + 2;
    await transition.run(h);
    assert.equal(h.store.writes, writes + 1, transition.name);
    assert.equal(h.starts.length, 2, transition.name);
    assert.equal(h.starts[0].signal.aborted, true);
    assert.notEqual(h.starts[1].attemptId, h.starts[0].attemptId);
    assert.equal(h.starts[1].signal.aborted, false);
    assert.deepEqual(h.store.sessions.get("guild"), h.music.snapshot("guild"));
    const next = h.starts[1].session;
    assert.equal(next.state, "starting");
    if (transition.name === "source reload seek") {
      assert.equal(next.current?.id, before.current?.id); assert.equal(next.positionMs, 60000);
      assert.equal(next.resumePaused, true); assert.deepEqual(next.queue, before.queue); assert.deepEqual(next.history, before.history);
    } else {
      assert.equal(next.resumePaused, false); assert.equal(next.positionMs, 0);
      assert.equal(next.history[0].entry.id, before.current?.id); assert.equal(next.history[0].outcome, "skipped");
      assert.equal(next.current?.recording.title, transition.name === "advance" ? "Next" : "Replacement");
    }
  }
});

test("a failed playback transition preserves the old attempt, queue, pause and position", async t => {
  t.mock.method(console, "info", () => {});
  for (const transition of transitions) {
    const h = fixture(); await h.add("Current"); await h.add("Next"); await h.playing(); await h.music.pause("guild");
    const before = h.music.snapshot("guild"), oldAttempt = h.music.attemptId("guild"), stops = h.stops();
    h.store.failAt = h.store.writes + 1;
    await assert.rejects(transition.run(h), /temporary storage failure/, transition.name);
    assert.deepEqual(h.music.snapshot("guild"), before); assert.deepEqual(h.store.sessions.get("guild"), before);
    assert.equal(h.music.attemptId("guild"), oldAttempt); assert.equal(h.starts.length, 1);
    assert.equal(h.starts[0].signal.aborted, false); assert.equal(h.stops(), stops);
  }
});

test("the initial durable enqueue and advance can start before any subsequent storage write", async t => {
  t.mock.method(console, "info", () => {});
  const h = fixture(); h.store.failAt = 3;
  await h.add("First");
  assert.equal(h.starts.length, 1); assert.equal(h.store.writes, 2);
  assert.equal(h.music.snapshot("guild").state, "starting");
  assert.equal(h.music.snapshot("guild").current?.recording.title, "First");
});

test("a finished looping request starts from its committed repeat entry without recounting the request", async t => {
  t.mock.method(console, "info", () => {});
  const h = fixture(); await h.add("Original"); await h.add("Upcoming"); await h.playing(180000); await h.music.setLoop("guild", "track");
  const original = h.music.snapshot("guild").current!, writes = h.store.writes, oldAttempt = h.music.attemptId("guild")!;
  h.store.failAt = writes + 2;
  await h.music.event("guild", { type: "end", attemptId: oldAttempt, reason: "finished" });
  const next = h.music.snapshot("guild");
  assert.equal(h.store.writes, writes + 1); assert.equal(h.starts.length, 2);
  assert.notEqual(next.current?.id, original.id); assert.equal(next.current?.requestId, original.id);
  assert.equal(next.current?.recording.uri, original.recording.uri);
  assert.equal(next.history[0].entry.id, original.id); assert.equal(next.history[0].outcome, "finished");
  assert.equal(next.queue[0].recording.title, "Upcoming"); assert.equal(next.resumePaused, false);
});
