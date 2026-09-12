import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ChannelType, Collection, PermissionsBitField, PermissionFlagsBits, type Client } from "discord.js";
import { Connection, Connectors, Constants, LoadType, RestError, type LavalinkResponse, type Shoukaku, type Track } from "shoukaku";
import { LavalinkBackend } from "../src/audio/player-service.js";
import { MusicCoordinator } from "../src/audio/coordinator.js";
import { entryFor, newSession, type PlaybackEvent, type Session } from "../src/audio/model.js";
import { recordingFor, type Loader } from "../src/audio/sources.js";
import { failureScope, isRecordingFailure } from "../src/audio/diagnostics.js";
import type { YoutubeResolver } from "../src/audio/youtube.js";
import type { SpotifyOriginalAudio } from "../src/audio/spotify-direct.js";
import type { MusicStorage } from "../src/storage/types.js";

const track: Track = { encoded: "fixture", info: { identifier: "song", uri: "https://soundcloud.com/artist/song", title: "Song", author: "Artist", length: 180000, sourceName: "soundcloud", position: 0, isSeekable: true, isStream: false }, pluginInfo: {} };
class FakePlayer extends EventEmitter {
  guildId = "g";
  plays: Array<{ volume: number; track: { userData: { attemptId: string } } }> = [];
  async playTrack(options: typeof this.plays[number]) { this.plays.push(options); }
  async stopTrack() {} async setPaused() {} async seekTo() {} async setGlobalVolume(_volume: number) {}
}
const settle = async () => { for (let count = 0; count < 5; count++) await new Promise<void>(done => setImmediate(done)); };
function fixture() {
  let now = 1_000_000;
  const player = new FakePlayer(), joins: string[] = [], outbound: Array<string | null> = [];
  const permissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]);
  const channel = { name: "fixture", type: ChannelType.GuildVoice, userLimit: 0, isVoiceBased: () => true, permissionsFor: () => permissions };
  const guild = { shardId: 0, channels: { cache: new Map([["original", channel], ["moved", channel]]) }, members: { me: { id: "bot", voice: { channelId: "original" as string | null, serverMute: false } } }, voiceStates: { cache: new Collection() } };
  const client = { guilds: { cache: new Map([["g", guild]]) } } as unknown as Client;
  let resolve: Loader = async () => ({ loadType: LoadType.TRACK, data: track });
  const gateway = {
    id: "bot", emit: () => {}, connector: { sendPacket: (_shard: number, packet: { d: { channel_id: string | null } }) => { outbound.push(packet.d.channel_id); } },
    nodes: new Map([["node", { state: 1, rest: { resolve: (id: string) => resolve(id) } }]]),
    players: new Map([["g", player]]), connections: new Map<string, Connection>(),
    leaveVoiceChannel: async (guildId: string) => { gateway.connections.get(guildId)?.disconnect(); gateway.connections.delete(guildId); gateway.players.delete(guildId); },
    joinVoiceChannel: async (options: { guildId: string; channelId: string }) => { joins.push(options.channelId); gateway.connections.set(options.guildId, connection(options.channelId)); gateway.players.set(options.guildId, player); return player; }
  };
  const connection = (channelId: string) => {
    const result = new Connection(gateway as unknown as Shoukaku, { guildId: "g", channelId, shardId: 0 });
    result.state = Constants.State.CONNECTED; return result;
  };
  gateway.connections.set("g", connection("original"));
  const connector = new Connectors.DiscordJS(client).set(gateway as unknown as Shoukaku);
  const backend = new LavalinkBackend(client, () => gateway as unknown as Shoukaku, () => {}, () => now);
  const changes: Array<string | undefined> = [], events: PlaybackEvent[] = [];
  backend.onVoiceChange = (_guild, channelId) => { changes.push(channelId); };
  backend.onEvent = (_guild, event) => { events.push(event); };
  const session = newSession("g"); session.voiceChannelId = "original"; session.current = entryFor({ query: "Song", source: "auto", requestedBy: "u" }, recordingFor(track));
  const deliver = (channelId: string | null) => {
    const previous = guild.members.me.voice.channelId;
    connector["raw"]({ t: "VOICE_STATE_UPDATE", d: { guild_id: "g", user_id: "bot", channel_id: channelId, session_id: "fixture", self_deaf: true, self_mute: false } });
    guild.members.me.voice.channelId = channelId;
    return backend.voiceStateChanged("g", previous, channelId);
  };
  return { backend, player, gateway, joins, outbound, changes, events, session, deliver, step: (ms: number) => { now += ms; }, now: () => now, setResolve: (next: typeof resolve) => { resolve = next; } };
}

