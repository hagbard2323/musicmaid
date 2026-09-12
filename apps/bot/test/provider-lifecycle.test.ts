import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoadType, type LavalinkResponse } from 'shoukaku';
import { SpotifyOriginalAudio, runOriginalSpotify, type OriginalRecording, type OriginalRunner } from '../src/audio/spotify-direct.js';
import { SPOTIFY_DEVICE_CLIENT_ID } from '../src/audio/spotify-direct-auth.js';

const recording: OriginalRecording = { id: '0NTMtAO2BV4tnGvw9EgBVq', title: 'Fixture', artists: ['Artist'], durationMs: 2000 };
const quality = { codec: 'vorbis', bitrateKbps: 320, sampleRateHz: 44100 };
const decoded = async (url: string): Promise<LavalinkResponse> => ({ loadType: LoadType.TRACK, data: { encoded: 'fixture-http', pluginInfo: {}, info: { identifier: url, uri: url, title: 'Fixture', author: 'Artist', length: 2000, position: 0, sourceName: 'http', isSeekable: true, isStream: false } } });
async function until(condition: () => boolean, milliseconds = 2000) {
  const end = Date.now() + milliseconds;
  while (!condition()) { if (Date.now() > end) throw new Error('Provider fixture did not settle.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('Spotify admits four preparations, serializes work and releases queued work on disposal', async () => {
  let running = 0, peak = 0, calls = 0;
  const runner: OriginalRunner = async (_binary, _file, _recording, signal) => {
    calls++; peak = Math.max(peak, ++running);
    try { return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Fixture canceled.')), { once: true })); }
    finally { running--; }
  };
  const service = new SpotifyOriginalAudio('fixture', 'fixture', runner);
  const pending = Array.from({ length: 4 }, () => assert.rejects(service.resolve(recording, decoded)));
  await until(() => calls === 1);
  await assert.rejects(service.resolve(recording, decoded), /preparation is busy/);
  assert.equal(peak, 1); assert.equal(calls, 1);
  service.close(); await Promise.all(pending);
  assert.equal(running, 0); assert.equal(calls, 1, 'Canceled queued requests must never reach the runner.');
  await assert.rejects(service.resolve(recording, decoded)); assert.equal(calls, 1);
});

test('closing Spotify transport cancels a stalled Lavalink lookup and releases the preparation queue', async () => {
  let loaded = false, settled = false;
  const service = new SpotifyOriginalAudio('fixture', 'fixture', async () => ({ bytes: Buffer.alloc(100), recording, quality }));
  let release!: (value: LavalinkResponse | undefined) => void;
  const pending = service.resolve(recording, async () => { loaded = true; return new Promise(resolve => { release = resolve; }); }).then(() => { settled = true; }, () => { settled = true; });
  try {
    await until(() => loaded); service.close();
    await until(() => settled, 1000);
    assert.equal(settled, true);
  } finally { service.close(); release?.(undefined); await pending; }
});

test('canceling a stalled Spotify load removes its private lease and lets the next request prepare', async () => {
  const abort = new AbortController(); let uri = '', release!: (value: LavalinkResponse | undefined) => void;
  const service = new SpotifyOriginalAudio('fixture', 'fixture', async () => ({ bytes: Buffer.alloc(100), recording, quality }));
  const canceled = assert.rejects(service.resolve(recording, async url => { uri = url; return new Promise(resolve => { release = resolve; }); }, abort.signal));
  try {
    await until(() => Boolean(uri)); abort.abort(); await canceled;
    const removed = await fetch(uri); assert.equal(removed.status, 404); await removed.body?.cancel();
    assert.equal((await service.resolve(recording, decoded)).loadType, LoadType.TRACK);
  } finally { abort.abort(); release?.(undefined); service.close(); await canceled; }
});

test('Spotify enforces its 128 MiB active lease budget and recovers capacity after an attempt aborts', async () => {
  // Shared backing memory keeps this fixture small; each lease still accounts
  // for its advertised 64 MiB payload independently, just like separate buffers.
  const bytes = Buffer.alloc(64 * 1024 * 1024), aborts = [new AbortController(), new AbortController(), new AbortController()];
  let calls = 0;
  const service = new SpotifyOriginalAudio('fixture', 'fixture', async (_binary, _file, _recording, _signal, maximum) => { calls++; assert.equal(maximum, bytes.length); return { bytes, recording, quality }; });
  try {
    await service.resolve(recording, decoded, aborts[0].signal); await service.resolve(recording, decoded, aborts[1].signal);
    await assert.rejects(service.resolve(recording, decoded, aborts[2].signal), /buffers are full/); assert.equal(calls, 2);
    aborts[0].abort(); await service.resolve(recording, decoded, aborts[2].signal); assert.equal(calls, 3);
  } finally { for (const abort of aborts) abort.abort(); service.close(); }
});

async function childFixture(behavior: string) {
  const directory = await mkdtemp(join(tmpdir(), 'musicmaid-spotify-child-')), auth = join(directory, 'auth.json'), binary = join(directory, 'helper'), report = join(directory, 'child.json');
  await writeFile(auth, JSON.stringify({ version: 1, clientId: SPOTIFY_DEVICE_CLIENT_ID, deviceId: 'a'.repeat(40), refreshToken: 'fixture-refresh-private', scope: 'streaming user-read-private' }), { mode: 0o600 });
  const audio = (await readFile(new URL('fixtures/stereo-vorbis.ogg', import.meta.url))).toString('base64');
  await writeFile(binary, `#!${process.execPath}
const fs=require('node:fs');let input='';process.stdin.on('data', chunk=>input+=chunk);process.stdin.on('end',()=>{
 const request=JSON.parse(input);const bytes=Buffer.from(${JSON.stringify(audio)},'base64');
 fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({pid:process.pid,args:process.argv.slice(2),environment:Object.keys(process.env),stdinAccount:request.accessToken==='fixture-access-private'}));
 ${behavior}
});
`, { mode: 0o700 });
  return { auth, binary, report, started: async () => {
    const end = Date.now() + 3000;
    while (Date.now() < end) { try { return JSON.parse(await readFile(report, 'utf8')) as { pid: number; args: string[]; environment: string[]; stdinAccount: boolean }; } catch { await new Promise(resolve => setTimeout(resolve, 5)); } }
    throw new Error('Fixture helper did not start.');
  }, close: async () => { try { const value = JSON.parse(await readFile(report, 'utf8')); const argv = (await readFile('/proc/' + value.pid + '/cmdline', 'utf8')).split('\0'); if (argv.includes(binary)) process.kill(value.pid, 'SIGKILL'); } catch {} await rm(directory, { recursive: true, force: true }); } };
}

test('a Spotify helper early EOF is rejected and account material reaches only stdin', async t => {
  const f = await childFixture(`process.stderr.write(JSON.stringify({event:'metadata',trackId:request.trackId,durationMs:request.expectedDurationMs})+'\\n');process.stdout.write(bytes);`);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ access_token: 'fixture-access-private', expires_in: 3600 }));
  try {
    await assert.rejects(runOriginalSpotify(f.binary, f.auth, recording, new AbortController().signal, 1024 * 1024), error => { assert.match(String(error), /full audio or exact recording/); assert.doesNotMatch(String(error), /fixture-access|fixture-refresh/); return true; });
    const child = await f.started(); assert.equal(child.stdinAccount, true); assert.deepEqual(child.args, []);
    assert.deepEqual(child.environment.sort(), ['LANG', 'PATH']); assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  } finally { await f.close(); }
});

