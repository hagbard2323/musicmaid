const idPattern = /^\d{5,22}$/;
const historicalTitles = new Set(['Played', 'Skipped', 'Playback failed', 'Previous track']);

/** Convert only MusicMaid's known historical navigation button; retain the card itself. */
export function migratePlayerNavigation(message, { guildId, channelId, botUserId, applicationId = botUserId }) {
  if (![guildId, channelId, botUserId, applicationId].every(value => typeof value === 'string' && idPattern.test(value))) return undefined;
  if (typeof message?.id !== 'string' || !idPattern.test(message.id) || message.channel_id !== channelId || message.author?.id !== botUserId || message.author?.bot !== true || message.webhook_id) return undefined;
  if (message.application_id !== undefined && message.application_id !== applicationId) return undefined;
  if (message.embeds?.length !== 1 || !historicalTitles.has(message.embeds[0]?.title)) return undefined;
  const rows = message.components;
  if (!Array.isArray(rows) || !rows.length || rows.length > 5 || rows.some(row => row.type !== 1 || !Array.isArray(row.components) || !row.components.length || row.components.length > 5 || row.components.some(component => component.type !== 2))) return undefined;
  const controls = rows.flatMap(row => row.components);
  if (controls.some(component => component.custom_id === 'm:current')) return undefined;
  const prefix = `https://discord.com/channels/${guildId}/${channelId}/`;
  const matches = controls.filter(component => component.style === 5 && component.label === 'Open current player' && component.custom_id === undefined && typeof component.url === 'string' && component.url.startsWith(prefix) && idPattern.test(component.url.slice(prefix.length)));
  if (matches.length !== 1) return undefined;
  return rows.map(row => ({ ...row, components: row.components.map(component => {
    if (component !== matches[0]) return structuredClone(component);
    const migrated = { ...structuredClone(component), style: 2, custom_id: 'm:current' };
    delete migrated.url;
    return migrated;
  }) }));
}
