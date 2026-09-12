import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LibraryController } from '../src/commands/library.js';
import { SqliteMusicStorage } from '../src/storage/sqlite-storage.js';
import { MusicCoordinator } from '../src/audio/coordinator.js';
import { entryFor } from '../src/audio/model.js';
import { exportPlaylistDocument, fetchPlaylistAttachment, parsePlaylistDocument } from '../src/storage/playlist-document.js';

const track = () => entryFor({ query: 'private original search', source: 'youtube', requestedBy: 'alice' }, { source: 'youtube', identifier: '2I3PLVuKNtw', uri: 'https://www.youtube.com/watch?v=2I3PLVuKNtw', title: 'Sastanàqqàm', author: 'Tinariwen', durationMs: 205000, isStream: false, isSeekable: true });
const customIds = (payload: any): string[] => payload.components.flatMap((row: any) => row.toJSON().components.map((component: any) => component.custom_id));
function setup() {
  const store = new SqliteMusicStorage(':memory:'); let starts = 0;
  const music = new MusicCoordinator(store, { start: async () => { starts++; }, stop: async () => {}, pause: async () => {}, seek: async () => {}, volume: async () => {} });
  let content = exportPlaylistDocument({ name: 'Shared document', entries: [track(), track()] }).json;
  const attachment = () => ({ id: '20000001', name: 'playlist.json', url: 'https://cdn.discordapp.com/attachments/10000001/20000001/playlist.json', size: content.length });
  const voiceChecks: boolean[] = [];
  const controller = new LibraryController(music, store.library, async () => undefined, (_interaction, voice) => { voiceChecks.push(voice); return { guildId: 'guild', voiceChannelId: 'voice' }; }, i => i.user.id === 'moderator',
    (file, signal) => fetchPlaylistAttachment(file, signal, async () => new Response(content)));
  const output: any[] = []; let modal: any, deferred = false;
  const make = (id: string, user = 'bob', type = 'button', fields: Record<string, string> = {}, values: string[] = []) => ({
    id, customId: id, guildId: 'guild', channelId: 'text', user: { id: user }, values,
    message: { flags: { has: () => true } },
    fields: { getTextInputValue: (name: string) => fields[name] ?? '', getUploadedFiles: () => ({ size: 1, first: attachment }) },
    isChatInputCommand: () => type === 'command', isButton: () => type === 'button', isModalSubmit: () => type === 'modal', isStringSelectMenu: () => type === 'select',
    showModal: async (value: any) => { assert.equal(deferred, false); modal = value.toJSON(); }, deferUpdate: async () => { deferred = true; }, deferReply: async () => { deferred = true; },
    editReply: async (value: any) => { output.push(value); }
  });
  return { store, music, controller, output, voiceChecks, attachment, make, modal: () => modal, starts: () => starts, setContent: (value: Buffer) => { content = value; }, reset: () => { deferred = false; } };
}

test('members export another creator’s playlist without voice access or editing its history/ownership', async () => {
  const h = setup();
  try {
    const list = h.store.library.create('guild', 'alice', 'Everyone can export', [track()]);
    await h.controller.handle(h.make('pl:open', 'bob', 'select', {}, [list.id]) as never);
    const detail = h.output.at(-1), exportButton = customIds(detail).find(id => id.startsWith('pl:export:'))!;
    assert.match(detail.embeds[0].toJSON().fields.find((field: any) => field.name === 'Access').value, /creator and moderators/);
    await h.controller.handle(h.make(exportButton) as never);
    const exported = h.output.at(-1);
    assert.equal(exported.files.length, 2);
    assert.equal(parsePlaylistDocument(exported.files[0].attachment).tracks.length, 1);
    assert.equal(exported.files[0].attachment.includes('alice'), false);
    assert.deepEqual(h.store.library.get('guild', list.id), list);
    assert.equal(h.starts(), 0); assert.equal(h.voiceChecks.some(Boolean), false);
    await h.controller.handle(h.make(customIds(exported)[0]) as never);
    assert.deepEqual(h.output.at(-1).attachments, [], 'Returning to the playlist clears old export attachments.');
  } finally { h.controller.close(); h.store.close(); }
});

