import { randomUUID } from "node:crypto";

export type RecordingSource = "youtube" | "soundcloud" | "spotify";
export type SearchSource = "auto" | RecordingSource;
export function sourceLabel(source: RecordingSource): string { return { youtube: "YouTube", soundcloud: "SoundCloud", spotify: "Spotify" }[source]; }
export type Recording = {
  identifier: string;
  uri: string;
  title: string;
  author: string;
  artists?: string[];
  source: RecordingSource;
  durationMs: number;
  isStream: boolean;
  isSeekable: boolean;
  artworkUrl?: string;
  isrc?: string;
  explicit?: boolean;
  channelVerified?: boolean;
  audioQuality?: { codec: string; bitrateKbps?: number; sampleRateHz?: number };
};
export type MusicRequest = {
  query: string;
  source: SearchSource;
  sources?: RecordingSource[];
  requestedBy: string;
  spotify?: { id: string; title: string; artists: string[]; durationMs?: number; isrc?: string; url?: string };
};
export type QueueEntry = { id: string; request: MusicRequest; recording: Recording; addedAt: number; requestId?: string };
export type HistoryEntry = {
  id: string;
  entry: QueueEntry;
  outcome: "finished" | "skipped" | "failed";
  at: number;
  reason?: string;
  incidentId?: string;
};
export type PlaybackState = "idle" | "starting" | "playing" | "paused" | "recovering" | "awaiting_choice" | "suspended";
export type FailureScope = "recording" | "environment" | "control";
export type QueueMode = "fifo" | "fair";
export type Session = {
  guildId: string;
  revision: number;
  voiceChannelId?: string;
  textChannelId?: string;
  panelMessageId?: string;
  state: PlaybackState;
  current?: QueueEntry;
  queue: QueueEntry[];
  /** Missing fields in pre-fair-queue snapshots mean FIFO. */
  queueMode?: QueueMode;
  /** Requesters waiting for their next turn; stored with the visible queue. */
  fairRotation?: string[];
  history: HistoryEntry[];
  positionMs: number;
  positionUpdatedAt?: number;
  volume: number;
  loop: "off" | "track" | "queue";
  failure?: { reason: string; incidentId: string; scope?: FailureScope; deadline?: number };
  idleSince?: number;
  lastVerifiedAt?: number;
  lastCompletedAt?: number;
  resumePaused?: boolean;
};
export type PlaybackEvent =
  | { type: "start"; attemptId: string; recording?: Recording }
  | { type: "end"; attemptId: string; reason: string }
  | { type: "failure"; attemptId: string; reason: string; reconnect?: boolean; scope?: FailureScope }
  | { type: "update"; attemptId: string; positionMs: number; connected: boolean; time: number };
export function newSession(guildId: string): Session {
  return { guildId, revision: 0, state: "idle", queue: [], queueMode: "fifo", fairRotation: [], history: [], positionMs: 0, volume: 100, loop: "off" };
}
export function entryFor(request: MusicRequest, recording: Recording, now = Date.now()): QueueEntry {
  return { id: randomUUID(), request, recording, addedAt: now };
}
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
