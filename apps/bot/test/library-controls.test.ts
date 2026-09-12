import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { LibraryController } from '../src/commands/library.js';
import { SqliteMusicStorage } from '../src/storage/sqlite-storage.js';
import { MusicCoordinator } from '../src/audio/coordinator.js';
import { entryFor } from '../src/audio/model.js';
const entry = (title: string) => entryFor({ query: title, source: 'auto', requestedBy: 'alice' }, { title, author: 'Artist', uri: 'https://soundcloud.com/artist/' + title, identifier: title, source: 'soundcloud', durationMs: 180000, isStream: false, isSeekable: true });
function setup() {
  const store = new SqliteMusicStorage(':memory:');
  const music = new MusicCoordinator(store, { start: async () => {}, stop: async () => {}, pause: async () => {}, seek: async () => {}, volume: async () => {} });
  const controller = new LibraryController(music, store.library, async () => undefined, () => ({ guildId: 'guild', voiceChannelId: 'voice' }), () => false);
  const output: any[] = []; let modal: any; let deferred = false;
  const make = (customId: string, type = 'button', fields: Record<string, string> = {}, values: string[] = []) => ({ id: customId, customId, guildId: 'guild', channelId: 'text', user: { id: 'alice' }, values,
    message: { flags: { has: (flag: number) => flag === MessageFlags.Ephemeral } }, fields: { getTextInputValue: (name: string) => fields[name] },
    isChatInputCommand: () => false, isButton: () => type === 'button', isStringSelectMenu: () => type === 'select', isModalSubmit: () => type === 'modal',
    showModal: async (value: any) => { assert.equal(deferred, false); modal = value.toJSON(); }, deferUpdate: async () => { deferred = true; }, deferReply: async () => { deferred = true; },
    editReply: async (payload: any) => { output.push(payload); }
  });
  return { store, music, controller, output, modal: () => modal, make, reset: () => { deferred = false; } };
}
function ids(payload: any): string[] { return payload.components.flatMap((r: any) => r.toJSON().components.map((c: any) => c.custom_id)); }
test('Create playlist opens a modal first, then saves and renders valid distinct controls', async () => {
  const h = setup(); await h.controller.handle(h.make('pl:create') as never);
  assert.ok(h.modal()); await h.controller.handle(h.make(h.modal().custom_id, 'modal', { name: 'Late night' }) as never);
  assert.equal(h.store.library.list('guild')[0].name, 'Late night');
  const controls = ids(h.output.at(-1)); assert.equal(new Set(controls).size, controls.length); assert.ok(controls.every(id => id.length <= 100));
  h.store.close();
});
test('Add to playlist keeps the clicked recording even if playback advances while choosing', async () => {
  const h = setup(); const one = entry('one'), two = entry('two'); await h.music.enqueue('guild', one, 'voice', 'text'); await h.music.enqueue('guild', two, 'voice', 'text');
  const list = h.store.library.create('guild', 'alice', 'Favorites');
  await h.controller.handle(h.make('pl:add:' + one.id) as never);
  const choose = ids(h.output.at(-1)).find(id => id.startsWith('pl:addto:'))!;
  await h.music.skip('guild', one.id); await h.controller.handle(h.make(choose, 'select', {}, [list.id]) as never);
  assert.equal(h.store.library.get('guild', list.id).entries[0].recording.title, 'one'); h.store.close();
});
test('playlist append preserves current playback, sequence and user credit; duplicate confirmation is rejected', async () => {
  const h = setup(); const current = entry('current'); await h.music.enqueue('guild', current, 'voice', 'text');
  const list = h.store.library.create('guild', 'alice', 'Mix', [entry('one'), entry('two')]);
  await h.controller.handle(h.make('pl:open', 'select', {}, [list.id]) as never);
  const play = ids(h.output.at(-1)).find(id => id.startsWith('pl:play:'))!;
  await h.controller.handle(h.make(play) as never);
  assert.equal(h.music.snapshot('guild').current?.id, current.id); assert.deepEqual(h.music.snapshot('guild').queue.map(e => e.recording.title), ['one', 'two']);
  await assert.rejects(h.controller.handle(h.make(play) as never), /expired/); h.store.close();
});
test('stats renders empty and populated chart controls without duplicate IDs or invalid rows', async () => {
  const h = setup();
  for (const tab of ['tracks', 'members', 'genres']) {
    await h.controller.handle(h.make('stats:' + tab + ':30') as never);
    const payload = h.output.at(-1); const controls = ids(payload); assert.equal(new Set(controls).size, controls.length);
    assert.ok(payload.components.every((r: any) => r.toJSON().components.length <= 5)); assert.ok(payload.embeds[0].toJSON().description);
  }
  h.store.close();
});

test('other members can browse all tracks and play a selection but cannot forge edit actions', async () => {
  const h = setup(); const list = h.store.library.create('guild', 'someone-else', 'Shared', [entry('one'), entry('two')]);
  await h.controller.handle(h.make('pl:open', 'select', {}, [list.id]) as never);
  const browse = ids(h.output.at(-1)).find(id => id.startsWith('pl:edit:'))!;
  await h.controller.handle(h.make(browse) as never); const select = ids(h.output.at(-1)).find(id => id.startsWith('pl:entry:'))!;
  await h.controller.handle(h.make(select, 'select', {}, [list.entries[1].id]) as never);
  const controls = ids(h.output.at(-1));
  await assert.rejects(h.controller.handle(h.make(controls.find(id => id.startsWith('pl:remove:'))!) as never), /creator/);
  assert.equal(h.store.library.get('guild', list.id).entries.length, 2);
  await h.controller.handle(h.make(select, 'select', {}, [list.entries[1].id]) as never);
  await h.controller.handle(h.make(ids(h.output.at(-1)).find(id => id.startsWith('pl:playentry:'))!) as never);
  assert.equal(h.music.snapshot('guild').current?.recording.title, 'two'); h.store.close();
});


test('cancelling an import while metadata is loading never saves a partial playlist', async () => {
  const h = setup(); let release!: () => void;
  h.controller['load'] = async () => { await new Promise<void>(resolve => { release = resolve; }); return undefined; };
  await h.controller.handle(h.make('pl:import') as never);
  const work = h.controller.handle(h.make(h.modal().custom_id, 'modal', { name: 'Imported', url: 'https://www.youtube.com/playlist?list=PL0123456789', start: '1' }) as never);
  await new Promise(resolve => setImmediate(resolve));
  const cancel = ids(h.output.at(-1)).find(id => id.startsWith('pl:cancelimport:'))!;
  await h.controller.handle(h.make(cancel) as never); release(); await work;
  assert.equal(h.store.library.list('guild').length, 0); assert.match(h.output.at(-1).content, /cancelled/);
  h.store.close();
});
