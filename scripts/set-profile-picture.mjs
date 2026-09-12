#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

class ProfileError extends Error {}
export async function profileImage(path) {
  const file = await lstat(path);
  if (!file.isFile() || file.size < 24 || file.size > 8 * 1024 * 1024) throw new ProfileError('Use a PNG or JPEG file up to 8 MiB.');
  const bytes = await readFile(path);
  let mime, dimensions;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    mime = 'image/png'; dimensions = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    if (dimensions.some(n => n < 1 || n > 4096)) throw new ProfileError('Use a PNG no larger than 4096 pixels per side.');
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else throw new ProfileError('The file is not a supported PNG or JPEG.');
  return { data: `data:${mime};base64,${bytes.toString('base64')}`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, mime, dimensions };
}

export async function setProfilePicture({ imagePath, token, clientId, target = 'both', fetcher = fetch, progress = () => {} }) {
  if (!['application', 'bot', 'both'].includes(target)) throw new ProfileError('Target must be application, bot, or both.');
  if (!token || !/^\d{5,22}$/.test(clientId ?? '')) throw new ProfileError('Load MusicMaid’s protected environment before running this helper.');
  const image = await profileImage(imagePath);
  const request = async (path, method = 'GET', body) => {
    let response;
    try { response = await fetcher('https://discord.com/api/v10' + path, { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: 'Bot ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new ProfileError('Discord could not be reached. No credentials were printed.'); }
    let data; try { data = await response.json(); } catch { throw new ProfileError(`Discord returned an unreadable response (HTTP ${response.status}).`); }
    if (!response.ok) {
      const retry = response.status === 429 ? Number(response.headers.get('retry-after') ?? data.retry_after) : 0;
      throw new ProfileError(`Discord rejected ${method} ${path} (HTTP ${response.status}${typeof data.code === 'number' ? ', code ' + data.code : ''}).${Number.isFinite(retry) && retry > 0 ? ` Try again after ${Math.ceil(retry)} seconds.` : ''}`);
    }
    return data;
  };
  const app = await request('/applications/@me'), bot = await request('/users/@me');
  if (app.id !== clientId || bot.bot !== true || (app.bot?.id && app.bot.id !== bot.id)) throw new ProfileError('The credentials do not identify the expected MusicMaid application and bot. Nothing was changed.');
  progress({ event: 'input_verified', target, imageSha256: image.sha256, bytes: image.bytes, dimensions: image.dimensions });
  const results = [];
  if (target === 'application' || target === 'both') {
    const updated = await request('/applications/@me', 'PATCH', { icon: image.data });
    if (updated.id !== clientId || !/^[a-f0-9]{32}$/.test(updated.icon ?? '')) throw new ProfileError('Discord did not confirm the new application icon.');
    const result = { target: 'application', id: updated.id, hash: updated.icon, url: `https://cdn.discordapp.com/app-icons/${updated.id}/${updated.icon}.png?size=1024` };
    results.push(result); progress({ event: 'picture_updated', ...result });
  }
  if (target === 'bot' || target === 'both') {
    const updated = await request('/users/@me', 'PATCH', { avatar: image.data });
    if (updated.id !== bot.id || !/^(?:a_)?[a-f0-9]{32}$/.test(updated.avatar ?? '')) throw new ProfileError('Discord did not confirm the new bot avatar.');
    const result = { target: 'bot', id: updated.id, hash: updated.avatar, url: `https://cdn.discordapp.com/avatars/${updated.id}/${updated.avatar}.png?size=1024` };
    results.push(result); progress({ event: 'picture_updated', ...result });
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new ProfileError('Usage: set-profile-picture.mjs <PNG-or-JPEG> [application|bot|both]');
    await setProfilePicture({ imagePath: resolve(process.argv[2]), target: process.argv[3] ?? 'both', token: process.env.DISCORD_TOKEN, clientId: process.env.DISCORD_CLIENT_ID, progress: data => console.info(JSON.stringify(data)) });
    console.info('Profile picture update complete. The original file bytes were uploaded without browser cropping.');
  } catch (error) { console.error(error instanceof ProfileError ? error.message : 'Profile picture update failed. Check the local image path and protected environment.'); process.exitCode = 1; }
}
