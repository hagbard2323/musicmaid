import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { newSession, type Session, type SearchSource } from "../audio/model.js";
import { musicSchemaSql, musicSchemaVersion } from "./schema.js";
import type { MusicStorage } from "./types.js";
import { SqliteLibrary } from "./library.js";
import { assertGuildScope } from "../config/guild-scope.js";

function storageError(error: unknown): unknown {
  const sqlite = error as { code?: string; errcode?: number } | null;
  if (sqlite?.code === "ERR_SQLITE_ERROR" && typeof sqlite.errcode === "number" && [5, 6].includes(sqlite.errcode & 0xff)) return new Error("Music storage is busy. Your change was not saved; retry the action shortly.");
  return error;
}

export class SqliteMusicStorage implements MusicStorage {
  private readonly db: DatabaseSync;
  private readonly guildId?: string;
  readonly library: SqliteLibrary;
  constructor(path: string, options: { guildId?: string } = {}) {
    this.guildId = options.guildId;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.library = new SqliteLibrary(this.db);
    // DatabaseSync waits on the event loop. Bound lock contention well below
    // Discord's interaction deadline; this does not bound a slow filesystem/fsync.
    this.db.exec("PRAGMA busy_timeout=200; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version > musicSchemaVersion) { this.db.close(); throw new Error(`Music database schema ${version} is newer than this bot supports. Restore the matching release.`); }
    if (version < musicSchemaVersion) {
      const populated = Number((this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number }).n) > 0;
      if (populated && path !== ":memory:") this.db.prepare("VACUUM INTO ?").run(`${path}.before-v${musicSchemaVersion}-${Date.now()}.sqlite`);
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        this.db.exec(musicSchemaSql);
        if (version < 2) this.migrateLegacy();
        for (const session of this.loadSessions()) this.library.recordSession(session);
        this.db.exec(`PRAGMA user_version=${musicSchemaVersion}; COMMIT;`);
      } catch (error) { this.db.exec("ROLLBACK;"); this.db.close(); throw error; }
    }
  }
  private migrateLegacy(): void {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE name='queued_tracks'").get()) return;
    const rows = (this.guildId === undefined ? this.db.prepare("SELECT * FROM queued_tracks ORDER BY guild_id, position").all()
      : this.db.prepare("SELECT * FROM queued_tracks WHERE guild_id=? ORDER BY position").all(this.guildId)) as unknown as Array<{
      guild_id: string; title: string; author: string; uri: string; source_name: string; requested_by_user_id?: string;
    }>;
    const sessions = new Map<string, Session>();
    for (const row of rows) {
      if (!row.uri || !["youtube", "soundcloud"].includes(row.source_name)) continue;
      const session = sessions.get(row.guild_id) ?? newSession(row.guild_id);
      session.state = "suspended";
      session.queue.push({ id: randomUUID(), addedAt: Date.now(), request: {
        query: row.uri, source: row.source_name as SearchSource, requestedBy: row.requested_by_user_id ?? "unknown"
      }, recording: { identifier: row.uri, uri: row.uri, title: row.title, author: row.author ?? "", source: row.source_name as "youtube" | "soundcloud", durationMs: 0, isStream: false, isSeekable: true } });
      sessions.set(row.guild_id, session);
    }
    for (const session of sessions.values()) {
      if (!this.db.prepare("SELECT guild_id FROM music_sessions WHERE guild_id=?").get(session.guildId)) this.writeSession(session);
    }
  }
  loadSessions(guildId = this.guildId): Session[] {
    assertGuildScope(guildId, this.guildId);
    const rows = guildId === undefined ? this.db.prepare("SELECT guild_id, snapshot FROM music_sessions").all()
      : this.db.prepare("SELECT guild_id, snapshot FROM music_sessions WHERE guild_id=?").all(guildId);
    return rows.map((row) => {
      const session = JSON.parse(row.snapshot as string) as Session;
      if (!session.guildId || session.guildId !== row.guild_id || !Array.isArray(session.queue) || !Array.isArray(session.history)) throw new Error("Invalid music session snapshot. Restore the database backup.");
      return session;
    });
  }
  saveSession(session: Session): void {
    assertGuildScope(session.guildId, this.guildId);
    let began = false;
    try { this.db.exec("BEGIN IMMEDIATE"); began = true; this.writeSession(session); this.library.recordSession(session); this.db.exec("COMMIT"); }
    catch (error) {
      if (began) { try { this.db.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back a failed transaction; retain its original error. */ } }
      throw storageError(error);
    }
  }
  private writeSession(session: Session): void {
    this.db.prepare("INSERT INTO music_sessions VALUES (?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET snapshot=excluded.snapshot, updated_at=excluded.updated_at")
      .run(session.guildId, JSON.stringify(session), Date.now());
  }
  getValue(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM music_values WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }
  setValue(key: string, value: string): void {
    try { this.db.prepare("INSERT INTO music_values VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
    catch (error) { throw storageError(error); }
  }
  close(): void { this.db.close(); }
}
