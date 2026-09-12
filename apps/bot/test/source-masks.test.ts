import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { LoadType, type Track } from "shoukaku";
import { searchTracks } from "../src/audio/sources.js";
import { bestMatch } from "../src/audio/matching.js";
import { env } from "../src/config/env.js";
import type { MusicRequest, RecordingSource } from "../src/audio/model.js";

const originalId = "2MYPFXScWdR3PQihBQxu7x", alternativeId = "0123456789ABCDEFGHIJKL";
const metadata = { id: originalId, name: "Bubbles", artists: [{ name: "Yosi Horikawa" }], duration_ms: 347250, external_ids: { isrc: "GBTEST1234567" } };
const request = (sources?: RecordingSource[]): MusicRequest => ({ query: "Yosi Horikawa Bubbles", source: "auto", sources, requestedBy: "u" });
function track(source: "youtube" | "soundcloud", identifier = source === "youtube" ? "2I3PLVuKNtw" : "bubbles"): Track {
  return { encoded: "fixture", pluginInfo: {}, info: { identifier, uri: source === "youtube" ? "https://www.youtube.com/watch?v=" + identifier : "https://soundcloud.com/yosi-horikawa/" + identifier, title: "Bubbles", author: "Yosi Horikawa", sourceName: source, length: 347250, isSeekable: true, isStream: false, position: 0 } };
}
function spotify(t: TestContext, enabled = true) {
  const before = [env.spotifyDirectEnabled, env.spotifyClientId, env.spotifyClientSecret] as const;
  env.spotifyDirectEnabled = enabled; env.spotifyClientId = "mask-fixture"; env.spotifyClientSecret = "mask-fixture";
  t.after(() => { [env.spotifyDirectEnabled, env.spotifyClientId, env.spotifyClientSecret] = before; });
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(input); calls.push(url.pathname + url.search);
    if (url.pathname === "/api/token") return Response.json({ access_token: "fixture", expires_in: 3600 });
    if (url.pathname === "/v1/search") return Response.json({ tracks: { items: [metadata, { ...metadata, id: alternativeId, duration_ms: 347300 }] } });
    if (url.pathname === "/v1/tracks/" + originalId) return Response.json(metadata);
    assert.fail("Unexpected provider request: " + url.pathname);
  });
  return calls;
}

test("text source masks are validated, deduplicated and do not mutate the submitted preference", async t => {
  t.mock.method(globalThis, "fetch", async () => { assert.fail("Spotify must not be contacted"); });
  for (const invalid of [[], null, {}, ["auto"], ["YouTube"], ["youtube", "other"]]) {
    await assert.rejects(searchTracks(async () => { assert.fail("Invalid mask must not reach a source"); }, { ...request(), sources: invalid } as MusicRequest), /valid search source/);
  }
  const input = request(["soundcloud", "soundcloud", "youtube"]), calls: string[] = [];
  const result = await searchTracks(async id => {
    calls.push(id);
    return id.startsWith("ytmeta:") ? { loadType: LoadType.TRACK, data: track("youtube") } : { loadType: LoadType.SEARCH, data: [track(id.startsWith("scsearch:") ? "soundcloud" : "youtube")] };
  }, input);
  assert.deepEqual(result.request.sources, ["soundcloud", "youtube"]); assert.deepEqual(input.sources, ["soundcloud", "soundcloud", "youtube"]);
  assert.equal(calls.filter(id => id.startsWith("scsearch:")).length, 1);
  assert.deepEqual(new Set(result.candidates.map(candidate => candidate.source)), new Set(["youtube", "soundcloud"]));
});

test("single-source text masks cannot query or return an unrelated provider", async t => {
  t.mock.method(globalThis, "fetch", async () => { assert.fail("Spotify must not be contacted"); });
  for (const source of ["youtube", "soundcloud"] as const) {
    const calls: string[] = [];
    const result = await searchTracks(async id => { calls.push(id); return { loadType: LoadType.SEARCH, data: [track(source)] }; }, request([source]));
    assert.ok(calls.every(id => id.startsWith(source === "youtube" ? "yt" : "scsearch:")));
    assert.ok(result.candidates.length > 0 && result.candidates.every(candidate => candidate.source === source));
  }
  const mixed = await searchTracks(async () => ({ loadType: LoadType.SEARCH, data: [track("youtube"), track("soundcloud")] }), request(["soundcloud"]));
  assert.deepEqual(mixed.candidates.map(candidate => candidate.source), ["soundcloud"], "an unexpected provider response cannot escape the requested mask");
});

test("disabled Spotify is excluded from an automatic mask without broadening the other selections", async t => {
  const calls = spotify(t, false), loaded: string[] = [];
  const result = await searchTracks(async id => { loaded.push(id); return { loadType: LoadType.SEARCH, data: [track("soundcloud")] }; }, request(["spotify", "soundcloud"]));
  assert.equal(calls.length, 0); assert.deepEqual(loaded, ["scsearch:Yosi Horikawa Bubbles"]);
  assert.match(result.notices.join(" "), /Spotify was excluded/); assert.equal(result.candidates[0].source, "soundcloud");
  await assert.rejects(searchTracks(async () => { assert.fail("No fallback beyond the mask"); }, request(["spotify"])), /None of the selected search sources/);
  await assert.rejects(searchTracks(async () => { assert.fail("Explicit Spotify must explain its disabled state"); }, { ...request(), source: "spotify" }), /Original Spotify audio is not enabled/);
});

