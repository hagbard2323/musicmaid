import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const { classifyMessage, planCleanup, applyCleanup, readProtectedState, discordApi, installedNavigationHandlerReady } = await import(new URL('../../../scripts/channel-cleanup.mjs', import.meta.url).href);

const guildId = '10000', channelId = '20000', selfId = '30000', chipId = '40000', humanId = '50000';
const now = Date.now();
const roles = [{ id: guildId, position: 0, permissions: '0' }, { id: '60000', position: 3, permissions: String(1024n | 65536n | 8192n | 2n) }, { id: '70000', position: 1, permissions: '0' }];
const ownMember = { user: { id: selfId, bot: true }, roles: ['60000'] };
const chip = { id: chipId, bot: true, username: 'Chip' };
const scope = { guildId, channelId, selfId, chipId, guild: { id: guildId, owner_id: humanId }, channel: { id: channelId, guild_id: guildId, type: 0, permission_overwrites: [] }, roles, member: ownMember, permissions: 1024n | 65536n | 8192n, guildPermissions: 2n };
type Message = { id: string; channel_id: string; pinned: boolean; author: { id: string; bot: boolean; username?: string }; timestamp: string; content: string; embeds: { title: string }[]; components: { type: number; components: { type: number; custom_id?: string; style?: number; label?: string; url?: string }[] }[] };
const message = (id: string, author = selfId, title = 'MusicMaid Console'): Message => ({ id, channel_id: channelId, pinned: false, author: author === chipId ? chip : { id: author, bot: author === selfId }, timestamp: new Date(now - 3600000).toISOString(), content: 'fixture text must never be included in the report', embeds: [{ title }], components: [{ type: 1, components: [{ type: 2, custom_id: 'm:play' }, { type: 2, custom_id: 'm:queue' }] }] });
const protectedState = (ids: string[] = []) => async () => ({ known: true, protectedIds: new Set(ids) });

function fakeApi(messages: Message[], roleList = roles) {
  const calls: { method: string; path: string; payload?: { components: Message['components'] } }[] = [];
  const api = async (method: string, path: string, payload?: { components: Message['components'] }): Promise<unknown> => {
    calls.push({ method, path, payload });
    if (method === 'DELETE' || method === 'PATCH') return undefined;
    if (path.includes('/members/search?')) return [{ user: chip }];
    if (path.includes('/messages?')) return structuredClone(messages);
    if (path === '/users/' + chipId) return chip;
    if (path === `/guilds/${guildId}/members/${chipId}`) return { user: chip, roles: ['70000'] };
    if (path === `/guilds/${guildId}/members/${selfId}`) return ownMember;
    if (path === `/guilds/${guildId}/roles`) return roleList;
    const id = /^\/channels\/\d+\/messages\/(\d+)$/.exec(path)?.[1];
    if (id) {
      const found = messages.find(item => item.id === id);
      if (!found) throw Object.assign(new Error('fixture absent'), { status: 404 });
      return structuredClone(found);
    }
    throw new Error('Unexpected fixture route ' + path);
  };
  return { api, calls };
}

test('cleanup preserves humans, pins, active controls, song history, unknown cards and recent consoles', () => {
  const target = { guildId, channelId, selfId, chipId };
  assert.equal(classifyMessage(message('100001'), target, new Set(), now), 'obsolete_control');
  assert.equal(classifyMessage(message('100002', chipId), target, new Set(), now), 'chip_message');
  assert.equal(classifyMessage(message('100003', humanId), target, new Set(), now), null);
  assert.equal(classifyMessage({ ...message('100004', chipId), pinned: true }, target, new Set(), now), null);
  assert.equal(classifyMessage(message('100005'), target, new Set(['100005']), now), null);
  for (const title of ['Played', 'Skipped', 'Now playing', 'Paused', 'Playback failed', 'Rihanna — Bitch Better Have My Money']) assert.equal(classifyMessage(message('100006', selfId, title), target, new Set(), now), null);
  assert.equal(classifyMessage({ ...message('100007'), timestamp: new Date(now - 1000).toISOString() }, target, new Set(), now), null);
  assert.equal(classifyMessage({ ...message('100008'), components: [{ type: 1, components: [{ type: 2, custom_id: 'unrecognized:action' }] }] }, target, new Set(), now), null);
  assert.equal(classifyMessage({ ...message('100008'), components: [{ type: 1, components: [{ type: 2, custom_id: 'm:play' }, { type: 2, custom_id: 'm:unknown-future-control' }] }] }, target, new Set(), now), null);
  assert.equal(classifyMessage({ ...message('100009'), channel_id: '99999' }, target, new Set(), now), null);
});

