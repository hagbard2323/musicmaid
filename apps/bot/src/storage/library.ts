import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { youtubeVideoId } from "../audio/youtube.js";
import type { QueueEntry, Session } from "../audio/model.js";

export type SavedPlaylist = { id: string; guildId: string; name: string; creatorId: string; revision: number; createdAt: number; updatedAt: number; entries: QueueEntry[] };
export type MusicStats = { requests: number; played: number; finished: number; failed: number; since?: number;
  tracks: { title: string; author: string; uri: string; count: number }[];
  members: { id: string; count: number; played: number }[]; genres: { name: string; count: number }[]; tagged: number };
export interface LibraryStorage {
  list(guildId: string): SavedPlaylist[];
  get(guildId: string, id: string): SavedPlaylist;
  create(guildId: string, creatorId: string, name: string, entries?: QueueEntry[]): SavedPlaylist;
  update(guildId: string, id: string, revision: number, actor: string, mod: boolean, change: (list: SavedPlaylist) => void): SavedPlaylist;
  delete(guildId: string, id: string, revision: number, actor: string, mod: boolean): void;
  stats(guildId: string, since: number): MusicStats;
  tag(guildId: string, uri: string, genres: string[], actor: string): void;
}
function validUri(input: string): boolean {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    return (url.hostname === 'open.spotify.com' && /^\/track\/[A-Za-z0-9]{22}$/.test(url.pathname)) || Boolean(youtubeVideoId(input)) || (['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'].includes(url.hostname) && url.pathname.split('/').filter(Boolean).length >= 2);
  } catch { return false; }
}
function validate(list: SavedPlaylist): void {
  list.name = list.name.trim();
  if (!list.name || list.name.length > 60 || /[\r\n\x00-\x1f]/.test(list.name)) throw new Error("Use a playlist name between 1 and 60 characters on one line.");
  if (list.entries.length > 500) throw new Error("A saved playlist can contain at most 500 tracks.");
  for (const item of list.entries) {
    if (!item.id || !item.request?.requestedBy || !item.recording?.identifier || !validUri(item.recording.uri)) throw new Error("A playlist entry is missing its selected recording.");
  }
}
const key = (name: string) => name.normalize("NFKC").toLocaleLowerCase("en");
export class SqliteLibrary implements LibraryStorage {
  constructor(private db: DatabaseSync) {}
  list(guildId: string): SavedPlaylist[] {
    return this.db.prepare("SELECT snapshot FROM music_playlists WHERE guild_id=? ORDER BY name_key").all(guildId).map(row => JSON.parse(row.snapshot as string));
  }
  get(guildId: string, id: string): SavedPlaylist {
    const row = this.db.prepare("SELECT snapshot FROM music_playlists WHERE guild_id=? AND id=?").get(guildId, id);
    if (!row) throw new Error("That playlist no longer exists in this server.");
    return JSON.parse(row.snapshot as string);
  }
  create(guildId: string, creatorId: string, name: string, entries: QueueEntry[] = []): SavedPlaylist {
    if (this.list(guildId).length >= 50) throw new Error("This server has reached its limit of 50 playlists.");
    const now = Date.now();
    const list = { id: randomUUID(), guildId, creatorId, name, revision: 0, createdAt: now, updatedAt: now, entries: structuredClone(entries).map(e => ({ ...e, id: randomUUID() })) };
    validate(list); this.unique(list);
    this.db.prepare("INSERT INTO music_playlists VALUES (?, ?, ?, ?, ?, ?)").run(guildId, list.id, key(list.name), creatorId, 0, JSON.stringify(list));
    return list;
  }
  private unique(list: SavedPlaylist): void {
    if (this.db.prepare("SELECT id FROM music_playlists WHERE guild_id=? AND name_key=? AND id<>?").get(list.guildId, key(list.name), list.id)) throw new Error("A playlist with that name already exists. Choose another name.");
  }
  private editable(list: SavedPlaylist, revision: number, actor: string, mod: boolean): void {
    if (list.creatorId !== actor && !mod) throw new Error("Only this playlist's creator or a moderator can edit it.");
    if (list.revision !== revision) throw new Error("This playlist changed. Reopen it before editing.");
  }
  update(guildId: string, id: string, revision: number, actor: string, mod: boolean, change: (list: SavedPlaylist) => void): SavedPlaylist {
    const list = this.get(guildId, id); this.editable(list, revision, actor, mod); change(list);
    validate(list); this.unique(list); list.revision++; list.updatedAt = Date.now();
    const result = this.db.prepare("UPDATE music_playlists SET name_key=?, revision=?, snapshot=? WHERE guild_id=? AND id=? AND revision=?")
      .run(key(list.name), list.revision, JSON.stringify(list), guildId, id, revision);
    if (!result.changes) throw new Error("This playlist changed. Reopen it before editing.");
    return list;
  }
  delete(guildId: string, id: string, revision: number, actor: string, mod: boolean): void {
    this.editable(this.get(guildId, id), revision, actor, mod);
    if (!this.db.prepare("DELETE FROM music_playlists WHERE guild_id=? AND id=? AND revision=?").run(guildId, id, revision).changes) throw new Error("This playlist changed. Reopen it before deleting.");
  }
  /** Called inside the session transaction. Retries/restarts never count a request twice. */
  recordSession(session: Session): void {
    const entries = new Map(session.history.map(h => [h.entry.id, h.entry]));
    for (const e of session.queue) entries.set(e.id, e);
    if (session.current) entries.set(session.current.id, session.current);
    const write = this.db.prepare(`INSERT INTO music_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, entry_id) DO UPDATE SET title=excluded.title, author=excluded.author, uri=excluded.uri,
      played=max(played,excluded.played), finished=max(finished,excluded.finished), failed=max(failed,excluded.failed)
      WHERE title<>excluded.title OR author<>excluded.author OR uri<>excluded.uri OR played<excluded.played OR finished<excluded.finished OR failed<excluded.failed`);
    const histories = new Map(session.history.map(h => [h.entry.id, h]));
    for (const e of entries.values()) {
      const outcome = histories.get(e.id)?.outcome;
      const played = outcome === "finished" || (session.current?.id === e.id && ["playing", "paused"].includes(session.state));
      write.run(session.guildId, e.id, e.request.requestedBy, e.addedAt, e.recording.title, e.recording.author, e.recording.uri, +played, +(outcome === "finished"), +(outcome === "failed"), e.requestId ? 0 : 1);
    }
  }
  tag(guildId: string, uri: string, genres: string[], actor: string): void {
    if (!validUri(uri)) throw new Error("Invalid recording.");
    const clean = [...new Set(genres.map(g => g.trim().toLocaleLowerCase("en")).filter(Boolean))];
    if (clean.length > 3 || clean.some(g => g.length > 32 || !/^[\p{L}\p{N}][\p{L}\p{N} &'’/+-]*$/u.test(g))) throw new Error("Enter up to three genres, each at most 32 characters, separated by commas.");
    this.db.prepare("INSERT INTO music_genres VALUES (?, ?, ?, ?, ?) ON CONFLICT(guild_id, uri) DO UPDATE SET genres=excluded.genres, actor=excluded.actor, updated_at=excluded.updated_at")
      .run(guildId, uri, JSON.stringify(clean), actor, Date.now());
  }
  stats(guildId: string, since: number): MusicStats {
    const totals = this.db.prepare("SELECT coalesce(sum(counted),0) AS requests, coalesce(sum(played),0) AS played, coalesce(sum(finished),0) AS finished, coalesce(sum(failed),0) AS failed, min(added_at) AS since FROM music_requests WHERE guild_id=? AND added_at>=? AND counted=1").get(guildId, since) as unknown as MusicStats;
    totals.tracks = this.db.prepare("SELECT title, author, uri, count(*) AS count FROM music_requests WHERE guild_id=? AND added_at>=? AND counted=1 AND played=1 GROUP BY uri ORDER BY count DESC, uri LIMIT 10").all(guildId, since) as unknown as MusicStats["tracks"];
    totals.members = this.db.prepare("SELECT requester AS id, sum(counted) AS count, sum(played) AS played FROM music_requests WHERE guild_id=? AND added_at>=? AND counted=1 GROUP BY requester ORDER BY count DESC, requester LIMIT 10").all(guildId, since) as unknown as MusicStats["members"];
    totals.genres = this.db.prepare("SELECT j.value AS name, count(*) AS count FROM music_requests r JOIN music_genres g ON g.guild_id=r.guild_id AND g.uri=r.uri, json_each(g.genres) j WHERE r.guild_id=? AND r.added_at>=? AND r.counted=1 AND r.played=1 GROUP BY j.value ORDER BY count DESC, name LIMIT 10").all(guildId, since) as unknown as MusicStats["genres"];
    totals.tagged = Number(this.db.prepare("SELECT count(*) AS n FROM music_requests r JOIN music_genres g ON g.guild_id=r.guild_id AND g.uri=r.uri WHERE r.guild_id=? AND r.added_at>=? AND r.counted=1 AND r.played=1 AND json_array_length(g.genres)>0").get(guildId, since)!.n);
    return totals;
  }
}
