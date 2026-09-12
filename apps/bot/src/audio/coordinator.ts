import { randomUUID } from "node:crypto";
import type { MusicStorage } from "../storage/types.js";
import { failureScope, incident, safeError } from "./diagnostics.js";
import { newSession, type FailureScope, type PlaybackEvent, type QueueEntry, type QueueMode, type Session } from "./model.js";
import { scheduleFairQueue, takeFairQueue } from "./fair-queue.js";
import { assertGuildScope } from "../config/guild-scope.js";

export interface PlaybackBackend {
  start(session: Session, attemptId: string, signal: AbortSignal, reconnect: boolean): Promise<void>;
  stop(guildId: string, disconnect: boolean): Promise<void>;
  pause(guildId: string, paused: boolean): Promise<void>;
  seek(guildId: string, positionMs: number): Promise<void>;
  requiresReloadForSeek?(recording: QueueEntry["recording"]): boolean;
  volume(guildId: string, volume: number): Promise<void>;
  restoreVolumeIntent?(guildId: string, attemptedVolume: number, previousVolume: number): void;
}
type Attempt = {
  id: string; controller: AbortController; consumed: boolean; started: boolean; connectedOnce: boolean;
  lastProgressAt: number; lastPosition: number; lastUpdateTime: number;
  disconnectedAt?: number;
  retries: number; recoveryStartedAt?: number; retryAt?: number; reconnect: boolean;
};
// Lavalink reports gateway state every five seconds; allow one report plus jitter
// for its existing voice-server update to reconnect before forcing a new attempt.
const voiceReconnectGraceMs = 6000;
type Options = {
  guildId?: string;
  now?: () => number;
  onChange?: (session: Session) => void;
  onFailure?: (entry: QueueEntry, reason: string, scope: FailureScope) => void;
  idleMs?: number;
};

