#!/usr/bin/env node
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, rename, rm, stat, chown } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
const clientId = process.env.SPOTIFY_CLIENT_ID, secret = process.env.SPOTIFY_CLIENT_SECRET;
const redirect = 'http://127.0.0.1:8765/callback';
const path = process.env.SPOTIFY_USER_TOKEN_FILE ?? '/var/lib/audiobot/spotify-user.json';
if (!clientId || !secret) throw new Error('Load the protected bot .env using node --env-file before running this script.');
const state = randomBytes(24).toString('hex');
const url = new URL('https://accounts.spotify.com/authorize');
url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirect, scope: 'playlist-read-private playlist-read-collaborative', state, show_dialog: 'true' }).toString();
console.log('Add this exact Redirect URI to the existing Spotify developer app, then save it:\n' + redirect);
console.log('\nOpen this URL in your browser and authorize the dedicated Spotify account:\n' + url.href);
console.log('\nThe browser may show a connection error at 127.0.0.1 afterwards. Copy that full address from the address bar and paste it HERE in this terminal, not into chat.');
const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  const callback = new URL((await rl.question('Callback URL: ')).trim());
  if (callback.origin + callback.pathname !== redirect) throw new Error('Unexpected callback address.');
  const returned = callback.searchParams.get('state') ?? '';
  if (returned.length !== state.length || !timingSafeEqual(Buffer.from(returned), Buffer.from(state))) throw new Error('Authorization state did not match. Run the script again.');
  if (callback.searchParams.has('error') || !callback.searchParams.get('code')) throw new Error('Spotify authorization was not completed.');
  const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', signal: AbortSignal.timeout(15000), headers: { Authorization: 'Basic ' + Buffer.from(clientId + ':' + secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: callback.searchParams.get('code'), redirect_uri: redirect }) });
  if (!response.ok) throw new Error('Spotify refused the authorization exchange (HTTP ' + response.status + '). Check the Redirect URI and app access.');
  const data = await response.json();
  if (typeof data.refresh_token !== 'string') throw new Error('Spotify did not return playlist authorization.');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const owner = await stat(dirname(path)); const temporary = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify({ refresh_token: data.refresh_token, scope: data.scope }), { mode: 0o600, flag: 'wx' });
    if (process.getuid?.() === 0) await chown(temporary, owner.uid, owner.gid);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  console.log('Spotify playlist authorization saved privately. No bot restart is needed. Import a playlist owned by or shared collaboratively with that account.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Authorization failed.'); process.exitCode = 1; }
finally { rl.close(); }
