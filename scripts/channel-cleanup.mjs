// Deliberately limited maintenance tool: dry-run first, fixed bot/channel scope,
// no gateway connection, no message creation, and no member/role permission edits.
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migratePlayerNavigation } from './migrate-player-navigation.mjs';

const idPattern = /^\d{5,22}$/;
const MAX_SCAN = 10000, MAX_DELETE = 500, PLAN_AGE = 30 * 60000, CONTROL_AGE = 10 * 60000;
const bits = { kick: 2n, administrator: 8n, view: 1024n, manageMessages: 8192n, history: 65536n };
const consoleTitles = new Set(['MusicMaid Console', 'MusicMaid', 'Current player']);
const trackTitles = new Set(['Played', 'Skipped', 'Playback failed', 'Previous track', 'Now playing', 'Paused', 'Recovering playback', 'Playback needs attention']);
const knownControl = /^(?:m:(?:play|spotify|youtube|choose|queue|history|current|loop|volume)|m:(?:pause|resume|skip|stop|retry|alternative|watch)(?::(?:idle|[a-f0-9-]{36}))?|pl:list|pl:add:(?:idle|[a-f0-9-]{36})|stats:tracks:(?:7|30|all))$/;
const validId = value => typeof value === 'string' && idPattern.test(value);
const chipName = user => user?.bot === true && [user.username, user.global_name].some(value => typeof value === 'string' && /\bchip\b/i.test(value));
export class CleanupError extends Error {
  constructor(reason, status, retryAfter) { super(reason); this.reason = reason; this.status = status; this.retryAfter = retryAfter; }
}

export function discordApi(token, { fetcher = fetch, sleep = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  return async (method, path, payload) => {
    if (!['GET', 'DELETE', 'PATCH'].includes(method) || !/^\/(users|guilds|channels)\//.test(path)) throw new CleanupError('unsupported_route');
    if (method === 'PATCH' && (!/^\/channels\/\d{5,22}\/messages\/\d{5,22}$/.test(path) || !payload || Object.keys(payload).length !== 1 || !Array.isArray(payload.components))) throw new CleanupError('only_message_components_may_be_patched');
    if (method !== 'PATCH' && payload !== undefined) throw new CleanupError('unsupported_request_body');
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try { response = await fetcher('https://discord.com/api/v10' + path, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: 'Bot ' + token, ...(method === 'DELETE' ? { 'X-Audit-Log-Reason': 'Requested MusicMaid channel cleanup and Chip removal' } : {}), ...(method === 'PATCH' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'PATCH' ? { body: JSON.stringify(payload) } : {}) }); }
      catch { throw new CleanupError('discord_unreachable'); }
      const value = response.status === 204 ? undefined : await response.json().catch(() => undefined);
      if (response.status === 429) {
        const retryValue = value?.retry_after ?? response.headers.get('retry-after');
        const retry = retryValue === null || retryValue === undefined ? NaN : Number(retryValue);
        if (attempt === 3 || !Number.isFinite(retry) || retry < 0 || retry > 60) throw new CleanupError('rate_limited', 429, Number.isFinite(retry) ? retry : undefined);
        await sleep(Math.ceil(retry * 1000) + 100); continue;
      }
      if (!response.ok) throw new CleanupError(response.status === 403 ? 'missing_permission' : 'discord_request_failed', response.status);
      return value;
    }
  };
}

export async function installedNavigationHandlerReady(path = '/opt/botsvc/audiobot/dist/apps/bot/src/commands/music.js') {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 1024 * 1024) return false;
    const code = await readFile(path, 'utf8');
    return /async\s+currentPlayer\s*\(i\)/.test(code) && /action\s*===\s*["']current["']\s*\)\s*\{\s*await\s+this\.currentPlayer\(i\)/.test(code) && /["']m:current["']/.test(code);
  } catch { return false; }
}

function historyNavigation(message, scope, protectedIds) {
  if (message?.pinned || protectedIds.has(message?.id)) return undefined;
  return migratePlayerNavigation(message, { guildId: scope.guildId, channelId: scope.channelId, botUserId: scope.selfId, applicationId: scope.selfId });
}