test('cleanup dry run emits only scoped identifiers/counts and makes no mutations', async () => {
  const messages = [message('100001', chipId), message('100002'), message('100003', humanId), message('100004', selfId, 'Played'), message('100005')];
  const { api, calls } = fakeApi(messages);
  const result = await planCleanup({ api, scope, protectedState: protectedState(['100005']), chipId, now });
  assert.equal(result.report.scanned, 5);
  assert.equal(result.report.planned, 2);
  assert.deepEqual(result.report.protectedIds, ['100005']);
  assert.deepEqual(result.manifest.entries.map((entry: { id: string }) => entry.id), ['100001', '100002']);
  assert.equal(JSON.stringify(result).includes('fixture text'), false);
  assert.equal(calls.every(call => call.method === 'GET'), true);
});

test('cleanup includes verified Chip application webhook replies and rejects impersonating webhooks', () => {
  const target = { guildId, channelId, selfId, chipId };
  const ordinary = message('100001', chipId);
  const applicationReply = { ...ordinary, webhook_id: chipId, application_id: chipId };
  assert.equal(classifyMessage(ordinary, target, new Set(), now), 'chip_message');
  assert.equal(classifyMessage(applicationReply, target, new Set(), now), 'chip_message');
  assert.equal(classifyMessage({ ...applicationReply, webhook_id: '99999' }, target, new Set(), now), null);
  assert.equal(classifyMessage({ ...applicationReply, application_id: '99999' }, target, new Set(), now), null);
  assert.equal(classifyMessage({ ...ordinary, webhook_id: chipId }, target, new Set(), now), null);
  assert.equal(classifyMessage({ ...applicationReply, author: { id: chipId, bot: false } }, target, new Set(), now), null);
  assert.equal(classifyMessage({ ...applicationReply, author: { id: '99999', bot: true, username: 'Chip' } }, target, new Set(), now), null);
  assert.equal(classifyMessage({ ...message('100002'), webhook_id: selfId, application_id: selfId }, target, new Set(), now), null);
  assert.equal(classifyMessage({ ...applicationReply, pinned: true }, target, new Set(), now), null);
});

test('apply rechecks fresh protected IDs and edited authors before deleting, then kicks only exact Chip', async () => {
  const messages = [message('100001', chipId), message('100002'), message('100003', chipId)];
  const { api, calls } = fakeApi(messages);
  const { manifest } = await planCleanup({ api, scope, protectedState: protectedState(), chipId, now });
  messages[2].author = { id: humanId, bot: false };
  const result = await applyCleanup({ api, scope, protectedState: protectedState(['100002']), manifest, chipId, now });
  assert.equal(result.deletedChip, 1);
  assert.equal(result.deletedControls, 0);
  assert.equal(result.skippedChangedOrProtected, 2);
  assert.equal(result.kicked, true);
  assert.deepEqual(calls.filter(call => call.method === 'DELETE').map(call => call.path), [`/channels/${channelId}/messages/100001`, `/guilds/${guildId}/members/${chipId}`]);
});

