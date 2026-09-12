import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ChannelType, Collection, PermissionsBitField, PermissionFlagsBits, type Client } from "discord.js";
import { LoadType, type Shoukaku, type Track } from "shoukaku";
import { LavalinkBackend } from "../src/audio/player-service.js";
import { newSession, entryFor, type PlaybackEvent } from "../src/audio/model.js";
import { recordingFor } from "../src/audio/sources.js";
import { env } from "../src/config/env.js";
import { parseSpotifyReference, resolveSpotifyTrackMetadata } from "../src/audio/spotify.js";

const track: Track = { encoded: "encoded", info: { identifier: "bubbles", uri: "https://soundcloud.com/yosi-horikawa/bubbles", title: "Bubbles", author: "Yosi Horikawa", length: 347508, sourceName: "soundcloud", position: 0, isSeekable: true, isStream: false }, pluginInfo: {} };
class FakePlayer extends EventEmitter {
  guildId = "g"; plays: Array<{ track: { userData: { attemptId: string } }; position: number; volume: number }> = []; stops = 0;
  async playTrack(options: typeof this.plays[number]) { this.plays.push(options); }
  async stopTrack() { this.stops++; }
  async setPaused() {} async setGlobalVolume() {} async seekTo() {}
}
function backendFixture() {
  const player = new FakePlayer();
  let resolve: (id: string) => Promise<{ loadType: LoadType.TRACK; data: Track }> = async () => ({ loadType: LoadType.TRACK, data: track });
  const gateway = { nodes: new Map([["node", { state: 1, rest: { resolve: (id: string) => resolve(id) } }]]), players: new Map([["g", player]]), connections: new Map([["g", { channelId: "voice" }]]), leaveVoiceChannel: async () => {}, joinVoiceChannel: async () => player } as unknown as Shoukaku;
  const permissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]);
  const channel = { name: "movies", type: ChannelType.GuildVoice, userLimit: 0, isVoiceBased: () => true, permissionsFor: () => permissions };
  const guild = { shardId: 0, channels: { cache: new Map([["voice", channel]]) }, members: { me: { id: "bot", voice: { channelId: "voice", serverMute: false } } }, voiceStates: { cache: new Collection([["u", { id: "u", channelId: "voice" }]]) } };
  const client = { guilds: { cache: new Map([["g", guild]]) } } as unknown as Client;
  const backend = new LavalinkBackend(client, () => gateway, () => {});
  const events: PlaybackEvent[] = []; backend.onEvent = (_guild, event) => { events.push(event); };
  const session = newSession("g"); session.voiceChannelId = "voice"; session.current = entryFor({ query: "Bubbles", source: "auto", requestedBy: "u" }, recordingFor(track)); session.positionMs = 30000;
  return { player, backend, events, session, permissions, channel, setResolve: (next: typeof resolve) => { resolve = next; } };
}
test("missing View Channel fails before resolving audio even when Connect and Speak are allowed", async () => {
  const h = backendFixture(); let loads = 0;
  h.permissions.remove(PermissionFlagsBits.ViewChannel);
  h.setResolve(async () => { loads++; return { loadType: LoadType.TRACK, data: track }; });
  await assert.rejects(h.backend.start(h.session, "no-view", new AbortController().signal, false), /Voice:.*View Channel.*movies/);
  assert.equal(loads, 0); assert.equal(h.player.plays.length, 0);
});
test("a remix discovered during final resolution cannot silently replace the requested version", async () => {
  const h = backendFixture();
  h.setResolve(async () => ({ loadType: LoadType.TRACK, data: { ...track, info: { ...track.info, title: "Bubbles (Someone remix)" } } }));
  await assert.rejects(h.backend.start(h.session, "changed-version", new AbortController().signal, false), /Version mismatch:.*remix/);
  assert.equal(h.player.plays.length, 0);
});
test("backend tags actual Lavalink requests and rejects late/untagged events", async () => {
  const h = backendFixture(); await h.backend.start(h.session, "attempt-one", new AbortController().signal, false);
  assert.equal(h.player.plays[0].track.userData.attemptId, "attempt-one"); assert.equal(h.player.plays[0].position, 30000);
  const tagged = { ...track, userData: { attemptId: "attempt-one" } };
  h.player.emit("start", { track: tagged }); h.player.emit("update", { state: { connected: true, position: 35000, time: Date.now() } });
  await h.backend.start(h.session, "attempt-two", new AbortController().signal, false);
  h.player.emit("exception", { track: tagged, exception: { message: "Old error", cause: "404" } });
  h.player.emit("end", { track: tagged, reason: "loadFailed" });
  h.player.emit("exception", { exception: { message: "Unidentifiable", cause: "404" } });
  assert.deepEqual(h.events.map(e => e.type), ["start", "update"]);
  h.player.emit("start", { track: { ...track, userData: { attemptId: "attempt-two" } } });
  h.player.emit("end", { track: { ...track, userData: { attemptId: "attempt-two" } }, reason: "finished" });
  assert.deepEqual(h.events.map(e => e.type), ["start", "update", "start", "end"]);
});
test("cancelled resolution cannot issue a late playback request", async () => {
  const h = backendFixture(); let finish!: (result: { loadType: LoadType.TRACK; data: Track }) => void;
  h.setResolve(() => new Promise(resolve => { finish = resolve; }));
  const abort = new AbortController(); const promise = h.backend.start(h.session, "cancelled", abort.signal, false);
  abort.abort(); finish({ loadType: LoadType.TRACK, data: track });
  await assert.rejects(promise, /abort/i); assert.equal(h.player.plays.length, 0);
});
test("stop detaches player bindings so orphan events cannot affect a session", async () => {
  const h = backendFixture(); await h.backend.start(h.session, "attempt", new AbortController().signal, false); await h.backend.stop("g", false);
  h.player.emit("end", { track: { ...track, userData: { attemptId: "attempt" } }, reason: "stopped" });
  assert.equal(h.events.length, 0); assert.equal(h.player.listenerCount("end"), 0);
});
test("volume changed during slow resolution is applied to the eventual playback request", async () => {
  const h = backendFixture(); let finish!: (result: { loadType: LoadType.TRACK; data: Track }) => void;
  h.setResolve(() => new Promise(resolve => { finish = resolve; }));
  const start = h.backend.start(h.session, "attempt", new AbortController().signal, false);
  await h.backend.volume("g", 25); finish({ loadType: LoadType.TRACK, data: track }); await start;
  assert.equal(h.player.plays[0].volume, 25);
});
test("Spotify full, locale, wrapped and URI track references parse consistently", () => {
  const id = "0fahUDIRujvV16hAQNtWha";
  for (const url of [`spotify:track:${id}`, `https://open.spotify.com/intl-de/track/${id}?si=share`, `<https://open.spotify.com/track/${id}>`]) assert.deepEqual(parseSpotifyReference(url), { type: "track", id });
  assert.deepEqual(parseSpotifyReference("https://open.spotify.com/playlist/abc"), { type: "unsupported", itemType: "playlist" });
});
test("Spotify coalesces tokens, refreshes a 401 once, preserves duration/ISRC and explains 429", async t => {
  const { sourceRetryAt } = await import("../src/audio/source-errors.js");
  t.after(() => { sourceRetryAt("spotify", Date.now() + 13000); });
  const originalId = env.spotifyClientId; const originalSecret = env.spotifyClientSecret;
  env.spotifyClientId = "fixture"; env.spotifyClientSecret = "fixture";
  let tokens = 0; let fail401 = false; let rateLimited = false;
  const id = "0fahUDIRujvV16hAQNtWha";
  t.mock.method(globalThis, "fetch", async (input: URL | string) => {
    const url = String(input);
    if (url.includes("api/token")) { tokens++; return Response.json({ access_token: "fixture-token-" + tokens, expires_in: 3600 }); }
    if (rateLimited) return new Response(null, { status: 429, headers: { "retry-after": "12" } });
    if (fail401) { fail401 = false; return new Response(null, { status: 401 }); }
    return Response.json({ id, name: "Bubbles", artists: [{ name: "Yosi Horikawa" }], duration_ms: 347508, external_ids: { isrc: "GBTEST1234567" }, external_urls: { spotify: `https://open.spotify.com/track/${id}` } });
  });
  try {
    const results = await Promise.all([resolveSpotifyTrackMetadata(`spotify:track:${id}`), resolveSpotifyTrackMetadata(`spotify:track:${id}`)]);
    assert.equal(tokens, 1); assert.equal(results[0]?.durationMs, 347508); assert.equal(results[0]?.isrc, "GBTEST1234567");
    fail401 = true; await resolveSpotifyTrackMetadata(`spotify:track:${id}`); assert.equal(tokens, 2);
    rateLimited = true; await assert.rejects(resolveSpotifyTrackMetadata(`spotify:track:${id}`), /12 seconds/);
  } finally { env.spotifyClientId = originalId; env.spotifyClientSecret = originalSecret; }
});
test("Spotify short links cannot redirect to local/internal addresses", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:2333/v4/stats" } }));
  await assert.rejects(resolveSpotifyTrackMetadata("https://spotify.link/example"), /unsupported address/);
});

test('Spotify source offsets map to the full timeline while Lavalink starts at zero', async () => {
  const h = backendFixture(); const id = '0NTMtAO2BV4tnGvw9EgBVq';
  const original: Track = { encoded: 'private-tail', info: { ...track.info, identifier: id, uri: 'https://open.spotify.com/track/' + id, sourceName: 'spotify', length: 219305 }, pluginInfo: { spotifyOffsetMs: 120054 } };
  h.session.current = entryFor({ query: original.info.uri!, source: 'spotify', requestedBy: 'u' }, recordingFor(original)); h.session.positionMs = 120000;
  h.backend['resolve'] = async (_uri, _signal, position) => { assert.equal(position, 120000); return { loadType: LoadType.TRACK, data: original }; };
  await h.backend.start(h.session, 'spotify-offset', new AbortController().signal, false);
  assert.equal(h.player.plays[0].position, 0);
  h.player.emit('start', { track: { ...original, userData: { attemptId: 'spotify-offset' } } });
  h.player.emit('update', { state: { connected: true, position: 5000, time: Date.now() } });
  const update = h.events.find(e => e.type === 'update'); assert.equal(update?.type === 'update' ? update.positionMs : undefined, 125054);
});
