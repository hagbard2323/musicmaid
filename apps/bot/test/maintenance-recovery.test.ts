import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import type { Client } from "discord.js";
import { MusicController } from "../src/commands/music.js";
import { MusicCoordinator, type PlaybackBackend } from "../src/audio/coordinator.js";
import { entryFor, type Session } from "../src/audio/model.js";
import { env } from "../src/config/env.js";
import type { MusicStorage } from "../src/storage/types.js";
import { spotifyPlaylist } from "../src/audio/spotify-playlists.js";
import { searchSpotifyMetadata } from "../src/audio/spotify.js";
import { rateLimited, sourceRetryAt } from "../src/audio/source-errors.js";

class MemoryStore implements MusicStorage {
  sessions = new Map<string, Session>(); fail = false;
  loadSessions() { return [...this.sessions.values()].map(s => structuredClone(s)); }
  saveSession(s: Session) { if (this.fail) throw new Error("disk full"); this.sessions.set(s.guildId, structuredClone(s)); }
  getValue() { return undefined; } setValue() {} close() {}
}
async function repairFixture() {
  const store = new MemoryStore();
  const starts: Array<{ session: Session; signal: AbortSignal }> = [];
  let disconnect: () => Promise<void> = async () => {};
  // Model the real backend's per-guild voice-operation queue. A timed-out
  // cleanup must finish before a replacement can enter voice playback.
  let pending: Promise<unknown> = Promise.resolve();
  const serial = (action: () => Promise<void>) => { const work = pending.then(action, action); pending = work.catch(() => {}); return work; };
  const backend: PlaybackBackend = {
    start: async (session, _id, signal) => serial(async () => { starts.push({ session, signal }); }),
    stop: async (_guild, leave) => serial(async () => { if (leave) await disconnect(); }),
    pause: async () => {}, seek: async () => {}, volume: async () => {}
  };
  const music = new MusicCoordinator(store, backend);
  for (const title of ["Current", "Next"]) await music.enqueue("g", entryFor({ query: title, requestedBy: "u", source: "youtube" }, {
    identifier: "2I3PLVuKNtw", uri: "https://www.youtube.com/watch?v=2I3PLVuKNtw", title, author: "Artist", source: "youtube", durationMs: 200000, isStream: false, isSeekable: true
  }), "voice", "text");
  await pending;
  const attemptId = music.attemptId("g")!;
  await music.event("g", { type: "start", attemptId });
  await music.event("g", { type: "update", attemptId, positionMs: 30000, time: Date.now(), connected: true });
  await music.pause("g");
  const replies: string[] = [];
  const controller = new MusicController({} as Client, music, async () => undefined, store);
  const interaction = { guildId: "g", guild: { members: { cache: new Map() } }, user: { id: "mod" }, memberPermissions: { has: () => true }, channelId: "text", options: { getSubcommand: () => "repair" }, editReply: async (value: string) => { replies.push(value); } };
  return { store, music, starts, controller, replies, repair: () => controller["admin"](interaction as never), setDisconnect: (work: typeof disconnect) => { disconnect = work; }, settled: () => pending };
}

test("YouTube repair retries the same paused recording after disconnect refusal and preserves the account file", async t => {
  t.mock.method(console, "info", () => {});
  const directory = await mkdtemp("/tmp/musicmaid-repair-"); const oldCookies = env.youtubeCookies;
  env.youtubeCookies = directory + "/cookies.txt";
  await writeFile(env.youtubeCookies, "fixture account session");
  await mkdir(directory + "/youtube-embedded-cache/youtube-sigfuncs", { recursive: true });
  await writeFile(directory + "/youtube-embedded-cache/youtube-sigfuncs/stale", "stale decoder");
  const h = await repairFixture(); const before = h.music.snapshot("g"); let disconnects = 0;
  h.setDisconnect(async () => { disconnects++; throw new Error("audio service unreachable"); });
  try {
    await h.repair(); await h.settled();
    assert.equal(disconnects, 1); assert.equal(h.starts.length, 2);
    assert.equal(h.starts[0].signal.aborted, true);
    assert.equal(h.starts[1].session.current?.id, before.current?.id);
    assert.equal(h.starts[1].session.positionMs, 30000); assert.equal(h.starts[1].session.resumePaused, true);
    assert.deepEqual(h.music.snapshot("g").queue, before.queue);
    assert.equal(await readFile(env.youtubeCookies, "utf8"), "fixture account session");
    await assert.rejects(access(directory + "/youtube-embedded-cache/youtube-sigfuncs"));
    assert.match(h.replies[0], /retrying its selected upload/);
  } finally { h.controller.close(); env.youtubeCookies = oldCookies; await rm(directory, { recursive: true, force: true }); }
});