test('missing moderation permissions still allow own obsolete controls and never change roles', async () => {
  const messages = [message('100001', chipId), message('100002')];
  const roleList = roles.map(role => role.id === '60000' ? { ...role, permissions: String(1024n | 65536n) } : role);
  const { api, calls } = fakeApi(messages, roleList);
  const limited = { ...scope, permissions: 1024n | 65536n, guildPermissions: 0n };
  const { manifest } = await planCleanup({ api, scope: limited, protectedState: protectedState(), chipId, now });
  const result = await applyCleanup({ api, scope: limited, protectedState: protectedState(), manifest, chipId, now });
  assert.equal(result.deletedChip, 0); assert.equal(result.deletedControls, 1); assert.equal(result.kicked, false);
  assert.deepEqual(result.missingPermissions.sort(), ['KickMembers', 'ManageMessagesForChip']);
  assert.deepEqual(calls.filter(call => call.method === 'DELETE').map(call => call.path), [`/channels/${channelId}/messages/100002`]);
});

test('apply fails closed for expired/wrong-scope plans, unknown database and human kick targets', async () => {
  const { api, calls } = fakeApi([message('100001', chipId)]);
  const { manifest } = await planCleanup({ api, scope, protectedState: protectedState(), chipId, now });
  await assert.rejects(applyCleanup({ api, scope, protectedState: protectedState(), manifest, chipId, now: now + 1800001 }), /invalid_or_expired/);
  await assert.rejects(applyCleanup({ api, scope, protectedState: protectedState(), manifest, chipId: humanId, now }), /invalid_or_expired/);
  await assert.rejects(applyCleanup({ api, scope, protectedState: async () => ({ known: false }), manifest, chipId, now }), /protected_database/);
  await assert.rejects(applyCleanup({ api: async (method: string, path: string) => path === '/users/' + chipId ? { id: chipId, bot: false, username: 'Chip' } : api(method, path), scope, protectedState: protectedState(), manifest, chipId, now }), /not_verified_chip/);
  assert.equal(calls.some(call => call.method === 'DELETE'), false);
});

test('apply tolerates deleted messages and refuses to kick a bot above MusicMaid', async () => {
  const messages = [message('100001', chipId)];
  const { api, calls } = fakeApi(messages, roles.map(role => role.id === '70000' ? { ...role, position: 10 } : role));
  const { manifest } = await planCleanup({ api, scope, protectedState: protectedState(), chipId, now });
  messages.length = 0;
  const result = await applyCleanup({ api, scope, protectedState: protectedState(), manifest, chipId, now });
  assert.equal(result.alreadyAbsent, 1); assert.equal(result.kicked, false);
  assert.deepEqual(result.missingPermissions, ['BotRoleMustBeAboveChip']);
  assert.equal(calls.some(call => call.method === 'DELETE'), false);
});

test('single-message cleanup honors Discord retry_after without bulk-delete or token output', async () => {
  let count = 0;
  const sleeps: number[] = [];
  const api = discordApi('fixture-token', { sleep: async (ms: number) => { sleeps.push(ms); }, fetcher: async (url: string, options: { method: string }) => {
    assert.equal(url, 'https://discord.com/api/v10/channels/20000/messages/100001');
    assert.equal(options.method, 'DELETE');
    return ++count === 1 ? Response.json({ retry_after: 1.25 }, { status: 429 }) : new Response(null, { status: 204 });
  } });
  await api('DELETE', '/channels/20000/messages/100001');
  assert.equal(count, 2); assert.deepEqual(sleeps, [1350]);
});

