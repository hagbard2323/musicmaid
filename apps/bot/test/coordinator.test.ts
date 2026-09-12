import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { MusicCoordinator, type PlaybackBackend } from "../src/audio/coordinator.js";
import { entryFor, type Session } from "../src/audio/model.js";
import type { MusicStorage } from "../src/storage/types.js";
mock.method(console, "info", () => {});
class MemoryStore implements MusicStorage {
  sessions = new Map<string, Session>(); values = new Map<string, string>(); fail = false;
  loadSessions() { return [...this.sessions.values()].map(s => structuredClone(s)); }
  saveSession(s: Session) { if (this.fail) throw new Error("disk full"); this.sessions.set(s.guildId, structuredClone(s)); }
  getValue(k: string) { return this.values.get(k); }
  setValue(k: string, v: string) { this.values.set(k, v); }
  close() {}
}
function song(title = "Sarà perché ti amo", durationMs = 190_015) {
  return entryFor({ query: title, source: "auto", requestedBy: "listener" }, { identifier: title, title, author: "Ricchi E Poveri", uri: "https://soundcloud.com/artist/" + encodeURIComponent(title), source: "soundcloud", durationMs, isStream: false, isSeekable: true });
}
function setup(store = new MemoryStore()) {
  let now = 1_000_000;
  const starts: Array<{ session: Session; id: string; signal: AbortSignal; reconnect: boolean }> = [];
  const stops: boolean[] = [];
  const backend: PlaybackBackend = {
    start: async (session, id, signal, reconnect) => { starts.push({ session, id, signal, reconnect }); },
    stop: async (_g, disconnect) => { stops.push(disconnect); }, pause: async () => {}, seek: async () => {}, volume: async () => {}
  };
  const music = new MusicCoordinator(store, backend, { now: () => now });
  const add = (entry = song()) => music.enqueue("guild", entry, "voice", "text");
  const start = async () => { const id = music.attemptId("guild")!; await music.event("guild", { type: "start", attemptId: id }); return id; };
  const progress = (id: string, positionMs: number, connected = true) => music.event("guild", { type: "update", attemptId: id, positionMs, connected, time: now });
  return { music, store, starts, stops, add, start, progress, advance: (ms: number) => { now += ms; } };
}
test("30-second finished event for a 3:10 recording prompts; never chooses a substitute", async () => {
  const h = setup(); await h.add(); await h.add(song("Next")); const id = await h.start();
  h.advance(30_000); await h.progress(id, 30_000);
  await h.music.event("guild", { type: "end", attemptId: id, reason: "finished" });
  assert.equal(h.music.snapshot("guild").state, "awaiting_choice");
  assert.equal(h.starts.length, 1); assert.equal(h.music.snapshot("guild").queue.length, 1);
  h.advance(60_000); await h.music.tick();
  assert.equal(h.music.snapshot("guild").current?.recording.title, "Next");
  assert.equal(h.music.snapshot("guild").history[0].outcome, "failed");
});
test("known voice permission denial reports immediately instead of retrying a blocked channel", async () => {
  const h = setup(); await h.add(); const id = h.music.attemptId("guild")!;
  await h.music.event("guild", { type: "failure", attemptId: id, reason: "Voice: MusicMaid needs View Channel in movies." });
  assert.equal(h.music.snapshot("guild").state, "suspended");
  assert.equal(h.music.snapshot("guild").failure?.deadline, undefined);
  h.advance(10_000); await h.music.tick();
  assert.equal(h.starts.length, 1);
});
test("exception + loadFailed + late start advance no queue twice", async () => {
  const h = setup(); await h.add(); await h.add(song("Next")); const id = await h.start();
  await h.music.event("guild", { type: "failure", attemptId: id, reason: "404 stream missing" });
  await h.music.event("guild", { type: "end", attemptId: id, reason: "loadFailed" });
  h.advance(1000); await h.music.tick();
  assert.equal(h.starts.length, 2); assert.equal(h.starts[1].session.current?.id, h.starts[0].session.current?.id);
  const retry = h.music.attemptId("guild");
  await h.music.event("guild", { type: "start", attemptId: id });
  await h.music.event("guild", { type: "end", attemptId: id, reason: "finished" });
  assert.equal(h.music.attemptId("guild"), retry); assert.equal(h.music.snapshot("guild").queue.length, 1);
});
test("two automatic retries are the maximum", async () => {
  const h = setup(); await h.add();
  for (let n = 0; n < 3; n++) {
    const id = await h.start(); await h.music.event("guild", { type: "failure", attemptId: id, reason: "404" });
    h.advance(4000); await h.music.tick();
  }
  assert.equal(h.starts.length, 3); assert.equal(h.music.snapshot("guild").state, "awaiting_choice");
});
test("successful recovery clears its old deadline and a later outage gets a fresh retry budget", async () => {
  const h = setup(); await h.add(); let id = await h.start();
  h.advance(1000); await h.progress(id, 1000);
  await h.music.event("guild", { type: "failure", attemptId: id, reason: "Transient network reset" });
  h.advance(1000); await h.music.tick(); id = await h.start();
  for (let n = 1; n <= 20; n++) { h.advance(2000); await h.progress(id, 1000 + 2000 * n); await h.music.tick(); assert.equal(h.music.snapshot("guild").state, "playing"); }
  await h.music.event("guild", { type: "failure", attemptId: id, reason: "Transient network reset" });
  h.advance(1000); await h.music.tick();
  assert.equal(h.starts.length, 3); assert.equal(h.music.snapshot("guild").current?.id, h.starts[0].session.current?.id);
});
test("normal short song completes; pause does not trigger the watchdog", async () => {
  const h = setup(); await h.add(song("Short", 5000)); const id = await h.start(); h.advance(5000);
  await h.music.event("guild", { type: "end", attemptId: id, reason: "finished" });
  assert.equal(h.music.snapshot("guild").history[0].outcome, "finished");
  await h.add(); const long = await h.start(); h.advance(5000); await h.progress(long, 5000); await h.music.pause("guild");
  h.advance(120_000); await h.music.tick(); assert.equal(h.music.snapshot("guild").state, "paused");
});
test("watchdog detects silence and voice disconnects, including missing start events", async () => {
  const h = setup(); await h.add(); h.advance(75_000); await h.music.tick();
  assert.equal(h.music.snapshot("guild").state, "recovering");
  h.advance(1000); await h.music.tick(); const id = await h.start(); h.advance(5000); await h.progress(id, 5000); h.advance(5000); await h.progress(id, 5000, false);
  assert.equal(h.music.snapshot("guild").state, "playing");
  h.advance(6000); await h.music.tick();
  assert.equal(h.music.snapshot("guild").state, "recovering");
});
test("initial voice handshake gets its watchdog grace period instead of an immediate reconnect", async () => {
  const h = setup(); await h.add(); const id = await h.start();
  h.advance(5000); await h.progress(id, 0, false);
  assert.equal(h.music.snapshot("guild").state, "starting");
  h.advance(5000); await h.progress(id, 5000, true);
  assert.equal(h.music.snapshot("guild").state, "playing");
  assert.equal(h.starts.length, 1);
});
test("a paused session recovers without resuming audible playback", async () => {
  const h = setup(); await h.add(); const id = await h.start(); h.advance(5000); await h.progress(id, 5000); await h.music.pause("guild");
  await h.music.event("guild", { type: "failure", attemptId: id, reason: "Voice closed", reconnect: true });
  h.advance(1000); await h.music.tick(); await h.start();
  assert.equal(h.starts[1].session.resumePaused, true); assert.equal(h.music.snapshot("guild").state, "paused");
});
test("skip/stop during recovery cancel the old attempt and its pending work", async () => {
  const h = setup(); await h.add(); await h.add(song("Next")); const old = await h.start();
  await h.music.event("guild", { type: "failure", attemptId: old, reason: "404" });
  await h.music.skip("guild"); assert.equal(h.starts[0].signal.aborted, true);
  await h.music.stop("guild"); h.advance(60_000); await h.music.tick();
  await h.music.event("guild", { type: "end", attemptId: old, reason: "loadFailed" });
  assert.equal(h.music.snapshot("guild").state, "idle"); assert.equal(h.music.snapshot("guild").queue.length, 0); assert.equal(h.starts.length, 2);
});
test("the same recording queued twice gets separate attempt identities", async () => {
  const h = setup(); await h.add(); await h.add(); const first = await h.start(); await h.music.skip("guild");
  const second = await h.start(); assert.notEqual(first, second);
  await h.music.event("guild", { type: "failure", attemptId: first, reason: "404" });
  assert.equal(h.music.attemptId("guild"), second); assert.equal(h.music.snapshot("guild").failure, undefined);
});
test("concurrent requests start only one song and preserve submission order", async () => {
  const h = setup(); await Promise.all(Array.from({ length: 20 }, (_, i) => h.add(song(String(i)))));
  assert.equal(h.starts.length, 1); assert.deepEqual(h.music.snapshot("guild").queue.map(e => e.recording.title), Array.from({ length: 19 }, (_, i) => String(i + 1)));
});
test("simultaneous clicks on the same Skip button only skip its original entry", async () => {
  const h = setup(); await h.add(song("A")); await h.add(song("B")); await h.add(song("C")); const id = h.music.snapshot("guild").current!.id;
  const results = await Promise.allSettled([h.music.skip("guild", id), h.music.skip("guild", id)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(h.music.snapshot("guild").current?.recording.title, "B");
  await assert.rejects(h.music.stop("guild", id), /song changed/);
  assert.equal(h.music.snapshot("guild").queue.length, 1);
});
test("stale queue edits are rejected; progress checkpoints do not stale a menu", async () => {
  const h = setup(); await h.add(); await h.add(song("B")); await h.add(song("C"));
  const view = h.music.snapshot("guild"); const id = await h.start(); h.advance(5000); await h.progress(id, 5000);
  await h.music.editQueue("guild", view.revision, "move", view.queue[1].id, 1);
  await assert.rejects(h.music.editQueue("guild", view.revision, "remove", view.queue[0].id), /queue changed/);
  assert.equal(h.music.snapshot("guild").queue[0].recording.title, "C");
});
test("persistence failure leaves the live queue and attempt untouched", async () => {
  const h = setup(); await h.add(); await h.add(song("Next")); const before = h.music.snapshot("guild"); const id = h.music.attemptId("guild");
  h.store.fail = true; await assert.rejects(h.music.skip("guild"), /disk full/);
  assert.deepEqual(h.music.snapshot("guild"), before); assert.equal(h.music.attemptId("guild"), id); assert.equal(h.starts[0].signal.aborted, false);
});
test("restart retains current recording, position, queue, and paused intent", async () => {
  const h = setup(); await h.add(); await h.add(song("Next")); const id = await h.start(); h.advance(25_000); await h.progress(id, 25_000); await h.music.pause("guild");
  const restored = setup(h.store); assert.equal(restored.starts.length, 0);
  const s = restored.music.snapshot("guild"); assert.equal(s.positionMs, 25_000); assert.equal(s.state, "suspended"); assert.equal(s.resumePaused, true); assert.equal(s.queue.length, 1);
  await restored.music.resume("guild", "voice", "text"); assert.equal(restored.starts[0].session.positionMs, 25_000);
});
test("late alternative selection requeues without replacing the song now playing", async () => {
  const h = setup(); const failed = song(); await h.add(failed); await h.add(song("Next")); const id = await h.start();
  await h.music.event("guild", { type: "failure", attemptId: id, reason: "preview" });
  h.advance(60_000); await h.music.tick();
  await h.music.chooseAlternative("guild", failed.id, song("Confirmed alternative"), "voice", "text");
  assert.equal(h.music.snapshot("guild").current?.recording.title, "Next"); assert.equal(h.music.snapshot("guild").queue[0].recording.title, "Confirmed alternative");
});
test("explicit version correction replaces a queued entry in place, without a duplicate", async () => {
  const h = setup(); const current = song("A"), queued = song("B"); await h.add(current); await h.add(queued);
  await h.music.chooseAlternative("guild", queued.id, song("B chosen version"), "voice", "text");
  assert.equal(h.music.snapshot("guild").current?.id, current.id);
  assert.equal(h.music.snapshot("guild").queue.length, 1);
  assert.equal(h.music.snapshot("guild").queue[0].recording.title, "B chosen version");
});
test("explicit version correction of the current entry cancels the old attempt", async () => {
  const h = setup(); const current = song("A"); await h.add(current); await h.add(song("B"));
  await h.music.chooseAlternative("guild", current.id, song("A chosen version"), "voice", "text");
  assert.equal(h.starts[0].signal.aborted, true); assert.equal(h.music.snapshot("guild").queue.length, 1);
  assert.equal(h.music.snapshot("guild").current?.recording.title, "A chosen version");
  assert.equal(h.music.snapshot("guild").history[0].outcome, "skipped");
});
test("requests from another text channel keep the established console in place", async () => {
  const h = setup(); await h.music.setPanelChannel("guild", "console"); await h.add();
  assert.equal(h.music.snapshot("guild").textChannelId, "console");
  await h.music.setPanel("guild", "panel-message");
  await assert.rejects(h.music.setPanelChannel("guild", "other"), /already in another channel/);
});
test("restart preserves a failed request and its incident instead of silently retrying it", async () => {
  const h = setup(); await h.add(); const id = await h.start();
  await h.music.event("guild", { type: "failure", attemptId: id, reason: "preview" });
  const failed = h.music.snapshot("guild"); const restored = setup(h.store);
  await restored.music.resume("guild", "voice", "text");
  assert.equal(restored.starts.length, 0); assert.equal(restored.music.snapshot("guild").state, "awaiting_choice");
  assert.equal(restored.music.snapshot("guild").failure?.incidentId, failed.failure?.incidentId);
});
test("live streams do not trigger premature-finish detection and cannot seek", async () => {
  const h = setup(); const live = song("Live"); live.recording.isStream = true; live.recording.isSeekable = false;
  await h.add(live); const id = await h.start(); h.advance(1000); await h.progress(id, 1000);
  await assert.rejects(h.music.seek("guild", 500), /cannot be sought/);
  await h.music.event("guild", { type: "end", attemptId: id, reason: "finished" }); assert.equal(h.music.snapshot("guild").state, "idle");
});
test("clear upcoming does not stop current audio; idle disconnect waits five minutes", async () => {
  const h = setup(); await h.add(song("Short", 1000)); await h.add(song("Next")); const s = h.music.snapshot("guild");
  await h.music.editQueue("guild", s.revision, "clear"); assert.equal(h.music.snapshot("guild").current?.id, s.current?.id);
  const id = await h.start(); h.advance(1000); await h.music.event("guild", { type: "end", attemptId: id, reason: "finished" });
  h.advance(299_000); await h.music.tick(); assert.equal(h.stops.includes(true), false);
  h.advance(1000); await h.music.tick(); assert.equal(h.stops.includes(true), true);
});

test('playlist append is atomic when capacity is insufficient or a stale voice channel submits it', async () => {
  const h = setup(); await h.add(song('Current'));
  await h.music.enqueueMany('guild', Array.from({ length: 499 }, (_, n) => song('Saved ' + n)), 'voice', 'text');
  const before = h.music.snapshot('guild');
  await assert.rejects(h.music.enqueueMany('guild', [song('overflow1'), song('overflow2')], 'voice', 'text'), /Nothing was added/);
  assert.deepEqual(h.music.snapshot('guild'), before);
  await assert.rejects(h.music.enqueueMany('guild', [song('wrong-channel')], 'other', 'text'), /voice channel/);
  assert.deepEqual(h.music.snapshot('guild'), before);
});
test('slow initial source extraction does not trigger the playing-track silence watchdog', async () => {
  const h = setup(); await h.add(); h.advance(25_000); await h.music.tick();
  assert.equal(h.music.snapshot('guild').state, 'starting');
  await h.start(); h.advance(20_000); await h.music.tick(); assert.equal(h.music.snapshot('guild').state, 'recovering');
});

test('sources requiring a fresh seek keep the recording, position, pause intent and request identity', async () => {
  const h = setup(); h.music['backend'].requiresReloadForSeek = () => true;
  const entry = song('Original source'); await h.add(entry); const first = await h.start(); h.advance(5000); await h.progress(first, 5000);
  await h.music.seek('guild', 120000, entry.id);
  const second = h.music.attemptId('guild')!; assert.notEqual(second, first);
  assert.equal(h.music.snapshot('guild').current?.id, entry.id); assert.equal(h.music.snapshot('guild').history.length, 0);
  assert.equal(h.starts.at(-1)?.session.positionMs, 120000);
  await h.start(); h.advance(5000); await h.progress(second, 125000); await h.music.pause('guild');
  await h.music.seek('guild', 30000, entry.id); assert.equal(h.starts.at(-1)?.session.resumePaused, true);
  await h.start(); assert.equal(h.music.snapshot('guild').state, 'paused'); assert.equal(h.music.snapshot('guild').positionMs, 30000);
});
