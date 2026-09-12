import { lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export const SPOTIFY_DEVICE_CLIENT_ID = '65b708073fc0480ea92a077233ca87bd';
export type SpotifyDirectAuth = { version: 1; clientId: string; deviceId: string; refreshToken: string; scope: string };
type Token = { accessToken: string; deviceId: string; until: number; fileKey: string };
const cached = new Map<string, Token>();
const pending = new Map<string, Promise<Token>>();
export function invalidateSpotifyDirectToken(path: string): void { cached.delete(path); }
export async function readDirectAuth(path: string): Promise<{ auth: SpotifyDirectAuth; fileKey: string }> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o077)) throw new Error('private');
    const auth = JSON.parse(await readFile(path, 'utf8')) as SpotifyDirectAuth;
    if (auth.version !== 1 || auth.clientId !== SPOTIFY_DEVICE_CLIENT_ID || typeof auth.refreshToken !== 'string' || !auth.refreshToken || !/^[a-f0-9]{40}$/.test(auth.deviceId)) throw new Error('invalid');
    return { auth, fileKey: info.ino + ':' + info.mtimeMs };
  } catch { throw new Error('Spotify: the original-audio account is not connected. A server operator must reconnect it.'); }
}
export async function spotifyDirectToken(path: string, signal?: AbortSignal): Promise<{ accessToken: string; deviceId: string }> {
  signal?.throwIfAborted();
  const { auth, fileKey } = await readDirectAuth(path);
  const existing = cached.get(path);
  if (existing && existing.fileKey === fileKey && existing.until > Date.now() + 60_000) return existing;
  let work = pending.get(path);
  if (!work) {
    work = (async () => {
      const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: auth.clientId, grant_type: 'refresh_token', refresh_token: auth.refreshToken }) });
      if (!response.ok) throw new Error('Spotify: direct-audio authorization expired or was refused. Refresh the account authorization.');
      const data = await response.json() as { access_token?: string; expires_in?: number; refresh_token?: string };
      if (typeof data.access_token !== 'string' || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Spotify: invalid account token response.');
      if (data.refresh_token && data.refresh_token !== auth.refreshToken) {
        // Never overwrite credentials if the operator switched accounts during refresh.
        if ((await readDirectAuth(path)).fileKey !== fileKey) throw new Error('Spotify: account changed during authorization. Retry the request.');
        const temporary = path + '.' + randomUUID() + '.tmp';
        try { await writeFile(temporary, JSON.stringify({ ...auth, refreshToken: data.refresh_token }), { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
        finally { await rm(temporary, { force: true }); }
      }
      const current = await readDirectAuth(path);
      if (current.auth.deviceId !== auth.deviceId) throw new Error('Spotify: account changed during authorization. Retry the request.');
      const token = { accessToken: data.access_token, deviceId: auth.deviceId, until: Date.now() + data.expires_in * 1000, fileKey: current.fileKey };
      cached.set(path, token); return token;
    })().finally(() => { pending.delete(path); });
    pending.set(path, work);
  }
  const result = await work; signal?.throwIfAborted(); return result;
}
