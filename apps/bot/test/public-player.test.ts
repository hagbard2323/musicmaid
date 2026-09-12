import { test } from "node:test";
import assert from "node:assert/strict";
import { EmbedBuilder } from "discord.js";
import { PublicPlayerFeed } from "../src/commands/public-player.js";
import { entryFor, newSession } from "../src/audio/model.js";
import type { MusicStorage } from "../src/storage/types.js";

const song = (title: string) => entryFor({ query: title, requestedBy: "user", source: "auto" }, { title, author: "Artist", identifier: title, uri: "https://soundcloud.com/artist/" + title, source: "soundcloud", durationMs: 180000, isStream: false, isSeekable: true });
test("public player posts once per track, updates queue changes, and preserves earlier cards", async () => {
  const values = new Map<string, string>();
  const store = { getValue: (key: string) => values.get(key), setValue: (key: string, value: string) => { values.set(key, value); } } as MusicStorage;
  const sent: unknown[] = [], edits = new Map<string, unknown[]>();
  const channel = {
    id: "text",
    send: async (payload: unknown) => { sent.push(payload); const id = String(sent.length); edits.set(id, []); return { id }; },
    messages: { fetch: async (id: string) => ({ edit: async (payload: unknown) => { edits.get(id)!.push(payload); } }) }
  };
  const render = () => ({ embeds: [new EmbedBuilder().setTitle("Player").addFields({ name: "Playback", value: "playing" }, { name: "Up next", value: "queue" })], components: [] });
  const feed = new PublicPlayerFeed(store, render);
  const s = newSession("guild"); s.textChannelId = "text"; s.current = song("one"); s.state = "starting";
  await feed.update(channel, s); assert.equal(sent.length, 0);
  s.state = "playing"; await feed.update(channel, s); assert.equal(sent.length, 1);
  s.positionMs = 10000; await feed.update(channel, s); assert.equal(sent.length, 1); assert.equal(edits.get("1")!.length, 0);
  s.queue.push(song("two")); await feed.update(channel, s); assert.equal(edits.get("1")!.length, 1);
  const restored = new PublicPlayerFeed(store, render); await restored.update(channel, s); assert.equal(sent.length, 1);
  s.history.unshift({ id: "history", entry: s.current!, outcome: "finished", at: Date.now() });
  s.current = s.queue.shift(); await restored.update(channel, s); assert.equal(sent.length, 2);
  const previous = edits.get("1")!.at(-1) as { embeds: EmbedBuilder[] };
  assert.equal(previous.embeds[0].toJSON().title, "Played"); assert.equal(previous.embeds[0].toJSON().fields?.length, 0);
});

test('finished cards resolve the current player on click and never retain old links or skip controls', async () => {
  const values = new Map<string, string>();
  const store = { getValue: (key: string) => values.get(key), setValue: (key: string, value: string) => { values.set(key, value); } } as MusicStorage;
  let edited: any;
  const channel = { id: 'text', send: async () => ({ id: 'playing' }), messages: { fetch: async () => ({ edit: async (payload: any) => { edited = payload; } }) } };
  const render = () => ({ embeds: [new EmbedBuilder().setTitle('Player')], components: [] });
  const feed = new PublicPlayerFeed(store, render); const s = newSession('guild'); s.panelMessageId = 'console'; s.textChannelId = 'text'; s.current = song('one'); s.state = 'playing';
  await feed.update(channel, s); s.history.unshift({ id: 'h', entry: s.current, outcome: 'finished', at: Date.now() }); s.current = undefined; s.state = 'idle'; await feed.update(channel, s);
  const buttons = edited.components[0].toJSON().components;
  assert.equal(buttons[0].label, 'Open current player'); assert.equal(buttons[0].custom_id, 'm:current'); assert.equal(buttons[0].url, undefined);
  assert.equal(buttons.find((b: any) => b.custom_id === 'm:play')?.label, 'Add music');
  assert.ok(!buttons.some((b: any) => b.custom_id?.includes('skip')));
});

test('navigation uses only the matching current card, including after restart or between tracks', async () => {
  const values = new Map<string, string>();
  const store = { getValue: (key: string) => values.get(key), setValue: (key: string, value: string) => { values.set(key, value); } } as MusicStorage;
  let sent = 0;
  const channel = { id: 'text', send: async () => ({ id: `playing-${++sent}` }), messages: { fetch: async () => ({ edit: async () => {} }) } };
  const render = () => ({ embeds: [new EmbedBuilder().setTitle('Player')], components: [] });
  const feed = new PublicPlayerFeed(store, render);
  const s = newSession('guild'); s.textChannelId = 'text'; s.panelMessageId = 'old-console'; s.current = song('one'); s.state = 'playing';
  await feed.update(channel, s);
  assert.deepEqual(feed.currentMessage(s), { messageId: 'playing-1', channelId: 'text' });
  s.current = song('two'); s.state = 'starting';
  assert.equal(feed.currentMessage(s), undefined, 'the previous card must not be offered while the next one is starting');
  await feed.update(channel, s); assert.equal(sent, 1);
  s.state = 'playing'; await feed.update(channel, s);
  const restored = new PublicPlayerFeed(store, render);
  assert.deepEqual(restored.currentMessage(s), { messageId: 'playing-2', channelId: 'text' });
  assert.equal(sent, 2);
  s.textChannelId = 'elsewhere'; assert.equal(restored.currentMessage(s), undefined);
  s.current = undefined; assert.equal(restored.currentMessage(s), undefined);
});