test("repair refuses to disconnect or retry when the initial durable suspension fails", async t => {
  t.mock.method(console, "info", () => {});
  const oldCookies = env.youtubeCookies; env.youtubeCookies = "/tmp/musicmaid-test-unused/cookies.txt";
  const h = await repairFixture(); const before = h.music.snapshot("g"); let disconnects = 0;
  h.setDisconnect(async () => { disconnects++; }); h.store.fail = true;
  try {
    await assert.rejects(h.repair(), /disk full/);
    assert.equal(disconnects, 0); assert.equal(h.starts.length, 1); assert.equal(h.starts[0].signal.aborted, false);
    assert.deepEqual(h.music.snapshot("g"), before);
  } finally { h.controller.close(); env.youtubeCookies = oldCookies; }
});

test("repair bounds cleanup without overlapping a pending voice disconnect with its replacement", async t => {
  t.mock.method(console, "info", () => {});
  const directory = await mkdtemp("/tmp/musicmaid-repair-timeout-"); const oldCookies = env.youtubeCookies;
  env.youtubeCookies = directory + "/cookies.txt";
  const h = await repairFixture(); let release!: () => void, started!: () => void;
  const disconnectStarted = new Promise<void>(resolve => { started = resolve; });
  h.setDisconnect(() => { started(); return new Promise<void>(resolve => { release = resolve; }); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const repair = h.repair(); await disconnectStarted;
    t.mock.timers.tick(10000); await repair;
    assert.equal(h.starts.length, 1, "replacement voice start waits behind old disconnect");
    assert.equal(h.starts[0].signal.aborted, true);
    assert.equal(h.music.snapshot("g").state, "starting");
    release(); await h.settled(); assert.equal(h.starts.length, 2);
  } finally { release?.(); h.controller.close(); env.youtubeCookies = oldCookies; t.mock.timers.reset(); await rm(directory, { recursive: true, force: true }); }
});

test("playlist and metadata requests share Spotify backoff, including playlist token refresh limits", async t => {
  const directory = await mkdtemp("/tmp/musicmaid-playlist-backoff-");
  const before = [env.spotifyClientId, env.spotifyClientSecret, env.spotifyUserTokenFile] as const;
  env.spotifyClientId = "fixture-backoff"; env.spotifyClientSecret = "fixture"; env.spotifyUserTokenFile = directory + "/auth.json";
  await writeFile(env.spotifyUserTokenFile, JSON.stringify({ refresh_token: "fixture" }), { mode: 0o600 });
  const input = "https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL";
  let tokenCalls = 0, apiCalls = 0, limitedToken = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    if (String(input).includes("/api/token")) {
      tokenCalls++;
      return limitedToken ? new Response(null, { status: 429, headers: { "retry-after": "3600" } }) : Response.json({ access_token: "fixture", expires_in: 3600 });
    }
    apiCalls++; return new Response(null, { status: 429, headers: { "retry-after": "3600" } });
  });
  const clearBackoff = () => { sourceRetryAt("spotify", Date.now() + 86400001); };
  try {
    clearBackoff();
    for (let n = 0; n < 4; n++) await assert.rejects(spotifyPlaylist(input, 1, new AbortController().signal), /rate-limiting|cooling down/);
    assert.equal(apiCalls, 1); assert.equal(tokenCalls, 1);
    await assert.rejects(searchSpotifyMetadata("Artist Song"), /cooling down/); assert.equal(apiCalls, 1);
    clearBackoff(); rateLimited("spotify", "3600");
    await assert.rejects(spotifyPlaylist(input, 1, new AbortController().signal), /cooling down/); assert.equal(apiCalls, 1);
    clearBackoff(); limitedToken = true;
    env.spotifyUserTokenFile = directory + "/new-auth.json";
    await writeFile(env.spotifyUserTokenFile, JSON.stringify({ refresh_token: "fixture-new" }), { mode: 0o600 });
    for (let n = 0; n < 3; n++) await assert.rejects(spotifyPlaylist(input, 1, new AbortController().signal), /rate-limiting|cooling down/);
    assert.equal(tokenCalls, 2); assert.equal(apiCalls, 1);
  } finally { clearBackoff(); [env.spotifyClientId, env.spotifyClientSecret, env.spotifyUserTokenFile] = before; await rm(directory, { recursive: true, force: true }); }
});