test('native JSON upload modal creates a new importer-owned playlist without autoplay or partial saves', async () => {
  const h = setup();
  try {
    await h.controller.handle(h.make('pl:importfile') as never);
    assert.equal(h.modal().components[0].type, 18);
    assert.equal(h.modal().components[0].component.type, 19);
    assert.equal(h.modal().components[0].component.max_values, 1);
    await h.controller.handle(h.make(h.modal().custom_id, 'bob', 'modal', { name: 'My imported copy' }) as never);
    const saved = h.store.library.list('guild')[0];
    assert.equal(saved.creatorId, 'bob'); assert.equal(saved.name, 'My imported copy'); assert.equal(saved.entries.length, 2);
    assert.equal(new Set(saved.entries.map(entry => entry.id)).size, 2);
    assert.equal(h.starts(), 0); assert.deepEqual(h.music.snapshot('guild').queue, []);
    assert.match(h.output.at(-1).content, /Nothing was queued/);

    h.reset(); await h.controller.handle(h.make('pl:importfile') as never);
    const corrupt = exportPlaylistDocument({ name: 'Never saved', entries: [track()] }).document;
    (corrupt.tracks[0] as any).request = { requestedBy: 'someone-else' };
    h.setContent(Buffer.from(JSON.stringify(corrupt)));
    await assert.rejects(h.controller.handle(h.make(h.modal().custom_id, 'bob', 'modal') as never), /supported MusicMaid/);
    assert.equal(h.store.library.list('guild').length, 1);
    assert.deepEqual(h.store.library.get('guild', saved.id), saved);
  } finally { h.controller.close(); h.store.close(); }
});

test('playlist detail adds the playing recording for editors while preserving playback and refusing forged edits', async () => {
  const h = setup();
  try {
    const current = track(); await h.music.enqueue('guild', current, 'voice', 'text');
    const list = h.store.library.create('guild', 'alice', 'Owned');
    await h.controller.handle(h.make('pl:open', 'bob', 'select', {}, [list.id]) as never);
    let add = customIds(h.output.at(-1)).find(id => id.startsWith('pl:addcurrent:'))!;
    await assert.rejects(h.controller.handle(h.make(add) as never), /creator or a moderator/);
    await h.controller.handle(h.make('pl:open', 'alice', 'select', {}, [list.id]) as never);
    add = customIds(h.output.at(-1)).find(id => id.startsWith('pl:addcurrent:'))!;
    await h.controller.handle(h.make(add, 'alice') as never);
    assert.equal(h.store.library.get('guild', list.id).entries[0].recording.identifier, current.recording.identifier);
    assert.equal(h.music.snapshot('guild').current?.id, current.id); assert.equal(h.starts(), 1);
    const controls = customIds(h.output.at(-1)); assert.equal(new Set(controls).size, controls.length);
    assert.ok(h.output.at(-1).components.every((row: any) => row.toJSON().components.length <= 5));
  } finally { h.controller.close(); h.store.close(); }
});

test('slash attachment import and name-based export work without internal playlist IDs', async () => {
  const h = setup();
  try {
    const command = (subcommand: string, name: string) => ({ ...h.make('command', 'bob', 'command'), commandName: 'playlist', options: {
      getSubcommand: () => subcommand, getAttachment: () => h.attachment(), getString: () => name
    } });
    await h.controller.handle(command('import-file', 'A portable list') as never);
    assert.equal(h.store.library.list('guild')[0].name, 'A portable list');
    await h.controller.handle(command('export', 'A PORTABLE LIST') as never);
    assert.equal(h.output.at(-1).files[0].name, 'musicmaid-playlist.json');
    assert.equal(h.starts(), 0);
  } finally { h.controller.close(); h.store.close(); }
});

test('shutdown during JSON download never creates a partial or delayed playlist', async () => {
  const h = setup(); let finish!: (document: ReturnType<typeof parsePlaylistDocument>) => void;
  try {
    h.controller['fetchFile'] = async () => new Promise(resolve => { finish = resolve; });
    await h.controller.handle(h.make('pl:importfile') as never);
    const pending = h.controller.handle(h.make(h.modal().custom_id, 'bob', 'modal') as never);
    await new Promise(resolve => setImmediate(resolve));
    h.controller.close();
    finish(exportPlaylistDocument({ name: 'Must not appear', entries: [track()] }).document);
    await assert.rejects(pending);
    assert.equal(h.store.library.list('guild').length, 0);
    assert.equal(h.starts(), 0);
  } finally { h.controller.close(); h.store.close(); }
});
