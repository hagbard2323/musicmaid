import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Client, Interaction } from "discord.js";
import { entryFor, newSession } from "../src/audio/model.js";
import { MusicController } from "../src/commands/music.js";
import type { MusicCoordinator } from "../src/audio/coordinator.js";
import type { MusicStorage } from "../src/storage/types.js";
import { viewerReader, ViewerBridge } from "../src/video/bridge.js";
import { videoPosition, type ViewerSnapshot } from "../src/video/protocol.js";
import { bridgeClient, BridgeError } from "../../viewer-server/src/bridge-client.js";
import { createViewerServer } from "../../viewer-server/src/server.js";
import { YoutubeResolver } from "../src/audio/youtube.js";
import { env } from "../src/config/env.js";

const guild = "10000001", user = "20000001", voice = "30000001";
const entry = () => entryFor({ query: "https://youtu.be/2I3PLVuKNtw", source: "youtube", requestedBy: user }, { identifier: "2I3PLVuKNtw", title: "Sastanàqqàm", author: "Tinariwen", uri: "https://www.youtube.com/watch?v=2I3PLVuKNtw", source: "youtube", durationMs: 205000, isStream: false, isSeekable: true });
test("viewer reader permits voice listeners, exposes only YouTube, and never changes playback", () => {
  const session = newSession(guild); session.voiceChannelId = voice; session.current = entry(); session.state = "playing"; session.positionMs = 10000; session.positionUpdatedAt = 1000;
  const member = { voice: { channelId: voice } };
  const client = { isReady: () => true, guilds: { cache: new Map([[guild, { members: { cache: new Map([[user, member]]) } }]]) } } as unknown as Client;
  const read = viewerReader(client, { snapshot: () => structuredClone(session) } as unknown as MusicCoordinator);
  const before = structuredClone(session), scope = { guildId: guild, userId: user, voiceChannelId: voice };
  assert.equal(read(scope).track?.videoId, "2I3PLVuKNtw"); assert.deepEqual(session, before);
  assert.throws(() => read({ ...scope, userId: "99999999" }), /voice channel/);
  session.current.recording.source = "spotify"; assert.equal(read(scope).track, null);
  session.queue.push(entry()); assert.equal(read(scope).waitingForYoutube, true); session.queue = [];
  session.current = undefined; session.voiceChannelId = undefined; assert.equal(read(scope).track, null);
  member.voice.channelId = "other"; assert.throws(() => read(scope));
});
test("video clock follows pause and clamps stale progress instead of running indefinitely", () => {
  const track = { entryId: "e", videoId: "2I3PLVuKNtw", title: "Video", artist: "Artist", durationMs: 205000, positionMs: 10000, observedAt: 1000, state: "playing" as const };
  assert.equal(videoPosition(track, 2000), 11000);
  assert.equal(videoPosition({ ...track, state: "paused" }, 100000), 10000);
  assert.equal(videoPosition(track, 100000), 25000);
});
test("private viewer bridge rejects mutation routes and stale video requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "musicmaid-bridge-")), socket = join(dir, "reader.sock");
  const current = entry();
  const snapshot: ViewerSnapshot = { serverTime: Date.now(), voiceChannelId: voice, runId: "run", track: { entryId: current.id, videoId: current.recording.identifier, title: "Fixture", artist: "Artist", durationMs: 205000, positionMs: 0, observedAt: Date.now(), state: "playing" } };
  let preparations = 0;
  const bridge = new ViewerBridge(socket, () => snapshot, async () => { preparations++; throw new Error("not needed"); });
  try {
    await bridge.start(); const read = bridgeClient(socket);
    assert.equal((await read<ViewerSnapshot>("/state", { guildId: guild, userId: user })).track?.entryId, current.id);
    await assert.rejects(read("/video", { guildId: guild, userId: user, entryId: "stale" }));
    await assert.rejects(read("/stop" as "/state", { guildId: guild, userId: user })); assert.equal(preparations, 0);
  } finally { bridge.close(); await rm(dir, { recursive: true, force: true }); }
});
test("optional video selects bounded H.264 video only and keeps signed URLs outside recording metadata", async () => {
  const url = "https://r1---fixture.googlevideo.com/videoplayback?expire=" + Math.floor(Date.now() / 1000 + 3600);
  let calls = 0;
  const resolver = new YoutubeResolver({ binary: "fixture", cookies: "fixture" }, async (_options, args) => {
    calls++; assert.ok(args.some(value => value.includes("height<=720") && value.includes("vcodec^=avc1")));
    return { id: "2I3PLVuKNtw", title: "Fixture", channel: "Artist", duration: 205, height: 720, fps: 30, vcodec: "avc1.4d401f", acodec: "none", url };
  });
  const [a, b] = await Promise.all([resolver.video("2I3PLVuKNtw"), resolver.video("2I3PLVuKNtw")]);
  assert.equal(calls, 1); assert.equal(a.url, b.url); assert.equal(a.height, 720);
  await resolver.video("2I3PLVuKNtw", undefined, true); assert.equal(calls, 2, "Retry obtains a fresh address for the same selected ID");
  const invalid = new YoutubeResolver({ binary: "fixture", cookies: "fixture" }, async () => ({ id: "2I3PLVuKNtw", title: "Fixture", duration: 205, height: 720, vcodec: "avc1", acodec: "mp4a", url }));
  await assert.rejects(invalid.video("2I3PLVuKNtw"), /video-only/);
});
test("one viewer closing cannot cancel video preparation shared by another viewer", async () => {
  let finish: (value: unknown) => void = () => {};
  const resolver = new YoutubeResolver({ binary: "fixture", cookies: "fixture" }, async () => new Promise(resolve => { finish = resolve; }));
  const first = new AbortController();
  const a = resolver.video("2I3PLVuKNtw", first.signal), b = resolver.video("2I3PLVuKNtw");
  const cancelled = assert.rejects(a); first.abort(); await cancelled;
  finish({ id: "2I3PLVuKNtw", title: "Fixture", duration: 205, height: 720, fps: 30, vcodec: "avc1", acodec: "none", url: "https://r1---fixture.googlevideo.com/videoplayback?expire=" + Math.floor(Date.now() / 1000 + 3600) });
  assert.equal((await b).id, "2I3PLVuKNtw");
});
test("viewer authorization, range proxy and YouTube transitions remain read-only and scoped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "musicmaid-viewer-")); await writeFile(join(dir, "index.html"), "Viewer");
  const current = entry(); const first = current.id;
  const snapshot: ViewerSnapshot = { serverTime: Date.now(), voiceChannelId: voice, runId: "run", track: { entryId: first, videoId: "2I3PLVuKNtw", title: "Fixture", artist: "Artist", durationMs: 205000, positionMs: 5000, observedAt: Date.now(), state: "playing" } };
  const privateUrl = "https://r1---fixture.googlevideo.com/videoplayback?expire=" + Math.floor(Date.now() / 1000 + 3600);
  let allowed = true, mediaRequests = 0, clock = Date.now();
  const bridge = (async (path: string, scope: { userId: string; guildId: string; entryId?: string }) => {
    if (!allowed || scope.userId !== user || scope.guildId !== guild) throw new BridgeError(403);
    if (path === "/state") return structuredClone(snapshot);
    assert.equal(path, "/video"); assert.equal(scope.entryId, snapshot.track?.entryId);
    return { id: snapshot.track!.videoId, url: privateUrl, durationMs: 205000, height: 720, codec: "avc1", expiresAt: Date.now() + 3600000 };
  }) as ReturnType<typeof bridgeClient>;
  const fetcher = (async (url: string | URL, options?: RequestInit) => {
    if (String(url).endsWith("/oauth2/token")) return Response.json({ access_token: "user-access", expires_in: 3600, scope: "identify" });
    if (String(url).endsWith("/users/@me")) return Response.json({ id: user });
    assert.equal(String(url), privateUrl); mediaRequests++;
    assert.equal(new Headers(options?.headers).get("range"), "bytes=0-5");
    return new Response("video!", { status: 206, headers: { "Content-Type": "video/mp4", "Content-Length": "6", "Content-Range": "bytes 0-5/6" } });
  }) as typeof fetch;
  const server = createViewerServer({ clientId: "12345678", clientSecret: "private-client-secret", publicOrigin: "https://viewer.example", socketPath: "unused", assetsDir: dir, bridge, fetcher, now: () => clock });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  try {
    assert.equal((await fetch(base + "/api/state")).status, 401);
    const request = (path: string, body: unknown, token?: string, origin?: string) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
    assert.equal((await request("/api/auth", { code: "code-fixture", guildId: guild }, undefined, "https://evil.example")).status, 403);
    const authResponse = await request("/api/auth", { code: "code-fixture", guildId: guild }); assert.equal(authResponse.status, 200);
    const auth = await authResponse.json() as { token: string }; assert.ok(auth.token);
    const headers = { Authorization: "Bearer " + auth.token };
    assert.equal((await request("/api/auth", { code: "code-fixture", guildId: guild })).status, 409);
    assert.equal((await request("/api/stop", {}, auth.token)).status, 404);
    const loaded = await request("/api/video", { entryId: first }, auth.token); assert.equal(loaded.status, 200);
    const media = await loaded.json() as { path: string }; assert.match(media.path, /^\/media\/[a-f0-9]{64}$/); assert.ok(!JSON.stringify(media).includes("googlevideo"));
    const bytes = await fetch(base + media.path, { headers: { Range: "bytes=0-5" } }); assert.equal(bytes.status, 206); assert.equal(await bytes.text(), "video!"); assert.equal(mediaRequests, 1);
    assert.equal((await fetch(base + media.path, { headers: { Range: "bytes=0-5,6-8" } })).status, 416);
    snapshot.track!.entryId = entry().id;
    clock += 1000;
    assert.equal((await fetch(base + "/api/state", { headers })).status, 200, "consecutive YouTube tracks keep the viewer open");
    assert.equal((await fetch(base + media.path)).status, 410, "old video cannot continue as a different track");
    allowed = false; clock += 1000; assert.equal((await fetch(base + "/api/state", { headers })).status, 403); allowed = true;
    const nextYoutube = snapshot.track;
    snapshot.track = null; snapshot.waitingForYoutube = true; clock += 1000;
    const waiting = await fetch(base + "/api/state", { headers }); assert.equal(waiting.status, 200); assert.equal((await waiting.json() as ViewerSnapshot).waitingForYoutube, true);
    snapshot.track = nextYoutube; snapshot.waitingForYoutube = false; clock += 1000;
    assert.equal((await fetch(base + "/api/state", { headers })).status, 200, "the same viewer resumes after an intervening source");
    snapshot.track = null;
    clock += 1000;
    const ended = await fetch(base + "/api/state", { headers }); assert.equal(ended.status, 200); assert.equal((await ended.json() as ViewerSnapshot).track, null);
    assert.equal((await fetch(base + "/api/state", { headers })).status, 401);
    const config = await (await fetch(base + "/config")).text(); assert.ok(!config.includes("private-client-secret"));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
test("Watch video launches before deferring and rejects controls for a previous track", async () => {
  const session = newSession(guild); session.current = entry(); session.voiceChannelId = voice; session.state = "playing";
  const music = { snapshot: () => session } as unknown as MusicCoordinator;
  const controller = new MusicController({} as Client, music, async () => undefined, {} as MusicStorage); controller.viewerReady = () => true;
  let launched = 0; const replies: string[] = [];
  const i = { id: "watch", guildId: guild, guild: { members: { cache: new Map([[user, { voice: { channelId: voice } }]]) } }, user: { id: user }, channelId: env.discordMusicTextChannelId ?? "text", customId: "m:watch:" + session.current.id,
    isButton: () => true, isChatInputCommand: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false,
    launchActivity: async () => { launched++; }, deferReply: async () => { assert.fail("Launch must be the initial response"); }, reply: async (r: { content: string }) => { replies.push(r.content); } };
  await controller.handle(i as unknown as Interaction); assert.equal(launched, 1);
  await controller.handle({ ...i, id: "stale-watch", customId: "m:watch:old" } as unknown as Interaction); assert.equal(launched, 1); assert.match(replies[0], /no longer current/);
  for (const current of [session.current, undefined]) {
    session.current = current; const rows = controller["panel"](session).components;
    const ids = rows.flatMap(r => r.toJSON().components).map(b => "custom_id" in b ? b.custom_id : "");
    assert.ok(rows.every(r => r.components.length <= 5)); assert.equal(ids.length, new Set(ids).size);
  }
});
test("moderator restart saves sessions and proceeds when audio cleanup fails", async () => {
  const session = newSession(guild), order: string[] = [], values = new Map<string, string>();
  const music = { snapshot: () => session, all: () => [session], suspend: async () => { order.push("save"); }, disconnectPreservingQueue: async () => { order.push("disconnect"); throw new Error("Audio service unreachable"); } } as unknown as MusicCoordinator;
  const store = { getValue: (k: string) => values.get(k), setValue: (k: string, v: string) => { values.set(k, v); } } as MusicStorage;
  const controller = new MusicController({} as Client, music, async () => undefined, store, async () => { order.push("restart"); });
  const id = controller["menus"].create(user, guild, { kind: "restart", target: "audio" });
  const i = { guildId: guild, guild: { members: { cache: new Map() } }, user: { id: user }, memberPermissions: { has: () => true }, editReply: async () => {} };
  await controller["confirmRestart"](i as never, "confirm", id); assert.deepEqual(order, ["save", "disconnect", "restart"]);
});
test("moderator viewer restart never suspends or disconnects music", async () => {
  const session = newSession(guild), values = new Map<string, string>(); let restarted = "";
  const music = { snapshot: () => session, all: () => { assert.fail("Viewer restart must not touch playback sessions"); } } as unknown as MusicCoordinator;
  const store = { getValue: (k: string) => values.get(k), setValue: (k: string, v: string) => { values.set(k, v); } } as MusicStorage;
  const controller = new MusicController({} as Client, music, async () => undefined, store, async target => { restarted = target; });
  const id = controller["menus"].create(user, guild, { kind: "restart", target: "viewer" });
  const i = { guildId: guild, guild: { members: { cache: new Map() } }, user: { id: user }, memberPermissions: { has: () => true }, editReply: async () => {} };
  await controller["confirmRestart"](i as never, "confirm", id); assert.equal(restarted, "viewer");
});
