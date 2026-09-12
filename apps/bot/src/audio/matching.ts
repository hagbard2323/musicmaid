import type { Recording } from "./model.js";
import type { SearchResult } from "./sources.js";
import { plausibleRecording, rankRecording, wordMatches } from "./ranking.js";
import { sourceAvailable, trackFailure } from "./track-health.js";
import { normalizeText, cleanedTitle, versionTerms, artistName, sameArtist } from "./music-text.js";

/** Initial selection only. Failed uploads still require explicit replacement consent. */
export function clearMatch(result: SearchResult): Recording | undefined {
  const { request } = result;
  const expected = request.spotify;
  const query = normalizeText(request.query);
  const requestedVersions = versionTerms(expected?.title ?? request.query);
  const eligible = result.candidates.filter(candidate => {
    if (candidate.isStream || candidate.durationMs <= 0 || trackFailure(candidate.uri) || !sourceAvailable(candidate.source)) return false;
    if (versionTerms(candidate.title).some(term => !requestedVersions.includes(term))) return false;
    const title = cleanedTitle(candidate.title);
    let artist = artistName(candidate.source === "spotify" && candidate.artists?.length ? candidate.artists.find(name => query.includes(normalizeText(name))) ?? candidate.artists[0] : candidate.author);
    if (expected) {
      if (!expected.durationMs || Math.abs(candidate.durationMs - expected.durationMs) > Math.max(5000, expected.durationMs * 0.02)) return false;
      const titleMatches = title === cleanedTitle(expected.title) || expected.artists.some(a => title === cleanedTitle(`${a} ${expected.title}`));
      const artistMatches = expected.artists.some(a => sameArtist(candidate.author, a));
      return titleMatches && (artistMatches || Boolean(expected.isrc && candidate.isrc === expected.isrc));
    }
    // Accept normal artist-title/title-artist input, preserving order and repeated
    // words within the song title. A title alone can belong to different artists.
    const lead = candidate.title.split(/\s[-–—]\s/)[0];
    if (lead !== candidate.title && sameArtist(candidate.author, lead)) artist = artistName(lead);
    if (!artist) return false;
    const song = title.startsWith(artist + " ") ? title.slice(artist.length + 1) : title.endsWith(" " + artist) ? title.slice(0, -artist.length - 1) : title;
    const matches = (expected: string) => { const words = expected.split(" "), actual = query.split(" "); return words.length === actual.length && words.every((word, index) => wordMatches(word, actual[index])); };
    return Boolean(song) && (matches(`${artist} ${song}`) || matches(`${song} ${artist}`));
  });
  const preferred = eligible.some(candidate => candidate.source === "spotify") ? eligible.filter(candidate => candidate.source === "spotify") : eligible;
  const first = preferred[0];
  if (!first) return undefined;
  // Multiple materially different lengths/versions are a choice, even with the same title.
  if (preferred.some(other => Math.abs(first.durationMs - other.durationMs) > Math.max(5000, first.durationMs * 0.02))) return undefined;
  return [...preferred].sort((a, b) => rankRecording(b, request) - rankRecording(a, request))[0];
}

/** Play chooses the best credible match; explicit Choose version still exposes the candidates. */
export function bestMatch(result: SearchResult, excluded: string[] = []): Recording | undefined {
  const requested = versionTerms(result.request.spotify?.title ?? result.request.query);
  return result.candidates.filter(candidate => plausibleRecording(candidate, result.request) && !excluded.includes(candidate.uri) && !candidate.isStream && candidate.durationMs > 0
    && !trackFailure(candidate.uri) && sourceAvailable(candidate.source)
    && !versionTerms(candidate.title).some(term => term !== "remaster" && !requested.includes(term)))
    .sort((a, b) => rankRecording(b, result.request) - rankRecording(a, result.request))[0];
}
