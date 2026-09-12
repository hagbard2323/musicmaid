import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, FileUploadBuilder, LabelBuilder, MessageFlags, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, type ButtonInteraction, type ChatInputCommandInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { duration, entryFor, type QueueEntry } from '../audio/model.js';
import type { MusicCoordinator } from '../audio/coordinator.js';
import type { Loader } from '../audio/sources.js';
import { importPlaylist, type PlaylistImport } from '../audio/playlist-import.js';
import type { LibraryStorage, SavedPlaylist } from '../storage/library.js';
import { exportPlaylistDocument, fetchPlaylistAttachment, playlistDocumentEntries, type PlaylistAttachment } from '../storage/playlist-document.js';
import { InteractionState } from './interaction-state.js';
import { metadataText } from './metadata-text.js';
type UI = ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction | StringSelectMenuInteraction;
export type LibraryAccess = (i: UI, voice: boolean) => { guildId: string; voiceChannelId: string };
type Menu = { kind: string; playlistId?: string; revision?: number; entryId?: string; entries?: QueueEntry[]; name?: string; result?: PlaylistImport; jobId?: string };
const b = (id: string, label: string, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
const safe = (value: string, limit = 160) => metadataText(value, limit);
const field = (id: string, label: string, max = 60, value?: string) => {
  const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(max);
  if (value) input.setValue(value); return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
};
export class LibraryController {
  private menus = new InteractionState<Menu>();
  private jobs = new Map<string, { id: string; cancel: AbortController }>();
  constructor(private music: MusicCoordinator, private store: LibraryStorage, private load: Loader, private access: LibraryAccess, private isMod: (i: UI) => boolean, private fetchFile = fetchPlaylistAttachment) {}
  handles(i: UI): boolean { return i.isChatInputCommand() ? ['playlist', 'music-stats'].includes(i.commandName) : /^(pl|stats):/.test(i.customId); }
  close(): void { for (const job of this.jobs.values()) job.cancel.abort(); }
  private remember(i: UI, menu: Menu, ttl = 120_000): string { return this.menus.create(i.user.id, i.guildId!, menu, ttl); }
  private read(i: UI, id: string | undefined, consume = false): Menu { return this.menus.read(id ?? "", i.user.id, i.guildId!, consume); }
  private editable(i: UI, list: SavedPlaylist): boolean { return list.creatorId === i.user.id || this.isMod(i); }
  private recording(i: UI, id?: string): QueueEntry {
    const session = this.music.snapshot(i.guildId!);
    const entry = session.current?.id === id ? session.current : session.history.find(h => h.entry.id === id)?.entry;
    if (!entry) throw new Error('That track has changed or left history. Use the current playing card.');
    return structuredClone(entry);
  }
  async handle(i: UI): Promise<void> {
    this.access(i, false);
    const command = i.isChatInputCommand();
    const [prefix, action, id] = command ? [i.commandName === 'music-stats' ? 'stats' : 'pl', i.commandName === 'music-stats' ? 'tracks' : i.options.getSubcommand(), undefined] : i.customId.split(':');
    if (i.isButton() && prefix === 'pl' && action === 'importfile') {
      const token = this.remember(i, { kind: 'importfile' });
      const upload = new FileUploadBuilder().setCustomId('file').setMinValues(1).setMaxValues(1).setRequired(true);
      const name = new TextInputBuilder().setCustomId('name').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(60).setPlaceholder('Keep the name from the file, or choose a new one');
      await i.showModal(new ModalBuilder().setCustomId('pl:form:' + token).setTitle('Import a playlist file').addLabelComponents(
        new LabelBuilder().setLabel('MusicMaid JSON playlist').setDescription('One .json file, up to 2 MiB and 500 songs. Creates your own new playlist.').setFileUploadComponent(upload),
        new LabelBuilder().setLabel('New playlist name (optional)').setTextInputComponent(name))); return;
    }
    // A modal must be the initial response. Public buttons always open private views.
    if ((command || i.isButton()) && prefix === 'pl' && ['create', 'save', 'newadd', 'rename', 'import', 'move'].includes(action)) {
      let menu: Menu = { kind: action };
      if (id) menu = { ...this.read(i, id), kind: action };
      if (action === 'save') { const s = this.music.snapshot(i.guildId!); menu.entries = [s.current, ...s.queue].filter((e): e is QueueEntry => Boolean(e)); if (!menu.entries.length) throw new Error('The queue is empty. Create an empty playlist instead.'); }
      if (action === 'newadd') menu.kind = 'create';
      let list: SavedPlaylist | undefined;
      if (menu.playlistId) { list = this.store.get(i.guildId!, menu.playlistId); if (!this.editable(i, list)) throw new Error('Only the creator or a moderator can edit this playlist.'); }
      const token = this.remember(i, menu);
      const modal = new ModalBuilder().setCustomId('pl:form:' + token).setTitle(action === 'import' ? 'Import playlist · up to 100 tracks' : action === 'move' ? 'Move playlist track' : action === 'save' ? 'Save this queue as a playlist' : 'Save your music');
      if (action === 'move') modal.addComponents(field('position', 'New position (1–500)', 3));
      else {
        if (!list || action === 'rename') modal.addComponents(field('name', 'Playlist name', 60, list?.name));
        if (action === 'import') modal.addComponents(field('url', 'YouTube or Spotify playlist link', 500), field('start', 'Start at track (next batches: 101, 201, …)', 5, '1'));
      }
      await i.showModal(modal); return;
    }
    if ((command || i.isButton()) && prefix === 'stats' && action === 'tag') {
      this.access(i, true); const entry = this.recording(i, id);
      const token = this.remember(i, { kind: 'genre', entries: [entry] });
      await i.showModal(new ModalBuilder().setCustomId('stats:form:' + token).setTitle('Tag this recording’s genres').addComponents(field('genres', 'Up to 3 genres, separated by commas', 100))); return;
    }
    if ((i.isButton() || i.isStringSelectMenu()) && i.message.flags.has(MessageFlags.Ephemeral)) await i.deferUpdate();
    else await i.deferReply({ flags: MessageFlags.Ephemeral });
    if (i.isModalSubmit()) { await this.submit(i, id); return; }
    if (command && prefix === 'pl' && action === 'import-file') { await this.importFile(i, i.options.getAttachment('file', true), i.options.getString('name') ?? undefined); return; }
    if (prefix === 'stats') {
      const days = i.isStringSelectMenu() ? i.values[0] : id ?? '30';
      await this.stats(i, action === 'period' ? id ?? 'tracks' : action, days); return;
    }
    if (['list', 'browse'].includes(action)) { await this.browse(i, Number(id ?? 0)); return; }
    if (action === 'open' && i.isStringSelectMenu()) { await this.detail(i, this.store.get(i.guildId!, i.values[0])); return; }
    if (action === 'detail') { const menu = this.read(i, id); await this.detail(i, this.store.get(i.guildId!, menu.playlistId!)); return; }
    if (action === 'export') {
      const list = command ? this.named(i.guildId!, i.options.getString('name', true)) : this.store.get(i.guildId!, this.read(i, id).playlistId!);
      const document = exportPlaylistDocument(list), token = this.remember(i, { kind: 'detail', playlistId: list.id, revision: list.revision });
      await i.editReply({ content: '**' + safe(list.name) + '** · ' + list.entries.length + ' songs in order.\nShare the JSON to import a new copy, or use the readable track links. This export contains song references and display metadata only.', embeds: [], attachments: [], files: [new AttachmentBuilder(document.json, { name: 'musicmaid-playlist.json' }), new AttachmentBuilder(document.links, { name: 'musicmaid-track-links.txt' })], components: [row(b('pl:detail:' + token, 'Back to playlist'))], allowedMentions: { parse: [] } }); return;
    }
    if (action === 'addcurrent') {
      this.access(i, true); const menu = this.read(i, id, true), list = this.store.get(i.guildId!, menu.playlistId!);
      if (!this.editable(i, list)) throw new Error('Only the creator or a moderator can edit this playlist.');
      const entry = this.recording(i, this.music.snapshot(i.guildId!).current?.id);
      if (list.entries.some(saved => saved.recording.uri === entry.recording.uri)) { await this.detail(i, list, 'That recording is already in this playlist.'); return; }
      const updated = this.store.update(i.guildId!, list.id, menu.revision!, i.user.id, this.isMod(i), current => current.entries.push({ ...entry, id: randomUUID() }));
      await this.detail(i, updated, 'Saved ' + safe(entry.recording.title) + '. Playback continues.'); return;
    }
    if (action === 'add') { this.access(i, true); await this.addView(i, this.recording(i, id)); return; }
    if (action === 'addpage') { const menu = this.read(i, id); await this.addView(i, menu.entries![0], Number(!i.isChatInputCommand() ? i.customId.split(':')[3] : 0)); return; }
    if (action === 'addto' && i.isStringSelectMenu()) {
      this.access(i, true); const menu = this.read(i, id, true); const list = this.store.get(i.guildId!, i.values[0]);
      if (!this.editable(i, list)) throw new Error('Choose a playlist you own, or ask a moderator.');
      const entry = menu.entries![0];
      if (list.entries.some(e => e.recording.uri === entry.recording.uri)) { await this.detail(i, list, 'That recording is already in this playlist.'); return; }
      const updated = this.store.update(i.guildId!, list.id, list.revision, i.user.id, this.isMod(i), current => current.entries.push({ ...entry, id: randomUUID() }));
      await this.detail(i, updated, 'Added ' + safe(entry.recording.title) + '.'); return;
    }
    if (action === 'play' || action === 'playentry') {
      const { guildId, voiceChannelId } = this.access(i, true);
      let list: SavedPlaylist; let selectedEntry: string | undefined;
      if (command) { list = this.named(guildId, i.options.getString('name', true)); }
      else { const menu = this.read(i, id, true); selectedEntry = action === 'playentry' ? menu.entryId : undefined; list = this.store.get(guildId, menu.playlistId!); if (list.revision !== menu.revision) throw new Error('The playlist changed. Reopen it before playing.'); }
      const entries = selectedEntry ? list.entries.filter(e => e.id === selectedEntry) : list.entries;
      await this.music.enqueueMany(guildId, entries.map(e => entryFor({ ...e.request, requestedBy: i.user.id }, e.recording)), voiceChannelId, i.channelId!);
      await this.detail(i, list, 'Added ' + entries.length + ' tracks in order. Existing playback continues; an idle queue starts automatically.'); return;
    }
    if (action === 'edit' || action === 'delete' || action === 'confirmdelete') {
      const menu = this.read(i, id, action === 'confirmdelete'); const list = this.store.get(i.guildId!, menu.playlistId!);
      if (action === 'edit') { await this.editView(i, list, 0); return; }
      if (!this.editable(i, list)) throw new Error('Only the creator or a moderator can edit this playlist.');
      if (action === 'confirmdelete') { this.store.delete(i.guildId!, list.id, menu.revision!, i.user.id, this.isMod(i)); await this.browse(i, 0, 'Playlist deleted.'); return; }
      const token = this.remember(i, { kind: 'delete', playlistId: list.id, revision: list.revision });
      await i.editReply({ content: 'Delete **' + safe(list.name) + '** and its saved entries?', embeds: [], components: [row(b('pl:confirmdelete:' + token, 'Delete playlist', ButtonStyle.Danger), b('pl:list', 'Cancel'))] }); return;
    }
    if (action === 'editpage') { const menu = this.read(i, id); await this.editView(i, this.store.get(i.guildId!, menu.playlistId!), Number(!i.isChatInputCommand() ? i.customId.split(':')[3] : 0)); return; }
    if (action === 'entry' && i.isStringSelectMenu()) {
      const menu = this.read(i, id); const list = this.store.get(i.guildId!, menu.playlistId!);
      if (list.revision !== menu.revision) throw new Error('The playlist changed. Reopen it to edit.');
      const entry = list.entries.find(e => e.id === i.values[0]); if (!entry) throw new Error('That entry no longer exists.');
      const token = this.remember(i, { ...menu, kind: 'entry', entryId: entry.id });
      await i.editReply({ content: safe(entry.recording.title) + ' — ' + safe(entry.recording.author), embeds: [], components: [row(b('pl:playentry:' + token, 'Play track', ButtonStyle.Primary), b('pl:move:' + token, 'Move to…').setDisabled(!this.editable(i, list)), b('pl:remove:' + token, 'Remove', ButtonStyle.Danger).setDisabled(!this.editable(i, list)), b('pl:detail:' + token, 'Back'))] }); return;
    }
    if (action === 'remove') {
      const menu = this.read(i, id, true);
      const list = this.store.update(i.guildId!, menu.playlistId!, menu.revision!, i.user.id, this.isMod(i), p => { p.entries = p.entries.filter(e => e.id !== menu.entryId); });
      await this.detail(i, list, 'Removed that saved entry.'); return;
    }
    if (action === 'cancelimport') {
      const menu = this.read(i, id, true); const job = this.jobs.get(i.guildId!);
      if (job && job.id === menu.jobId) job.cancel.abort();
      await i.editReply({ content: 'Import cancelled. No playlist entries were saved.', embeds: [], components: [row(b('pl:list', 'Playlists'))] }); return;
    }
    if (action === 'confirmimport') {
      const menu = this.read(i, id, true); if (!menu.result) throw new Error('Import preview expired.');
      const list = menu.playlistId ? this.store.update(i.guildId!, menu.playlistId, menu.revision!, i.user.id, this.isMod(i), p => p.entries.push(...menu.result!.entries.map(e => ({ ...e, id: randomUUID() }))))
        : this.store.create(i.guildId!, i.user.id, menu.name!, menu.result.entries);
      await this.detail(i, list, 'Saved ' + menu.result.entries.length + ' imported tracks.' + (menu.result.hasMore ? ' Import again starting at track ' + menu.result.nextStart + ' for the next batch.' : '')); return;
    }
    throw new Error('Open a fresh Playlists or Stats view.');
  }
  private named(guildId: string, name: string): SavedPlaylist {
    const key = name.trim().normalize('NFKC').toLocaleLowerCase('en');
    const list = this.store.list(guildId).find(p => p.name.normalize('NFKC').toLocaleLowerCase('en') === key);
    if (!list) throw new Error('Playlist not found. Open Playlists to choose one.');
    return list;
  }
  private async importFile(i: UI, attachment: PlaylistAttachment, overrideName?: string): Promise<void> {
    if (this.jobs.has(i.guildId!)) throw new Error('This server already has a playlist import running. Finish or cancel it first.');
    const job = { id: randomUUID(), cancel: new AbortController() }; this.jobs.set(i.guildId!, job);
    try {
      const document = await this.fetchFile(attachment, job.cancel.signal);
      job.cancel.signal.throwIfAborted(); this.access(i, false);
      const list = this.store.create(i.guildId!, i.user.id, overrideName?.trim() || document.name, playlistDocumentEntries(document, i.user.id));
      await this.detail(i, list, 'Imported ' + list.entries.length + ' songs into your new playlist. Nothing was queued. Track details are checked when played.');
    } finally { if (this.jobs.get(i.guildId!) === job) this.jobs.delete(i.guildId!); }
  }
  private async browse(i: UI, requestedPage = 0, notice = ''): Promise<void> {
    const lists = this.store.list(i.guildId!); const page = Math.max(0, Math.min(Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0, Math.ceil(lists.length / 5) - 1));
    const components: (ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>)[] = [];
    if (lists.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId('pl:open').setPlaceholder('Choose a saved playlist').addOptions(lists.slice(page * 5, page * 5 + 5).map(p => ({ label: p.name.slice(0, 100), description: p.entries.length + ' tracks · ' + (this.editable(i, p) ? 'you can edit' : 'shared · creator edits'), value: p.id })))));
    const session = this.music.snapshot(i.guildId!);
    components.push(row(b('pl:create', 'Create playlist', ButtonStyle.Primary), b('pl:save', 'Save queue').setDisabled(!session.current && !session.queue.length), b('pl:import', 'Import link'), b('pl:importfile', 'Import JSON')));
    if (lists.length > 5) components.push(row(b('pl:browse:' + (page - 1), 'Previous').setDisabled(page === 0), b('pl:browse:' + (page + 1), 'Next').setDisabled((page + 1) * 5 >= lists.length)));
    await i.editReply({ content: notice || null, attachments: [], embeds: [new EmbedBuilder().setColor(0xf5b301).setTitle('Your server’s music library').setDescription('Everyone can browse, play and export. Creators and moderators can edit.\n**Save queue** keeps the current song and upcoming tracks in order. Import a YouTube / Spotify link, or a shared MusicMaid JSON file.').setFooter({ text: lists.length + '/50 playlists · page ' + (page + 1) })], components, allowedMentions: { parse: [] } });
  }
  private async detail(i: UI, list: SavedPlaylist, notice = ''): Promise<void> {
    const token = this.remember(i, { kind: 'detail', playlistId: list.id, revision: list.revision }); const edit = this.editable(i, list);
    const description = list.entries.slice(0, 10).map((e, n) => (n + 1) + '. ' + safe(e.recording.title, 110) + ' — ' + safe(e.recording.author, 70) + ' · ' + duration(e.recording.durationMs)).join('\n');
    const embed = new EmbedBuilder().setColor(0xf5b301).setTitle(list.name).setDescription(description || 'Your playlist is empty. Add the playing track, or import a playlist link.').setFooter({ text: list.entries.length + '/500 tracks · ' + duration(list.entries.reduce((n, e) => n + e.recording.durationMs, 0)) + (list.entries.length > 10 ? ' · first 10 shown; Browse tracks for all' : '') }).addFields({ name: 'Created by', value: '<@' + list.creatorId + '>', inline: true }, { name: 'Access', value: edit ? 'You can edit. Everyone can play or export a copy.' : 'Shared with you. The creator and moderators can edit; you can play or export.', inline: false });
    await i.editReply({ content: notice || null, attachments: [], embeds: [embed], components: [row(b('pl:play:' + token, 'Play playlist', ButtonStyle.Primary).setDisabled(!list.entries.length), b('pl:addcurrent:' + token, 'Add playing track').setDisabled(!edit || !this.music.snapshot(i.guildId!).current || list.entries.length >= 500), b('pl:edit:' + token, 'Browse tracks').setDisabled(!list.entries.length), b('pl:export:' + token, 'Export')), row(b('pl:import:' + token, 'Import link').setDisabled(!edit), b('pl:rename:' + token, 'Rename').setDisabled(!edit), b('pl:delete:' + token, 'Delete').setDisabled(!edit), b('pl:list', 'All playlists'))], allowedMentions: { parse: [] } });
  }
  private async editView(i: UI, list: SavedPlaylist, requestedPage: number): Promise<void> {
    if (!list.entries.length) { await this.detail(i, list); return; }
    const page = Math.max(0, Math.min(Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0, Math.ceil(list.entries.length / 10) - 1));
    const token = this.remember(i, { kind: 'edit', playlistId: list.id, revision: list.revision });
    await i.editReply({ content: '**' + safe(list.name) + '** · choose a track to play or edit · page ' + (page + 1), embeds: [], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId('pl:entry:' + token).setPlaceholder('Choose a saved track').addOptions(list.entries.slice(page * 10, page * 10 + 10).map((e, n) => ({ label: ((page * 10 + n + 1) + '. ' + e.recording.title).slice(0, 100), description: (e.recording.author + ' · ' + duration(e.recording.durationMs)).slice(0, 100), value: e.id })))), row(b('pl:editpage:' + token + ':' + (page - 1), 'Previous').setDisabled(page === 0), b('pl:editpage:' + token + ':' + (page + 1), 'Next').setDisabled((page + 1) * 10 >= list.entries.length), b('pl:detail:' + token, 'Back'))] });
  }
  private async addView(i: UI, entry: QueueEntry, requestedPage = 0): Promise<void> {
    const lists = this.store.list(i.guildId!).filter(p => this.editable(i, p));
    const page = Math.max(0, Math.min(Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0, Math.ceil(lists.length / 5) - 1));
    const token = this.remember(i, { kind: 'add', entries: [entry] });
    const components: (ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>)[] = [];
    if (lists.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId('pl:addto:' + token).setPlaceholder('Save to a playlist').addOptions(lists.slice(page * 5, page * 5 + 5).map(p => ({ label: p.name, description: p.entries.length + ' tracks', value: p.id })))));
    components.push(row(b('pl:newadd:' + token, 'Create playlist', ButtonStyle.Primary), b('pl:list', 'Browse playlists')));
    if (lists.length > 5) components.push(row(b('pl:addpage:' + token + ':' + (page - 1), 'Previous').setDisabled(page === 0), b('pl:addpage:' + token + ':' + (page + 1), 'Next').setDisabled((page + 1) * 5 >= lists.length)));
    await i.editReply({ content: 'Save **' + safe(entry.recording.title) + '** — ' + safe(entry.recording.author) + '. The selected recording is preserved.', embeds: [], components, allowedMentions: { parse: [] } });
  }
  private async submit(i: ModalSubmitInteraction, id: string | undefined): Promise<void> {
    const menu = this.read(i, id, true);
    if (menu.kind === 'importfile') {
      const files = i.fields.getUploadedFiles('file', true);
      if (files.size !== 1) throw new Error('Choose one MusicMaid JSON playlist file.');
      await this.importFile(i, files.first()!, i.fields.getTextInputValue('name')); return;
    }
    if (menu.kind === 'genre') { this.access(i, true); this.store.tag(i.guildId!, menu.entries![0].recording.uri, i.fields.getTextInputValue('genres').split(','), i.user.id); await this.stats(i, 'genres', '30'); return; }
    if (menu.kind === 'move' || menu.kind === 'rename') {
      const list = this.store.update(i.guildId!, menu.playlistId!, menu.revision!, i.user.id, this.isMod(i), p => {
        if (menu.kind === 'rename') p.name = i.fields.getTextInputValue('name');
        else { const position = Number(i.fields.getTextInputValue('position')); const from = p.entries.findIndex(e => e.id === menu.entryId); if (from < 0 || !Number.isInteger(position) || position < 1 || position > p.entries.length) throw new Error('Choose a valid position in this playlist.'); const [entry] = p.entries.splice(from, 1); p.entries.splice(position - 1, 0, entry); }
      }); await this.detail(i, list, 'Playlist updated.'); return;
    }
    if (menu.kind !== 'import') { const list = this.store.create(i.guildId!, i.user.id, i.fields.getTextInputValue('name'), menu.entries); await this.detail(i, list, menu.entries?.length ? 'Saved ' + list.entries.length + ' songs in order. Playback continues unchanged.' : 'Playlist created. Add a playing track or import a link to fill it.'); return; }
    if (this.jobs.has(i.guildId!)) throw new Error('This server already has a playlist import running. Finish or cancel it first.');
    const name = menu.playlistId ? this.store.get(i.guildId!, menu.playlistId).name : i.fields.getTextInputValue('name');
    const job = { id: randomUUID(), cancel: new AbortController() }; this.jobs.set(i.guildId!, job);
    const cancel = this.remember(i, { kind: 'cancel', jobId: job.id }, 600_000);
    const signal = AbortSignal.any([job.cancel.signal, AbortSignal.timeout(480_000)]);
    try {
      const progress = async (done: number, total: number) => { await i.editReply({ content: 'Preparing **' + safe(name) + '** · ' + done + '/' + total + ' tracks checked. Playback continues. Review before saving.', embeds: [], components: [row(b('pl:cancelimport:' + cancel, 'Cancel import'))], allowedMentions: { parse: [] } }); };
      await progress(0, 100);
      const result = await importPlaylist(this.load, i.fields.getTextInputValue('url'), Number(i.fields.getTextInputValue('start')), i.user.id, signal, progress);
      signal.throwIfAborted();
      const token = this.remember(i, { ...menu, name, kind: 'import-result', result }, 600_000);
      await i.editReply({ content: '**' + safe(name) + '** · ' + result.entries.length + ' playable matches · ' + result.skipped + ' unavailable/unmatched.' + (result.hasMore ? '\nMore tracks remain; next batch starts at ' + result.nextStart + '.' : '') + (result.unmatched.length ? '\nUnmatched: ' + result.unmatched.slice(0, 5).map(v => safe(v, 120)).join('; ') : '') + '\nSelected uploads:\n' + result.entries.slice(0, 5).map(e => '• ' + safe(e.recording.title, 90) + ' — ' + safe(e.recording.author, 50) + ' · ' + duration(e.recording.durationMs)).join('\n') + '\nSave this batch to your library; it will not start playback.', embeds: [], components: [row(b('pl:confirmimport:' + token, 'Save imported tracks', ButtonStyle.Primary).setDisabled(!result.entries.length), b('pl:list', 'Discard'))], allowedMentions: { parse: [] } });
    } catch (error) { if (signal.aborted) { await i.editReply({ content: job.cancel.signal.aborted ? 'Import cancelled. No playlist entries were saved.' : 'Import timed out. Try a smaller or later batch. No entries were saved.', embeds: [], components: [row(b('pl:list', 'Playlists'))] }); } else throw error; }
    finally { if (this.jobs.get(i.guildId!) === job) this.jobs.delete(i.guildId!); }
  }
  private async stats(i: UI, requestedTab: string, requestedDays: string): Promise<void> {
    const tab = ['tracks', 'members', 'genres'].includes(requestedTab) ? requestedTab : 'tracks';
    const days = ['0', '7', '30'].includes(requestedDays) ? Number(requestedDays) : 30;
    const stats = this.store.stats(i.guildId!, days ? Date.now() - days * 86400000 : 0);
    const rows = tab === 'tracks' ? stats.tracks.map(t => ({ label: '[' + safe(t.title, 100) + '](' + t.uri + ') — ' + safe(t.author, 55), count: t.count })) : tab === 'members' ? stats.members.map(m => ({ label: '<@' + m.id + '>', count: m.count })) : stats.genres.map(g => ({ label: safe(g.name), count: g.count }));
    const max = rows[0]?.count || 1;
    const chart = rows.map((r, index) => '**' + (index + 1) + '.** ' + r.label + '\n`' + '▰'.repeat(Math.max(1, Math.round(r.count / max * 10))).padEnd(10, '▱') + '` **' + r.count + '**').join('\n');
    const embed = new EmbedBuilder().setColor(0xf5b301).setTitle('MusicMaid · ' + ({ tracks: 'Most played', members: 'Top music contributors', genres: 'Genre mix' }[tab])).setDescription(chart || (tab === 'genres' ? 'Tag playing tracks to build your server’s genre mix. No genres are guessed.' : 'Your listening story starts here. Play a few songs to fill this view.')).addFields({ name: 'Requests added', value: String(stats.requests), inline: true }, { name: 'Confirmed plays', value: String(stats.played), inline: true }, { name: 'Completed', value: String(stats.finished), inline: true }).setFooter({ text: (days ? 'Last ' + days + ' days' : 'All recorded history') + ' · Each request counts once; loops excluded · Includes retained history' });
    if (tab === 'genres') embed.addFields({ name: 'Community genre tags', value: stats.tagged + ' of ' + stats.played + ' plays tagged. A recording can have up to three genres.' });
    const current = this.music.snapshot(i.guildId!).current;
    await i.editReply({ content: null, embeds: [embed], components: [row(b('stats:tracks:' + days, 'Songs', tab === 'tracks' ? ButtonStyle.Primary : ButtonStyle.Secondary), b('stats:members:' + days, 'Members', tab === 'members' ? ButtonStyle.Primary : ButtonStyle.Secondary), b('stats:genres:' + days, 'Genres', tab === 'genres' ? ButtonStyle.Primary : ButtonStyle.Secondary)), new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId('stats:period:' + tab).setPlaceholder('Choose a time period').addOptions([{ label: 'Last 7 days', value: '7', default: days === 7 }, { label: 'Last 30 days', value: '30', default: days === 30 }, { label: 'All recorded history', value: '0', default: !days }])), row(b('stats:tag:' + (current?.id ?? 'idle'), 'Tag current song’s genres').setDisabled(!current), b('pl:list', 'Playlists'))], allowedMentions: { parse: [] } });
  }
}