export async function readProtectedState(database, guildId, channelId) {
  let db;
  try {
    if (!(await lstat(database)).isFile()) throw new Error();
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(database, { readOnly: true });
    if (Number(db.prepare('PRAGMA user_version').get().user_version) !== 3) throw new Error();
    const row = db.prepare('SELECT snapshot FROM music_sessions WHERE guild_id=?').get(guildId);
    if (!row) throw new Error();
    const session = JSON.parse(row.snapshot);
    if (session.guildId !== guildId || !Array.isArray(session.queue) || !Array.isArray(session.history)) throw new Error();
    const card = JSON.parse(db.prepare('SELECT value FROM music_values WHERE key=?').get('music-public-player:' + guildId)?.value ?? 'null');
    const protectedIds = new Set();
    if (session.panelMessageId !== undefined) {
      if (!validId(session.panelMessageId) || !validId(session.textChannelId)) throw new Error();
      protectedIds.add(session.panelMessageId);
    }
    if (card !== null) {
      if (!validId(card?.messageId) || !validId(card?.channelId) || typeof card?.entry?.id !== 'string') throw new Error();
      protectedIds.add(card.messageId);
    }
    return { known: true, protectedIds, guildId, channelId };
  } catch { return { known: false, protectedIds: new Set(), guildId, channelId }; }
  finally { db?.close(); }
}

function controls(components) {
  return (components ?? []).flatMap(component => [...(typeof component.custom_id === 'string' ? [component.custom_id] : []), ...controls(component.components)]);
}
export function classifyMessage(message, { guildId, channelId, selfId, chipId }, protectedIds, now = Date.now()) {
  if (!validId(message?.id) || message.channel_id !== channelId || message.pinned || message.author?.bot !== true || protectedIds.has(message.id)) return null;
  if (chipId && message.author.id === chipId && chipId !== selfId) {
    // Slash-command replies are sent through the bot application's own webhook.
    // Accept only its exact verified application identity, never a named webhook.
    if (message.webhook_id && (message.webhook_id !== chipId || message.application_id !== chipId)) return null;
    return 'chip_message';
  }
  if (message.webhook_id) return null;
  if (message.author.id !== selfId) return null;
  const titles = (message.embeds ?? []).map(embed => embed.title);
  if (titles.some(title => trackTitles.has(title)) || !titles.some(title => consoleTitles.has(title))) return null;
  const created = Date.parse(message.timestamp);
  if (!Number.isFinite(created) || now - created < CONTROL_AGE) return null;
  const ids = controls(message.components);
  if (!ids.some(id => ['m:play', 'm:queue', 'm:history', 'm:current'].includes(id)) || ids.some(id => !knownControl.test(id))) return null;
  return 'obsolete_control';
}
export function messageFingerprint(message) {
  return createHash('sha256').update(JSON.stringify({ id: message.id, channel: message.channel_id, author: message.author?.id, bot: message.author?.bot, pinned: Boolean(message.pinned), webhook: message.webhook_id, application: message.application_id, timestamp: message.timestamp, edited: message.edited_timestamp, type: message.type, content: message.content, embeds: message.embeds, components: message.components, attachments: (message.attachments ?? []).map(a => a.id) })).digest('hex');
}

