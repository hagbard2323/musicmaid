import { test } from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/config/env.js";
import { searchTracks } from "../src/audio/sources.js";
import { clearMatch } from "../src/audio/matching.js";
import { rateLimited, sourceRetryAt } from "../src/audio/source-errors.js";
import { markSourcePlayback, sourceAvailable, trackFailure } from "../src/audio/track-health.js";

test("clear Spotify selection does not wait for optional YouTube work", async t => {
  const previous = [env.spotifyDirectEnabled, env.spotifyClientId, env.spotifyClientSecret] as const;
  env.spotifyDirectEnabled = true; env.spotifyClientId = "fixture"; env.spotifyClientSecret = "fixture";
  t.mock.method(globalThis, "fetch", async (url: string | URL) => String(url).includes("api/token") ? Response.json({ access_token: "fixture", expires_in: 3600 }) : Response.json({ tracks: { items: [{ id: "0NTMtAO2BV4tnGvw9EgBVq", name: "Bitch Better Have My Money", artists: [{ name: "Rihanna" }], duration_ms: 219305 }] } }));
  let cancelled = false;
  try {
    const result = await searchTracks(async (id, signal) => {
      if (id.startsWith("ytmsearch:")) return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => { cancelled = true; reject(new Error("cancelled")); }, { once: true }));
      return { loadType: "empty" as never, data: {} };
    }, { query: "Rihanna Bitch Better Have My Money", source: "auto", requestedBy: "u" });
    assert.equal(clearMatch(result)?.source, "spotify"); assert.equal(result.moreAvailable, true); assert.equal(cancelled, true);
  } finally { [env.spotifyDirectEnabled, env.spotifyClientId, env.spotifyClientSecret] = previous; }
});
test("Spotify Retry-After prevents repeated API calls and audio progress cannot clear it", async t => {
  const previous = [env.spotifyDirectEnabled, env.spotifyClientId, env.spotifyClientSecret] as const;
  env.spotifyDirectEnabled = true; env.spotifyClientId = "fixture"; env.spotifyClientSecret = "fixture";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL) => {
    if (String(url).includes("api/token")) return Response.json({ access_token: "fixture", expires_in: 3600 });
    calls++; return new Response(null, { status: 429, headers: { "retry-after": "3600" } });
  });
  try {
    for (let i = 0; i < 4; i++) await searchTracks(async () => undefined, { query: "limited " + i, source: "spotify", requestedBy: "u" });
    assert.equal(calls, 1); assert.equal(sourceAvailable("spotify"), false);
    markSourcePlayback("spotify"); assert.equal(sourceAvailable("spotify"), false);
    assert.ok(sourceRetryAt("spotify") > Date.now() + 3500000);
    const dateLimit = rateLimited("test-provider", new Date(Date.now() + 120000).toUTCString()); assert.ok(dateLimit.retryAt! > Date.now() + 100000);
  } finally { sourceRetryAt("spotify", Date.now() + 3601000); [env.spotifyDirectEnabled, env.spotifyClientId, env.spotifyClientSecret] = previous; }
});
test("a source client that never resolves cannot hold a search past its deadline", async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await searchTracks(async () => new Promise(() => {}), { query: "Artist Song", source: "youtube", requestedBy: "u" }, false, { timeoutMs: 20 });
    assert.equal(result.candidates.length, 0); assert.ok(result.notices.some(n => /timed out/.test(n)));
  } finally { clearTimeout(keepAlive); }
});
test("audio-service lookup failures are reported without penalizing searches or their source", async () => {
  markSourcePlayback("soundcloud");
  for (let index = 0; index < 3; index++) {
    const query = `Fixture environment outage ${index}`;
    const result = await searchTracks(async () => { throw new Error("Lavalink lookup failed: fetch failed"); }, { query, source: "soundcloud", requestedBy: "fixture" });
    assert.equal(result.candidates.length, 0);
    assert.ok(result.notices.some(notice => notice.includes("Lavalink lookup failed")));
    assert.equal(trackFailure(query), undefined);
  }
  assert.equal(sourceAvailable("soundcloud"), true);
});
