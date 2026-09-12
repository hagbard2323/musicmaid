import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { MusicCoordinator, type PlaybackBackend } from "../src/audio/coordinator.js";
import { scheduleFairQueue, takeFairQueue } from "../src/audio/fair-queue.js";
import { entryFor, newSession, type QueueEntry, type Session } from "../src/audio/model.js";
import { SqliteMusicStorage } from "../src/storage/sqlite-storage.js";
import type { MusicStorage } from "../src/storage/types.js";

class MemoryStore implements MusicStorage {
  sessions = new Map<string, Session>(); fail = false;
  loadSessions() { return [...this.sessions.values()].map(s => structuredClone(s)); }
  saveSession(s: Session) { if (this.fail) throw new Error("disk full"); this.sessions.set(s.guildId, structuredClone(s)); }
  getValue() { return undefined; } setValue() {} close() {}
}
function song(owner: string, name: string): QueueEntry {
  return entryFor({ query: name, requestedBy: owner, source: "auto", sources: ["youtube", "soundcloud"] }, {
    identifier: name, uri: "https://soundcloud.com/fixture/" + name, title: name, author: "Artist", source: "soundcloud", durationMs: 10000, isStream: false, isSeekable: true
  });
}
const names = (entries: QueueEntry[]) => entries.map(entry => entry.recording.title);
function setup(store: MusicStorage = new MemoryStore()) {
  let now = Date.now();
  const starts: Array<{ session: Session; id: string; signal: AbortSignal }> = [], stops: string[] = [];
  const backend: PlaybackBackend = { start: async (session, id, signal) => { starts.push({ session, id, signal }); }, stop: async guild => { stops.push(guild); }, pause: async () => {}, seek: async () => {}, volume: async () => {} };
  const music = new MusicCoordinator(store, backend, { now: () => now });
  const add = (entry: QueueEntry, guild = "g") => music.enqueue(guild, entry, "voice-" + guild, "text");
  const many = (entries: QueueEntry[], guild = "g") => music.enqueueMany(guild, entries, "voice-" + guild, "text");
  const finish = async (guild = "g") => {
    const attemptId = music.attemptId(guild)!; await music.event(guild, { type: "start", attemptId }); now += 10000;
    await music.event(guild, { type: "update", attemptId, positionMs: music.snapshot(guild).current!.recording.durationMs, time: now, connected: true });
    await music.event(guild, { type: "end", attemptId, reason: "finished" });
  };
  return { music, starts, stops, add, many, finish, store };
}

test("fair scheduling preserves personal track order and appends new requesters behind waiting turns", () => {
  const input = [song("a", "A1"), song("a", "A2"), song("a", "A3"), song("b", "B1"), song("b", "B2"), song("c", "C1")];
  const before = structuredClone(input);
  const fair = scheduleFairQueue(input, ["gone", "b", "a", "b"]);
  assert.deepEqual(fair.rotation, ["b", "a", "c"]);
  assert.deepEqual(names(fair.queue), ["B1", "A1", "C1", "B2", "A2", "A3"]);
  const next = takeFairQueue(fair.queue, fair.rotation);
  assert.equal(next.entry?.recording.title, "B1"); assert.deepEqual(next.rotation, ["a", "c", "b"]);
  assert.deepEqual(scheduleFairQueue(next.queue, next.rotation).queue, next.queue);
  assert.deepEqual(input, before); assert.deepEqual(takeFairQueue([], ["a"]), { queue: [], rotation: [] });
});

test("legacy sessions default to FIFO and new source filters survive durable queue snapshots", async t => {
  t.mock.method(console, "info", () => {});
  const store = new MemoryStore(); const legacy = newSession("g"); delete legacy.queueMode; delete legacy.fairRotation;
  legacy.queue = [song("a", "A1"), song("a", "A2"), song("b", "B1")]; store.saveSession(legacy);
  const h = setup(store); assert.equal(h.music.snapshot("g").queueMode, "fifo"); assert.deepEqual(h.music.snapshot("g").fairRotation, []);
  await h.music.resume("g", "voice-g", "text");
  assert.equal(h.music.snapshot("g").current?.recording.title, "A1"); assert.deepEqual(names(h.music.snapshot("g").queue), ["A2", "B1"]);
  assert.deepEqual(store.loadSessions()[0].current?.request.sources, ["youtube", "soundcloud"]);
});

