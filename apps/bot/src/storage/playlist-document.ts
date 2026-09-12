import { entryFor, type QueueEntry, type RecordingSource } from '../audio/model.js';
import type { SavedPlaylist } from './library.js';

export const playlistDocumentMaxBytes = 2 * 1024 * 1024;
export type PlaylistTrackReference = { source: RecordingSource; identifier: string; uri: string; title: string; author: string; durationMs: number };
export type PlaylistDocument = { format: 'musicmaid-playlist'; version: 1; name: string; tracks: PlaylistTrackReference[] };
const invalid = () => new Error('This is not a supported MusicMaid playlist file. Export a playlist as JSON and upload that file.');
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  return value.trim();
}
/** Public recording identity only. Private SoundCloud links are refused, never rewritten. */
export function canonicalPlaylistReference(source: RecordingSource, input: string): { identifier: string; uri: string } {
  let url: URL;
  try { if (typeof input !== 'string' || input.length > 2048) throw invalid(); url = new URL(input); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('Playlist files can contain only public recording links without credentials.');
  let identifier: string | undefined, uri: string | undefined;
  const tracking = new Set(['si', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']);
  if (source === 'youtube') {
    for (const key of ['v', 'list', 'index', 'feature', 't', 'start', 'ab_channel', 'pp']) tracking.add(key);
    if (url.hostname === 'youtu.be') identifier = /^\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)?.[1];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
      identifier = url.pathname === '/watch' ? url.searchParams.get('v') ?? undefined : /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)?.[1];
    }
    if (identifier && /^[A-Za-z0-9_-]{11}$/.test(identifier)) uri = 'https://www.youtube.com/watch?v=' + identifier;
  } else if (source === 'spotify') {
    for (const key of ['context', 'nd', 'flow_ctx']) tracking.add(key);
    if (url.hostname === 'open.spotify.com') identifier = /^\/(?:intl-[a-z]{2}\/)?track\/([A-Za-z0-9]{22})$/.exec(url.pathname)?.[1];
    if (identifier) uri = 'https://open.spotify.com/track/' + identifier;
  } else if (source === 'soundcloud') {
    tracking.add('in');
    if (['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'].includes(url.hostname)) {
      const match = /^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
      if (match && !['sets', 'tracks', 'likes', 'reposts', 'albums', 'popular-tracks', 'comments'].includes(match[2])) {
        identifier = match[1] + '/' + match[2]; uri = 'https://soundcloud.com/' + identifier;
      }
    }
    if (!uri || [...url.searchParams.keys()].some(key => !tracking.has(key))) throw new Error('Private or unsupported SoundCloud links cannot be shared in playlist files. Use a public track link.');
  }
  if (!uri || !identifier || [...url.searchParams.keys()].some(key => !tracking.has(key))) throw new Error('The recording source and public track link do not match, or the link contains unsupported parameters.');
  if (source === 'youtube' && url.searchParams.getAll('v').length > 1) throw invalid();
  return { identifier, uri };
}

export function exportPlaylistDocument(list: Pick<SavedPlaylist, 'name' | 'entries'>): { document: PlaylistDocument; json: Buffer; links: Buffer } {
  const document: PlaylistDocument = { format: 'musicmaid-playlist', version: 1, name: text(list.name, 60), tracks: list.entries.map(entry => {
    const selected = entry.recording, reference = canonicalPlaylistReference(selected.source, selected.uri);
    if (selected.source !== 'soundcloud' && selected.identifier !== reference.identifier && selected.identifier !== selected.uri) throw new Error('A saved recording has inconsistent source identity. Re-add it before exporting.');
    return { source: selected.source, ...reference, title: text(selected.title, 300), author: text(selected.author, 200), durationMs: selected.durationMs };
  }) };
  const json = Buffer.from(JSON.stringify(document, null, 2) + '\n');
  parsePlaylistDocument(json); // Apply the same format/size checks before sharing anything.
  const links = Buffer.from(document.name + '\n\n' + document.tracks.map((track, index) => `${index + 1}. ${track.title} — ${track.author}\n${track.uri}`).join('\n\n') + '\n');
  return { document, json, links };
}