test("exact YouTube and SoundCloud links override text preferences even during review or a disabled Spotify shortcut", async t => {
  const calls = spotify(t, false);
  for (const source of ["youtube", "soundcloud"] as const) {
    const expected = track(source), loaded: string[] = [];
    const result = await searchTracks(async id => { loaded.push(id); return { loadType: LoadType.TRACK, data: expected }; }, { query: expected.info.uri!, source: "spotify", sources: ["spotify"], requestedBy: "u" }, true);
    assert.equal(result.direct, true); assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].source, source);
    assert.equal(result.candidates[0].identifier, expected.info.identifier); assert.deepEqual(loaded, [expected.info.uri]);
  }
  assert.equal(calls.length, 0);
});

test("an exact link never accepts a different video or a different provider's response", async () => {
  for (const candidate of [track("youtube", "85CLbxM8gQ8"), track("soundcloud")]) {
    await assert.rejects(searchTracks(async () => ({ loadType: LoadType.TRACK, data: candidate }), { query: "https://youtu.be/2I3PLVuKNtw", source: "auto", sources: ["soundcloud"], requestedBy: "u" }), /not substituted/);
  }
});

test("an original Spotify link remains the exact recording in review regardless of text source choices", async t => {
  const calls = spotify(t);
  for (const review of [false, true]) {
    const result = await searchTracks(async () => { assert.fail("An exact Spotify link must not search mirrors"); }, { query: "https://open.spotify.com/intl-de/track/" + originalId, source: "youtube", sources: ["soundcloud"], requestedBy: "u" }, review);
    assert.equal(result.direct, true); assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].identifier, originalId); assert.equal(result.candidates[0].source, "spotify");
  }
  assert.equal(calls.filter(url => url.startsWith("/v1/search")).length, 0);
});

test("Spotify links without original audio retain a labelled YouTube/SoundCloud metadata match", async t => {
  const calls = spotify(t, false), loaded: string[] = [];
  const result = await searchTracks(async id => {
    loaded.push(id); return { loadType: LoadType.SEARCH, data: [track(id.startsWith("scsearch:") ? "soundcloud" : "youtube")] };
  }, { query: "spotify:track:" + originalId, source: "spotify", sources: ["spotify"], requestedBy: "u" }, true);
  assert.equal(result.direct, false); assert.equal(result.request.spotify?.id, originalId);
  assert.match(result.notices.join(" "), /link supplies song metadata/);
  assert.deepEqual(new Set(result.candidates.map(candidate => candidate.source)), new Set(["youtube", "soundcloud"]));
  assert.ok(loaded.some(id => id.startsWith("ytmsearch:")) && loaded.some(id => id.startsWith("scsearch:")));
  assert.equal(calls.filter(url => url.startsWith("/v1/search")).length, 0);
});

test("Spotify-only Change version text searches the catalog while preserving expected recording metadata", async t => {
  const calls = spotify(t);
  const expected = { id: originalId, title: "Bubbles", artists: ["Yosi Horikawa"], durationMs: 347250, isrc: "GBTEST1234567" };
  const result = await searchTracks(async () => { assert.fail("Review stays within the Spotify mask"); }, { ...request(["spotify"]), spotify: expected }, true);
  assert.equal(result.direct, false); assert.deepEqual(result.request.spotify, expected);
  assert.equal(calls.filter(url => url.startsWith("/v1/search")).length, 1);
  assert.deepEqual(result.candidates.map(candidate => candidate.identifier), [originalId, alternativeId]);
  assert.equal(bestMatch(result, ["https://open.spotify.com/track/" + originalId])?.identifier, alternativeId);
});

test("a clear Spotify match returns early even when Spotify is last in the selected mask", async t => {
  spotify(t); let abortReason: string | undefined;
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const result = await searchTracks(async (_id, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => { abortReason = signal!.reason.name; reject(signal!.reason); }, { once: true });
    }), request(["youtube", "spotify"]), false, { timeoutMs: 1000 });
    assert.equal(result.candidates[0].source, "spotify"); assert.equal(abortReason, "AbortError", "optional work was cancelled by the early result, not the overall timeout");
  } finally { clearTimeout(keepAlive); }
});

test("caller cancellation prevents provider calls and discards an in-flight masked search", async t => {
  const calls = spotify(t);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(searchTracks(async () => { assert.fail("Already cancelled"); }, request(["spotify"]), false, { signal: cancelled.signal }), /abort/i);
  assert.equal(calls.length, 0);
  let complete!: (response: { loadType: LoadType.SEARCH; data: Track[] }) => void;
  const active = new AbortController();
  const pending = searchTracks(async () => new Promise(resolve => { complete = resolve; }), request(["soundcloud"]), false, { signal: active.signal });
  active.abort(); await assert.rejects(pending, /abort/i);
  complete({ loadType: LoadType.SEARCH, data: [track("soundcloud")] });
});
