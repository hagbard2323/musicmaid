import { test } from "node:test";
import assert from "node:assert/strict";
import { bestMatch, clearMatch } from "../src/audio/matching.js";
import type { Recording } from "../src/audio/model.js";
import type { SearchResult } from "../src/audio/sources.js";
function recording(title = "Bubbles", author = "Yosi Horikawa", durationMs = 347508): Recording {
  return { title, author, durationMs, identifier: title, uri: `https://soundcloud.com/fixture/${encodeURIComponent(title)}`, source: "soundcloud", isStream: false, isSeekable: true };
}
function result(query: string, candidates: Recording[]): SearchResult {
  return { request: { query, requestedBy: "u", source: "auto" }, candidates, direct: false, notices: [] };
}
test("clear artist-title requests play directly in either order, including Unicode", () => {
  const bubbles = recording();
  assert.equal(clearMatch(result("Yosi Horikawa — Bubbles", [bubbles])), bubbles);
  assert.equal(clearMatch(result("Bubbles Yosi Horikawa", [bubbles])), bubbles);
  assert.ok(clearMatch(result("平沢進 パレード", [recording("パレード", "平沢進")])));
  assert.ok(clearMatch(result("Tinariwen Sastanaqqam", [recording("Sastanàqqàm", "Tinariwen")])));
});
test("clear selection tolerates the reported artist typo but asks for competing artists", () => {
  assert.ok(clearMatch(result("sara perche ti amo richi e poveri", [recording("Sarà perché ti amo", "Ricchi e Poveri", 190000)])));
  assert.equal(clearMatch(result("Hello", [recording("Hello", "Adele"), recording("Hello", "Lionel Richie")])), undefined);
});
test("ambiguous title-only searches and unrelated songs never auto-select", () => {
  assert.equal(clearMatch(result("Bubbles", [recording()])), undefined);
  assert.equal(clearMatch(result("Yosi Horikawa Bubbles", [recording("Letter"), recording("Stars")])), undefined);
  assert.equal(clearMatch(result("Say Say Say Paul McCartney", [recording("Say", "Paul McCartney")])), undefined);
});
test("unrequested versions and materially different durations require a choice", () => {
  assert.equal(clearMatch(result("Yosi Horikawa Bubbles", [recording("Bubbles (Remix)")])), undefined);
  assert.equal(clearMatch(result("Oasis Live Forever", [recording("Live Forever (Official Live)", "Oasis")])), undefined);
  assert.equal(clearMatch(result("Yosi Horikawa Bubbles", [recording(), recording("Bubbles", "Yosi Horikawa", 240000)])), undefined);
});
test("official presentation text is ignored but an unverified uploader is not treated as the artist", () => {
  assert.ok(clearMatch(result("Yosi Horikawa Bubbles", [recording("Yosi Horikawa - Bubbles (Official Audio)", "Yosi Horikawa - Topic")])));
  assert.equal(clearMatch(result("Yosi Horikawa Bubbles", [recording("Yosi Horikawa - Bubbles", "Random uploads")])), undefined);
});
test("Spotify auto-selection requires matching identity, duration and version", () => {
  const r = result("spotify:track:fixture", [recording()]);
  r.request.spotify = { id: "fixture", title: "Bubbles", artists: ["Yosi Horikawa"], durationMs: 347508 };
  assert.ok(clearMatch(r));
  r.candidates = [recording("Bubbles", "Yosi Horikawa", 30000)]; assert.equal(clearMatch(r), undefined);
  r.candidates = [recording("Bubbles", "Other artist")]; assert.equal(clearMatch(r), undefined);
  r.candidates = [recording("Bubbles (Live)")]; assert.equal(clearMatch(r), undefined);
});
test("Spotify recognizes an exact artist-song upload with the artist's Music channel suffix", () => {
  const r = result("spotify:track:fixture", [recording("Gabzito - Locked Away [Lyric video]", "GabzitoMusic", 178000)]);
  r.request.spotify = { id: "fixture", title: "Locked Away", artists: ["Gabzito"], durationMs: 178000 };
  assert.ok(clearMatch(r));
  assert.ok(clearMatch(result("Gabzito Locked Away", r.candidates)));
  r.candidates[0].author = "UnrelatedMusic";
  assert.equal(clearMatch(r), undefined);
});
test("Play chooses a best title-only match while rejecting unrelated uploads and unrequested covers", () => {
  const original = { ...recording("Diamonds", "Rihanna", 225000), source: "youtube" as const, channelVerified: true };
  const cover = recording("Diamonds (Cover)", "Someone", 225000);
  assert.equal(bestMatch(result("Diamonds", [cover, original])), original);
  assert.equal(bestMatch(result("Rihanna Diamonds", [recording("Umbrella", "Rihanna")])), undefined);
  assert.equal(bestMatch(result("Diamonds", [cover])), undefined);
});
test("Rihanna original audio ranks ahead of the hidden remix, music video and lyrics reupload", () => {
  const original = { ...recording("Bitch Better Have My Money", "Rihanna", 219305), identifier: "ukW82Ico4U0", uri: "https://www.youtube.com/watch?v=ukW82Ico4U0", source: "youtube" as const, channelVerified: true };
  const lyrics = { ...recording("Rihanna - Bitch Better Have My Money / LYRICS", "BEAST COAST", 219361), source: "youtube" as const };
  const remix = { ...recording("Bitch Better Have My Money (Michael Woods remix)", "Rihanna", 264341), source: "youtube" as const, channelVerified: true };
  const video = { ...recording("Rihanna - Bitch Better Have My Money (Explicit)", "Rihanna", 422000), source: "youtube" as const };
  const flip = recording("RIHANNA - Bitch Better Have My Money (MIND G4ME FLIP)", "MIND G4ME", 125623);
  const r = result("rihanna bitch better have my money", [lyrics, remix, video, original, flip]);
  assert.equal(bestMatch(r), original);
  assert.equal(bestMatch(result(r.request.query, [remix, flip])), undefined);
  r.request.spotify = { id: "0NTMtAO2BV4tnGvw9EgBVq", title: "Bitch Better Have My Money", artists: ["Rihanna"], durationMs: 219305, isrc: "QM5FT1500006" };
  assert.equal(bestMatch(r), original);
  assert.notEqual(bestMatch(r, [original.uri]), remix);
});