test('a track transition during Discord fetch cannot repaint an obsolete playing card', async () => {
  const values = new Map<string, string>();
  const store = { getValue: (key: string) => values.get(key), setValue: (key: string, value: string) => { values.set(key, value); } } as MusicStorage;
  const s = newSession('guild'); s.textChannelId = 'text'; s.current = song('one'); s.state = 'playing';
  const edits: string[] = [], sends: string[] = [];
  let transition: (() => void) | undefined;
  const channel = {
    id: 'text', send: async (payload: any) => { sends.push(payload.embeds[0].toJSON().description); return { id: String(sends.length) }; },
    messages: { fetch: async () => { transition?.(); transition = undefined; return { edit: async (payload: any) => { edits.push(payload.embeds[0].toJSON().title); } }; } }
  };
  const feed = new PublicPlayerFeed(store, session => ({ embeds: [new EmbedBuilder().setTitle('Player').setDescription(session.current!.recording.title)], components: [] }));
  await feed.update(channel, structuredClone(s), () => structuredClone(s));
  s.volume = 90;
  transition = () => { s.history.unshift({ id: 'h', entry: s.current!, outcome: 'finished', at: Date.now() }); s.current = song('two'); };
  await feed.update(channel, structuredClone(s), () => structuredClone(s));
  assert.deepEqual(edits, [], 'fetch completed after the old track ended');
  assert.deepEqual(sends, ['one']);
  assert.equal(feed.currentMessage(s), undefined);
  await feed.update(channel, structuredClone(s), () => structuredClone(s));
  assert.deepEqual(edits, ['Played']); assert.deepEqual(sends, ['one', 'two']);
  assert.deepEqual(feed.currentMessage(s), { messageId: '2', channelId: 'text' });
});

test('archiving a previous card cannot post a track that ended while Discord was editing', async () => {
  const values = new Map<string, string>();
  const store = { getValue: (key: string) => values.get(key), setValue: (key: string, value: string) => { values.set(key, value); } } as MusicStorage;
  const s = newSession('guild'); s.textChannelId = 'text'; s.current = song('one'); s.state = 'playing';
  const titles: string[] = [];
  const channel = { id: 'text', send: async (payload: any) => { titles.push(payload.embeds[0].toJSON().description); return { id: String(titles.length) }; }, messages: { fetch: async () => ({ edit: async () => { s.current = song('three'); } }) } };
  const feed = new PublicPlayerFeed(store, session => ({ embeds: [new EmbedBuilder().setTitle('Player').setDescription(session.current!.recording.title)], components: [] }));
  await feed.update(channel, structuredClone(s), () => structuredClone(s));
  s.current = song('two');
  await feed.update(channel, structuredClone(s), () => structuredClone(s));
  assert.deepEqual(titles, ['one', 'three']);
  assert.deepEqual(feed.currentMessage(s), { messageId: '2', channelId: 'text' });
});

test('public progress refreshes at a bounded cadence and queue policy changes stay visible without new posts', async () => {
  const values = new Map<string, string>();
  const store = { getValue: (key: string) => values.get(key), setValue: (key: string, value: string) => { values.set(key, value); } } as MusicStorage;
  let sends = 0, edits = 0;
  const channel = { id: 'text', send: async () => { sends++; return { id: 'player' }; }, messages: { fetch: async () => ({ edit: async () => { edits++; } }) } };
  const feed = new PublicPlayerFeed(store, () => ({ embeds: [new EmbedBuilder().setTitle('Player')], components: [] }));
  const s = newSession('g'); s.textChannelId = 'text'; s.current = song('one'); s.state = 'playing';
  await feed.update(channel, s);
  for (const position of [5000, 10000, 14000]) { s.positionMs = position; await feed.update(channel, s); }
  assert.equal(edits, 0);
  s.positionMs = 15000; await feed.update(channel, s); assert.equal(edits, 1);
  s.queueMode = 'fair'; await feed.update(channel, s); assert.equal(edits, 2);
  assert.equal(sends, 1);
});