test("internal reconnect acknowledgements remain expected after the network operation completes", async () => {
  const h = fixture();
  try {
    await h.backend.start(h.session, "attempt", new AbortController().signal, true);
    assert.deepEqual(h.joins, ["original"]); assert.deepEqual(h.outbound, [null]);
    assert.equal(h.deliver(null), "expected");
    assert.equal(h.deliver("original"), "expected");
    assert.deepEqual(h.changes, []);
    assert.equal(h.deliver(null), "external", "a later removal must not consume an old internal leave marker");
    assert.deepEqual(h.changes, [undefined]);
  } finally { h.backend.close(); }
});

test("repair or shutdown leave acknowledgements are consumed once without erasing the saved target", async () => {
  const h = fixture();
  try {
    await h.backend.stop("g", true);
    assert.equal(h.deliver(null), "expected"); assert.deepEqual(h.changes, []);
    assert.equal(h.session.voiceChannelId, "original");
    assert.equal(h.backend["voiceTimers"].size, 0); assert.equal(h.backend["expectedVoiceStates"].size, 0);
  } finally { h.backend.close(); }
});

test("expected voice acknowledgements expire and close clears their timers", async () => {
  const h = fixture();
  try {
    await h.backend.stop("g", true); h.step(30_001);
    assert.equal(h.deliver(null), "external"); assert.deepEqual(h.changes, [undefined]);
  } finally { h.backend.close(); }
  assert.equal(h.backend["voiceTimers"].size, 0); assert.equal(h.backend["expectedVoiceStates"].size, 0);
});

async function playingFixture() {
  const h = fixture(), saved = new Map<string, Session>();
  const store = { loadSessions: () => [...saved.values()].map(value => structuredClone(value)), saveSession: (session: Session) => { saved.set(session.guildId, structuredClone(session)); } } as MusicStorage;
  const failures: string[] = [];
  const music = new MusicCoordinator(store, h.backend, { now: h.now, onFailure: (_entry, reason) => { failures.push(reason); } });
  h.backend.onEvent = (guild, event) => { void music.event(guild, event); };
  h.backend.onVoiceChange = (guild, channelId) => { void music.externalVoiceChange(guild, channelId); };
  await music.enqueue("g", h.session.current!, "original", "text");
  await music.enqueue("g", entryFor({ query: "Next", source: "auto", requestedBy: "u" }, recordingFor(track)), "original", "text");
  await settle();
  const id = music.attemptId("g")!;
  h.player.emit("start", { track: { ...track, userData: { attemptId: id } } });
  h.step(5000); h.player.emit("update", { state: { connected: true, position: 5000, time: h.now() } });
  await settle();
  assert.equal(music.snapshot("g").state, "playing");
  return { ...h, music, store, failures };
}

test("an external move persists its destination and the next track does not return to the old channel", async t => {
  t.mock.method(console, "info", () => {});
  const h = await playingFixture();
  try {
    const before = h.music.snapshot("g");
    assert.equal(h.deliver("moved"), "external"); await settle();
    assert.equal(h.music.snapshot("g").voiceChannelId, "moved");
    assert.equal(h.music.snapshot("g").state, "playing"); assert.equal(h.music.snapshot("g").current?.id, before.current?.id);
    await h.music.skip("g", before.current!.id); await settle();
    assert.equal(h.music.snapshot("g").current?.id, before.queue[0].id);
    assert.deepEqual(h.joins, []); assert.deepEqual(h.outbound, []);
    assert.equal(new MusicCoordinator(h.store, h.backend).snapshot("g").voiceChannelId, "moved");
  } finally { h.backend.close(); }
});

test("an external removal preserves the queue and cannot be undone by the watchdog or restart", async t => {
  t.mock.method(console, "info", () => {});
  const h = await playingFixture();
  try {
    const before = h.music.snapshot("g");
    assert.equal(h.deliver(null), "external"); await settle();
    h.step(180_000); await h.music.tick(); await settle();
    const after = h.music.snapshot("g");
    assert.equal(after.state, "suspended"); assert.equal(after.voiceChannelId, undefined);
    assert.equal(after.current?.id, before.current?.id); assert.deepEqual(after.queue, before.queue); assert.deepEqual(after.history, before.history);
    assert.equal(after.positionMs, before.positionMs); assert.deepEqual(h.failures, []); assert.deepEqual(h.joins, []);
    assert.equal(new MusicCoordinator(h.store, h.backend).snapshot("g").voiceChannelId, undefined);
  } finally { h.backend.close(); }
});

