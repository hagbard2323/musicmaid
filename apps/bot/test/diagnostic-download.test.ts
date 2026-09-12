import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageFlags, type Client, type Interaction } from "discord.js";
import { diagnosticAudioSnapshot, diagnosticDownload, type DiagnosticInput } from "../src/commands/diagnostic-download.js";
import { MusicController } from "../src/commands/music.js";
import { newSession, entryFor } from "../src/audio/model.js";
import type { MusicCoordinator } from "../src/audio/coordinator.js";
import type { MusicStorage } from "../src/storage/types.js";
import { musicCommands } from "../src/commands/register.js";

const identity = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444'];
const sensitive = [...identity, 'PRIVATE_TRACK_TITLE', 'PRIVATE_ARTIST', 'PRIVATE_QUERY', 'PRIVATE_COOKIE_VALUE', '/private/account-file', 'https://private.example/stream?token=secret', 'private-incident-code', 'private-entry-id', 'PRIVATE_ISRC', 'private-spotify-id'];
function fixture(): DiagnosticInput {
  const session = newSession(identity[0]); session.voiceChannelId = identity[1]; session.textChannelId = identity[2]; session.panelMessageId = identity[3];
  session.current = entryFor({ query: 'PRIVATE_QUERY', requestedBy: identity[3], source: 'auto', spotify: { id: 'private-spotify-id', title: 'PRIVATE_TRACK_TITLE', artists: ['PRIVATE_ARTIST'], durationMs: 219305 } },
    { identifier: 'private-entry-id', title: 'PRIVATE_TRACK_TITLE', author: 'PRIVATE_ARTIST', uri: 'https://private.example/stream?token=secret', artworkUrl: 'https://private.example/private-artwork', isrc: 'PRIVATE_ISRC', source: 'spotify', durationMs: 219305, isSeekable: true, isStream: false });
  session.current.id = 'private-entry-id'; session.queue = [structuredClone(session.current)]; session.state = 'suspended'; session.positionMs = 172345;
  session.failure = { incidentId: 'private-incident-code', scope: 'environment', reason: 'Voice: PRIVATE_TRACK_TITLE account PRIVATE_COOKIE_VALUE /private/account-file https://private.example/stream?token=secret' };
  session.history = [{ id: 'private-history-id', at: 1723456789012, entry: session.current, outcome: 'failed', incidentId: 'private-incident-code', reason: 'Lavalink lookup failed: PRIVATE_COOKIE_VALUE /private/account-file' }];
  return {
    session, release: { revision: 'a'.repeat(40), builtAt: '2026-09-13T00:00:00.000Z', dirty: false },
    versions: { node: 'v22.23.0', discordJs: '14.27.0', shoukaku: '4.3.0' },
    audio: { nodes: 1, connectedNodes: 1, players: 1, connections: 1, info: { version: { semver: '4.2.2-PRIVATE_COOKIE_VALUE' }, lavaplayer: '2.2.6', plugins: [{ name: 'youtube-plugin', version: '1.18.2' }, { name: 'PRIVATE_ARTIST', version: 'https://private.example/stream?token=secret' }], git: { remote: 'https://private.example/stream?token=secret' }, password: 'PRIVATE_COOKIE_VALUE' } },
    health: { discordReady: true, voiceConnected: false, serverMuted: false, viewerReady: false },
    configuration: { youtubeAccount: true, spotifyMetadata: true, spotifyOriginalAudio: true, viewer: false },
    providers: [{ source: 'youtube', failures: [{ uri: 'https://private.example/stream?token=secret', at: 1723456789012 }], cooldownUntil: 999999, lastError: 'authorization refused PRIVATE_COOKIE_VALUE', lastPlaybackAt: 1723456789012 }],
  };
}