export function parsePlaylistDocument(bytes: Uint8Array): PlaylistDocument {
  if (!bytes.byteLength || bytes.byteLength > playlistDocumentMaxBytes) throw new Error('Upload a MusicMaid JSON playlist no larger than 2 MiB.');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  const document = object(parsed, ['format', 'version', 'name', 'tracks']);
  if (document.format !== 'musicmaid-playlist' || document.version !== 1 || !Array.isArray(document.tracks) || document.tracks.length > 500) throw invalid();
  const name = text(document.name, 60);
  const tracks = document.tracks.map(value => {
    const track = object(value, ['source', 'identifier', 'uri', 'title', 'author', 'durationMs']);
    if (!['youtube', 'spotify', 'soundcloud'].includes(track.source as string)) throw invalid();
    const source = track.source as RecordingSource;
    const reference = canonicalPlaylistReference(source, track.uri as string);
    if (track.identifier !== reference.identifier || track.uri !== reference.uri) throw new Error('Imported recording IDs must match their canonical public links.');
    if (!Number.isSafeInteger(track.durationMs) || (track.durationMs as number) <= 0 || (track.durationMs as number) > 86400000) throw invalid();
    return { source, ...reference, title: text(track.title, 300), author: text(track.author, 200), durationMs: track.durationMs as number };
  });
  return { format: 'musicmaid-playlist', version: 1, name, tracks };
}

/** Imported display metadata is a hint; playback still resolves the exact public recording. */
export function playlistDocumentEntries(document: PlaylistDocument, importer: string): QueueEntry[] {
  return document.tracks.map(track => entryFor({ source: track.source, query: track.uri, requestedBy: importer }, {
    ...track, identifier: track.source === 'soundcloud' ? track.uri : track.identifier, isStream: false, isSeekable: true
  }));
}

export type PlaylistAttachment = { id: string; name: string; url: string; size: number };
export async function fetchPlaylistAttachment(attachment: PlaylistAttachment, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<PlaylistDocument> {
  if (!/\.json$/i.test(attachment.name) || !/^\d{5,22}$/.test(attachment.id) || !Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > playlistDocumentMaxBytes) throw new Error('Choose one .json playlist file, up to 2 MiB.');
  let url: URL;
  try { url = new URL(attachment.url); } catch { throw invalid(); }
  const match = /^\/(?:ephemeral-)?attachments\/(\d{5,22})\/(\d{5,22})\/[^/]+$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.discordapp.com' || url.port || url.username || url.password || url.hash || !match || match[2] !== attachment.id || [...url.searchParams.keys()].some(key => !['ex', 'is', 'hm'].includes(key))) throw new Error('Upload the JSON file directly to Discord; external download links are not supported.');
  const deadline = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
  let response: Response;
  try { response = await fetcher(url.href, { redirect: 'error', signal: deadline, headers: { 'Accept-Encoding': 'identity' } }); }
  catch { throw new Error('The uploaded playlist could not be downloaded. Upload it again and retry.'); }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('The uploaded playlist is unavailable. Upload the file again.'); }
  const declared = response.headers.get('content-length');
  const encoding = response.headers.get('content-encoding');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > playlistDocumentMaxBytes || ((!encoding || encoding === 'identity') && Number(declared) !== attachment.size))) { await response.body.cancel(); throw new Error('The uploaded playlist size did not match its attachment.'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      deadline.throwIfAborted();
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > playlistDocumentMaxBytes || size > attachment.size) throw new Error('The uploaded playlist exceeds its allowed size.');
      chunks.push(part.value);
    }
    if (size !== attachment.size) throw new Error('The uploaded playlist was incomplete. Upload it again.');
    return parsePlaylistDocument(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