test("an external removal during resolution prevents a late join with the captured channel", async () => {
  const h = fixture(); let finish!: (value: { loadType: LoadType.TRACK; data: Track }) => void;
  h.setResolve(() => new Promise(resolve => { finish = resolve; }));
  try {
    const start = h.backend.start(h.session, "attempt", new AbortController().signal, true);
    const rejected = assert.rejects(start, /abort/i);
    assert.equal(h.deliver(null), "external");
    finish({ loadType: LoadType.TRACK, data: track }); await rejected;
    assert.deepEqual(h.joins, []); assert.equal(h.player.plays.length, 0);
  } finally { h.backend.close(); }
});

test("terminal Discord voice close codes hold playback while a voice-server crash remains recoverable", async () => {
  const h = fixture();
  try {
    await h.backend.start(h.session, "attempt", new AbortController().signal, false);
    for (const code of [4014, 4021, 4022, 4015]) {
      h.player.emit("closed", { code });
      const event = h.events.at(-1)!;
      assert.equal(event.type, "failure");
      if (event.type !== "failure") throw new Error("Expected failure event");
      assert.equal(event.scope, "environment"); assert.equal(event.reconnect, code === 4015);
      assert.equal(event.reason.startsWith("Voice:"), code !== 4015);
    }
  } finally { h.backend.close(); }
});

test("a failed volume intent can be restored without overwriting a newer volume request", async () => {
  const h = fixture();
  try {
    await h.backend.volume("g", 25); h.backend.restoreVolumeIntent("g", 25, 100);
    await h.backend.start(h.session, "restored", new AbortController().signal, false);
    assert.equal(h.player.plays.at(-1)?.volume, 100);
    await h.backend.volume("g", 50); h.backend.restoreVolumeIntent("g", 25, 100);
    await h.backend.start(h.session, "newer", new AbortController().signal, false);
    assert.equal(h.player.plays.at(-1)?.volume, 50);
  } finally { h.backend.close(); }
});

test("Lavalink lookup transport failures remain environment errors for native, YouTube and Spotify loading", async () => {
  const h = fixture();
  const serviceError = new RestError({ timestamp: 1, status: 502, error: "Bad Gateway", path: "/v4/loadtracks",
    message: "Upstream unavailable: http://127.0.0.1:32767/spotify/abcdef0123.ogg authorization=fixture-secret https://user:pass@media.example/audio?token=fixture-signed-token" });
  h.setResolve(async () => { throw serviceError; });
  h.backend["youtube"] = { resolve: async (_id: string, load: Loader) => load("https://media.example/youtube?token=private") } as unknown as YoutubeResolver;
  h.backend["spotify"] = { resolve: async (_recording: unknown, load: Loader) => load("http://127.0.0.1:32767/spotify/abcdef0123.ogg"), close: () => {} } as unknown as SpotifyOriginalAudio;
  const spotify = { ...recordingFor(track), identifier: "0NTMtAO2BV4tnGvw9EgBVq", uri: "https://open.spotify.com/track/0NTMtAO2BV4tnGvw9EgBVq", source: "spotify" as const };
  try {
    for (const run of [
      () => h.backend.load(track.info.uri!),
      () => h.backend.load("https://www.youtube.com/watch?v=2I3PLVuKNtw"),
      () => h.backend["resolve"](spotify.uri, undefined, 0, spotify)
    ]) await assert.rejects(run(), (error: Error) => {
      assert.match(error.message, /^Lavalink lookup failed:/);
      assert.equal(failureScope(error.message), "environment"); assert.equal(isRecordingFailure(error.message), false);
      assert.doesNotMatch(error.message, /fixture-secret|fixture-signed-token|user:pass|abcdef0123|127\.0\.0\.1/);
      assert.match(error.message, /\[private Spotify stream\]/); assert.match(error.message, /authorization=\[redacted\]/);
      return true;
    });
    h.setResolve(async () => { throw new TypeError("fetch failed"); });
    await assert.rejects(h.backend.load(track.info.uri!), /Lavalink lookup failed: fetch failed/);
  } finally { h.backend.close(); }
});

test("a valid Lavalink load error stays a recording failure rather than a service outage", async () => {
  const h = fixture();
  const sourceError: LavalinkResponse = { loadType: LoadType.ERROR, data: { message: "This upload is unavailable", severity: "common", cause: "private recording" } };
  h.setResolve(async () => sourceError);
  try {
    assert.equal(await h.backend.load(track.info.uri!), sourceError);
    await assert.rejects(h.backend.start(h.session, "attempt", new AbortController().signal, false), (error: Error) => {
      assert.equal(failureScope(error.message), "recording"); assert.equal(isRecordingFailure(error.message), true);
      assert.doesNotMatch(error.message, /Lavalink lookup failed/); return true;
    });
  } finally { h.backend.close(); }
});
