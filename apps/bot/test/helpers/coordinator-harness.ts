import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MusicCoordinator, type PlaybackBackend } from "../../src/audio/coordinator.js";
import type { QueueEntry, RecordingSource, Session } from "../../src/audio/model.js";
import { SqliteMusicStorage } from "../../src/storage/sqlite-storage.js";

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

/** Offline fixture: real file-backed SQLite/coordinator; no source or voice I/O. */
export class CoordinatorHarness {
  readonly directory: string;
  readonly path: string;
  store: SqliteMusicStorage;
  readonly guild = "10000001";
  readonly voice = "20000001";
  readonly channel = "30000001";
  now = 1_800_000_000_000;
  serial = 0;
  readonly accepted = new Map<string, string>();
  readonly starts: { id: string; entryId: string; signal: AbortSignal }[] = [];
  readonly active = new Set<string>();
  private backendAssertion: unknown;
  private closed = false;
  readonly backend: PlaybackBackend = {
    start: async (session, id, signal) => {
      try {
        assert.equal(this.active.size, 0, "A replacement must cancel its predecessor before starting.");
        assert.ok(!this.starts.some(start => start.id === id), "An attempt must start at most once.");
        assert.equal(this.store.loadSessions()[0].current?.id, session.current?.id, "Start must follow its durable handoff.");
      } catch (error) { this.backendAssertion = error; throw error; }
      this.starts.push({ id, entryId: session.current!.id, signal });
      this.active.add(id);
      signal.addEventListener("abort", () => this.active.delete(id), { once: true });
    },
    stop: async () => {}, pause: async () => {}, seek: async () => {}, volume: async () => {},
    requiresReloadForSeek: recording => recording.source === "spotify",
  };
  music: MusicCoordinator;
  constructor(storageDirectory = tmpdir()) {
    this.directory = mkdtempSync(join(storageDirectory, "musicmaid-stateful-"));
    this.path = join(this.directory, "music.sqlite");
    try { this.store = new SqliteMusicStorage(this.path); this.music = this.coordinator(); }
    catch (error) { rmSync(this.directory, { recursive: true, force: true }); throw error; }
  }
  private coordinator(): MusicCoordinator { return new MusicCoordinator(this.store, this.backend, { now: () => this.now }); }
  snapshot(): Session { return this.music.snapshot(this.guild); }
  entry(owner = "40000001"): QueueEntry {
    const serial = ++this.serial, source: RecordingSource = ["soundcloud", "youtube", "spotify"][serial % 3] as RecordingSource;
    const identifier = source === "soundcloud" ? `fixture-${serial}` : serial.toString(36).padStart(source === "youtube" ? 11 : 22, "0");
    const uri = source === "soundcloud" ? `https://soundcloud.com/fixture/${identifier}` : source === "youtube" ? `https://www.youtube.com/watch?v=${identifier}` : `https://open.spotify.com/track/${identifier}`;
    return { id: `00000000-0000-4000-8000-${serial.toString(16).padStart(12, "0")}`, addedAt: this.now,
      request: { query: `Fixture ${serial}`, source: "auto", requestedBy: owner },
      recording: { identifier, uri, source, title: `Fixture ${serial}`, author: "Fixture artist", durationMs: 180000, isStream: false, isSeekable: true } };
  }
  async add(entry = this.entry()): Promise<QueueEntry> {
    await this.music.enqueue(this.guild, entry, this.voice, this.channel);
    this.accepted.set(entry.id, entry.recording.uri);
    return entry;
  }
  async addMany(entries: QueueEntry[]): Promise<void> {
    await this.music.enqueueMany(this.guild, entries, this.voice, this.channel);
    for (const entry of entries) this.accepted.set(entry.id, entry.recording.uri);
  }
  async progress(position?: number, connected = true): Promise<void> {
    const id = this.music.attemptId(this.guild);
    if (!id || !this.active.has(id)) return;
    await this.music.event(this.guild, { type: "start", attemptId: id });
    this.now += 1000;
    await this.music.event(this.guild, { type: "update", attemptId: id, time: this.now, connected, positionMs: position ?? Math.min(179000, this.snapshot().positionMs + 1000) });
  }
  async settle(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }
  async reopen(): Promise<void> {
    await this.music.suspend(this.guild); await this.settle(); this.store.close();
    this.store = new SqliteMusicStorage(this.path); this.music = this.coordinator();
  }
  async rejectedWrite(action: () => Promise<unknown>, afterSessionWrite = false): Promise<void> {
    const before = this.snapshot(), durable = this.store.loadSessions(), attempt = this.music.attemptId(this.guild), starts = this.starts.length;
    const database = this.store["db"];
    if (afterSessionWrite) database.exec("CREATE TEMP TRIGGER fixture_reject_request BEFORE INSERT ON music_requests BEGIN SELECT RAISE(ABORT,'fixture statistics failure'); END;");
    else database.exec("PRAGMA query_only=ON;");
    try { await assert.rejects(action(), /readonly|read-only|fixture statistics failure/); }
    finally { database.exec(afterSessionWrite ? "DROP TRIGGER fixture_reject_request;" : "PRAGMA query_only=OFF;"); }
    assert.deepEqual(this.snapshot(), before);
    assert.deepEqual(this.store.loadSessions(), durable);
    assert.equal(this.music.attemptId(this.guild), attempt);
    assert.equal(this.starts.length, starts);
  }
  verify(): void {
    if (this.backendAssertion) throw this.backendAssertion;
    const session = this.snapshot();
    const entries = [session.current, ...session.queue, ...session.history.map(item => item.entry)].filter((entry): entry is QueueEntry => Boolean(entry));
    assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length, "An entry cannot exist twice in current/queue/history.");
    assert.ok(session.queue.length <= 500); assert.ok(session.history.length <= 100);
    assert.ok(this.active.size <= 1);
    for (const entry of entries) assert.equal(entry.recording.uri, this.accepted.get(entry.requestId ?? entry.id), "Recovery must retain the selected recording.");
    assert.equal(this.store.library.stats(this.guild, 0).requests, this.accepted.size, "Every accepted original request counts once, regardless of loops/retries.");
    const durable = this.store.loadSessions()[0];
    if (durable) assert.deepEqual(JSON.parse(JSON.stringify(session)), durable);
    for (const id of this.active) assert.equal(id, this.music.attemptId(this.guild));
  }
  async close(): Promise<{ activeBackendAttempts: number; pendingGuildActions: number }> {
    if (this.closed) return { activeBackendAttempts: this.active.size, pendingGuildActions: this.music["locks"].size };
    try {
      await this.music.stop(this.guild); await this.settle();
      const cleanup = { activeBackendAttempts: this.active.size, pendingGuildActions: this.music["locks"].size };
      assert.equal(cleanup.activeBackendAttempts, 0); assert.equal(cleanup.pendingGuildActions, 0);
      return cleanup;
    } finally { this.closed = true; this.store.close(); rmSync(this.directory, { recursive: true, force: true }); }
  }
}
