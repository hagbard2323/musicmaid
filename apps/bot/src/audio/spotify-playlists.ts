import { lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { parseSpotifyTrack, resolveSpotifyReference, type SpotifyTrackMetadata } from './spotify.js';
import { assertSourceReady, rateLimited } from './source-errors.js';
let cached: { token: string; until: number; key: string } | undefined;
let refreshing: Promise<string> | undefined;
async function credentialKey(): Promise<string> {
  try {
    const info = await lstat(env.spotifyUserTokenFile);
    if (!info.isFile() || (info.mode & 0o077)) throw new Error('private');
    return env.spotifyClientId + ':' + env.spotifyUserTokenFile + ':' + info.ino + ':' + info.mtimeMs;
  } catch { throw new Error('Spotify playlists need account authorization. Ask the server operator to run authorize-spotify-playlists.mjs.'); }
}
async function refresh(): Promise<string> {
  if (!env.spotifyClientId || !env.spotifyClientSecret) throw new Error('Configure the Spotify app first.');
  const path = env.spotifyUserTokenFile;
  let saved: { refresh_token?: string; scope?: string };
  try {
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o077)) throw new Error('private');
    saved = JSON.parse(await readFile(path, 'utf8'));
  } catch { throw new Error('Spotify playlists need account authorization. Ask the server operator to run authorize-spotify-playlists.mjs.'); }
  if (typeof saved.refresh_token !== 'string' || !saved.refresh_token) throw new Error('Spotify playlist authorization is missing. Reconnect the account.');
  const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { Authorization: 'Basic ' + Buffer.from(env.spotifyClientId + ':' + env.spotifyClientSecret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: saved.refresh_token }) });
  if (response.status === 429) throw rateLimited('spotify', response.headers.get('retry-after'));
  if (!response.ok) throw new Error('Spotify playlist authorization expired or was refused. Reconnect the account.');
  const data = await response.json() as { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string };
  if (typeof data.access_token !== 'string' || typeof data.expires_in !== 'number' || data.expires_in <= 0) throw new Error('Spotify returned an invalid account token.');
  if (data.refresh_token && data.refresh_token !== saved.refresh_token) {
    const temporary = path + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, JSON.stringify({ refresh_token: data.refresh_token, scope: data.scope ?? saved.scope }), { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  cached = { token: data.access_token, until: Date.now() + data.expires_in * 1000, key: await credentialKey() };
  return data.access_token;
}
async function token(): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000 && cached.key === await credentialKey()) return cached.token;
  if (!refreshing) refreshing = refresh().finally(() => { refreshing = undefined; });
  return refreshing;
}
async function api(path: string, signal: AbortSignal, retry = true): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  assertSourceReady('spotify');
  const response = await fetch('https://api.spotify.com/v1/' + path, { headers: { Authorization: 'Bearer ' + await token() }, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
  if (response.status === 401 && retry) { cached = undefined; return api(path, signal, false); }
  if (response.status === 403) throw new Error('Spotify refused this playlist. The authorized account must own it or be a collaborator in development mode.');
  if (response.status === 429) throw rateLimited('spotify', response.headers.get('retry-after'));
  if (!response.ok) throw new Error('Spotify playlist is unavailable (HTTP ' + response.status + ').');
  return response.json() as Promise<Record<string, unknown>>;
}
export async function spotifyPlaylist(input: string, start: number, signal: AbortSignal): Promise<{ name: string; tracks: SpotifyTrackMetadata[]; skipped: number; hasMore: boolean }> {
  const reference = await resolveSpotifyReference(input);
  if (reference?.type !== 'unsupported' || reference.itemType !== 'playlist' || !reference.id) throw new Error('Paste a Spotify playlist link.');
  if (!Number.isInteger(start) || start < 1 || start > 10_000) throw new Error('Choose a starting position from 1 to 10000.');
  const meta = await api('playlists/' + reference.id, signal);
  const tracks: SpotifyTrackMetadata[] = []; let skipped = 0, hasMore = false;
  for (let offset = start - 1; offset < start + 99; offset += 50) {
    const page = await api('playlists/' + reference.id + '/items?limit=50&offset=' + offset + '&market=' + env.spotifyMarket, signal);
    if (!Array.isArray(page.items)) throw new Error('Spotify did not return playlist items. Check this account’s playlist access.');
    for (const value of page.items.slice(0, 50)) {
      const row = value as { is_local?: boolean; item?: { type?: string }; track?: { type?: string } } | null;
      const item = row?.item ?? row?.track;
      try { if (!item || row?.is_local || item.type !== 'track') throw new Error('skip'); tracks.push(parseSpotifyTrack(item)); } catch { skipped++; }
    }
    hasMore = Boolean(page.next); if (!hasMore) break;
  }
  return { name: typeof meta.name === 'string' ? meta.name : 'Spotify playlist', tracks, skipped, hasMore };
}
