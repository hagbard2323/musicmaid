import { test } from "node:test";
import assert from "node:assert/strict";
import { type Client, type Interaction } from "discord.js";
import { MusicController } from "../src/commands/music.js";
import { MusicCoordinator, type PlaybackBackend } from "../src/audio/coordinator.js";
import { entryFor, newSession, type Session } from "../src/audio/model.js";
import type { MusicStorage } from "../src/storage/types.js";
import { env } from "../src/config/env.js";

const song = (index: number) => entryFor({ query: `Song ${index}`, source: "auto", requestedBy: "u" }, { identifier: `song-${index}`, uri: `https://soundcloud.com/artist/song-${index}`, title: `Song ${String(index).padStart(2, "0")}`, author: "Artist", source: "soundcloud", durationMs: 180000, isStream: false, isSeekable: true });
const controls = (payload: any): any[] => payload.components.flatMap((row: any) => row.toJSON().components);
function fixture(count = 21) {
  const initial = newSession("g"); initial.current = song(0); initial.queue = Array.from({ length: count }, (_, index) => song(index + 1)); initial.voiceChannelId = "voice"; initial.textChannelId = env.discordMusicTextChannelId ?? "text";
  let writes = 0, starts = 0, sequence = 0;
  const storage: MusicStorage = { loadSessions: () => [structuredClone(initial)], saveSession: (_session: Session) => { writes++; }, getValue: () => undefined, setValue: () => {}, close: () => {} };
  const backend: PlaybackBackend = { start: async () => { starts++; }, stop: async () => {}, pause: async () => {}, seek: async () => {}, volume: async () => {} };
  const music = new MusicCoordinator(storage, backend);
  const controller = new MusicController({} as Client, music, async () => undefined, storage, async () => {}, "g");
  const replies: any[] = [], acknowledgements: string[] = [], modals: any[] = [];
  const make = (customId: string, kind: "button" | "select" | "modal" = "button", value?: string) => {
    let deferred = false;
    return {
      id: `queue-${++sequence}`, customId, guildId: "g", channelId: initial.textChannelId, user: { id: "u" },
      guild: { members: { cache: new Map([["u", { voice: { channelId: "voice" }, roles: { cache: new Map() } }]]) } }, memberPermissions: { has: () => true },
      isChatInputCommand: () => false, isButton: () => kind === "button", isStringSelectMenu: () => kind === "select", isModalSubmit: () => kind === "modal", isFromMessage: () => kind === "modal",
      values: value ? [value] : [], fields: { getTextInputValue: () => value }, message: { flags: { has: () => true } }, get deferred() { return deferred; },
      deferReply: async () => { deferred = true; acknowledgements.push("reply"); }, deferUpdate: async () => { deferred = true; acknowledgements.push("update"); },
      showModal: async (modal: any) => { acknowledgements.push("modal"); modals.push(modal); },
      editReply: async (payload: any) => { replies.push(payload); }, reply: async (payload: any) => { replies.push(payload); },
    };
  };
  const invoke = async (customId: string, kind?: "button" | "select" | "modal", value?: string) => { await controller.handle(make(customId, kind, value) as unknown as Interaction); return replies.at(-1); };
  const find = (prefix: string) => controls(replies.at(-1)).find(item => item.custom_id?.startsWith(prefix));
  const selected = () => find("qselect:")?.options.find((option: any) => option.default)?.value;
  const choose = async (id: string) => { await invoke("m:queue"); await invoke(find("qselect:").custom_id, "select", id); };
  return { initial, controller, music, replies, acknowledgements, modals, invoke, find, selected, choose, writes: () => writes, starts: () => starts };
}

