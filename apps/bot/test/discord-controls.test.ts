import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageFlags, type Client, type Interaction } from "discord.js";
import { MusicController } from "../src/commands/music.js";
import { musicCommands } from "../src/commands/register.js";
import { newSession, entryFor, type QueueEntry } from "../src/audio/model.js";
import type { MusicCoordinator } from "../src/audio/coordinator.js";
import type { MusicStorage } from "../src/storage/types.js";
import { env } from "../src/config/env.js";
import { LoadType } from "shoukaku";

test("all command definitions serialize within Discord’s slash-command schema", () => {
  const commands = musicCommands.map(c => c.toJSON());
  assert.equal(new Set(commands.map(c => c.name)).size, commands.length);
  assert.ok(commands.find(c => c.name === "music-admin")?.options?.some(o => o.name === "restart"));
  assert.ok(commands.find(c => c.name === "queue")?.options?.some(o => o.name === "action"));
});
test("queue navigation IDs stay unique on empty, first and later pages", async () => {
  const session = newSession("g"); let payload: { components: Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }> };
  const controller = new MusicController({} as Client, { snapshot: () => session } as unknown as MusicCoordinator, async () => undefined, {} as MusicStorage);
  const i = { guildId: "g", user: { id: "u" }, editReply: async (value: typeof payload) => { payload = value; } };
  for (const count of [0, 1, 25]) {
    session.queue = Array.from({ length: count }, (_, index) => entryFor({ query: "Song", source: "auto", requestedBy: "u" }, { identifier: String(index), uri: `https://soundcloud.com/artist/${index}`, title: "Song " + index, author: "Artist", source: "soundcloud", durationMs: 180000, isStream: false, isSeekable: true }));
    for (const page of [0, 1, 2]) {
      await controller["queueView"](i as never, page);
      const ids = payload!.components.flatMap(row => row.toJSON().components.map(component => component.custom_id));
      assert.equal(ids.length, new Set(ids).size);
      assert.ok(ids.some(id => id?.startsWith("qpage:refresh:")));
    }
  }
});
test("a listener in another voice channel cannot skip, stop, or restart services", async () => {
  const session = newSession("g"); session.voiceChannelId = "bot-voice";
  let mutations = 0;
  const music = { snapshot: () => session, skip: () => { mutations++; }, stop: () => { mutations++; } } as unknown as MusicCoordinator;
  const controller = new MusicController({} as Client, music, async () => undefined, {} as MusicStorage);
  for (const commandName of ["skip", "stop", "music-admin"]) {
    const replies: string[] = [];
    const i = { id: commandName, guildId: "g", guild: { members: { cache: new Map([["u", { voice: { channelId: "other-voice" }, roles: { cache: new Map() } }]]) } }, user: { id: "u" }, memberPermissions: { has: () => false }, commandName,
      isChatInputCommand: () => true, isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false,
      reply: async (r: { content: string }) => { replies.push(r.content); }
    } as unknown as Interaction;
    await controller.handle(i);
    assert.match(replies[0], /voice channel|moderator role|music text channel/);
  }
  assert.equal(mutations, 0);
});
test("recovery panel renders stable track IDs and bounded component payloads", () => {
  const s = newSession("g"); s.current = entryFor({ query: "Sarà perché ti amo", source: "auto", requestedBy: "123" }, { identifier: "track", title: "Sarà perché ti amo", author: "Ricchi e Poveri", uri: "https://soundcloud.com/ricchi-e-poveri-official/sar-perch-ti-amo", source: "soundcloud", durationMs: 190015, isSeekable: true, isStream: false });
  s.state = "awaiting_choice"; s.failure = { reason: "Incomplete playback", incidentId: "incident", deadline: Date.now() + 60000 };
  const controller = new MusicController({} as Client, {} as MusicCoordinator, async () => undefined, {} as MusicStorage);
  const payload = controller["panel"](s);
  assert.ok(payload.embeds[0].toJSON().fields?.some(f => f.value.includes("incident")));
  const ids = payload.components.flatMap(row => row.toJSON().components).map(c => "custom_id" in c ? c.custom_id : "");
  assert.ok(ids.includes(`m:retry:${s.current.id}`)); assert.ok(ids.includes(`m:alternative:${s.current.id}`)); assert.ok(ids.every(id => id.length <= 100));
  assert.ok(!ids.includes("m:spotify"));
  assert.ok(payload.components.every(row => row.components.length <= 5));
});