test("fair enqueueMany rotates individual tracks, and single enqueue returns its actual scheduled position", async t => {
  t.mock.method(console, "info", () => {});
  const h = setup(); await h.music.setQueueMode("g", "fair");
  await h.many([song("a", "A1"), song("a", "A2"), song("b", "B1"), song("b", "B2")]);
  assert.equal(h.music.snapshot("g").current?.recording.title, "A1");
  assert.deepEqual(names(h.music.snapshot("g").queue), ["B1", "A2", "B2"]);
  assert.deepEqual(h.music.snapshot("g").fairRotation, ["b", "a"]);
  assert.equal(await h.add(song("c", "C1")), 3);
  assert.deepEqual(names(h.music.snapshot("g").queue), ["B1", "A2", "C1", "B2"]);
  await h.music.skip("g"); assert.equal(h.music.snapshot("g").current?.recording.title, "B1");
  assert.deepEqual(h.music.snapshot("g").fairRotation, ["a", "c", "b"]);
  assert.deepEqual(names(h.music.snapshot("g").queue), ["A2", "C1", "B2"]);
});

test("a later playlist joins after already waiting requesters without starving earlier turns", async t => {
  t.mock.method(console, "info", () => {});
  const h = setup(); await h.music.setQueueMode("g", "fair");
  await h.many([song("a", "A1"), song("a", "A2"), song("a", "A3")]);
  await h.many([song("b", "B1"), song("b", "B2")]);
  assert.deepEqual(names(h.music.snapshot("g").queue), ["A2", "B1", "A3", "B2"]);
  await h.music.skip("g"); assert.equal(h.music.snapshot("g").current?.recording.title, "A2");
  // An endless stream of newcomers must join behind B's already pending turn.
  for (let n = 0; n < 25; n++) await h.add(song("new-" + n, "N" + n));
  assert.equal(h.music.snapshot("g").queue[0].recording.title, "B1");
  await h.music.skip("g"); assert.equal(h.music.snapshot("g").current?.recording.title, "B1");
  assert.equal(h.music.snapshot("g").queue[0].recording.title, "A3");
});

test("queue mode changes invalidate old menus even when track order is unchanged", async t => {
  t.mock.method(console, "info", () => {});
  const h = setup(); await h.add(song("a", "A1")); await h.add(song("a", "A2"));
  const before = h.music.snapshot("g"); await h.music.setQueueMode("g", "fair");
  assert.equal(h.music.snapshot("g").revision, before.revision + 1); assert.deepEqual(h.music.snapshot("g").queue, before.queue);
  await assert.rejects(h.music.editQueue("g", before.revision, "clear"), /queue changed/);
  const fair = h.music.snapshot("g"); await h.music.setQueueMode("g", "fair"); assert.equal(h.music.snapshot("g").revision, fair.revision);
  await assert.rejects(h.music.editQueue("g", fair.revision, "move", fair.queue[0].id, 1), /moderator.*FIFO/);
  await assert.rejects(h.music.editQueue("g", fair.revision, "shuffle"), /moderator.*FIFO/);
  await h.music.setQueueMode("g", "fifo"); assert.equal(h.music.snapshot("g").revision, fair.revision + 1);
  assert.deepEqual(h.music.snapshot("g").queue, fair.queue); assert.deepEqual(h.music.snapshot("g").fairRotation, []);
  await h.music.editQueue("g", h.music.snapshot("g").revision, "move", fair.queue[0].id, 1);
});

test("mode conversion interleaves existing FIFO entries and switching back freezes their visible order", async t => {
  t.mock.method(console, "info", () => {});
  const h = setup(); await h.add(song("current", "Playing"));
  await h.many([song("a", "A1"), song("a", "A2"), song("b", "B1"), song("b", "B2"), song("c", "C1")]);
  const current = h.music.snapshot("g").current!.id, attempt = h.music.attemptId("g");
  await h.music.setQueueMode("g", "fair");
  assert.deepEqual(names(h.music.snapshot("g").queue), ["A1", "B1", "C1", "A2", "B2"]);
  assert.equal(h.music.snapshot("g").current?.id, current); assert.equal(h.music.attemptId("g"), attempt);
  await h.music.setQueueMode("g", "fifo"); await h.add(song("a", "A3"));
  assert.deepEqual(names(h.music.snapshot("g").queue), ["A1", "B1", "C1", "A2", "B2", "A3"]);
});

