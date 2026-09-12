import { LoadType } from 'shoukaku';
import { entryFor, type QueueEntry, type MusicRequest } from './model.js';
import { bestMatch } from './matching.js';
import { isSpotifyInput, spotifyRecording, spotifyTrackToSearchQuery } from './spotify.js';
import { env } from '../config/env.js';
import { spotifyPlaylist } from './spotify-playlists.js';
import { recordingFor, type Loader } from './sources.js';
export type PlaylistImport = { name: string; entries: QueueEntry[]; skipped: number; hasMore: boolean; nextStart: number; unmatched: string[] };
export function youtubePlaylistId(input: string): string | undefined {
  let url: URL; try { url = new URL(input.trim().replace(/^<(.+)>$/, '$1')); } catch { return; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com'].includes(url.hostname) || !['/playlist', '/watch'].includes(url.pathname)) return;
  const id = url.searchParams.get('list'); return id && /^[A-Za-z0-9_-]{10,100}$/.test(id) ? id : undefined;
}
export async function importPlaylist(load: Loader, input: string, start: number, requestedBy: string, signal: AbortSignal, progress: (done: number, total: number) => Promise<void> = async () => {}): Promise<PlaylistImport> {
  if (!Number.isInteger(start) || start < 1 || start > 10_000) throw new Error('Choose a starting position from 1 to 10000.');
  signal.throwIfAborted();
  if (isSpotifyInput(input)) {
    const playlist = await spotifyPlaylist(input, start, signal);
    const entries: QueueEntry[] = [], unmatched: string[] = []; let done = 0;
    // Catalog-only import keeps large lists from competing with playback extraction.
    // Full inspection at playback still refuses a newly discovered version mismatch.
    for (const metadata of playlist.tracks) {
      signal.throwIfAborted();
      const query = spotifyTrackToSearchQuery(metadata);
      const request: MusicRequest = { query: 'https://open.spotify.com/track/' + metadata.id, source: 'auto', requestedBy,
        spotify: { id: metadata.id, title: metadata.name, artists: metadata.artists, durationMs: metadata.durationMs, isrc: metadata.isrc, url: metadata.url } };
      if (env.spotifyDirectEnabled && metadata.durationMs) {
        entries.push(entryFor(request, spotifyRecording(metadata))); done++;
        if (done % 10 === 0 || done === playlist.tracks.length) await progress(done, playlist.tracks.length);
        continue;
      }
      const results = await Promise.allSettled([load('ytmsearch:' + query, signal), load('scsearch:' + query, signal)]);
      signal.throwIfAborted();
      const groups = results.map(result => result.status === 'fulfilled' && result.value?.loadType === LoadType.SEARCH ? result.value.data.map(recordingFor) : []);
      const candidates = groups.flat();
      // YouTube Music uses Lavalink's catalog client. If that client cannot
      // supply a credible recording, try the configured authenticated search.
      // Keep this sequential and catalog-only so imports do not prepare audio
      // or fill the extractor queue with an entire playlist at once.
      if (env.youtubeCookies && !bestMatch({ request, candidates: groups[0], direct: false, notices: [] })) {
        const fallback = await load('ytsearch:' + query, signal).catch(() => { signal.throwIfAborted(); return undefined; });
        signal.throwIfAborted();
        if (fallback?.loadType === LoadType.SEARCH) candidates.push(...fallback.data.map(recordingFor));
      }
      const selected = bestMatch({ request, candidates, direct: false, notices: [] });
      if (selected) entries.push(entryFor(request, selected)); else unmatched.push(metadata.name + ' — ' + metadata.artists.join(', '));
      done++; if (done % 10 === 0 || done === playlist.tracks.length) await progress(done, playlist.tracks.length);
    }
    return { name: playlist.name, entries, skipped: playlist.skipped + unmatched.length, hasMore: playlist.hasMore, nextStart: start + 100, unmatched };
  }
  const id = youtubePlaylistId(input);
  if (!id) throw new Error('Use a full YouTube or Spotify playlist link.');
  const result = await load('ytplaylist:' + start + ':' + id, signal);
  signal.throwIfAborted();
  if (result?.loadType !== LoadType.PLAYLIST) throw new Error('YouTube playlist import needs authenticated YouTube on this server.');
  const info = result.data.info as { name: string; skipped?: number; hasMore?: boolean };
  const entries = result.data.tracks.slice(0, 100).map(track => {
    const recording = recordingFor(track); return entryFor({ query: recording.uri, source: recording.source, requestedBy }, recording);
  });
  return { name: info.name, entries, skipped: info.skipped ?? 0, hasMore: info.hasMore ?? false, nextStart: start + 100, unmatched: [] };
}
