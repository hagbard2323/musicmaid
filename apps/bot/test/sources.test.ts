import { test } from "node:test";
import assert from "node:assert/strict";
import { LoadType, type Track } from "shoukaku";
import { normalizeText, plausibleRecording, rankRecording, recordingFor, resolveSelected, searchTracks, sourceUrl } from "../src/audio/sources.js";
import { markSourceFailure, sourceAvailable } from "../src/audio/track-health.js";

function track(title: string, author: string, source = "soundcloud", id = title): Track {
  return { encoded: `encoded-${id}`, info: { identifier: id, uri: `https://${source === "youtube" ? "www.youtube.com/watch?v=" : "soundcloud.com/artist/"}${id}`, title, author, length: 200_000, sourceName: source, isSeekable: true, isStream: false, position: 0 }, pluginInfo: {} };
}
test("Unicode matching preserves Japanese voiced characters and folds Latin accents", () => {
  assert.equal(normalizeText("平沢進 パレード"), "平沢進 パレード");
  assert.notEqual(normalizeText("パ"), normalizeText("ハ"));
  assert.equal(normalizeText("Sarà perché ti amo"), "sara perche ti amo");
  const r = { query: "平沢進 パレード", source: "auto" as const, requestedBy: "user" };
  assert.ok(rankRecording(recordingFor(track("パレード", "平沢進")), r) > rankRecording(recordingFor(track("別の歌", "別の人")), r));
});
test("direct YouTube link stays on YouTube without a SoundCloud substitution", async () => {
  const calls: string[] = [];
  const result = await searchTracks(async id => { calls.push(id); return { loadType: LoadType.TRACK, data: track("Selected", "Artist", "youtube", "2I3PLVuKNtw") }; }, { query: "https://youtu.be/2I3PLVuKNtw", source: "auto", requestedBy: "u" });
  assert.equal(result.direct, true); assert.equal(result.candidates[0].source, "youtube"); assert.equal(calls.length, 1);
});
test("search always returns choices; Bubbles, Letter and Stars never become automatic fallbacks", async () => {
  const candidates = [track("Letter", "Yosi Horikawa"), track("Stars", "Yosi Horikawa"), track("Bubbles", "Yosi Horikawa")];
  const result = await searchTracks(async () => ({ loadType: LoadType.SEARCH, data: candidates }), { query: "Yosi Horikawa Bubbles", source: "soundcloud", requestedBy: "u" });
  assert.equal(result.direct, false); assert.equal(result.candidates[0].title, "Bubbles");
  assert.equal(result.candidates.length, 1);
  assert.equal("alternates" in result, false);
});
test("Spotify choices reject other songs, other artists, clips and unrelated mixes", () => {
  const request = { query: "spotify:track:fixture", source: "auto" as const, requestedBy: "u", spotify: { id: "fixture", title: "Locked Away", artists: ["Gabzito"], durationMs: 178000 } };
  const valid = recordingFor(track("Gabzito - Locked Away [Lyric video]", "GabzitoMusic", "youtube")); valid.durationMs = 178000;
  assert.equal(plausibleRecording(valid, request), true);
  for (const candidate of [recordingFor(track("Another song", "Gabzito")), recordingFor(track("Locked Away", "Different Artist")), { ...valid, durationMs: 30000 }, { ...valid, durationMs: 600000 }]) assert.equal(plausibleRecording(candidate, request), false);
});
test("search relevance tolerates one-character spelling errors without admitting unrelated songs", () => {
  const request = { query: "Sarà perché ti amo Richi E Poveri", source: "auto" as const, requestedBy: "u" };
  assert.equal(plausibleRecording(recordingFor(track("Sarà perché ti amo", "Ricchi E Poveri")), request), true);
  assert.equal(plausibleRecording(recordingFor(track("Mamma Maria", "Ricchi E Poveri")), request), false);
});
test("failed selected upload does not trigger any search or play a different recording", async () => {
  const selected = recordingFor(track("Bubbles", "Yosi Horikawa")); const calls: string[] = [];
  await assert.rejects(resolveSelected(async id => { calls.push(id); return { loadType: LoadType.TRACK, data: track("Letter", "Yosi Horikawa") }; }, selected), /selected upload/);
  assert.deepEqual(calls, [selected.uri]);
});
test("search failure on one provider retains choices from the other provider", async () => {
  const result = await searchTracks(async id => {
    if (id.startsWith("yt")) throw new Error("All clients failed");
    return { loadType: LoadType.SEARCH, data: [track("Sastanàqqàm", "Tinariwen")] };
  }, { query: "Tinariwen Sastanàqqàm", source: "auto", requestedBy: "u" });
  assert.equal(result.candidates.length, 1); assert.equal(result.notices.length, 1);
});
test("known preview/unavailable source returns an actionable error", async () => {
  await assert.rejects(searchTracks(async () => ({ loadType: LoadType.EMPTY, data: {} }), { query: "https://soundcloud.com/artist/song", source: "auto", requestedBy: "u" }), /preview/);
});
test("ordinary short recordings are selectable and long instrumentals are not penalized by duration", () => {
  const short = recordingFor(track("Short", "Artist")); short.durationMs = 1000;
  const long = { ...short, durationMs: 1_200_000 };
  const request = { query: "Short Artist", source: "auto" as const, requestedBy: "u" };
  assert.equal(rankRecording(short, request), rankRecording(long, request));
});
test("generic URLs, local addresses, embedded credentials, and nonstandard ports are rejected", () => {
  for (const url of ["http://127.0.0.1/admin", "https://soundcloud.com.evil.test/track", "https://user:pass@soundcloud.com/a", "https://soundcloud.com:8443/a"]) assert.throws(() => sourceUrl(url));
});
test("public source URLs cannot use the new HTTP transport as a generic redirect fetcher", async t => {
  assert.throws(() => sourceUrl("https://www.youtube.com/redirect?q=http://127.0.0.1/admin"), /redirect/);
  assert.throws(() => sourceUrl("https://soundcloud.com/redirect?url=http://127.0.0.1/admin"), /track link/);
  assert.equal(sourceUrl("https://www.youtube.com/watch?v=2I3PLVuKNtw&next=http://127.0.0.1")?.href, "https://www.youtube.com/watch?v=2I3PLVuKNtw");
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }));
  await assert.rejects(searchTracks(async () => { assert.fail("must not pass the redirect to Lavalink"); }, { query: "https://on.soundcloud.com/fixture", source: "auto", requestedBy: "u" }), /unsupported address/);
});
test("SoundCloud short links resolve to a verified SoundCloud track before loading", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 302, headers: { location: "https://soundcloud.com/artist/song" } }));
  const result = await searchTracks(async url => { assert.equal(url, "https://soundcloud.com/artist/song"); return { loadType: LoadType.TRACK, data: track("Song", "Artist", "soundcloud", "song") }; }, { query: "https://on.soundcloud.com/fixture", source: "auto", requestedBy: "u" });
  assert.equal(result.candidates.length, 1);
});
test("track 404s do not trip the whole-provider circuit; repeated access failures can", () => {
  const now = Date.now();
  for (let i = 0; i < 5; i++) markSourceFailure("fixture-source", String(i), "404", now);
  assert.equal(sourceAvailable("fixture-source", now), true);
  for (let i = 0; i < 3; i++) markSourceFailure("fixture-source", String(i), "429", now);
  assert.equal(sourceAvailable("fixture-source", now), false); assert.equal(sourceAvailable("fixture-source", now + 300_001), true);
});

test('a recovered recording is removed from its temporary failure cache', async () => {
  const { markSourcePlayback, trackFailure } = await import('../src/audio/track-health.js');
  const uri = 'https://soundcloud.com/fixture/recovered'; markSourceFailure('soundcloud', uri, 'temporary missing stream');
  assert.ok(trackFailure(uri)); markSourcePlayback('soundcloud', Date.now(), uri); assert.equal(trackFailure(uri), undefined);
});