test('read-only cleanup protection requires known schema and preserves console/public-card IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicmaid-cleanup-db-')), path = join(directory, 'music.sqlite');
  try {
    assert.equal((await readProtectedState(path, guildId, channelId)).known, false);
    await assert.rejects(stat(path), { code: 'ENOENT' });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version=3; CREATE TABLE music_sessions(guild_id TEXT,snapshot TEXT); CREATE TABLE music_values(key TEXT,value TEXT);');
    db.prepare('INSERT INTO music_sessions VALUES (?,?)').run(guildId, JSON.stringify({ guildId, textChannelId: channelId, panelMessageId: '100001', queue: [], history: [] }));
    db.prepare('INSERT INTO music_values VALUES (?,?)').run('music-public-player:' + guildId, JSON.stringify({ entry: { id: 'entry' }, messageId: '100002', channelId }));
    const known = await readProtectedState(path, guildId, channelId);
    assert.equal(known.known, true); assert.deepEqual([...known.protectedIds], ['100001', '100002']);
    db.exec('PRAGMA user_version=4');
    assert.equal((await readProtectedState(path, guildId, channelId)).known, false);
    db.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('history navigation refresh requires deployed handler and patches only unchanged unprotected components', async () => {
  const archived = (id: string): Message => ({ ...message(id, selfId, 'Played'), components: [{ type: 1, components: [
    { type: 2, style: 5, label: 'Open current player', url: `https://discord.com/channels/${guildId}/${channelId}/90000` },
    { type: 2, style: 2, label: 'Play', custom_id: 'm:play' }
  ] }] });
  const messages = [archived('100001'), archived('100002'), { ...archived('100003'), pinned: true }, archived('100004')];
  const { api, calls } = fakeApi(messages);
  const state = protectedState(['100004']);
  assert.equal((await planCleanup({ api, scope, protectedState: state, chipId, now })).report.plannedHistoryUpdates, 0);
  const { manifest, report } = await planCleanup({ api, scope, protectedState: state, chipId, refreshControls: true, now });
  assert.equal(report.plannedHistoryUpdates, 2);
  assert.equal(report.plannedObsoleteControls, 0);
  await assert.rejects(applyCleanup({ api, scope, protectedState: state, manifest, chipId, navigationReady: async () => true, now }), /deploy_current_player/);
  await assert.rejects(applyCleanup({ api, scope, protectedState: state, manifest, chipId, refreshControls: true, navigationReady: async () => false, now }), /deploy_current_player/);
  assert.equal(calls.some(call => call.method !== 'GET'), false);
  const unchanged = structuredClone(messages[0]);
  messages[1].content = 'changed after plan';
  const result = await applyCleanup({ api, scope, protectedState: state, manifest, chipId, refreshControls: true, navigationReady: async () => true, now });
  assert.equal(result.updatedHistoryControls, 1);
  assert.equal(result.skippedChangedOrProtected, 1);
  assert.equal(result.deletedControls, 0);
  const patches = calls.filter(call => call.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].path, `/channels/${channelId}/messages/100001`);
  assert.deepEqual(Object.keys(patches[0].payload!), ['components']);
  assert.equal(patches[0].payload!.components[0].components[0].custom_id, 'm:current');
  assert.equal(patches[0].payload!.components[0].components[0].url, undefined);
  assert.deepEqual(patches[0].payload!.components[0].components[1], unchanged.components[0].components[1]);
  assert.deepEqual(messages[0], unchanged, 'History content and embeds are preserved.');
  assert.equal(calls.some(call => call.method === 'DELETE' && call.path.startsWith('/channels/')), false);
});

test('navigation deployment guard reads installed handler and fails closed for missing or incompatible code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicmaid-navigation-handler-')), path = join(directory, 'music.js');
  try {
    assert.equal(await installedNavigationHandlerReady(path), false);
    await writeFile(path, 'const label = "m:current";');
    assert.equal(await installedNavigationHandlerReady(path), false);
    await writeFile(path, 'class Controller { async currentPlayer(i) {} async button(i) { const action="m:current"; if (action === "current") { await this.currentPlayer(i); } } }');
    assert.equal(await installedNavigationHandlerReady(path), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cleanup REST permits only components-only message PATCH requests', async () => {
  let patched = 0;
  const api = discordApi('fixture-token', { fetcher: async (url: string, options: { method: string; body: string }) => {
    assert.equal(url, 'https://discord.com/api/v10/channels/20000/messages/100001');
    assert.equal(options.method, 'PATCH');
    assert.deepEqual(JSON.parse(options.body), { components: [] });
    patched++;
    return Response.json({ id: '100001' });
  } });
  await assert.rejects(api('PATCH', '/channels/20000/messages/100001', { components: [], content: 'forbidden history edit' }), /only_message_components/);
  await assert.rejects(api('PATCH', '/guilds/10000/members/40000', { components: [] }), /only_message_components/);
  await api('PATCH', '/channels/20000/messages/100001', { components: [] });
  assert.equal(patched, 1);
});
