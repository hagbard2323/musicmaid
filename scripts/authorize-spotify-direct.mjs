#!/usr/bin/env node
import { mkdir, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
const clientId = '65b708073fc0480ea92a077233ca87bd';
const output = resolve(process.argv[2] ?? '/var/lib/audiobot/spotify-direct.json');
const scopes = 'streaming user-read-private';
async function post(path, body) {
  const response = await fetch('https://accounts.spotify.com/' + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const data = await response.json(); return { ok: response.ok, data };
}
try {
  const initial = await post('oauth2/device/authorize', { client_id: clientId, scope: scopes });
  const data = initial.data;
  if (!initial.ok || typeof data.device_code !== 'string' || typeof data.user_code !== 'string' || !/^[A-Za-z0-9-]{4,16}$/.test(data.user_code)) throw new Error('Spotify did not offer device authorization. This unofficial client may no longer be accepted.');
  console.log('Authorize the Spotify Premium account for MusicMaid’s direct-audio test.');
  console.log('This uses librespot’s desktop-device flow; Spotify may label it Spotify for Desktop. MusicMaid is an unofficial client.');
  console.log('Open https://spotify.com/pair and enter code: ' + data.user_code);
  console.log('Waiting for approval. No password or callback URL needs to be pasted here.');
  const deadline = Date.now() + Math.min(Number(data.expires_in) || 600, 900) * 1000;
  let interval = Math.max(5, Number(data.interval) || 5);
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, interval * 1000));
    const result = await post('api/token', { client_id: clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: data.device_code });
    if (result.data.error === 'authorization_pending') continue;
    if (result.data.error === 'slow_down') { interval += 5; continue; }
    if (!result.ok || typeof result.data.refresh_token !== 'string') throw new Error('Spotify authorization was declined or expired. Run this setup again when ready.');
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    const temporary = output + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, clientId, deviceId: randomBytes(20).toString('hex'), refreshToken: result.data.refresh_token, scope: result.data.scope ?? scopes }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, output); await chmod(output, 0o600);
    } finally { await rm(temporary, { force: true }); }
    console.log('Direct Spotify authorization saved privately. Next: verify a full original-audio stream.'); process.exit(0);
  }
  throw new Error('Spotify pairing expired. Run the setup again.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Spotify authorization failed.'); process.exitCode = 1; }