test("selecting a queue entry retains the full queue and highlights its stable ID", async () => {
  const h = fixture(); const target = h.initial.queue[3];
  try {
    await h.choose(target.id);
    const payload = h.replies.at(-1);
    assert.match(payload.content, /Song 01/); assert.match(payload.content, /Song 10/); assert.match(payload.content, /21 queued/);
    assert.match(payload.content, /Selected #4: Song 04/); assert.equal(h.selected(), target.id);
    assert.ok(h.find("qedit:up:")); assert.ok(h.find("qedit:remove:")); assert.ok(h.find("qpage:next:")); assert.ok(h.find("pl:save"));
    assert.ok(payload.components.length <= 5 && payload.components.every((row: any) => row.components.length <= 5));
    const ids = controls(payload).map(component => component.custom_id); assert.equal(new Set(ids).size, ids.length);
    assert.equal(h.writes(), 0); assert.equal(h.starts(), 0);
  } finally { h.controller.close(); }
});

test("moving across a page boundary follows the same selected entry and supports another move immediately", async () => {
  const h = fixture(); const target = h.initial.queue[9];
  try {
    await h.choose(target.id); await h.invoke(h.find("qedit:down:").custom_id);
    assert.equal(h.music.snapshot("g").queue[10].id, target.id); assert.equal(h.selected(), target.id);
    assert.match(h.replies.at(-1).content, /Page 2/); assert.match(h.replies.at(-1).content, /Selected #11:/);
    await h.invoke(h.find("qedit:down:").custom_id);
    assert.equal(h.music.snapshot("g").queue[11].id, target.id); assert.equal(h.selected(), target.id);
    assert.equal(h.writes(), 2); assert.equal(h.starts(), 0); assert.equal(h.music.snapshot("g").current?.id, h.initial.current?.id);
  } finally { h.controller.close(); }
});

test("Move to updates the original private queue, follows the destination and retains selection on invalid input", async t => {
  t.mock.method(console, "info", () => {});
  const h = fixture(); const target = h.initial.queue[1];
  try {
    await h.choose(target.id);
    const before = h.replies.at(-1); await h.invoke(h.find("qmove:").custom_id);
    assert.equal(h.replies.at(-1), before, "opening the modal must not replace the queue with a detached editor");
    await h.invoke(h.modals.at(-1).toJSON().custom_id, "modal", "20");
    assert.equal(h.acknowledgements.at(-1), "update"); assert.equal(h.selected(), target.id);
    assert.equal(h.music.snapshot("g").queue[19].id, target.id); assert.match(h.replies.at(-1).content, /Page 2/);
    await h.invoke(h.find("qmove:").custom_id); await h.invoke(h.modals.at(-1).toJSON().custom_id, "modal", "999");
    assert.equal(h.selected(), target.id); assert.match(h.replies.at(-1).content, /Incident/); assert.match(h.replies.at(-1).content, /21 queued/);
    assert.equal(h.writes(), 1);
  } finally { h.controller.close(); }
});

test("stale edits refresh the current location of the selected entry without applying the old action", async () => {
  const h = fixture(); const target = h.initial.queue[3];
  try {
    await h.choose(target.id); const oldMove = h.find("qedit:up:").custom_id;
    await h.music.editQueue("g", h.music.snapshot("g").revision, "move", target.id, 13);
    const revision = h.music.snapshot("g").revision;
    await h.invoke(oldMove);
    assert.equal(h.music.snapshot("g").revision, revision); assert.equal(h.music.snapshot("g").queue[12].id, target.id);
    assert.equal(h.selected(), target.id); assert.match(h.replies.at(-1).content, /Page 2/); assert.match(h.replies.at(-1).content, /No edit was applied/);
    await h.invoke(oldMove); assert.equal(h.music.snapshot("g").revision, revision);
    assert.equal(h.writes(), 1);
  } finally { h.controller.close(); }
});

test("removal keeps the queue visible and never selects or removes a different song implicitly", async () => {
  const h = fixture(); const target = h.initial.queue[2];
  try {
    await h.choose(target.id); const remove = h.find("qedit:remove:").custom_id;
    await h.invoke(remove);
    assert.equal(h.music.snapshot("g").queue.length, 20); assert.equal(h.selected(), undefined);
    assert.match(h.replies.at(-1).content, /20 queued/); assert.match(h.replies.at(-1).content, /selected song has left/);
    assert.equal(h.find("qedit:remove:"), undefined);
    await h.invoke(remove); assert.equal(h.music.snapshot("g").queue.length, 20); assert.equal(h.writes(), 1);
  } finally { h.controller.close(); }
});

test("pagination retains the selection and Show selected returns to its page without a mutation", async () => {
  const h = fixture(); const target = h.initial.queue[2];
  try {
    await h.choose(target.id); await h.invoke(h.find("qpage:next:").custom_id);
    assert.match(h.replies.at(-1).content, /Page 2/); assert.match(h.replies.at(-1).content, /Selected #3:/);
    assert.equal(h.selected(), undefined, "a default must never refer to an option missing from this page");
    assert.ok(h.find("qedit:remove:")); await h.invoke(h.find("qpage:selected:").custom_id);
    assert.match(h.replies.at(-1).content, /Page 1/); assert.equal(h.selected(), target.id); assert.equal(h.writes(), 0);
  } finally { h.controller.close(); }
});

test("a policy change retains the selected entry and fair mode disables ordering without hiding the queue", async () => {
  const h = fixture(); const target = h.initial.queue[4];
  try {
    await h.choose(target.id); await h.invoke(h.find("qmode:fair:").custom_id);
    assert.equal(h.music.snapshot("g").queueMode, "fair"); assert.equal(h.selected(), target.id);
    for (const prefix of ["qedit:up:", "qedit:down:", "qmove:", "qedit:next:", "qedit:shuffle:"]) assert.equal(h.find(prefix).disabled, true);
    assert.ok(h.find("qedit:remove:")); assert.match(h.replies.at(-1).content, /21 queued/);
    await h.invoke(h.find("qmode:fifo:").custom_id); assert.equal(h.music.snapshot("g").queueMode, "fifo"); assert.equal(h.selected(), target.id);
  } finally { h.controller.close(); }
});