test('Spotify authorization refusal and rate limits never spawn an audio helper or replace the grant', async t => {
  for (const status of [401, 429]) {
    const f = await childFixture(`process.stderr.write('should not run');`);
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'PRIVATE_PROVIDER_DIAGNOSTIC', retry_after: 60 }, { status }));
    try {
      await assert.rejects(runOriginalSpotify(f.binary, f.auth, recording, new AbortController().signal, 1024), error => { assert.match(String(error), /authorization expired or was refused/); assert.doesNotMatch(String(error), /PRIVATE_PROVIDER|fixture-refresh/); return true; });
      await assert.rejects(readFile(f.report), { code: 'ENOENT' });
      assert.equal(JSON.parse(await readFile(f.auth, 'utf8')).refreshToken, 'fixture-refresh-private');
    } finally { await f.close(); t.mock.restoreAll(); }
  }
});

test('Spotify helper ignoring TERM is killed and reaped when its attempt is canceled', async t => {
  const f = await childFixture(`process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ access_token: 'fixture-access-private', expires_in: 3600 }));
  const abort = new AbortController(), pending = assert.rejects(runOriginalSpotify(f.binary, f.auth, recording, abort.signal, 1024));
  try {
    const child = await f.started(), started = Date.now(); abort.abort(); await pending;
    assert.ok(Date.now() - started < 3000); assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  } finally { abort.abort(); await f.close(); }
});
