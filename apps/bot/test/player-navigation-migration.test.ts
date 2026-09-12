import { test } from 'node:test';
import assert from 'node:assert/strict';

const { migratePlayerNavigation } = await import(new URL('../../../scripts/migrate-player-navigation.mjs', import.meta.url).href);
const scope = { guildId: '100001', channelId: '200002', botUserId: '300003' };
const fixture = () => ({ id: '400004', channel_id: scope.channelId, author: { id: scope.botUserId, bot: true }, pinned: true,
  content: '', embeds: [{ title: 'Played', description: 'Rihanna — Bitch Better Have My Money', thumbnail: { url: 'https://example.com/cover.png' }, fields: [{ name: 'Requested by', value: '<@500005>' }] }],
  components: [{ type: 1, id: 17, components: [
    { type: 2, id: 18, style: 5, label: 'Open current player', url: 'https://discord.com/channels/100001/200002/600006', emoji: { name: '🎵' } },
    { type: 2, style: 2, label: 'Play', custom_id: 'm:play' },
    { type: 2, style: 2, label: 'Playlists', custom_id: 'pl:list' }
  ] }]
});

test('historical navigation migration preserves the complete card and changes only its exact old link button', () => {
  for (const title of ['Played', 'Skipped', 'Playback failed', 'Previous track']) {
    const message = fixture(); message.embeds[0].title = title;
    const original = structuredClone(message);
    const migrated = migratePlayerNavigation(message, scope);
    assert.deepEqual(message, original, 'planning must not mutate the source message');
    assert.ok(migrated);
    const expected = structuredClone(message.components) as any[];
    delete expected[0].components[0].url;
    expected[0].components[0].style = 2; expected[0].components[0].custom_id = 'm:current';
    assert.deepEqual(migrated, expected);
    assert.equal(migratePlayerNavigation({ ...message, components: migrated }, scope), undefined, 'migration is idempotent');
    migrated[0].components[0].emoji.name = 'Changed only in the returned clone';
    migrated[0].components[1].label = 'Changed only in the returned clone';
    assert.deepEqual(message, original);
  }
});

test('navigation migration ignores other authors, active cards, webhooks, different destinations, and duplicate controls', () => {
  const changes: Array<(message: any) => void> = [
    message => { message.author.id = '999999'; },
    message => { message.author.bot = false; },
    message => { message.channel_id = '999999'; },
    message => { message.webhook_id = scope.botUserId; },
    message => { message.application_id = '999999'; },
    message => { message.embeds[0].title = 'Now playing'; },
    message => { message.embeds[0].title = 'MusicMaid Console'; },
    message => { message.embeds.push({ title: 'Now playing' }); },
    message => { message.components[0].components[0].url = 'https://discord.com/channels/100001/999999/600006'; },
    message => { message.components[0].components[0].url += '?after=1'; },
    message => { message.components[0].components[0].label = 'Other link'; },
    message => { message.components[0].components[0].custom_id = 'ambiguous'; },
    message => { message.components[0].components.push({ type: 2, style: 2, custom_id: 'm:current' }); },
    message => { message.components[0].components.push(structuredClone(message.components[0].components[0])); },
    message => { message.components[0].components.push({ type: 3, custom_id: 'unrelated-select' }); }
  ];
  for (const change of changes) {
    const message = fixture(); change(message);
    assert.equal(migratePlayerNavigation(message, scope), undefined);
  }
});
