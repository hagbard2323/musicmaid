import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Client, Interaction, REST } from "discord.js";
import { env, requireConfiguredGuildId } from "../src/config/env.js";
import { assertGuildScope, validateConfiguredGuildId } from "../src/config/guild-scope.js";
import { MusicCoordinator, type PlaybackBackend } from "../src/audio/coordinator.js";
import { newSession, entryFor, type Session } from "../src/audio/model.js";
import { SqliteMusicStorage } from "../src/storage/sqlite-storage.js";
import { MusicController } from "../src/commands/music.js";
import { registerCommands } from "../src/commands/register.js";
import { restoreConfiguredSession } from "../src/runtime/session-restore.js";
import { viewerReader } from "../src/video/bridge.js";
import type { MusicStorage } from "../src/storage/types.js";

const allowed = "123456789012345678", foreign = "987654321098765432";
function saved(guildId: string) {
  const s = newSession(guildId); s.state = "playing"; s.voiceChannelId = "voice-" + guildId; s.textChannelId = "text"; s.positionMs = 5000;
  s.current = entryFor({ query: "Bubbles", source: "soundcloud", requestedBy: "u" }, { identifier: guildId, uri: "https://soundcloud.com/fixture/" + guildId, title: "Bubbles", author: "Yosi Horikawa", source: "soundcloud", durationMs: 180000, isStream: false, isSeekable: true });
  return s;
}
function backendFixture() {
  const calls: Array<{ action: string; guild: string }> = [];
  const backend: PlaybackBackend = { start: async s => { calls.push({ action: "start", guild: s.guildId }); }, stop: async guild => { calls.push({ action: "stop", guild }); }, pause: async () => {}, seek: async () => {}, volume: async () => {} };
  return { backend, calls };
}
function listeningClient() {
  const channel = { isVoiceBased: () => true, members: { some: (predicate: (member: { user: { bot: boolean } }) => boolean) => predicate({ user: { bot: false } }) } };
  const guild = { channels: { cache: new Map([["voice-" + allowed, channel]]) } };
  return { isReady: () => true, guilds: { cache: new Map([[allowed, guild]]) } } as unknown as Client;
}

test("production scope validation refuses missing or malformed guild IDs", () => {
  for (const invalid of [undefined, null, "", "server-name", "123/456", "1e18"]) assert.throws(() => validateConfiguredGuildId(invalid), /DISCORD_GUILD_ID/);
  assert.equal(requireConfiguredGuildId(" " + allowed + " "), allowed);
  assert.doesNotThrow(() => assertGuildScope(allowed, allowed)); assert.throws(() => assertGuildScope(foreign, allowed), /configured server/);
});