export function permissionsFor(guild, roles, member, channel) {
  const roleIds = new Set([guild.id, ...(member.roles ?? [])]);
  let permissions = roles.filter(role => roleIds.has(role.id)).reduce((value, role) => value | BigInt(role.permissions), 0n);
  if (guild.owner_id === member.user.id || permissions & bits.administrator) return { permissions: (1n << 64n) - 1n, guildPermissions: (1n << 64n) - 1n };
  const guildPermissions = permissions, overwrites = channel.permission_overwrites ?? [];
  const everyone = overwrites.find(item => item.id === guild.id);
  if (everyone) permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  const relevant = overwrites.filter(item => item.type === 0 && item.id !== guild.id && roleIds.has(item.id));
  permissions = (permissions & ~relevant.reduce((value, item) => value | BigInt(item.deny), 0n)) | relevant.reduce((value, item) => value | BigInt(item.allow), 0n);
  const personal = overwrites.find(item => item.type === 1 && item.id === member.user.id);
  if (personal) permissions = (permissions & ~BigInt(personal.deny)) | BigInt(personal.allow);
  return { permissions, guildPermissions };
}
function higherRole(roles, left, right, guildId) {
  const best = member => roles.filter(role => [guildId, ...(member.roles ?? [])].includes(role.id)).sort((a, b) => b.position - a.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))[0];
  const a = best(left), b = best(right);
  return Boolean(a && b && (a.position > b.position || (a.position === b.position && BigInt(a.id) < BigInt(b.id))));
}
export async function discoverScope(api, environment = process.env) {
  const guildId = environment.DISCORD_GUILD_ID;
  if (!validId(guildId)) throw new CleanupError('configured_guild_required');
  const me = await api('GET', '/users/@me');
  if (!validId(me?.id) || me.bot !== true || (environment.DISCORD_CLIENT_ID && me.id !== environment.DISCORD_CLIENT_ID)) throw new CleanupError('wrong_bot_identity');
  let channelId = environment.DISCORD_MUSIC_TEXT_CHANNEL_ID;
  if (!channelId) {
    const channels = await api('GET', `/guilds/${guildId}/channels`);
    const candidates = channels.filter(channel => channel.type === 0 && channel.name?.toLowerCase().replace(/[^a-z]/g, '') === 'musicbot');
    if (candidates.length !== 1) throw new CleanupError('configured_music_channel_required');
    channelId = candidates[0].id;
  }
  if (!validId(channelId)) throw new CleanupError('invalid_music_channel');
  const channel = await api('GET', `/channels/${channelId}`);
  if (channel.guild_id !== guildId || channel.type !== 0) throw new CleanupError('wrong_channel_scope');
  const guild = await api('GET', `/guilds/${guildId}`), roles = await api('GET', `/guilds/${guildId}/roles`), member = await api('GET', `/guilds/${guildId}/members/${me.id}`);
  const permissions = permissionsFor(guild, roles, member, channel);
  if (!(permissions.permissions & bits.view) || !(permissions.permissions & bits.history)) throw new CleanupError('missing_view_or_history_permission', 403);
  return { guildId, channelId, selfId: me.id, guild, roles, member, channel, ...permissions };
}

export async function planCleanup({ api, scope, protectedState, chipId, refreshControls = false, now = Date.now() }) {
  if (chipId && (!validId(chipId) || chipId === scope.selfId)) throw new CleanupError('invalid_chip_id');
  const state = await protectedState(), messages = [], chipCandidates = new Map();
  try {
    for (const member of await api('GET', `/guilds/${scope.guildId}/members/search?query=Chip&limit=100`)) {
      if (chipName(member.user)) chipCandidates.set(member.user.id, { id: member.user.id, member: true, messages: 0 });
    }
  } catch (error) { if (![403, 404].includes(error.status)) throw error; }
  let before, complete = false;
  while (messages.length < MAX_SCAN) {
    const page = await api('GET', `/channels/${scope.channelId}/messages?limit=100${before ? '&before=' + before : ''}`);
    if (!Array.isArray(page) || page.some(message => !validId(message.id) || message.channel_id !== scope.channelId)) throw new CleanupError('invalid_message_page');
    messages.push(...page);
    for (const message of page) {
      if (chipName(message.author)) {
        const candidate = chipCandidates.get(message.author.id) ?? { id: message.author.id, member: false, messages: 0 };
        candidate.messages++; chipCandidates.set(candidate.id, candidate);
      }
    }
    if (page.length < 100) { complete = true; break; }
    const oldest = page.at(-1).id;
    if (before && BigInt(oldest) >= BigInt(before)) throw new CleanupError('message_pagination_did_not_advance');
    before = oldest;
  }
  if (chipId && !chipCandidates.has(chipId)) throw new CleanupError('chip_id_not_in_discovered_candidates');
  const target = { guildId: scope.guildId, channelId: scope.channelId, selfId: scope.selfId, chipId: chipId ?? null };
  const candidates = messages.map(message => ({ message, kind: classifyMessage(message, target, state.protectedIds, now) ?? (refreshControls && historyNavigation(message, target, state.protectedIds) ? 'refresh_history_controls' : null) })).filter(item => item.kind);
  const manifest = { version: 1, createdAt: now, expiresAt: now + PLAN_AGE, ...target, protectedStateKnown: state.known, kickChip: Boolean(chipId), refreshControls,
    entries: candidates.slice(0, MAX_DELETE).map(({ message, kind }) => ({ id: message.id, authorId: message.author.id, kind, fingerprint: messageFingerprint(message) })) };
  return { manifest, report: { guildId: scope.guildId, channelId: scope.channelId, selfId: scope.selfId, chipId: chipId ?? null, chipCandidates: [...chipCandidates.values()], scanned: messages.length, scanComplete: complete, planned: manifest.entries.length, plannedChipMessages: manifest.entries.filter(entry => entry.kind === 'chip_message').length, plannedObsoleteControls: manifest.entries.filter(entry => entry.kind === 'obsolete_control').length, plannedHistoryUpdates: manifest.entries.filter(entry => entry.kind === 'refresh_history_controls').length, additionalCandidates: Math.max(0, candidates.length - MAX_DELETE), protectedIds: [...state.protectedIds], protectedStateKnown: state.known,
    missingPermissions: [...(!(scope.permissions & bits.manageMessages) ? ['ManageMessagesForChip'] : []), ...(!(scope.guildPermissions & bits.kick) ? ['KickMembers'] : [])] } };
}

