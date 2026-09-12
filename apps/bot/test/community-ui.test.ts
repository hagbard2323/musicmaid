import { test } from "node:test";
import assert from "node:assert/strict";
import { type Client, type Interaction } from "discord.js";
import { LoadType, type Track } from "shoukaku";
import { MusicController } from "../src/commands/music.js";
import { MusicCoordinator, type PlaybackBackend } from "../src/audio/coordinator.js";
import { entryFor, newSession, type Session } from "../src/audio/model.js";
import type { MusicStorage } from "../src/storage/types.js";
import { env } from "../src/config/env.js";

const recording = (name = "Song") => ({ identifier: name.toLowerCase(), uri: `https://soundcloud.com/artist/${name.toLowerCase()}`, title: name, author: "Artist", source: "soundcloud" as const, durationMs: 180000, isStream: false, isSeekable: true });
const song = (name = "Song") => entryFor({ query: `Artist ${name}`, source: "auto", requestedBy: "u" }, recording(name));
const components = (payload: any): any[] => payload.components.flatMap((row: any) => row.toJSON().components);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function interaction(id: string, customId: string, mod = false) {
  const replies: any[] = []; let deferred = false;
  const i = { id, guildId: "g", channelId: env.discordMusicTextChannelId ?? "text", user: { id: "u" },
    guild: { members: { cache: new Map([["u", { voice: { channelId: "voice" }, roles: { cache: new Map() } }]]) } }, memberPermissions: { has: () => mod }, customId,
    isButton: () => true, isChatInputCommand: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false,
    message: { flags: { has: () => true } }, get deferred() { return deferred; },
    deferReply: async () => { deferred = true; }, deferUpdate: async () => { deferred = true; },
    editReply: async (payload: any) => { replies.push(payload); }, reply: async (payload: any) => { replies.push(payload); }
  };
  return { i, replies };
}

test("the shared player keeps three upcoming songs and full controls while codec details open privately", async () => {
  const session = newSession("g"); session.current = song(); session.state = "playing"; session.positionMs = 45000; session.queueMode = "fair"; session.loop = "track";
  session.current.recording.audioQuality = { codec: "opus", bitrateKbps: 133, sampleRateHz: 48000 };
  session.queue = ["Two", "Three", "Four", "Five"].map(song);
  const controller = new MusicController({} as Client, { snapshot: () => structuredClone(session) } as unknown as MusicCoordinator, async () => undefined, {} as MusicStorage);
  const h = interaction("details", "m:details");
  try {
    const panel = controller["panel"](session), embed = panel.embeds[0].toJSON();
    assert.match(embed.fields!.find(field => field.name === "Playback")!.value, /0:45 \/ 3:00/);
    assert.match(embed.fields!.find(field => field.name === "Audio source")!.value, /🟠 SoundCloud/);
    assert.equal(embed.fields!.find(field => field.name.startsWith("Up next"))!.value.split("\n").length, 3);
    assert.doesNotMatch(JSON.stringify(embed), /133|OPUS|48 kHz/);
    const controls = components(panel);
    for (const label of ["Add music", "Pause", "Skip", "Stop and clear", "Queue", "Change version", "Retry same track", "Save track", "Playlists", "History", "Details"]) assert.ok(controls.some(control => control.label === label), label);
    assert.equal(new Set(controls.map(control => control.custom_id)).size, controls.length);
    await controller.handle(h.i as unknown as Interaction);
    const details = h.replies.at(-1).embeds[0].toJSON();
    assert.match(details.fields.find((field: any) => field.name === "Source format").value, /OPUS · ~133 kb\/s · 48 kHz/);
    assert.match(details.fields.find((field: any) => field.name === "Queue policy").value, /Repeat-one temporarily holds/);
    assert.equal(session.positionMs, 45000); assert.equal(session.queue.length, 4);
  } finally { controller.close(); }
});

test("Queue offers Save queue and only moderators can select fair turns; manual ordering is disabled in fair mode", async () => {
  const session = newSession("g"); session.current = song(); session.state = "playing"; session.queue = ["Two", "Three"].map(song);
  let modeChanges = 0;
  const music = { snapshot: () => structuredClone(session), setQueueMode: async (_guild: string, mode: "fifo" | "fair") => { modeChanges++; session.queueMode = mode; session.revision++; } } as unknown as MusicCoordinator;
  const controller = new MusicController({} as Client, music, async () => undefined, {} as MusicStorage);
  try {
    const member = interaction("queue-member", "m:queue"); await controller.handle(member.i as unknown as Interaction);
    const normal = components(member.replies.at(-1));
    assert.ok(normal.some(control => control.custom_id === "pl:save")); assert.ok(!normal.some(control => control.custom_id?.startsWith("qmode:")));
    await controller.handle({ ...member.i, id: "forged-mode", customId: "qmode:fair" } as unknown as Interaction);
    assert.equal(modeChanges, 0); assert.match(member.replies.at(-1).content, /moderator role/);
    const mod = interaction("queue-mod", "qmode:fair", true); await controller.handle(mod.i as unknown as Interaction);
    assert.equal(modeChanges, 1); assert.equal(session.queueMode, "fair");
    const fair = components(mod.replies.at(-1));
    assert.equal(fair.find(control => control.custom_id?.startsWith("qedit:shuffle:")).disabled, true);
    assert.ok(fair.some(control => control.custom_id.startsWith("qmode:fifo:")));
    const select = fair.find(control => control.custom_id?.startsWith("qselect:"));
    await controller.handle({ ...mod.i, id: "select-fair", customId: select.custom_id, isButton: () => false, isStringSelectMenu: () => true, values: [session.queue[0].id] } as unknown as Interaction);
    const edit = components(mod.replies.at(-1));
    assert.ok(edit.filter(control => /qmove:|qedit:(up|down|next):/.test(control.custom_id)).every(control => control.disabled));
    assert.equal(edit.find(control => control.custom_id.startsWith("qedit:remove:")).disabled, undefined);
  } finally { controller.close(); }
});