test("production startup refuses an unset guild before creating a database or logging in", () => {
  const directory = mkdtempSync("/tmp/musicmaid-guild-startup-");
  try {
    const database = directory + "/must-not-exist/music.sqlite";
    const result = spawnSync(process.execPath, ["--import", "tsx", "apps/bot/src/index.ts"], {
      cwd: resolve("."), encoding: "utf8", timeout: 15000,
      env: { ...process.env, NODE_OPTIONS: "", DOTENV_CONFIG_PATH: directory + "/absent.env", DISCORD_TOKEN: "fixture", DISCORD_CLIENT_ID: allowed, DISCORD_GUILD_ID: "", MUSIC_DATABASE_PATH: database, NOTIFY_SOCKET: "" }
    });
    assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /DISCORD_GUILD_ID must identify/);
    assert.equal(existsSync(database), false); assert.doesNotMatch(result.stdout, /MusicMaid ready|Lavalink node/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("command registration requires a guild and never falls back to a global route", async t => {
  t.mock.method(console, "info", () => {});
  const previous = env.discordGuildId; const calls: string[] = [];
  const rest = { put: async (route: string) => { calls.push(route); } } as unknown as Pick<REST, "put">;
  try {
    env.discordGuildId = undefined; await assert.rejects(registerCommands({ rest }), /DISCORD_GUILD_ID/); assert.equal(calls.length, 0);
    await registerCommands({ guildId: allowed, rest });
    assert.equal(calls.length, 1); assert.ok(calls[0].endsWith("/guilds/" + allowed + "/commands"));
  } finally { env.discordGuildId = previous; }
});

test("scoped restore, ticks and maintenance preserve foreign SQLite snapshots and playlists", async t => {
  t.mock.method(console, "info", () => {});
  const directory = mkdtempSync("/tmp/musicmaid-guild-data-"); let storage: SqliteMusicStorage | undefined, inspect: DatabaseSync | undefined;
  try {
    const path = directory + "/music.sqlite"; storage = new SqliteMusicStorage(path);
    storage.saveSession(saved(allowed)); const untouched = saved(foreign); untouched.state = "awaiting_choice"; untouched.failure = { reason: "preview", incidentId: "old-incident", deadline: 1 }; storage.saveSession(untouched);
    storage.library.create(foreign, "foreign-owner", "Preserve foreign library", [untouched.current!]);
    inspect = new DatabaseSync(path);
    const snapshotBefore = inspect.prepare("SELECT * FROM music_sessions WHERE guild_id=?").get(foreign);
    const libraryBefore = inspect.prepare("SELECT * FROM music_playlists WHERE guild_id=?").all(foreign);
    const requestsBefore = inspect.prepare("SELECT * FROM music_requests WHERE guild_id=?").all(foreign);
    const h = backendFixture(); const music = new MusicCoordinator(storage, h.backend, { guildId: allowed });
    assert.deepEqual(music.all().map(s => s.guildId), [allowed]); assert.throws(() => music.snapshot(foreign), /configured server/);
    await restoreConfiguredSession(listeningClient(), music, allowed, () => {}); await music.tick();
    for (const session of music.all()) await music.disconnectPreservingQueue(session.guildId);
    await assert.rejects(music.stop(foreign), /configured server/);
    await assert.rejects(music.externalVoiceChange(foreign), /configured server/);
    await assert.rejects(music.enqueue(foreign, untouched.current!, "voice", "text"), /configured server/);
    assert.ok(h.calls.length > 0 && h.calls.every(call => call.guild === allowed));
    assert.deepEqual(inspect.prepare("SELECT * FROM music_sessions WHERE guild_id=?").get(foreign), snapshotBefore);
    assert.deepEqual(inspect.prepare("SELECT * FROM music_playlists WHERE guild_id=?").all(foreign), libraryBefore);
    assert.deepEqual(inspect.prepare("SELECT * FROM music_requests WHERE guild_id=?").all(foreign), requestsBefore);
  } finally { inspect?.close(); storage?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("foreign malformed or misleading snapshots cannot block scoped loading, including schema backfill", () => {
  const directory = mkdtempSync("/tmp/musicmaid-foreign-shape-"); let storage: SqliteMusicStorage | undefined, db: DatabaseSync | undefined;
  try {
    const path = directory + "/music.sqlite"; storage = new SqliteMusicStorage(path); storage.saveSession(saved(allowed)); storage.close(); storage = undefined;
    db = new DatabaseSync(path);
    const malformed = JSON.stringify({ guildId: foreign, queue: "foreign invalid shape", history: [] });
    const misleading = JSON.stringify(saved(allowed));
    db.prepare("INSERT INTO music_sessions VALUES (?,?,?)").run(foreign, malformed, 1);
    db.prepare("INSERT INTO music_sessions VALUES (?,?,?)").run("999999999999999999", misleading, 2);
    db.exec("PRAGMA user_version=2"); db.close(); db = undefined;
    storage = new SqliteMusicStorage(path, { guildId: allowed });
    const music = new MusicCoordinator(storage, backendFixture().backend, { guildId: allowed });
    assert.deepEqual(music.all().map(s => s.guildId), [allowed]); assert.equal(music.snapshot(allowed).current?.recording.identifier, allowed);
    assert.throws(() => storage!.loadSessions(foreign), /configured server/);
    assert.throws(() => storage!.saveSession(saved(foreign)), /configured server/);
    db = new DatabaseSync(path);
    assert.equal(db.prepare("SELECT snapshot FROM music_sessions WHERE guild_id=?").get(foreign)?.snapshot, malformed);
    assert.equal(db.prepare("SELECT snapshot FROM music_sessions WHERE guild_id=?").get("999999999999999999")?.snapshot, misleading);
  } finally { db?.close(); storage?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("scoped legacy queue migration leaves foreign raw rows untouched", () => {
  const directory = mkdtempSync("/tmp/musicmaid-foreign-legacy-"); let storage: SqliteMusicStorage | undefined;
  try {
    const path = directory + "/music.sqlite"; const db = new DatabaseSync(path);
    db.exec("CREATE TABLE queued_tracks(guild_id TEXT, position INTEGER, title TEXT, author TEXT, uri TEXT, source_name TEXT, requested_by_user_id TEXT)");
    for (const guild of [allowed, foreign]) db.prepare("INSERT INTO queued_tracks VALUES (?,1,'Song','Artist','https://soundcloud.com/fixture/song','soundcloud','u')").run(guild);
    const before = db.prepare("SELECT * FROM queued_tracks WHERE guild_id=?").all(foreign); db.close();
    storage = new SqliteMusicStorage(path, { guildId: allowed }); assert.deepEqual(storage.loadSessions().map(s => s.guildId), [allowed]);
    const inspect = new DatabaseSync(path);
    try { assert.deepEqual(inspect.prepare("SELECT * FROM queued_tracks WHERE guild_id=?").all(foreign), before); assert.equal(inspect.prepare("SELECT count(*) n FROM music_sessions WHERE guild_id=?").get(foreign)?.n, 0); }
    finally { inspect.close(); }
  } finally { storage?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("foreign play, library and moderator interactions are refused before session or source work", async t => {
  t.mock.method(console, "info", () => {});
  const music = { snapshot: () => { assert.fail("Foreign interaction must not read a session"); } } as unknown as MusicCoordinator;
  const controller = new MusicController({} as Client, music, async () => { assert.fail("No foreign source lookup"); }, {} as MusicStorage, async () => { assert.fail("No foreign restart"); }, allowed);
  const replies: string[] = [];
  try {
    for (const commandName of ["play", "playlist", "music-admin"]) {
      const i = { id: commandName, guildId: foreign, user: { id: "foreign-admin" }, guild: { get members() { return assert.fail("Do not inspect foreign roles"); } }, memberPermissions: { has: () => true }, commandName,
        isChatInputCommand: () => true, isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false,
        reply: async (message: { content: string }) => { replies.push(message.content); } };
      await controller.handle(i as unknown as Interaction);
    }
    assert.equal(replies.length, 3); assert.ok(replies.every(reply => reply.includes("configured server")));
    assert.equal(controller["seen"].size, 0);
  } finally { controller.close(); }
});

test("the scoped viewer and restoration preserve explicit pause and voice-removal holds", async t => {
  t.mock.method(console, "info", () => {});
  for (const hold of ["pause", "removed"] as const) {
    const session = saved(allowed); session.state = hold === "pause" ? "paused" : "suspended";
    if (hold === "removed") session.failure = { reason: "Voice: connection removed.", incidentId: "hold", scope: "environment" };
    const store = { loadSessions: () => [session], saveSession: () => { assert.fail("Held session must not be changed by automatic restore"); } } as unknown as MusicStorage;
    const h = backendFixture(), music = new MusicCoordinator(store, h.backend, { guildId: allowed });
    await restoreConfiguredSession(listeningClient(), music, allowed, () => {}); assert.equal(h.calls.length, 0);
    const read = viewerReader(listeningClient(), music);
    assert.throws(() => read({ guildId: foreign, userId: "foreign-user" }), /configured server/);
  }
});