test("remove, clear and Stop release empty requester turns while retaining the selected guild mode", async t => {
  t.mock.method(console, "info", () => {});
  const h = setup(); await h.music.setQueueMode("g", "fair"); await h.add(song("playing", "Playing"));
  await h.many([song("a", "A1"), song("a", "A2"), song("b", "B1"), song("c", "C1")]);
  let s = h.music.snapshot("g"); await h.music.editQueue("g", s.revision, "remove", s.queue.find(e => e.request.requestedBy === "b")!.id);
  assert.deepEqual(h.music.snapshot("g").fairRotation, ["a", "c"]); assert.deepEqual(names(h.music.snapshot("g").queue), ["A1", "C1", "A2"]);
  s = h.music.snapshot("g"); await h.music.editQueue("g", s.revision, "clear");
  assert.equal(h.music.snapshot("g").current?.id, s.current?.id); assert.deepEqual(h.music.snapshot("g").fairRotation, []);
  await h.add(song("b", "NewB")); await h.add(song("a", "NewA")); assert.deepEqual(h.music.snapshot("g").fairRotation, ["b", "a"]);
  await h.music.stop("g"); assert.deepEqual(h.music.snapshot("g").fairRotation, []); assert.equal(h.music.snapshot("g").queueMode, "fair");
});

test("changing a queued recording preserves its requester's track order and waiting turn", async t => {
  t.mock.method(console, "info", () => {});
  const h = setup(); await h.music.setQueueMode("g", "fair"); await h.add(song("playing", "Playing"));
  const original = song("a", "A1"); await h.many([original, song("a", "A2"), song("b", "B1")]);
  const rotation = h.music.snapshot("g").fairRotation;
  await h.music.chooseAlternative("g", original.id, song("a", "A1-chosen"), "voice-g", "text");
  assert.deepEqual(names(h.music.snapshot("g").queue), ["A1-chosen", "B1", "A2"]); assert.deepEqual(h.music.snapshot("g").fairRotation, rotation);
});

