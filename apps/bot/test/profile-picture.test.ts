import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { setProfilePicture } = await import(new URL('../../../scripts/set-profile-picture.mjs', import.meta.url).href);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=', 'base64');
test('direct profile upload preserves image bytes and sends only icon/avatar fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicmaid-profile-')), imagePath = join(directory, 'image.png');
  await writeFile(imagePath, png);
  const calls: { path: string; method: string; body?: Record<string, string> }[] = [];
  const hash = 'a'.repeat(32), clientId = '100000000000000001';
  const fetcher = async (url: string, options: RequestInit) => {
    assert.equal(options.redirect, 'error'); assert.equal(new Headers(options.headers).get('Authorization'), 'Bot fixture-secret');
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body as string) : undefined;
    calls.push({ path, method: options.method!, body });
    return Response.json(path.endsWith('/applications/@me') ? { id: clientId, bot: { id: clientId }, flags: 131072, icon: options.method === 'PATCH' ? hash : 'b'.repeat(32) } : { id: clientId, bot: true, avatar: hash });
  };
  try {
    const results = await setProfilePicture({ imagePath, token: 'fixture-secret', clientId, target: 'both', fetcher });
    const patches = calls.filter(call => call.method === 'PATCH'); assert.equal(patches.length, 2);
    assert.deepEqual(Object.keys(patches[0].body!), ['icon']); assert.deepEqual(Object.keys(patches[1].body!), ['avatar']);
    for (const body of patches.map(p => p.body!)) assert.equal(Object.values(body)[0], 'data:image/png;base64,' + png.toString('base64'));
    assert.equal(results[0].hash, hash); assert.equal(results[1].target, 'bot');
    assert.ok(calls.every(call => !call.body || !('flags' in call.body)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('wrong application credentials cannot mutate a profile and rate limits are not retried blindly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musicmaid-profile-')), imagePath = join(directory, 'image.png');
  await writeFile(imagePath, png);
  const clientId = '100000000000000001'; let patches = 0, rateCalls = 0;
  try {
    await assert.rejects(setProfilePicture({ imagePath, token: 'fixture', clientId, fetcher: async (_url: string, options: RequestInit) => { if (options.method === 'PATCH') patches++; return Response.json({ id: '99999999', bot: true }); } }), /expected MusicMaid/);
    assert.equal(patches, 0);
    await assert.rejects(setProfilePicture({ imagePath, token: 'fixture', clientId, fetcher: async () => { rateCalls++; return Response.json({ retry_after: 60 }, { status: 429, headers: { 'Retry-After': '60' } }); } }), /60 seconds/);
    assert.equal(rateCalls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