/** Owns queue transitions. Network work is cancellable and never holds the state lock. */
export class MusicCoordinator {
  private sessions = new Map<string, Session>();
  private attempts = new Map<string, Attempt>();
  private locks = new Map<string, Promise<unknown>>();
  private volumeRequests = new Map<string, number>();
  private readonly now: () => number;
  private readonly idleMs: number;
  constructor(private store: MusicStorage, private backend: PlaybackBackend, private options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? 300_000;
    for (const session of store.loadSessions(options.guildId)) {
      // Preserve foreign snapshots exactly as stored: no restoration, timer or
      // maintenance work should adopt them into this single-community runtime.
      if (options.guildId !== undefined && session.guildId !== options.guildId) continue;
      // No old attempt or pending prompt can become active before voice membership is checked.
      session.resumePaused = session.state === "paused" || session.resumePaused;
      session.state = session.current || session.queue.length ? "suspended" : "idle";
      session.queueMode ??= "fifo";
      this.scheduleQueue(session);
      if (session.failure) {
        session.failure.scope = failureScope(session.failure.reason, session.failure.scope);
        if (session.failure.scope !== "recording") delete session.failure.deadline;
      }
      this.sessions.set(session.guildId, session);
    }
  }
  snapshot(guildId: string): Session { assertGuildScope(guildId, this.options.guildId); return structuredClone(this.sessions.get(guildId) ?? newSession(guildId)); }
  all(): Session[] { return [...this.sessions.values()].map(s => structuredClone(s)); }
  attemptId(guildId: string): string | undefined { return this.attempts.get(guildId)?.id; }
  private run<T>(guildId: string, action: () => T | Promise<T>): Promise<T> {
    try { assertGuildScope(guildId, this.options.guildId); } catch (error) { return Promise.reject(error); }
    const previous = this.locks.get(guildId) ?? Promise.resolve();
    const next = previous.then(action, action);
    this.locks.set(guildId, next);
    void next.finally(() => { if (this.locks.get(guildId) === next) this.locks.delete(guildId); }).catch(() => {});
    return next;
  }
  private commit(guildId: string, change: (session: Session) => void): Session {
    const next = this.snapshot(guildId);
    change(next);
    const previous = this.snapshot(guildId);
    if (next.positionMs !== previous.positionMs || next.state !== previous.state || next.current?.id !== previous.current?.id) next.positionUpdatedAt = this.now();
    if (next.current?.id !== previous.current?.id || next.queue.map(e => e.id).join() !== previous.queue.map(e => e.id).join() || (next.queueMode ?? "fifo") !== (previous.queueMode ?? "fifo")) next.revision++;
    // Publish memory/UI only after the durable write succeeds.
    this.store.saveSession(next);
    this.sessions.set(guildId, next);
    try { this.options.onChange?.(structuredClone(next)); } catch (error) { incident("panel_error", { error: safeError(error) }); }
    return next;
  }
  private scheduleQueue(session: Session): void {
    if (session.queueMode !== "fair") { session.fairRotation = []; return; }
    const scheduled = scheduleFairQueue(session.queue, session.fairRotation);
    session.queue = scheduled.queue; session.fairRotation = scheduled.rotation;
  }
  private cancel(guildId: string): void {
    const attempt = this.attempts.get(guildId);
    if (attempt) { attempt.consumed = true; attempt.controller.abort(); }
  }
  private background(work: Promise<unknown>, guildId: string): void {
    void work.catch(error => incident("background_error", { guildId, error: safeError(error) }));
  }
  private begin(guildId: string, retries = 0, recoveryStartedAt?: number, reconnect = false): void {
    const session = this.commit(guildId, s => { s.resumePaused = s.state === "paused" || s.resumePaused; s.state = "starting"; s.failure = undefined; s.idleSince = undefined; });
    this.launch(guildId, session, retries, recoveryStartedAt, reconnect);
  }
  /** Launch only an already committed starting state: never write after cancelling the old attempt. */
  private launch(guildId: string, session: Session, retries = 0, recoveryStartedAt?: number, reconnect = false): void {
    if (!session.current) return;
    this.cancel(guildId);
    const attempt: Attempt = {
      id: randomUUID(), controller: new AbortController(), consumed: false, started: false, connectedOnce: false,
      lastProgressAt: this.now(), lastPosition: session.positionMs, lastUpdateTime: 0,
      retries, recoveryStartedAt, reconnect
    };
    this.attempts.set(guildId, attempt);
    incident("play_attempt", { guildId, attemptId: attempt.id, entryId: session.current.id, source: session.current.recording.source, retries });
    this.background(this.backend.start(session, attempt.id, attempt.controller.signal, reconnect)
      .catch(error => this.event(guildId, { type: "failure", attemptId: attempt.id, reason: safeError(error) })), guildId);
  }
  enqueue(guildId: string, entry: QueueEntry, voiceChannelId: string, textChannelId: string, signal?: AbortSignal): Promise<number> {
    return this.run(guildId, () => {
      signal?.throwIfAborted();
      const current = this.snapshot(guildId);
      if (current.voiceChannelId && current.voiceChannelId !== voiceChannelId && (current.current || current.queue.length)) throw new Error("Join the bot’s current voice channel to add songs.");
      if (current.queue.length >= 500) throw new Error("The queue is full (500 songs).");
      if (current.current?.id === entry.id || current.queue.some(t => t.id === entry.id)) return current.queue.findIndex(t => t.id === entry.id) + 1;
      const next = this.commit(guildId, s => {
        s.voiceChannelId = voiceChannelId; s.textChannelId ??= textChannelId;
        s.idleSince = undefined; s.queue.push(entry); this.scheduleQueue(s);
      });
      if (!next.current && next.state !== "suspended") { this.advance(guildId); return 0; }
      return next.queue.findIndex(item => item.id === entry.id) + 1;
    });
  }
  enqueueMany(guildId: string, entries: QueueEntry[], voiceChannelId: string, textChannelId: string): Promise<void> {
    return this.run(guildId, () => {
      const s = this.snapshot(guildId);
      if (!entries.length) throw new Error("This playlist has no tracks yet.");
      if (s.voiceChannelId && s.voiceChannelId !== voiceChannelId && (s.current || s.queue.length)) throw new Error("Join the bot's voice channel to play this playlist.");
      const existing = new Set([s.current?.id, ...s.queue.map(e => e.id)]);
      if (new Set(entries.map(e => e.id)).size !== entries.length || entries.some(e => existing.has(e.id))) throw new Error("This playlist request was already added. Open a fresh control.");
      if (s.queue.length + entries.length > 500) throw new Error(`The queue has room for ${500 - s.queue.length} more tracks; this playlist contains ${entries.length}. Nothing was added.`);
      const next = this.commit(guildId, current => { current.voiceChannelId = voiceChannelId; current.textChannelId ??= textChannelId; current.idleSince = undefined; current.queue.push(...structuredClone(entries)); this.scheduleQueue(current); });
      if (!next.current && next.state !== "suspended") this.advance(guildId);
    });
  }
  private archive(session: Session, outcome: "finished" | "skipped" | "failed"): void {
    if (!session.current) return;
    session.history.unshift({ id: randomUUID(), entry: session.current, outcome, at: this.now(), reason: session.failure?.reason, incidentId: session.failure?.incidentId });
    session.history = session.history.slice(0, 100);
  }
  private advance(guildId: string, outcome?: "finished" | "skipped" | "failed"): void {
    const session = this.commit(guildId, s => {
      if (outcome) this.archive(s, outcome);
      let repeatCurrent: QueueEntry | undefined;
      if (outcome === "finished") {
        s.lastCompletedAt = this.now();
        const repeat = s.current ? { ...s.current, id: randomUUID(), requestId: s.current.requestId ?? s.current.id, addedAt: this.now() } : undefined;
        if (s.loop === "queue" && repeat) s.queue.push(repeat);
        if (s.loop === "track" && repeat) repeatCurrent = repeat;
      }
      // Repeat-one deliberately holds the shared rotation until it is disabled
      // or skipped. Repeating the queue returns each track to its owner's tail.
      if (repeatCurrent) s.current = repeatCurrent;
      else if (s.queueMode === "fair") {
        const next = takeFairQueue(s.queue, s.fairRotation);
        s.current = next.entry; s.queue = next.queue; s.fairRotation = next.rotation;
      } else s.current = s.queue.shift();
      s.positionMs = 0; s.failure = undefined;
      s.resumePaused = false;
      s.state = s.current ? "starting" : "idle";
      s.idleSince = s.current ? undefined : this.now();
    });
    this.cancel(guildId);
    this.background(this.backend.stop(guildId, false), guildId);
    if (session.current) this.launch(guildId, session);
  }
  event(guildId: string, event: PlaybackEvent): Promise<void> {
    return this.run(guildId, () => {
      const attempt = this.attempts.get(guildId);
      const session = this.snapshot(guildId);
      if (!attempt || attempt.id !== event.attemptId || attempt.consumed || !session.current) return;
      if (event.type === "start") {
        if (attempt.started) return;
        if (session.resumePaused || event.recording) this.commit(guildId, s => {
          if (session.resumePaused) s.state = "paused";
          if (event.recording && s.current) s.current.recording = event.recording;
        });
        attempt.started = true; attempt.lastProgressAt = this.now();
        return;
      }
      if (event.type === "update") {
        if (!attempt.started || !Number.isFinite(event.time) || event.time <= attempt.lastUpdateTime) return;
        if (!event.connected && attempt.connectedOnce && session.state !== "paused") {
          attempt.lastUpdateTime = event.time;
          attempt.disconnectedAt ??= this.now();
          // Unsent audio is not verified progress. Retain its last checkpoint so
          // recovery does not skip forward over the disconnected interval.
          return;
        }
        if (!Number.isFinite(event.positionMs) || event.positionMs < 0) return;
        const advancing = event.positionMs > attempt.lastPosition;
        this.commit(guildId, s => {
          s.positionMs = event.positionMs;
          if (advancing && event.connected && s.state !== "paused") { s.state = "playing"; s.lastVerifiedAt = this.now(); }
        });
        // Consume this observation only after its checkpoint was accepted. A
        // rejected write must not suppress a replayed start/update or clear an outage.
        attempt.lastUpdateTime = event.time;
        if (event.connected) { attempt.connectedOnce = true; attempt.disconnectedAt = undefined; }
        if ((advancing && event.connected) || session.state === "paused") attempt.lastProgressAt = this.now();
        if (advancing && event.connected) { attempt.recoveryStartedAt = undefined; attempt.retries = 0; }
        attempt.lastPosition = event.positionMs;
        return;
      }
      if (event.type === "failure") { this.fail(guildId, attempt, event.reason, event.reconnect ?? false, false, event.scope); return; }
      if (event.reason === "replaced") return;
      if (event.reason !== "finished") { this.fail(guildId, attempt, event.reason); return; }
      const track = session.current.recording;
      const estimatedPosition = session.positionMs + (session.state === "paused" ? 0 : Math.min(this.now() - attempt.lastProgressAt, 5000));
      if (!track.isStream && track.durationMs > 0 && track.durationMs - estimatedPosition > 10_000) {
        this.fail(guildId, attempt, "Incomplete playback: upload finished early", false, true);
        return;
      }
      this.advance(guildId, "finished");
    });
  }
  private fail(guildId: string, attempt: Attempt, reason: string, reconnect = false, permanent = false, explicitScope?: FailureScope): void {
    const session = this.snapshot(guildId);
    if (!session.current || attempt.consumed) return;
    const now = this.now();
    const recoveryStartedAt = attempt.recoveryStartedAt ?? now;
    const exhausted = attempt.retries >= 2 || now - recoveryStartedAt >= 30_000;
    const scope = failureScope(reason, explicitScope);
    const restricted = permanent || reason.startsWith("Voice:") || reason.startsWith("Version mismatch:")
      || /^Spotify:.*(?:authorization|login|account|premium|buffer limit|different recording)/i.test(reason)
      || /preview|paywall|unavailable|private|restricted|not found|not available|403|401|429|rate.limit|all clients|sign.in/i.test(reason);
    const id = incident("play_failure", { guildId, attemptId: attempt.id, entryId: session.current.id, reason: safeError(reason) });
    this.commit(guildId, s => {
      s.resumePaused = s.state === "paused" || s.resumePaused;
      s.state = exhausted || restricted ? scope === "recording" ? "awaiting_choice" : "suspended" : "recovering";
      s.failure = { reason, incidentId: id, scope, ...(s.state === "awaiting_choice" ? { deadline: now + 60_000 } : {}) };
    });
    attempt.consumed = true; attempt.controller.abort();
    attempt.recoveryStartedAt = recoveryStartedAt;
    attempt.retryAt = exhausted || restricted ? undefined : now + (attempt.retries === 0 ? 1000 : 3000);
    attempt.reconnect = reconnect;
    try { this.options.onFailure?.(session.current, reason, scope); } catch (error) { incident("health_error", { error: safeError(error) }); }
    this.background(this.backend.stop(guildId, false), guildId);
  }
  tick(): Promise<void> {
    return Promise.all(this.all().map(session => this.run(session.guildId, () => {
      const s = this.snapshot(session.guildId);
      const attempt = this.attempts.get(s.guildId);
      const now = this.now();
      if (s.state === "awaiting_choice" && s.failure?.deadline !== undefined && now >= s.failure.deadline) { this.advance(s.guildId, "failed"); return; }
      if (s.state === "recovering" && attempt?.retryAt !== undefined && now >= attempt.retryAt) {
        if (now - (attempt.recoveryStartedAt ?? now) >= 30_000) {
          this.commit(s.guildId, next => {
            const recording = next.failure && failureScope(next.failure.reason, next.failure.scope) === "recording";
            next.state = recording ? "awaiting_choice" : "suspended";
            if (next.failure) { if (recording) next.failure.deadline = now + 60_000; else delete next.failure.deadline; }
          });
        } else this.begin(s.guildId, attempt.retries + 1, attempt.recoveryStartedAt, attempt.reconnect);
        return;
      }
      if (attempt && !attempt.consumed && ["starting", "playing"].includes(s.state)) {
        if (attempt.disconnectedAt !== undefined && now - attempt.disconnectedAt >= voiceReconnectGraceMs) this.fail(s.guildId, attempt, "Voice connection lost", true);
        else if ((attempt.recoveryStartedAt !== undefined && now - attempt.recoveryStartedAt >= 30_000) || now - attempt.lastProgressAt >= (attempt.started ? 20_000 : 75_000)) this.fail(s.guildId, attempt, "Playback made no progress", true);
      }
      if (s.state === "idle" && s.voiceChannelId && s.idleSince !== undefined && this.idleMs > 0 && now - s.idleSince >= this.idleMs) {
        this.commit(s.guildId, next => { next.voiceChannelId = undefined; });
        this.background(this.backend.stop(s.guildId, true), s.guildId);
      }
    }))).then(() => {});
  }
  skip(guildId: string, expectedEntryId?: string): Promise<void> {
    return this.run(guildId, () => {
      const session = this.snapshot(guildId);
      this.assertCurrent(session, expectedEntryId);
      if (!session.current) throw new Error("Nothing is playing.");
      this.advance(guildId, session.failure && failureScope(session.failure.reason, session.failure.scope) === "recording" ? "failed" : "skipped");
    });
  }
  stop(guildId: string, expectedEntryId?: string | null): Promise<void> {
    return this.run(guildId, () => {
      this.assertCurrent(this.snapshot(guildId), expectedEntryId);
      this.commit(guildId, s => {
        this.archive(s, s.failure && failureScope(s.failure.reason, s.failure.scope) === "recording" ? "failed" : "skipped");
        s.current = undefined; s.queue = []; s.fairRotation = []; s.failure = undefined; s.positionMs = 0; s.state = "idle"; s.voiceChannelId = undefined; s.resumePaused = false;
      });
      this.cancel(guildId);
      this.background(this.backend.stop(guildId, true), guildId);
    });
  }
  retry(guildId: string, entryId: string, reconnect = false): Promise<void> {
    return this.run(guildId, () => {
      if (this.snapshot(guildId).current?.id !== entryId) throw new Error("That song is no longer current. Requeue it from history.");
      this.begin(guildId, 0, undefined, reconnect);
    });
  }
  resume(guildId: string, voiceChannelId: string, textChannelId: string, expectedEntryId?: string | null): Promise<void> {
    return this.run(guildId, () => {
      const s = this.snapshot(guildId);
      this.assertCurrent(s, expectedEntryId);
      if (s.voiceChannelId && s.voiceChannelId !== voiceChannelId && (s.current || s.queue.length)) throw new Error("Join the original voice channel to resume its queue.");
      if (!s.current && !s.queue.length) throw new Error("The queue is empty.");
      if (s.state === "paused" && this.attempts.get(guildId)?.started) {
        this.commit(guildId, next => { next.state = "playing"; next.resumePaused = false; });
        this.attempts.get(guildId)!.lastProgressAt = this.now();
        this.attempts.get(guildId)!.disconnectedAt = undefined;
        this.control(guildId, "resume", () => this.backend.pause(guildId, false));
      } else if (s.state === "suspended" || s.state === "idle") {
        this.commit(guildId, next => { next.voiceChannelId = voiceChannelId; next.textChannelId ??= textChannelId; next.resumePaused = false; });
        if (s.current && s.failure && failureScope(s.failure.reason, s.failure.scope) === "recording") this.commit(guildId, next => { next.state = "awaiting_choice"; next.failure!.deadline = this.now() + 60_000; });
        else if (s.current) this.begin(guildId, 0, undefined, true);
        else this.advance(guildId);
      } else throw new Error("Playback is already active. Use Retry or Repair if it is stuck.");
    });
  }
  private control(guildId: string, name: "pause" | "resume" | "seek", action: () => Promise<void>): void {
    const id = this.attemptId(guildId);
    this.background(action().catch(error => id ? this.event(guildId, { type: "failure", attemptId: id, reason: `Control: ${name} could not be confirmed (${safeError(error)})`, scope: "control", reconnect: true }) : Promise.reject(error)), guildId);
  }
  pause(guildId: string, expectedEntryId?: string): Promise<void> {
    return this.run(guildId, () => {
      this.assertCurrent(this.snapshot(guildId), expectedEntryId);
      if (this.snapshot(guildId).state !== "playing") throw new Error("Wait for playback to start before pausing.");
      this.commit(guildId, s => { s.state = "paused"; });
      this.attempts.get(guildId)!.disconnectedAt = undefined;
      this.control(guildId, "pause", () => this.backend.pause(guildId, true));
    });
  }
  seek(guildId: string, positionMs: number, expectedEntryId?: string): Promise<void> {
    return this.run(guildId, () => {
      const s = this.snapshot(guildId);
      this.assertCurrent(s, expectedEntryId);
      if (!s.current?.recording.isSeekable || s.current.recording.isStream || !["playing", "paused"].includes(s.state)) throw new Error("This track cannot be sought right now.");
      if (!Number.isFinite(positionMs) || positionMs < 0 || positionMs >= s.current.recording.durationMs) throw new Error("Choose a position within the song.");
      const reload = this.backend.requiresReloadForSeek?.(s.current.recording) ?? false;
      const next = this.commit(guildId, next => {
        next.positionMs = positionMs;
        if (reload) { next.resumePaused = next.state === "paused" || next.resumePaused; next.state = "starting"; next.failure = undefined; next.idleSince = undefined; }
      });
      if (reload) {
        // Lavaplayer 2.2.6 cannot initially seek Vorbis before its pipeline exists.
        // Prepare the same recording from the desired source position instead.
        this.cancel(guildId); this.background(this.backend.stop(guildId, false), guildId);
        this.launch(guildId, next); return;
      }
      const a = this.attempts.get(guildId)!; a.lastPosition = positionMs; a.lastProgressAt = this.now();
      this.control(guildId, "seek", () => this.backend.seek(guildId, positionMs));
    });
  }
  async setVolume(guildId: string, volume: number): Promise<void> {
    const request = await this.run(guildId, () => {
      if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new Error("Volume must be 0–100%.");
      const previous = this.snapshot(guildId);
      const generation = (this.volumeRequests.get(guildId) ?? 0) + 1;
      this.commit(guildId, s => { s.volume = volume; });
      this.volumeRequests.set(guildId, generation);
      return { previous: previous.volume, generation, attemptId: this.attemptId(guildId), entryId: previous.current?.id };
    });
    try { await this.backend.volume(guildId, volume); }
    catch (error) {
      const id = incident("volume_control_failed", { guildId, error: safeError(error) });
      await this.run(guildId, () => {
        if (this.volumeRequests.get(guildId) !== request.generation || this.attemptId(guildId) !== request.attemptId || this.snapshot(guildId).current?.id !== request.entryId) return;
        this.commit(guildId, s => { s.volume = request.previous; });
        this.backend.restoreVolumeIntent?.(guildId, volume, request.previous);
      });
      throw new Error(`The volume change could not be confirmed. Playback continues; try Volume again. Incident ${id}`);
    }
  }
  private assertCurrent(session: Session, expectedEntryId?: string | null): void {
    if ((expectedEntryId === null && session.current) || (expectedEntryId && session.current?.id !== expectedEntryId)) throw new Error("The song changed. Use the current playback panel.");
  }
  setLoop(guildId: string, loop: Session["loop"]): Promise<void> {
    return this.run(guildId, () => { if (!["off", "track", "queue"].includes(loop)) throw new Error("Unknown repeat mode."); this.commit(guildId, s => { s.loop = loop; }); });
  }
  setQueueMode(guildId: string, mode: QueueMode): Promise<void> {
    return this.run(guildId, () => {
      if (mode !== "fifo" && mode !== "fair") throw new Error("Choose FIFO or Fair queue mode.");
      if ((this.snapshot(guildId).queueMode ?? "fifo") === mode) return;
      this.commit(guildId, next => { next.queueMode = mode; next.fairRotation = []; this.scheduleQueue(next); });
    });
  }
  editQueue(guildId: string, revision: number, action: "move" | "remove" | "clear" | "shuffle", entryId?: string, position?: number): Promise<void> {
    return this.run(guildId, () => {
      const s = this.snapshot(guildId);
      if (s.revision !== revision) throw new Error("The queue changed. Refresh it and try again.");
      if (s.queueMode === "fair" && (action === "move" || action === "shuffle")) throw new Error("Manual moves and queue shuffling are disabled in Fair mode. A moderator can switch the queue to FIFO first.");
      if (action === "move" && (!Number.isInteger(position) || position! < 1 || position! > s.queue.length)) throw new Error("Choose a valid queue position.");
      const index = s.queue.findIndex(e => e.id === entryId);
      if (["move", "remove"].includes(action) && index < 0) throw new Error("That song is no longer queued. Refresh the queue.");
      this.commit(guildId, next => {
        if (action === "clear") next.queue = [];
        if (action === "remove") next.queue.splice(index, 1);
        if (action === "move") { const [entry] = next.queue.splice(index, 1); next.queue.splice(position! - 1, 0, entry); }
        if (action === "shuffle") for (let i = next.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [next.queue[i], next.queue[j]] = [next.queue[j], next.queue[i]]; }
        this.scheduleQueue(next);
      });
    });
  }
  setPanel(guildId: string, messageId: string): Promise<void> {
    return this.run(guildId, () => { this.commit(guildId, s => { s.panelMessageId = messageId; }); });
  }
  setPanelChannel(guildId: string, textChannelId: string): Promise<void> {
    return this.run(guildId, () => {
      const current = this.snapshot(guildId);
      if (current.textChannelId && current.textChannelId !== textChannelId && current.panelMessageId) throw new Error("The console is already in another channel. Open it with /music.");
      this.commit(guildId, s => { s.textChannelId = textChannelId; });
    });
  }
  chooseAlternative(guildId: string, failedEntryId: string, replacement: QueueEntry, voiceChannelId: string, textChannelId: string, signal?: AbortSignal, replaceOnly = false): Promise<void> {
    return this.run(guildId, () => {
      signal?.throwIfAborted();
      const session = this.snapshot(guildId);
      if (session.voiceChannelId && session.voiceChannelId !== voiceChannelId) throw new Error("Join the bot’s voice channel to choose an alternative.");
      const replaceNow = session.current?.id === failedEntryId;
      const queuedIndex = session.queue.findIndex(entry => entry.id === failedEntryId);
      if (replaceOnly && !replaceNow && queuedIndex === -1) throw new Error("That track has finished or left the queue. Open the current player and choose again.");
      if (session.queue.length >= 500 && !replaceNow && queuedIndex === -1) throw new Error("The queue is full.");
      const next = this.commit(guildId, s => {
        s.voiceChannelId = voiceChannelId; s.textChannelId ??= textChannelId;
        if (replaceNow) { this.archive(s, s.failure && failureScope(s.failure.reason, s.failure.scope) === "recording" ? "failed" : "skipped"); s.current = replacement; s.positionMs = 0; s.failure = undefined; s.resumePaused = false; s.state = "starting"; s.idleSince = undefined; }
        else if (queuedIndex !== -1) s.queue[queuedIndex] = replacement;
        else s.queue.push(replacement);
        this.scheduleQueue(s);
      });
      if (replaceNow) { this.cancel(guildId); this.background(this.backend.stop(guildId, false), guildId); this.launch(guildId, next); }
      else if (!session.current && session.state !== "suspended") this.advance(guildId);
    });
  }
  suspend(guildId: string): Promise<void> {
    return this.run(guildId, () => { this.commit(guildId, s => { s.resumePaused = s.state === "paused" || s.resumePaused; s.state = s.current || s.queue.length ? "suspended" : "idle"; }); this.cancel(guildId); });
  }
  externalVoiceChange(guildId: string, channelId?: string): Promise<void> {
    return this.run(guildId, () => {
      const before = this.snapshot(guildId);
      if (channelId && before.voiceChannelId === channelId) return;
      const restart = Boolean(channelId && before.current && ["starting", "recovering"].includes(before.state));
      const next = this.commit(guildId, s => {
        s.voiceChannelId = channelId;
        if (!channelId) {
          s.resumePaused = s.state === "paused" || s.resumePaused;
          s.state = s.current || s.queue.length ? "suspended" : "idle";
          s.failure = s.current || s.queue.length ? { scope: "environment", reason: "Voice: the connection was removed. Use Resume from your voice channel when you want music again.", incidentId: incident("voice_connection_removed", { guildId }) } : undefined;
        } else if (restart) { s.state = "starting"; s.failure = undefined; s.idleSince = undefined; }
      });
      if (!channelId) { this.cancel(guildId); this.background(this.backend.stop(guildId, true), guildId); }
      else if (restart) { this.cancel(guildId); this.background(this.backend.stop(guildId, false), guildId); this.launch(guildId, next); }
    });
  }
  async disconnectPreservingQueue(guildId: string): Promise<void> {
    await this.suspend(guildId);
    await this.backend.stop(guildId, true);
  }
}