test("Change version requires a replacement confirmation and cannot queue a version after the original request has ended", async () => {
  const session = newSession("g"); session.current = song(); session.state = "playing";
  let replacements = 0;
  const music = { snapshot: () => structuredClone(session), chooseAlternative: async () => { replacements++; } } as unknown as MusicCoordinator;
  const controller = new MusicController({} as Client, music, async () => undefined, {} as MusicStorage);
  const h = interaction("version", "m:alternative:" + session.current.id);
  const result = { request: session.current.request, candidates: [recording("Other")], direct: false, notices: [] };
  try {
    await controller["picker"](h.i as never, result, "voice", session.current.id, 0, undefined, true);
    const picker = components(h.replies.at(-1))[0];
    await controller.handle({ ...h.i, id: "select-version", customId: picker.custom_id, isButton: () => false, isStringSelectMenu: () => true, values: ["0"] } as unknown as Interaction);
    const confirm = components(h.replies.at(-1)).find(control => control.custom_id?.startsWith("confirm-track:"));
    assert.equal(confirm.label, "Replace with this version"); assert.equal(replacements, 0);
    session.current = undefined; session.state = "idle";
    await controller.handle({ ...h.i, id: "confirm-ended", customId: confirm.custom_id } as unknown as Interaction);
    assert.equal(replacements, 0); assert.match(h.replies.at(-1).content, /already left the queue/);
  } finally { controller.close(); }
});

test("a confirmed Change version replaces the selected request with the coordinator's atomic stale-target guard", async () => {
  const session = newSession("g"); session.current = song(); session.state = "playing";
  const calls: unknown[][] = [];
  const music = { snapshot: () => structuredClone(session), chooseAlternative: async (...args: unknown[]) => { calls.push(args); session.current = args[2] as typeof session.current; } } as unknown as MusicCoordinator;
  const controller = new MusicController({} as Client, music, async () => undefined, {} as MusicStorage);
  const h = interaction("replace", ""), oldId = session.current.id;
  const menuId = controller["menus"].create("u", "g", { kind: "recording_confirmation", result: { request: session.current.request, candidates: [recording("Other")], direct: false, notices: [] }, recording: recording("Other"), voiceChannelId: "voice", failedEntryId: oldId, replaceOnly: true });
  try {
    await controller.handle({ ...h.i, customId: `confirm-track:${menuId}` } as unknown as Interaction);
    assert.equal(calls.length, 1); assert.equal(calls[0][1], oldId); assert.equal(calls[0][6], true);
    assert.equal(session.current?.recording.title, "Other");
  } finally { controller.close(); }
});

test("native Add music submissions pass the selected source mask and Review mode through to search", async () => {
  const session = newSession("g"); const loads: string[] = [];
  let queued = 0;
  const music = { snapshot: () => structuredClone(session), enqueue: async () => { queued++; } } as unknown as MusicCoordinator;
  const controller = new MusicController({} as Client, music, async id => {
    loads.push(id);
    return { loadType: LoadType.SEARCH, data: [{ encoded: "song", info: { identifier: "song", uri: "https://soundcloud.com/artist/song", title: "Song", author: "Artist", length: 180000, position: 0, sourceName: "soundcloud", isStream: false, isSeekable: true }, pluginInfo: {} }] };
  }, {} as MusicStorage);
  const h = interaction("native-submit", "");
  const menuId = controller["menus"].create("u", "g", { kind: "music_input", native: true, source: "auto", forceChoices: false, voiceChannelId: "voice" });
  try {
    await controller.handle({ ...h.i, customId: `music-input:${menuId}`, isButton: () => false, isModalSubmit: () => true,
      fields: { getTextInputValue: () => "Artist Song", getStringSelectValues: (id: string) => id === "sources" ? ["soundcloud"] : ["review"] } } as unknown as Interaction);
    assert.deepEqual(loads, ["scsearch:Artist Song"]); assert.equal(queued, 0);
    const select = components(h.replies.at(-1))[0]; assert.ok(select.custom_id.startsWith("pick:"));
    const picker = controller["menus"].read(select.custom_id.slice(5), "u", "g");
    assert.equal(picker.kind, "picker");
    if (picker.kind === "picker") { assert.equal(picker.result.request.source, "auto"); assert.deepEqual(picker.result.request.sources, ["soundcloud"]); }
  } finally { controller.close(); }
});