function spotifyInteractions() {
  const replies: Array<{ content?: string; components?: Array<{ toJSON(): { custom_id?: string; components?: Array<{ custom_id?: string }> } }> }> = [];
  let modal: { toJSON(): { custom_id: string } } | undefined;
  let deferred = false;
  const guild = { members: { cache: new Map([["u", { voice: { channelId: "voice" }, roles: { cache: new Map() } }]]) } };
  const common = {
    guildId: "g", guild, user: { id: "u" }, channelId: env.discordMusicTextChannelId ?? "text", memberPermissions: { has: () => false },
    isChatInputCommand: () => false, isStringSelectMenu: () => false,
    reply: async (reply: typeof replies[number]) => { replies.push(reply); },
    editReply: async (reply: typeof replies[number]) => { replies.push(reply); },
    deferReply: async () => { deferred = true; }
  };
  const button = { ...common, id: "spotify-button", customId: "m:spotify", isButton: () => true, isModalSubmit: () => false, showModal: async (value: typeof modal) => { modal = value; } };
  return { button, replies, modal: () => modal, deferred: () => deferred,
    submit: (url: string) => ({ ...common, id: "spotify-submit", customId: modal!.toJSON().custom_id, isButton: () => false, isModalSubmit: () => true, get deferred() { return deferred; }, fields: { getTextInputValue: () => url,
      getStringSelectValues: (id: string) => ((modal!.toJSON() as any).components.find((row: any) => row.component?.custom_id === id)?.component.options ?? []).filter((option: any) => option.default).map((option: any) => option.value) } }) };
}
test("player keeps full controls within Discord limits while source choice lives in Add music", () => {
  const controller = new MusicController({} as Client, {} as MusicCoordinator, async () => undefined, {} as MusicStorage);
  const previous = env.spotifyDirectEnabled;
  try {
    for (const enabled of [false, true]) {
      env.spotifyDirectEnabled = enabled;
      const payload = controller["panel"](newSession("g"));
      const ids = payload.components.flatMap(row => row.toJSON().components).map(c => "custom_id" in c ? c.custom_id : "");
      assert.equal(ids.includes("m:spotify"), false);
      assert.equal(new Set(ids).size, ids.length);
      for (const id of ["m:play", "m:details", "m:queue", "m:history", "pl:list", "stats:tracks:30"]) assert.ok(ids.includes(id));
      assert.ok(payload.components.length <= 5 && payload.components.every(row => row.components.length <= 5));
      assert.ok(payload.components[1].toJSON().components.slice(0, 3).every(control => "disabled" in control && control.disabled));
    }
  } finally { env.spotifyDirectEnabled = previous; }
});
test("legacy Spotify text search stays source-specific while exact links select their own source", async t => {
  const previous = [env.spotifyClientId, env.spotifyClientSecret, env.spotifyDirectEnabled] as const;
  env.spotifyClientId = "fixture"; env.spotifyClientSecret = "fixture"; env.spotifyDirectEnabled = true;
  const metadata = { id: "0NTMtAO2BV4tnGvw9EgBVq", name: "Bitch Better Have My Money", artists: [{ name: "Rihanna" }], duration_ms: 219305 };
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/token")) return Response.json({ access_token: "fixture", expires_in: 3600 });
    if (url.pathname.endsWith("/search")) return url.searchParams.get("q") === "Unavailable song"
      ? new Response(null, { status: 503 }) : Response.json({ tracks: { items: [metadata] } });
    return Response.json(metadata);
  });
  try {
    for (const scenario of [
      { button: "m:spotify", query: "Rihanna Bitch Better Have My Money", plays: true },
      { button: "m:spotify", query: "https://open.spotify.com/track/0NTMtAO2BV4tnGvw9EgBVq", plays: true },
      { button: "m:play", query: "Rihanna Bitch Better Have My Money", plays: true },
      { button: "m:spotify", query: "https://youtu.be/2I3PLVuKNtw", plays: true },
      { button: "m:spotify", query: "Unavailable song", plays: false }
    ]) {
      let loads = 0;
      const i = spotifyInteractions(); i.button.customId = scenario.button;
      const session = newSession("g");
      const music = { snapshot: () => session, enqueue: (_guild: string, entry: QueueEntry) => { session.current = entry; session.state = "starting"; return 0; } } as unknown as MusicCoordinator;
      const controller = new MusicController({} as Client, music, async id => {
        loads++;
        if (id === "https://www.youtube.com/watch?v=2I3PLVuKNtw") return { loadType: LoadType.TRACK, data: { encoded: "youtube-fixture", info: { identifier: "2I3PLVuKNtw", uri: id, title: "Sastanàqqàm", author: "Tinariwen", length: 205000, position: 0, sourceName: "youtube", isStream: false, isSeekable: true }, pluginInfo: {} } };
        return { loadType: LoadType.SEARCH, data: id.startsWith("scsearch:") ? [{ encoded: "fixture", info: { identifier: "rihanna", uri: "https://soundcloud.com/rihanna/bitch-better-have-my-money", title: metadata.name, author: "Rihanna", length: metadata.duration_ms, position: 0, sourceName: "soundcloud", isStream: false, isSeekable: true }, pluginInfo: {} }] : [] };
      }, {} as MusicStorage);
      try {
        await controller.handle(i.button as unknown as Interaction);
        assert.ok(i.modal()); assert.equal(i.deferred(), false);
        await controller.handle(i.submit(scenario.query) as unknown as Interaction);
        assert.equal(Boolean(session.current), scenario.plays, scenario.query);
        if (scenario.plays) {
          const youtubeLink = scenario.query.includes("youtu.be");
          assert.equal(session.current?.recording.source, youtubeLink ? "youtube" : "spotify");
          assert.equal(session.current?.recording.identifier, youtubeLink ? "2I3PLVuKNtw" : metadata.id);
          assert.equal(session.current?.request.source, scenario.button === "m:spotify" ? "spotify" : "auto");
          assert.match(i.replies.at(-1)!.content!, /^Starting/);
        } else assert.match(i.replies.at(-1)!.content!, /No matching uploads/);
        if (scenario.button === "m:spotify") assert.equal(loads, scenario.query.includes("youtu.be") ? 1 : 0, "text source restrictions do not override an exact track link");
        else assert.ok(loads > 0, "Normal Play also searches other providers");
      } finally { controller.close(); }
    }
  } finally { [env.spotifyClientId, env.spotifyClientSecret, env.spotifyDirectEnabled] = previous; }
});
test("Choose version opens an input and shows only three options even for a clear query", async () => {
  const i = spotifyInteractions(); i.button.customId = "m:choose";
  let queued = false;
  const music = { snapshot: () => newSession("g"), enqueue: () => { queued = true; } } as unknown as MusicCoordinator;
  const controller = new MusicController({} as Client, music, async () => ({ loadType: LoadType.SEARCH, data: Array.from({ length: 12 }, (_, index) => ({ encoded: String(index), info: { identifier: String(index), uri: `https://soundcloud.com/fixture/${index}`, title: index ? "Bubbles — version " + index : "Bubbles", author: "Yosi Horikawa", length: 347508, position: 0, sourceName: "soundcloud", isStream: false, isSeekable: true }, pluginInfo: {} })) }), {} as MusicStorage);
  await controller.handle(i.button as unknown as Interaction);
  assert.ok(i.modal()); assert.equal(i.deferred(), false);
  await controller.handle(i.submit("Yosi Horikawa Bubbles") as unknown as Interaction);
  assert.equal(queued, false);
  const payload = i.replies.at(-1)!;
  assert.doesNotMatch(payload.content!, /https?:\/\//);
  assert.ok(payload.content!.length < 300);
  assert.match(payload.content!, /Select below/);
  assert.equal((payload as { flags?: number }).flags, MessageFlags.SuppressEmbeds);
  const select = payload.components![0].toJSON().components![0] as unknown as { options: Array<{ value: string }>; custom_id: string };
  assert.equal(select.options.length, 3); assert.equal(select.options[2].value, "2");
  const more = payload.components![1].toJSON().components![1].custom_id!;
  let updated = false;
  await controller.handle({ ...i.button, id: "next-choice-page", customId: more, message: { flags: { has: () => true } }, deferUpdate: async () => { updated = true; } } as unknown as Interaction);
  const next = i.replies.at(-1)!.components![0].toJSON().components![0] as unknown as typeof select;
  assert.equal(updated, true); assert.equal(next.custom_id, select.custom_id); assert.equal(next.options[0].value, "3"); assert.equal(next.options.length, 3);
});
test("unconfigured Spotify button explains setup instead of opening an unusable form", async () => {
  const previous = [env.spotifyClientId, env.spotifyClientSecret]; env.spotifyClientId = undefined; env.spotifyClientSecret = undefined;
  try {
    const i = spotifyInteractions(); const music = { snapshot: () => newSession("g") } as unknown as MusicCoordinator;
    const controller = new MusicController({} as Client, music, async () => undefined, {} as MusicStorage);
    await controller.handle(i.button as unknown as Interaction);
    assert.equal(i.modal(), undefined); assert.equal(i.deferred(), false); assert.match(i.replies[0].content!, /moderator.*setup/);
  } finally { [env.spotifyClientId, env.spotifyClientSecret] = previous; }
});
test("Spotify button opens its modal before deferring; invalid links never reach the source loader", async () => {
  const previous = [env.spotifyClientId, env.spotifyClientSecret]; env.spotifyClientId = "fixture"; env.spotifyClientSecret = "fixture";
  try {
    let loads = 0; const i = spotifyInteractions(); const music = { snapshot: () => newSession("g") } as unknown as MusicCoordinator;
    const controller = new MusicController({} as Client, music, async () => { loads++; return undefined; }, {} as MusicStorage);
    await controller.handle(i.button as unknown as Interaction);
    assert.ok(i.modal()); assert.equal(i.deferred(), false);
    await controller.handle(i.submit("https://youtube.com/watch?v=other") as unknown as Interaction);
    assert.match(i.replies.at(-1)?.content ?? "", /Paste a Spotify track link/); assert.equal(loads, 0);
  } finally { [env.spotifyClientId, env.spotifyClientSecret] = previous; }
});
test("Spotify modal submission directly queues a clear match and offers other versions", async t => {
  const previous = [env.spotifyClientId, env.spotifyClientSecret]; env.spotifyClientId = "fixture"; env.spotifyClientSecret = "fixture";
  t.mock.method(globalThis, "fetch", async (input: string | URL) => String(input).includes("api/token")
    ? Response.json({ access_token: "fixture", expires_in: 3600 })
    : Response.json({ id: "0fahUDIRujvV16hAQNtWha", name: "Bubbles", artists: [{ name: "Yosi Horikawa" }], duration_ms: 347508 }));
  try {
    let queued = false; const i = spotifyInteractions();
    const session = newSession("g");
    const music = { snapshot: () => session, enqueue: (_guild: string, entry: QueueEntry) => { queued = true; session.current = entry; session.state = "starting"; return 0; } } as unknown as MusicCoordinator;
    const controller = new MusicController({} as Client, music, async () => ({ loadType: LoadType.SEARCH, data: [{ encoded: "fixture", info: { identifier: "bubbles", uri: "https://soundcloud.com/yosi-horikawa/bubbles", title: "Bubbles", author: "Yosi Horikawa", length: 347508, position: 0, sourceName: "soundcloud", isStream: false, isSeekable: true }, pluginInfo: {} }] }), {} as MusicStorage);
    await controller.handle(i.button as unknown as Interaction);
    await controller.handle(i.submit("https://open.spotify.com/track/0fahUDIRujvV16hAQNtWha") as unknown as Interaction);
    assert.equal(queued, true);
    const ids = i.replies.at(-1)?.components?.[0].toJSON().components?.map(button => button.custom_id) ?? [];
    assert.ok(ids.some(id => id?.startsWith("try-next:"))); assert.ok(ids.some(id => id?.startsWith("versions:")));
  } finally { [env.spotifyClientId, env.spotifyClientSecret] = previous; }
});
test("Choose version reviews the selection before Play, then reports a later voice failure", async () => {
  const session = newSession("g");
  const music = { snapshot: () => session, enqueue: (_guild: string, entry: QueueEntry) => { session.current = entry; session.state = "starting"; return 0; } } as unknown as MusicCoordinator;
  const controller = new MusicController({} as Client, music, async () => undefined, {} as MusicStorage);
  const result = { request: { query: "Song", source: "youtube" as const, requestedBy: "u" }, candidates: [{ identifier: "2I3PLVuKNtw", uri: "https://www.youtube.com/watch?v=2I3PLVuKNtw", title: "Song", author: "Artist", source: "youtube" as const, durationMs: 205000, isSeekable: true, isStream: false }], direct: false, notices: [] };
  const nonce = controller["menus"].create("u", "g", { kind: "picker", result, voiceChannelId: "voice" });
  let acknowledged = false;
  const replies: Array<{ content: string; components: unknown[]; flags: number }> = [];
  const interaction = {
    id: "choose-one", guildId: "g", guild: { members: { cache: new Map([["u", { voice: { channelId: "voice" } }]]) } },
    user: { id: "u" }, channelId: env.discordMusicTextChannelId ?? "text", customId: `pick:${nonce}`, values: ["0"],
    message: { flags: { has: () => true }, edit: () => { assert.fail("ephemeral messages must use interaction editReply"); } },
    isChatInputCommand: () => false, isButton: () => false, isStringSelectMenu: () => true, isModalSubmit: () => false,
    deferUpdate: async () => { acknowledged = true; }, deferReply: () => { assert.fail("must update the original picker"); },
    editReply: async (payload: typeof replies[number]) => { replies.push(payload); }, get deferred() { return acknowledged; }
  };
  await controller.handle(interaction as unknown as Interaction);
  assert.equal(acknowledged, true); assert.equal(session.current, undefined);
  assert.match(replies.at(-1)!.content, /Press Play/);
  const confirm = (replies.at(-1)!.components[0] as { toJSON(): { components: Array<{ custom_id?: string }> } }).toJSON().components[0].custom_id!;
  await controller.handle({ ...interaction, id: "confirm-choice", customId: confirm, isStringSelectMenu: () => false, isButton: () => true } as unknown as Interaction);
  assert.match(replies.at(-1)!.content, /^Starting in <#voice>/);
  assert.deepEqual(replies.at(-1)!.components, []);
  session.state = "awaiting_choice"; session.failure = { reason: "Voice: MusicMaid needs View Channel in movies.", incidentId: "voice-incident", deadline: Date.now() + 60000 };
  controller.changed(session);
  await Promise.all([...controller["receipts"].values()].map(receipt => receipt.pending));
  assert.match(replies.at(-1)!.content, /Couldn’t start.*\nVoice:.*View Channel/);
  assert.equal(controller["receipts"].size, 0);
});
test("Play auto-selects a clear artist-title match; Try next changes it only after a click", async () => {
  const session = newSession("g"); let replacements = 0;
  const music = {
    snapshot: () => session,
    enqueue: (_guild: string, entry: QueueEntry) => { session.current = entry; session.state = "starting"; return 0; },
    chooseAlternative: (_guild: string, _old: string, entry: QueueEntry) => { replacements++; session.current = entry; }
  } as unknown as MusicCoordinator;
  const controller = new MusicController({} as Client, music, async () => undefined, {} as MusicStorage);
  const candidates = ["one", "two"].map(id => ({ identifier: id, title: "Bubbles", author: "Yosi Horikawa", uri: `https://soundcloud.com/artist/${id}`, source: "soundcloud" as const, durationMs: 347508, isStream: false, isSeekable: true }));
  const replies: Array<{ content?: string; components?: Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }> }> = [];
  const i = { id: "auto-one", guildId: "g", guild: { members: { cache: new Map([["u", { voice: { channelId: "voice" } }]]) } }, user: { id: "u" }, channelId: env.discordMusicTextChannelId ?? "text", isChatInputCommand: () => false, isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false, customId: "m:play", editReply: async (payload: typeof replies[number]) => { replies.push(payload); }, deferReply: async () => {}, deferred: true };
  await controller["presentSearch"](i as never, { request: { query: "Yosi Horikawa Bubbles", source: "auto", requestedBy: "u" }, candidates, direct: false, notices: [] }, "voice", false);
  assert.equal(session.current?.recording.uri, candidates[0].uri); assert.equal(replacements, 0);
  const next = replies.at(-1)!.components![0].toJSON().components[0].custom_id!;
  await controller.handle({ ...i, id: "try-next", customId: next } as unknown as Interaction);
  assert.equal(replacements, 1); assert.equal(session.current?.recording.uri, candidates[1].uri);
  for (const receipt of controller["receipts"].values()) clearTimeout(receipt.timer);
});
test("playback confirmation only says Playing after the coordinator confirms startup", async () => {
  const session = newSession("g");
  const entry = entryFor({ query: "Song", source: "youtube", requestedBy: "u" }, { identifier: "2I3PLVuKNtw", uri: "https://www.youtube.com/watch?v=2I3PLVuKNtw", title: "Song", author: "Artist", source: "youtube", durationMs: 205000, isSeekable: true, isStream: false });
  session.current = entry; session.state = "starting";
  const controller = new MusicController({} as Client, { snapshot: () => session } as unknown as MusicCoordinator, async () => undefined, {} as MusicStorage);
  const replies: string[] = [];
  const interaction = { id: "status", guildId: "g", editReply: async (payload: { content: string }) => { replies.push(payload.content); } };
  await controller["confirmPlayback"](interaction as never, entry, "voice");
  assert.match(replies.at(-1)!, /^Starting/);
  session.state = "playing"; controller.changed(session);
  await Promise.all([...controller["receipts"].values()].map(receipt => receipt.pending));
  assert.match(replies.at(-1)!, /^Playing in <#voice>/); assert.equal(controller["receipts"].size, 0);
});
test("an empty disconnected session does not trap the next request in its old voice channel", () => {
  const session = newSession("g"); session.voiceChannelId = "movies";
  const controller = new MusicController({} as Client, { snapshot: () => session } as unknown as MusicCoordinator, async () => undefined, {} as MusicStorage);
  const interaction = {
    guildId: "g", guild: { members: { me: { voice: { channelId: null } }, cache: new Map([["u", { voice: { channelId: "music" } }]]) } },
    user: { id: "u" }, channelId: env.discordMusicTextChannelId ?? "text",
    isChatInputCommand: () => true, commandName: "play"
  };
  assert.equal(controller["access"](interaction as never).voiceChannelId, "music");
});
test("moderator panel setup reuses and pins one public console", async () => {
  const session = newSession("g"); let sends = 0, pins = 0, edits = 0;
  const message = { id: "console", url: "https://discord.com/channels/g/text/console", pinned: false, edit: async () => { edits++; }, pin: async () => { pins++; message.pinned = true; } };
  const channel = { id: env.discordMusicTextChannelId ?? "text", isTextBased: () => true, messages: { fetch: async () => message }, send: async () => { sends++; return message; } };
  let controller: MusicController;
  const music = { snapshot: () => structuredClone(session), setPanelChannel: async (_g: string, id: string) => { session.textChannelId = id; controller.changed(session); }, setPanel: async (_g: string, id: string) => { session.panelMessageId = id; controller.changed(session); } } as unknown as MusicCoordinator;
  controller = new MusicController({ channels: { fetch: async () => channel } } as unknown as Client, music, async () => undefined, {} as MusicStorage);
  const i = { id: "panel-one", guildId: "g", guild: { members: { cache: new Map() } }, user: { id: "mod" }, memberPermissions: { has: () => true }, channelId: "text", commandName: "music-admin", options: { getSubcommand: () => "panel" }, isChatInputCommand: () => true, isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false, deferReply: async () => {}, editReply: async () => {} };
  try {
    await controller.handle(i as unknown as Interaction);
    await controller.handle({ ...i, id: "panel-two" } as unknown as Interaction);
    assert.equal(sends, 1); assert.equal(pins, 1); assert.equal(edits, 1); assert.equal(session.panelMessageId, "console");
  } finally { for (const work of controller["panels"].values()) if (work.timer) clearTimeout(work.timer); }
});

test("opening an old card or /music shows current controls without moving playback or linking the old console", async () => {
  const session = newSession("g"); session.panelMessageId = "old-console"; session.textChannelId = env.discordMusicTextChannelId ?? "text"; session.voiceChannelId = "other-voice"; session.state = "playing";
  session.current = entryFor({ query: "Latest song", source: "auto", requestedBy: "u" }, { identifier: "latest", uri: "https://soundcloud.com/artist/latest", title: "Latest song", author: "Artist", source: "soundcloud", durationMs: 180000, isStream: false, isSeekable: true });
  const values = new Map<string, string>();
  const store = { getValue: (key: string) => values.get(key), setValue: (key: string, value: string) => { values.set(key, value); } } as MusicStorage;
  values.set("music-public-player:g", JSON.stringify({ entry: session.current, messageId: "latest-playing", channelId: session.textChannelId, fingerprint: "fixture" }));
  const music = { snapshot: () => structuredClone(session) } as unknown as MusicCoordinator;
  const controller = new MusicController({} as Client, music, async () => undefined, store);
  const replies: any[] = [], acknowledgements: string[] = [];
  const common = { guildId: "g", guild: { members: { cache: new Map([["u", { voice: { channelId: null }, roles: { cache: new Map() } }]]) } }, user: { id: "u" }, channelId: session.textChannelId,
    isStringSelectMenu: () => false, isModalSubmit: () => false,
    deferReply: async (payload: { flags: number }) => { assert.equal(payload.flags, MessageFlags.Ephemeral); acknowledgements.push("reply"); },
    deferUpdate: async () => { acknowledgements.push("update"); },
    editReply: async (payload: any) => { replies.push(payload); }, reply: async (payload: any) => { replies.push(payload); }
  };
  const saved = structuredClone(session);
  try {
    await controller.handle({ ...common, id: "old-card", customId: "m:current", isButton: () => true, isChatInputCommand: () => false, message: { flags: { has: () => false } } } as unknown as Interaction);
    await controller.handle({ ...common, id: "music-command", commandName: "music", isButton: () => false, isChatInputCommand: () => true } as unknown as Interaction);
    for (const payload of replies) {
      assert.match(payload.embeds[0].toJSON().description, /Latest song/);
      const components = payload.components.flatMap((row: any) => row.toJSON().components);
      assert.equal(components.find((item: any) => item.url)?.url, `https://discord.com/channels/g/${session.textChannelId}/latest-playing`);
      assert.ok(components.some((item: any) => item.custom_id === `m:skip:${session.current!.id}`));
      assert.equal(new Set(components.map((item: any) => item.custom_id).filter(Boolean)).size, components.filter((item: any) => item.custom_id).length);
      assert.ok(payload.components.length <= 5 && payload.components.every((row: any) => row.components.length <= 5));
    }
    assert.equal(replies.length, 2); assert.deepEqual(session, saved);
    session.current = { ...session.current!, id: "new-entry" };
    await controller.handle({ ...common, id: "refresh", customId: "m:current", isButton: () => true, isChatInputCommand: () => false, message: { flags: { has: () => true } } } as unknown as Interaction);
    const refreshed = replies.at(-1).components.flatMap((row: any) => row.toJSON().components);
    assert.ok(!refreshed.some((item: any) => item.url), "during transition, neither the old card nor the console is offered as current");
    assert.ok(refreshed.some((item: any) => item.custom_id === "m:skip:new-entry"));
    assert.deepEqual(acknowledgements, ["reply", "reply", "update"]);
    session.failure = { incidentId: "fixture", reason: "Interrupted playback", deadline: Date.now() + 60000 };
    session.state = "awaiting_choice";
    await controller.handle({ ...common, id: "refresh-failed", customId: "m:current", isButton: () => true, isChatInputCommand: () => false, message: { flags: { has: () => true } } } as unknown as Interaction);
    assert.ok(replies.at(-1).components.length <= 5, "recovery actions plus private navigation fit Discord's row limit");
    if (env.discordMusicTextChannelId) {
      await controller.handle({ ...common, channelId: "another-channel", id: "outside-music", commandName: "music", isButton: () => false, isChatInputCommand: () => true } as unknown as Interaction);
      assert.match(replies.at(-1).content, /Music controls are in/);
      assert.ok(replies.at(-1).components.flatMap((row: any) => row.toJSON().components).every((item: any) => item.url), "outside the music channel, offer navigation rather than controls forbidden there");
    }
  } finally { controller.close(); }
});

test("a console refresh renders the new track if playback advances while Discord fetches the message", async () => {
  const session = newSession("g"); session.textChannelId = "text"; session.panelMessageId = "console"; session.state = "playing";
  const recording = { identifier: "one", uri: "https://soundcloud.com/artist/one", title: "First", author: "Artist", source: "soundcloud" as const, durationMs: 180000, isStream: false, isSeekable: true };
  session.current = entryFor({ query: "First", source: "auto", requestedBy: "u" }, recording);
  const edits: any[] = [], sends: any[] = [];
  const values = new Map<string, string>();
  const store = { getValue: (key: string) => values.get(key), setValue: (key: string, value: string) => { values.set(key, value); } } as MusicStorage;
  const channel = { id: "text", isTextBased: () => true, send: async (payload: any) => { sends.push(payload); return { id: "latest" }; }, messages: { fetch: async () => {
    session.current = entryFor({ query: "Second", source: "auto", requestedBy: "u" }, { ...recording, identifier: "two", title: "Second" });
    return { edit: async (payload: any) => { edits.push(payload); } };
  } } };
  const controller = new MusicController({ channels: { fetch: async () => channel } } as unknown as Client, { snapshot: () => structuredClone(session) } as unknown as MusicCoordinator, async () => undefined, store);
  controller["panels"].set("g", { dirty: false, running: false });
  try {
    await controller["updatePanel"]("g");
    assert.equal(edits.length, 1); assert.equal(sends.length, 1);
    assert.match(edits[0].embeds[0].toJSON().description, /Second/);
    assert.match(sends[0].embeds[0].toJSON().description, /Second/);
    assert.doesNotMatch(JSON.stringify(sends[0]), /First/);
  } finally { controller.close(); }
});