function validateManifest(manifest, scope, chipId, now) {
  if (manifest?.version !== 1 || manifest.guildId !== scope.guildId || manifest.channelId !== scope.channelId || manifest.selfId !== scope.selfId || !validId(chipId) || manifest.chipId !== chipId || chipId === scope.selfId || manifest.kickChip !== true || manifest.protectedStateKnown !== true
    || !Number.isFinite(manifest.createdAt) || !Number.isFinite(manifest.expiresAt) || manifest.createdAt > now || manifest.expiresAt <= now || manifest.expiresAt - manifest.createdAt > PLAN_AGE || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_DELETE
    || new Set(manifest.entries.map(entry => entry.id)).size !== manifest.entries.length
    || manifest.entries.some(entry => !validId(entry.id) || !['chip_message', 'obsolete_control', 'refresh_history_controls'].includes(entry.kind) || (entry.kind === 'refresh_history_controls' && manifest.refreshControls !== true) || entry.authorId !== (entry.kind === 'chip_message' ? chipId : scope.selfId) || !/^[a-f0-9]{64}$/.test(entry.fingerprint))) throw new CleanupError('invalid_or_expired_manifest');
}
export async function applyCleanup({ api, scope, protectedState, manifest, chipId, refreshControls = false, navigationReady = installedNavigationHandlerReady, now = Date.now() }) {
  validateManifest(manifest, scope, chipId, now);
  const updatingHistory = manifest.entries.some(entry => entry.kind === 'refresh_history_controls');
  if (updatingHistory && (!refreshControls || !(await navigationReady()))) throw new CleanupError('deploy_current_player_handler_then_use_refresh_controls');
  if (!(await protectedState()).known) throw new CleanupError('protected_database_state_unavailable');
  const chip = await api('GET', `/users/${chipId}`);
  if (!chipName(chip) || chip.id !== chipId) throw new CleanupError('target_is_not_verified_chip_bot');
  const report = { deletedChip: 0, deletedControls: 0, updatedHistoryControls: 0, skippedChangedOrProtected: 0, alreadyAbsent: 0, kicked: false, chipAlreadyAbsent: false, missingPermissions: [] };
  let canDeleteChip = Boolean(scope.permissions & bits.manageMessages);
  if (!canDeleteChip && manifest.entries.some(entry => entry.kind === 'chip_message')) report.missingPermissions.push('ManageMessagesForChip');
  for (const entry of manifest.entries) {
    if (entry.kind === 'chip_message' && !canDeleteChip) continue;
    let message;
    try { message = await api('GET', `/channels/${scope.channelId}/messages/${entry.id}`); }
    catch (error) { if (error.status === 404) { report.alreadyAbsent++; continue; } throw error; }
    const state = await protectedState();
    if (!state.known) throw new CleanupError('protected_database_state_unavailable');
    const components = entry.kind === 'refresh_history_controls' ? historyNavigation(message, manifest, state.protectedIds) : undefined;
    const matches = entry.kind === 'refresh_history_controls' ? Boolean(components) : classifyMessage(message, manifest, state.protectedIds, now) === entry.kind;
    if (message.id !== entry.id || message.author?.id !== entry.authorId || !matches || messageFingerprint(message) !== entry.fingerprint) { report.skippedChangedOrProtected++; continue; }
    if (components && !(await navigationReady())) throw new CleanupError('current_player_handler_no_longer_available');
    try { await api(components ? 'PATCH' : 'DELETE', `/channels/${scope.channelId}/messages/${entry.id}`, components ? { components } : undefined); }
    catch (error) {
      if (error.status === 404) { report.alreadyAbsent++; continue; }
      if (error.status === 403) { report.missingPermissions.push(entry.kind === 'chip_message' ? 'ManageMessagesForChip' : components ? 'EditOwnHistoryControls' : 'DeleteOwnControl'); if (entry.kind === 'chip_message') canDeleteChip = false; continue; }
      throw error;
    }
    if (components) report.updatedHistoryControls++; else if (entry.kind === 'chip_message') report.deletedChip++; else report.deletedControls++;
  }
  let member;
  try { member = await api('GET', `/guilds/${scope.guildId}/members/${chipId}`); }
  catch (error) { if (error.status === 404) { report.chipAlreadyAbsent = true; return report; } throw error; }
  if (member.user?.id !== chipId || member.user?.bot !== true) throw new CleanupError('chip_member_identity_changed');
  const roles = await api('GET', `/guilds/${scope.guildId}/roles`), self = await api('GET', `/guilds/${scope.guildId}/members/${scope.selfId}`);
  const current = permissionsFor(scope.guild, roles, self, scope.channel);
  if (!(current.guildPermissions & bits.kick)) report.missingPermissions.push('KickMembers');
  else if (!higherRole(roles, self, member, scope.guildId)) report.missingPermissions.push('BotRoleMustBeAboveChip');
  else {
    try { await api('DELETE', `/guilds/${scope.guildId}/members/${chipId}`); report.kicked = true; }
    catch (error) { if (error.status === 403) report.missingPermissions.push('KickMembersOrRoleHierarchy'); else if (error.status === 404) report.chipAlreadyAbsent = true; else throw error; }
  }
  report.missingPermissions = [...new Set(report.missingPermissions)];
  return report;
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--chip-id', '--manifest', '--apply', '--refresh-controls'].includes(flag) || options[flag]) throw new CleanupError('usage_plan_optional_chip_id_or_apply_with_exact_chip_id');
    if (flag === '--refresh-controls' || (flag === '--apply' && (!args[index + 1] || args[index + 1].startsWith('--')))) options[flag] = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new CleanupError('missing_option_value');
      options[flag] = args[++index];
    }
  }
  if (!process.env.DISCORD_TOKEN) throw new CleanupError('protected_runtime_environment_required');
  const api = discordApi(process.env.DISCORD_TOKEN), scope = await discoverScope(api);
  const protectedState = () => readProtectedState(process.env.MUSIC_DATABASE_PATH ?? '/var/lib/audiobot/music.sqlite', scope.guildId, scope.channelId);
  if (typeof options['--apply'] === 'string') {
    if (options['--manifest']) throw new CleanupError('choose_plan_or_apply');
    const path = resolve(options['--apply']), info = await lstat(path);
    if (!info.isFile() || info.uid !== process.geteuid() || info.mode & 0o077 || info.size > 256 * 1024) throw new CleanupError('manifest_must_be_private_and_owned_by_operator');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    console.log(JSON.stringify({ mode: 'apply', guildId: scope.guildId, channelId: scope.channelId, ...await applyCleanup({ api, scope, protectedState, manifest, chipId: options['--chip-id'], refreshControls: options['--refresh-controls'] === true }) }));
  } else {
    const { manifest, report } = await planCleanup({ api, scope, protectedState, chipId: options['--chip-id'], refreshControls: options['--refresh-controls'] === true });
    const path = resolve(options['--manifest'] ?? '/var/backups/audiobot/channel-cleanup/' + Date.now() + '.json');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(manifest, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
    console.log(JSON.stringify({ mode: 'dry-run', ...report, manifest: path, expiresAt: manifest.expiresAt }));
    if (options['--apply'] === true) {
      // One authorized operator command still records the exact bounded plan
      // before executing the same per-message checks as a saved-manifest apply.
      console.log(JSON.stringify({ mode: 'apply', guildId: scope.guildId, channelId: scope.channelId, ...await applyCleanup({ api, scope, protectedState, manifest, chipId: options['--chip-id'], refreshControls: options['--refresh-controls'] === true }) }));
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ error: error instanceof CleanupError ? error.reason : 'cleanup_stopped_without_printing_credentials', status: error.status, retryAfter: error.retryAfter })); process.exitCode = 1; });
}
