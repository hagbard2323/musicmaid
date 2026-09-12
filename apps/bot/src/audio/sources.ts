import { LoadType, type LavalinkResponse, type Track } from "shoukaku";
import type { MusicRequest, Recording, RecordingSource, SearchSource } from "./model.js";
import { isSpotifyInput, parseSpotifyReference, resolveSpotifyTrackMetadata, searchSpotifyMetadata, spotifyRecording, spotifyTrackToSearchQuery } from "./spotify.js";
import { env } from "../config/env.js";
import { sourceAvailable, trackFailure, markSourceFailure } from "./track-health.js";
import { isRecordingFailure, safeError } from "./diagnostics.js";
import { youtubeVideoId } from "./youtube.js";
import { plausibleRecording, rankRecording } from "./ranking.js";
export { plausibleRecording, rankRecording } from "./ranking.js";
import { clearMatch } from "./matching.js";
import { abortable } from "./source-errors.js";
export { normalizeText } from "./music-text.js";
export type { SearchSource } from "./model.js";
export type Loader = (identifier: string, signal?: AbortSignal) => Promise<LavalinkResponse | undefined>;
export type SearchResult = { request: MusicRequest; candidates: Recording[]; direct: boolean; notices: string[]; moreAvailable?: boolean };

export function recordingFor(track: Track): Recording {
  const { info } = track;
  const extra = track.pluginInfo as { channelVerified?: boolean; audioQuality?: Recording["audioQuality"]; artists?: string[] } | undefined;
  if (!info.uri || !["youtube", "soundcloud", "spotify"].includes(info.sourceName)) throw new Error("This source is not supported.");
  return { identifier: info.identifier, uri: info.uri, title: info.title, author: info.author,
    source: info.sourceName as Recording["source"], durationMs: info.length, isStream: info.isStream,
    isSeekable: info.isSeekable, artworkUrl: info.artworkUrl, isrc: info.isrc,
    channelVerified: extra?.channelVerified === true,
    audioQuality: extra?.audioQuality,
    ...(Array.isArray(extra?.artists) && extra.artists.every(a => typeof a === "string") ? { artists: extra.artists } : {}) };
}
function tracksFrom(response: LavalinkResponse | undefined): Track[] {
  if (!response) throw new Error("Source unreachable. A mod can check audio service health.");
  if (response.loadType === LoadType.ERROR) throw new Error(response.data.message + " " + response.data.cause);
  if (response.loadType === LoadType.TRACK) return [response.data];
  if (response.loadType === LoadType.SEARCH) return response.data;
  if (response.loadType === LoadType.PLAYLIST) throw new Error("Playlist import is not supported yet. Use a single track link.");
  return [];
}
export function cleanInput(input: string): string { return input.trim().replace(/^<(.+)>$/, "$1"); }
export function sourceUrl(input: string): URL | undefined {
  if (!/^https?:\/\//i.test(input)) return undefined;
  const url = new URL(input);
  const allowed = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"];
  if (!allowed.includes(url.hostname) || url.username || url.password || (url.port && url.port !== "443")) throw new Error("Use a YouTube, SoundCloud, or Spotify track link.");
  url.protocol = "https:";
  if (url.hostname.includes("youtube.com") || url.hostname === "youtu.be") {
    const id = youtubeVideoId(url.href);
    if (!id) throw new Error("Use a single YouTube video link, not a playlist or redirect URL.");
    return new URL(`https://www.youtube.com/watch?v=${id}`);
  }
  const path = url.pathname.split("/").filter(Boolean);
  if (url.hostname !== "on.soundcloud.com" && (path.length < 2 || path[1] === "sets" || path.length > 3)) {
    throw new Error("Use a full SoundCloud track link.");
  }
  url.hash = "";
  return url;
}
async function resolveSourceLink(url: URL, signal?: AbortSignal): Promise<URL> {
  for (let redirects = 0; url.hostname === "on.soundcloud.com"; redirects++) {
    if (redirects >= 5) throw new Error("SoundCloud short link has too many redirects. Use the full track link.");
    const response = await fetch(url, { redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) throw new Error("SoundCloud short link could not be resolved. Use the full track link.");
    const target = new URL(location, url);
    if (!["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"].includes(target.hostname)) throw new Error("SoundCloud short link redirected to an unsupported address.");
    url = sourceUrl(target.href)!;
  }
  return url;
}
export async function searchTracks(load: Loader, input: MusicRequest, includeVideos = false, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SearchResult> {
  const request = structuredClone(input);
  request.query = cleanInput(request.query);
  if (!request.query || request.query.length > 500) throw new Error("Enter an artist and song or a track link, up to 500 characters.");
  const supported: RecordingSource[] = ["spotify", "youtube", "soundcloud"];
  if (!["auto", ...supported].includes(request.source)) throw new Error("Choose Auto, YouTube, SoundCloud or Spotify for searches.");
  if (request.sources !== undefined) {
    if (!Array.isArray(request.sources) || !request.sources.length || request.sources.some(source => !supported.includes(source))) throw new Error("Select at least one valid search source: YouTube, SoundCloud or Spotify.");
    request.sources = [...new Set(request.sources)];
  }
  const done = new AbortController();
  const signal = AbortSignal.any([done.signal, AbortSignal.timeout(options.timeoutMs ?? 25000), ...(options.signal ? [options.signal] : [])]);
  const lookup: Loader = id => { signal.throwIfAborted(); return abortable(load(id, signal), signal); };
  const notices: string[] = [];
  let search = request.query;
  let spotifyMetadataLink = false;
  try {
    signal.throwIfAborted();
    if (isSpotifyInput(search)) {
      const metadata = await abortable(resolveSpotifyTrackMetadata(search), signal);
      if (!metadata) throw new Error("That Spotify track could not be read.");
      request.spotify = { id: metadata.id, title: metadata.name, artists: metadata.artists, durationMs: metadata.durationMs, isrc: metadata.isrc, url: metadata.url };
      if (env.spotifyDirectEnabled) {
        if (!metadata.durationMs) throw new Error("Spotify did not provide a complete recording duration.");
        options.signal?.throwIfAborted();
        return { request, candidates: [spotifyRecording(metadata)], direct: true, notices };
      }
      spotifyMetadataLink = true;
      notices.push("Original Spotify audio is disabled. This link supplies song metadata; the choices play matching uploads from YouTube or SoundCloud.");
      search = spotifyTrackToSearchQuery(metadata);
    } else {
      const url = sourceUrl(search);
      if (url) {
        const resolved = url.hostname === "on.soundcloud.com" ? await resolveSourceLink(url, signal) : url;
        const tracks = tracksFrom(await lookup(resolved.href));
        if (!tracks.length) throw new Error("This upload is unavailable or only provides a preview. Search for an alternative recording.");
        const youtubeId = youtubeVideoId(resolved.href);
        const exact = tracks.find(track => youtubeId ? track.info.sourceName === "youtube" && track.info.identifier === youtubeId : track.info.sourceName === "soundcloud");
        if (!exact) throw new Error("The linked upload is unavailable; another source or video was not substituted.");
        options.signal?.throwIfAborted();
        return { request, candidates: [recordingFor(exact)], direct: true, notices };
      }
    }
    // Source preferences narrow text searches. A Spotify link on a server
    // without original audio retains the explicit, labelled metadata matcher.
    if (!spotifyMetadataLink && !request.sources && request.source === "spotify" && !env.spotifyDirectEnabled) throw new Error("Original Spotify audio is not enabled on this server.");
    let sources: RecordingSource[] = spotifyMetadataLink ? ["youtube", "soundcloud"] : request.sources ?? (request.source === "auto" ? supported : [request.source]);
    if (!env.spotifyDirectEnabled && sources.includes("spotify")) {
      sources = sources.filter(source => source !== "spotify");
      if (request.sources?.includes("spotify")) notices.push("Spotify was excluded because original Spotify audio is not enabled on this server.");
    }
    if (!sources.length) throw new Error("None of the selected search sources are available. Select YouTube or SoundCloud, or ask a mod to enable original Spotify audio.");
    const tasks = sources.map(async source => {
      signal.throwIfAborted();
      if (!sourceAvailable(source)) throw new Error(`${source} is temporarily cooling down after access failures.`);
      try {
        if (source === "spotify") {
          if (!env.spotifyDirectEnabled) throw new Error("Original Spotify audio is not enabled on this server.");
          if (request.spotify && !includeVideos) return [spotifyRecording({ id: request.spotify.id, name: request.spotify.title, artists: request.spotify.artists, durationMs: request.spotify.durationMs, isrc: request.spotify.isrc })];
          return (await abortable(searchSpotifyMetadata(search), signal)).map(spotifyRecording);
        }
        if (source === "soundcloud") return tracksFrom(await lookup(`scsearch:${search}`)).map(recordingFor);
        let tracks: Track[] = [];
        try { tracks = tracksFrom(await lookup(`ytmsearch:${search}`)); } catch (error) { if (signal.aborted) throw error; /* Authenticated video search can still be available. */ }
        if (!signal.aborted && (includeVideos || !tracks.some(track => plausibleRecording(recordingFor(track), request)))) {
          try { tracks.push(...tracksFrom(await lookup(`ytsearch:${search}`))); } catch (error) { if (!tracks.length) throw error; }
        }
        return tracks.map(recordingFor);
      } catch (error) {
        const reason = safeError(error);
        if (!signal.aborted && isRecordingFailure(reason)) markSourceFailure(source, search, reason);
        throw error;
      }
    });
    const settled = Promise.allSettled(tasks);
    const ordered = (candidates: Recording[]) => [...new Map(candidates.filter(c => sources.includes(c.source) && plausibleRecording(c, request)).map(c => [c.uri, c])).values()]
      .sort((a, b) => rankRecording(b, request) - rankRecording(a, request));
    const spotifyIndex = sources.indexOf("spotify");
    if (!includeVideos && request.source === "auto" && spotifyIndex !== -1) {
      const candidates = ordered(await tasks[spotifyIndex].catch(() => []));
      const early = { request, candidates, direct: false, notices, moreAvailable: true };
      if (clearMatch(early)) { options.signal?.throwIfAborted(); return early; }
    }
    const results = await settled;
    const candidates: Recording[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") candidates.push(...result.value);
      else notices.push(`${sources[index]}: ${safeError(result.reason)}`);
    });
    const unique = ordered(candidates);
    for (const candidate of unique.filter(item => item.source === "youtube").slice(0, 3)) {
      if (signal.aborted) break;
      try {
        const details = await lookup(`ytmeta:${candidate.identifier}`);
        if (details?.loadType === LoadType.TRACK && details.data.info.sourceName === "youtube" && details.data.info.identifier === candidate.identifier) Object.assign(candidate, recordingFor(details.data));
      } catch { /* Keep labeled candidates available for explicit review. */ }
    }
    unique.sort((a, b) => rankRecording(b, request) - rankRecording(a, request));
    options.signal?.throwIfAborted();
    return { request, candidates: unique.slice(0, 20), direct: false, notices };
  } finally { done.abort(); }
}
/** Re-resolve only the selected upload. No search, mirrors, or implicit alternates here. */
export async function resolveSelected(load: Loader, selected: Recording, signal?: AbortSignal): Promise<Track> {
  if (selected.source === "spotify") {
    const reference = parseSpotifyReference(selected.uri);
    if (reference?.type !== "track" || reference.id !== selected.identifier) throw new Error("Spotify recording identity is invalid.");
    const tracks = tracksFrom(await load(selected.uri, signal));
    const exact = tracks.find(t => t.info.sourceName === "spotify" && t.info.identifier === selected.identifier);
    if (!exact) throw new Error("The exact Spotify recording is unavailable; no other source was substituted.");
    return exact;
  }
  const url = sourceUrl(selected.uri);
  if (!url) throw new Error("The selected upload has an invalid source link.");
  const resolved = url.hostname === "on.soundcloud.com" ? await resolveSourceLink(url, signal) : url;
  const tracks = tracksFrom(await load(resolved.href, signal));
  const legacyIdentity = selected.identifier === selected.uri;
  const exact = tracks.find(t => t.info.sourceName === selected.source && (t.info.identifier === selected.identifier || (legacyIdentity && t.info.uri === resolved.href)));
  if (!exact) throw new Error("The selected upload is unavailable or restricted. Choose an alternative.");
  return exact;
}