test('diagnostic export constructs only versions, health, counts and controlled incident summaries', () => {
  const input = fixture(), before = structuredClone(input);
  const report = diagnosticDownload(input, 1000), encoded = JSON.stringify(report);
  for (const value of sensitive) assert.ok(!encoded.includes(value), `excluded ${value}`);
  for (const key of ['guildId', 'voiceChannelId', 'textChannelId', 'panelMessageId', 'requestedBy', 'incidentId', 'query', 'title', 'author', 'uri', 'artworkUrl', 'isrc', 'positionMs', 'durationMs', 'lastPlaybackAt']) assert.ok(!encoded.includes(`"${key}"`), `excluded field ${key}`);
  assert.doesNotMatch(encoded, /https?:\/\/|\/private\//);
  assert.equal(report.release.revision, 'a'.repeat(40)); assert.equal(report.versions.node, '22.23.0');
  assert.equal(report.versions.youtubePlugin, '1.18.2');
  assert.equal(report.counts.queued, 1); assert.equal(report.counts.retainedFailures, 1);
  assert.deepEqual(report.incidents.current, { scope: 'environment', category: 'voice' });
  assert.equal(report.incidents.retainedFailureScopes.environment, 1);
  assert.equal(report.health.providers.youtube.lastIssue, 'account_access');
  assert.deepEqual(input, before, 'downloading diagnostics must not modify playback or stored data');
  assert.ok(Buffer.byteLength(encoded) < 8192);
});

test('unexpected string/object values cannot escape the diagnostic whitelist through versions or settings', () => {
  const input = fixture() as any;
  input.release = { revision: 'PRIVATE_COOKIE_VALUE', builtAt: '/private/account-file', dirty: 'PRIVATE_COOKIE_VALUE', secret: 'PRIVATE_COOKIE_VALUE' };
  input.versions = { node: 'https://private.example/stream?token=secret', discordJs: '/private/account-file', shoukaku: 'PRIVATE_COOKIE_VALUE' };
  input.audio.nodes = Number(identity[0]); input.audio.info = { version: { semver: 'https://private.example/stream?token=secret' }, plugins: [{ name: 'youtube-plugin', version: '/private/account-file' }] };
  input.session.state = 'PRIVATE_COOKIE_VALUE'; input.session.queueMode = '/private/account-file'; input.session.loop = 'PRIVATE_COOKIE_VALUE'; input.session.failure.scope = 'PRIVATE_COOKIE_VALUE';
  input.health.discordReady = 'PRIVATE_COOKIE_VALUE'; input.configuration.youtubeAccount = 'PRIVATE_COOKIE_VALUE';
  const report = diagnosticDownload(input), encoded = JSON.stringify(report);
  for (const value of sensitive) assert.ok(!encoded.includes(value));
  assert.equal(report.release.revision, 'unknown'); assert.equal(report.release.builtAt, null);
  assert.equal(report.versions.node, 'unknown'); assert.equal(report.counts.audioNodes, null);
  assert.equal(report.health.discordReady, null); assert.equal(report.configuration.youtubeAccount, null);
  assert.equal(report.playback.state, 'unknown');
});

test('a stalled audio-info lookup receives cancellation and the report can use unknown versions', async () => {
  let observed: AbortSignal | undefined;
  const counts = { nodes: 1, connectedNodes: 1, players: 1, connections: 1 };
  const audio = await diagnosticAudioSnapshot(counts, signal => { observed = signal; return new Promise(() => {}); }, 15);
  assert.equal(observed?.aborted, true); assert.equal(audio.info, undefined);
  const report = diagnosticDownload({ ...fixture(), audio });
  assert.equal(report.versions.lavalink, 'unknown'); assert.equal(report.health.audioInfoAvailable, false); assert.equal(report.health.audioConnected, true);
});

function interaction(guildId: string, moderator: boolean) {
  const replies: any[] = []; let acknowledged = false;
  const i = {
    id: `${guildId}-${moderator}`, guildId, channelId: identity[2], user: { id: identity[3] }, commandName: 'music-admin', options: { getSubcommand: () => 'diagnostic' },
    guild: { members: { cache: new Map(), me: { voice: { channelId: identity[1], serverMute: false } } } }, memberPermissions: { has: () => moderator },
    isChatInputCommand: () => true, isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false,
    get deferred() { return acknowledged; }, deferReply: async (payload: any) => { assert.equal(payload.flags, MessageFlags.Ephemeral); acknowledged = true; },
    editReply: async (payload: any) => { replies.push(payload); }, reply: async (payload: any) => { replies.push(payload); },
  };
  return { i, replies, acknowledged: () => acknowledged };
}

test('moderator diagnostic download acknowledges privately before slow collection and excludes identities', async () => {
  const input = fixture(), h = interaction(identity[0], true);
  const music = { snapshot: () => structuredClone(input.session) } as unknown as MusicCoordinator;
  const controller = new MusicController({ isReady: () => true } as unknown as Client, music, async () => { throw new Error('Diagnostic download must not search recordings.'); }, {} as MusicStorage, async () => {}, identity[0]);
  let release!: (value: typeof input.audio) => void;
  controller['diagnosticAudio'] = async () => { assert.equal(h.acknowledged(), true); return new Promise(resolve => { release = resolve; }); };
  try {
    const pending = controller.handle(h.i as unknown as Interaction);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.acknowledged(), true); assert.equal(h.replies.length, 0);
    release(input.audio); await pending;
    const payload = h.replies.at(-1), attachment = payload.files[0];
    assert.equal(attachment.name, 'musicmaid-diagnostic.json'); assert.ok(Buffer.isBuffer(attachment.attachment));
    const encoded = attachment.attachment.toString('utf8');
    for (const value of sensitive) assert.ok(!encoded.includes(value));
    assert.deepEqual(payload.allowedMentions.parse, []);
    assert.ok(musicCommands.find(command => command.name === 'music-admin')!.toJSON().options!.some(option => option.name === 'diagnostic'));
  } finally { controller.close(); }
});

test('non-moderators and other guilds cannot collect or download the diagnostic report', async t => {
  t.mock.method(console, 'info', () => {});
  const input = fixture(); let collected = 0;
  const controller = new MusicController({ isReady: () => true } as unknown as Client, { snapshot: () => structuredClone(input.session) } as unknown as MusicCoordinator, async () => undefined, {} as MusicStorage, async () => {}, identity[0]);
  controller['diagnosticAudio'] = async () => { collected++; return input.audio; };
  try {
    for (const h of [interaction(identity[0], false), interaction('555555555555555555', true)]) {
      await controller.handle(h.i as unknown as Interaction);
      assert.equal(h.replies.length, 1); assert.equal(h.replies[0].files, undefined); assert.equal(collected, 0);
    }
  } finally { controller.close(); }
});