test("SQLite restart preserves fair turns instead of reseeding them from new arrivals", async t => {
  t.mock.method(console, "info", () => {});
  const dir = mkdtempSync("/tmp/musicmaid-fair-restart-"); let store: SqliteMusicStorage | undefined;
  try {
    store = new SqliteMusicStorage(dir + "/music.sqlite"); let h = setup(store); await h.music.setQueueMode("g", "fair");
    await h.many([song("a", "A1"), song("a", "A2"), song("b", "B1"), song("b", "B2"), song("c", "C1")]);
    const before = h.music.snapshot("g"); assert.deepEqual(before.fairRotation, ["b", "c", "a"]);
    store.close(); store = undefined; store = new SqliteMusicStorage(dir + "/music.sqlite"); h = setup(store);
    assert.equal(h.music.snapshot("g").queueMode, "fair"); assert.deepEqual(h.music.snapshot("g").fairRotation, before.fairRotation);
    assert.deepEqual(h.music.snapshot("g").queue, before.queue);
    await h.add(song("d", "D1")); assert.deepEqual(h.music.snapshot("g").fairRotation, ["b", "c", "a", "d"]);
    await h.music.resume("g", "voice-g", "text"); assert.equal(h.music.snapshot("g").current?.id, before.current?.id);
    await h.music.skip("g"); assert.equal(h.music.snapshot("g").current?.recording.title, "B1");
    assert.deepEqual(h.music.snapshot("g").fairRotation, ["c", "a", "d", "b"]);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("repeat-one holds fair rotation while queue-repeat consumes fair turns and counts requests once", async t => {
  t.mock.method(console, "info", () => {});
  const store = new SqliteMusicStorage(":memory:");
  try {
    const h = setup(store); await h.music.setQueueMode("g", "fair");
    await h.many([song("a", "A1"), song("a", "A2"), song("b", "B1"), song("b", "B2")]);
    const original = h.music.snapshot("g").current!, before = h.music.snapshot("g");
    await h.music.setLoop("g", "track"); await h.finish(); await h.finish();
    assert.equal(h.music.snapshot("g").current?.requestId, original.id); assert.deepEqual(h.music.snapshot("g").fairRotation, before.fairRotation);
    assert.deepEqual(h.music.snapshot("g").queue, before.queue); assert.equal(store.library.stats("g", 0).tracks[0].count, 1);
    await h.music.setLoop("g", "queue"); await h.finish();
    assert.equal(h.music.snapshot("g").current?.recording.title, "B1"); assert.deepEqual(names(h.music.snapshot("g").queue), ["A2", "B2", "A1"]);
    await h.finish(); assert.equal(h.music.snapshot("g").current?.recording.title, "A2");
    await h.finish(); assert.equal(h.music.snapshot("g").current?.recording.title, "B2");
    await h.finish(); assert.equal(h.music.snapshot("g").current?.recording.title, "A1");
    assert.equal(h.music.snapshot("g").current?.requestId, original.id); assert.equal(store.library.stats("g", 0).requests, 4);
    assert.ok(store.library.stats("g", 0).tracks.every(track => track.count === 1));
  } finally { store.close(); }
});

test("guild modes and requester rotations are independent", async t => {
  t.mock.method(console, "info", () => {});
  const h = setup(); await h.music.setQueueMode("fair-guild", "fair");
  for (const guild of ["fair-guild", "fifo-guild"]) await h.many([song("a", guild + "-A1"), song("a", guild + "-A2"), song("b", guild + "-B1")], guild);
  assert.deepEqual(names(h.music.snapshot("fair-guild").queue), ["fair-guild-B1", "fair-guild-A2"]);
  assert.deepEqual(names(h.music.snapshot("fifo-guild").queue), ["fifo-guild-A2", "fifo-guild-B1"]);
  const untouched = h.music.snapshot("fifo-guild"); await h.music.skip("fair-guild"); assert.deepEqual(h.music.snapshot("fifo-guild"), untouched);
});

test("persistence errors leave fair queue order, rotation, mode and the current attempt untouched", async t => {
  t.mock.method(console, "info", () => {});
  const changes = [
    (h: ReturnType<typeof setup>) => h.add(song("new", "New")),
    (h: ReturnType<typeof setup>) => h.many([song("new", "New1"), song("new", "New2")]),
    (h: ReturnType<typeof setup>) => h.music.skip("g"),
    (h: ReturnType<typeof setup>) => h.music.setQueueMode("g", "fifo"),
    (h: ReturnType<typeof setup>) => { const s = h.music.snapshot("g"); return h.music.editQueue("g", s.revision, "remove", s.queue[0].id); },
    (h: ReturnType<typeof setup>) => h.music.editQueue("g", h.music.snapshot("g").revision, "clear")
  ];
  for (const change of changes) {
    const store = new MemoryStore(), h = setup(store); await h.music.setQueueMode("g", "fair");
    await h.many([song("a", "A1"), song("a", "A2"), song("b", "B1")]); const before = h.music.snapshot("g"), stops = h.stops.length;
    store.fail = true; await assert.rejects(change(h), /disk full/);
    assert.deepEqual(h.music.snapshot("g"), before); assert.deepEqual(store.loadSessions()[0], before);
    assert.equal(h.starts[0].signal.aborted, false); assert.equal(h.starts.length, 1); assert.equal(h.stops.length, stops);
  }
});

test("a full fair queue rejects a batch atomically without admitting a new rotation participant", async t => {
  t.mock.method(console, "info", () => {});
  const h = setup(); await h.music.setQueueMode("g", "fair"); await h.add(song("current", "Current"));
  await h.many(Array.from({ length: 499 }, (_, n) => song(n % 2 ? "a" : "b", "Queued" + n)));
  const before = h.music.snapshot("g"); await assert.rejects(h.many([song("c", "C1"), song("c", "C2")]), /Nothing was added/);
  assert.deepEqual(h.music.snapshot("g"), before); assert.equal(h.music.snapshot("g").fairRotation?.includes("c"), false);
});

test("search cancellation is checked inside the guild transaction before enqueue or replacement", async t => {
  t.mock.method(console, "info", () => {});
  for (const mode of ["fifo", "fair"] as const) {
    const store = new MemoryStore(), h = setup(store); await h.music.setQueueMode("g", mode); await h.add(song("a", "Current"));
    const before = h.music.snapshot("g");
    const adding = new AbortController();
    const queued = h.music.enqueue("g", song("b", "Cancelled"), "voice-g", "text", adding.signal);
    adding.abort(); await assert.rejects(queued, /abort/i);
    const replacing = new AbortController();
    const replaced = h.music.chooseAlternative("g", before.current!.id, song("b", "Cancelled replacement"), "voice-g", "text", replacing.signal);
    replacing.abort(); await assert.rejects(replaced, /abort/i);
    assert.deepEqual(h.music.snapshot("g"), before); assert.deepEqual(store.loadSessions()[0], before);
    assert.equal(h.starts.length, 1); assert.equal(h.starts[0].signal.aborted, false);
  }
});
