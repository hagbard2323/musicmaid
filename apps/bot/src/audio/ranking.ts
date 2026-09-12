import type { MusicRequest, Recording } from "./model.js";
import { trackFailure } from "./track-health.js";
import { normalizeText, artistName, cleanedTitle, sameArtist, versionTerms } from "./music-text.js";
export function wordMatches(word: string, text: string): boolean {
  if (/[^\p{Script=Latin}\p{N}]/u.test(word) && text.includes(word)) return true;
  return text.split(/\s+/).some(candidate => {
    if (word === candidate) return true;
    if (word.length >= 4 && ["vevo", "official", "music"].some(suffix => candidate === word + suffix)) return true;
    if (word.length < 5 || candidate.length < 5 || Math.abs(word.length - candidate.length) > 1) return false;
    let left = 0, right = 0, differences = 0;
    while (left < word.length && right < candidate.length) {
      if (word[left] === candidate[right]) { left++; right++; continue; }
      if (++differences > 1) return false;
      if (word.length === candidate.length && word[left] === candidate[right + 1] && word[left + 1] === candidate[right]) { left += 2; right += 2; continue; }
      if (word.length >= candidate.length) left++;
      if (candidate.length >= word.length) right++;
    }
    return differences + (word.length - left) + (candidate.length - right) <= 1;
  });
}
export function plausibleRecording(recording: Recording, request: MusicRequest): boolean {
  const title = normalizeText(recording.title);
  const author = normalizeText(recording.author);
  const combined = `${title} ${author}`;
  const expected = request.spotify;
  if (expected) {
    if (!expected.durationMs || recording.isStream || recording.durationMs <= 0) return false;
    const delta = recording.durationMs - expected.durationMs;
    const officialVideo = sameArtist(recording.author, expected.artists[0] ?? "") && /official.*video|music video/i.test(recording.title);
    if (Math.abs(delta) > Math.max(10_000, expected.durationMs * 0.05) && !(officialVideo && delta > 0 && delta <= 90_000)) return false;
    const expectedWords = normalizeText(expected.title).split(/\s+/).filter(Boolean);
    if (!expectedWords.length || !expectedWords.every(word => wordMatches(word, title))) return false;
    const artistsMatch = expected.artists.slice(0, 1).some(artist => {
      const name = normalizeText(artist);
      const compact = author.replace(/\s+/g, "");
      return name.split(/\s+/).every(word => wordMatches(word, combined)) || ["music", "vevo", "official"].some(suffix => compact === name.replace(/\s+/g, "") + suffix);
    });
    return artistsMatch || Boolean(expected.isrc && expected.isrc === recording.isrc);
  }
  const query = normalizeText(request.query).split(/\s+/).filter(Boolean);
  return query.length > 0 && query.every(word => wordMatches(word, combined));
}
export function rankRecording(recording: Recording, request: MusicRequest): number {
  const query = normalizeText(request.spotify ? `${request.spotify.title} ${request.spotify.artists.join(" ")}` : request.query);
  const title = normalizeText(recording.title);
  const artist = normalizeText(recording.author);
  const candidate = `${title} ${artist}`;
  const words = query.split(/\s+/).filter(Boolean);
  let score = words.filter(w => candidate.includes(w)).length * 10;
  if (query && title === query) score += 30;
  const requestedVersions = versionTerms(request.spotify?.title ?? request.query);
  for (const variant of versionTerms(recording.title)) if (!requestedVersions.includes(variant)) score -= variant === "remaster" ? 20 : 90;
  const clean = cleanedTitle(recording.title);
  const channelArtist = artistName(recording.source === "spotify" && recording.artists?.length
    ? recording.artists.find(name => normalizeText(name).split(/\s+/).every(word => wordMatches(word, query))) ?? recording.artists[0]
    : recording.author);
  if (recording.channelVerified) score += 15;
  if (/\b(?:official audio|audio only|lyrics?)\b/i.test(recording.title)) score += 8;
  if (recording.source === "youtube") score += 5;
  if (recording.source === "spotify") score += 60;
  if (request.spotify) {
    const expected = request.spotify;
    if (recording.source === "spotify" && recording.identifier === expected.id) score += 200;
    if (expected.isrc && recording.isrc === expected.isrc) score += 100;
    if (expected.durationMs && recording.durationMs) score -= Math.min(60, Math.abs(expected.durationMs - recording.durationMs) / 1000);
    if (!expected.artists.some(a => candidate.includes(normalizeText(a)))) score -= 40;
    if (sameArtist(recording.author, expected.artists[0] ?? "")) score += 65;
    if (clean === cleanedTitle(expected.title)) score += 80;
    else if (clean === cleanedTitle(`${expected.artists[0]} ${expected.title}`)) score += 65;
  } else {
    const artistInQuery = channelArtist && channelArtist.split(/\s+/).every(word => wordMatches(word, query));
    if (artistInQuery) {
      score += 60;
      const song = query.startsWith(channelArtist + " ") ? query.slice(channelArtist.length + 1)
        : query.endsWith(" " + channelArtist) ? query.slice(0, -channelArtist.length - 1) : "";
      if (song && [song, `${channelArtist} ${song}`, `${song} ${channelArtist}`].includes(clean)) score += 90;
    }
    if (clean === query) score += 40;
  }
  if (trackFailure(recording.uri)) score -= 100;
  return score;
}