test("a newer Play search aborts the earlier lookup and late results cannot enqueue an extra song", async t => {
  t.mock.method(console, "info", () => {});
  const saved = new Map<string, Session>();
  const store: MusicStorage = { loadSessions: () => [], saveSession: (session: Session) => { saved.set(session.guildId, structuredClone(session)); }, getValue: () => undefined, setValue: () => {}, close: () => {} };
  const backend = { start: async () => {}, stop: async () => {}, pause: async () => {}, seek: async () => {}, volume: async () => {} } as PlaybackBackend;
  const music = new MusicCoordinator(store, backend);
  let releaseOld!: (value: { loadType: LoadType.SEARCH; data: Track[] }) => void, oldSignal: AbortSignal | undefined;
  const raw = (title: string): Track => ({ encoded: title, info: { ...recording(title), length: 180000, position: 0, sourceName: "soundcloud" }, pluginInfo: {} });
  const controller = new MusicController({} as Client, music, async (id, signal) => {
    if (id.includes("First")) { oldSignal = signal; return new Promise(resolve => { releaseOld = resolve; }); }
    return { loadType: LoadType.SEARCH, data: [raw("Second")] };
  }, store);
  const first = interaction("first", ""), second = interaction("second", "");
  const command = (i: typeof first.i, title: string) => ({ ...i, commandName: "play", isButton: () => false, isChatInputCommand: () => true,
    options: { getBoolean: () => false, getString: (name: string) => name === "source" ? "soundcloud" : `Artist ${title}` } });
  try {
    const pending = controller.handle(command(first.i, "First") as unknown as Interaction); await tick(); assert.ok(releaseOld);
    await controller.handle(command(second.i, "Second") as unknown as Interaction); await pending;
    assert.equal(oldSignal?.aborted, true); assert.match(first.replies.at(-1).content, /replaced by your newer request/);
    releaseOld({ loadType: LoadType.SEARCH, data: [raw("First")] }); await tick();
    assert.equal(music.snapshot("g").current?.recording.title, "Second"); assert.equal(music.snapshot("g").queue.length, 0);
    assert.equal(saved.get("g")?.current?.recording.title, "Second");
  } finally { controller.close(); }
});

test("Try next cannot replace playback after the member moves or leaves during its source lookup", async t => {
  t.mock.method(console, "info", () => {});
  for (const destination of ["elsewhere", null]) {
    const store: MusicStorage = { loadSessions: () => [], saveSession: () => {}, getValue: () => undefined, setValue: () => {}, close: () => {} };
    const starts: string[] = [];
    const backend: PlaybackBackend = { start: async (_session, attempt) => { starts.push(attempt); }, stop: async () => {}, pause: async () => {}, seek: async () => {}, volume: async () => {} };
    const music = new MusicCoordinator(store, backend);
    const original = song(); original.request.source = "soundcloud";
    await music.enqueue("g", original, "voice", env.discordMusicTextChannelId ?? "text");
    const before = music.snapshot("g"), attempt = music.attemptId("g");
    let release!: (result: { loadType: LoadType.SEARCH; data: Track[] }) => void;
    const controller = new MusicController({} as Client, music, () => new Promise(resolve => { release = resolve; }), store);
    const id = controller["menus"].create("u", "g", { kind: "picker", result: { request: original.request, candidates: [original.recording], direct: false, notices: [], moreAvailable: true }, voiceChannelId: "voice", failedEntryId: original.id, tried: [original.recording.uri] });
    const h = interaction("try-next-" + String(destination), `try-next:${id}`);
    try {
      const pending = controller.handle(h.i as unknown as Interaction); await tick(); assert.ok(release);
      (h.i.guild.members.cache.get("u")! as { voice: { channelId: string | null } }).voice.channelId = destination;
      release({ loadType: LoadType.SEARCH, data: [{ encoded: "replacement", info: { identifier: "replacement", uri: "https://soundcloud.com/artist/replacement", title: "Song", author: "Artist", length: 180000, position: 0, sourceName: "soundcloud", isStream: false, isSeekable: true }, pluginInfo: {} }] });
      await pending;
      assert.equal(music.snapshot("g").current?.id, before.current?.id);
      assert.equal(music.attemptId("g"), attempt); assert.equal(starts.length, 1);
      assert.deepEqual(music.snapshot("g").queue, before.queue);
      assert.match(h.replies.at(-1).content, /voice channel/);
      assert.doesNotMatch(h.replies.at(-1).content, /^Starting/);
    } finally { controller.close(); }
  }
});
