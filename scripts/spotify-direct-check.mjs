#!/usr/bin/env node
import { SpotifyOriginalAudio } from '../dist/apps/bot/src/audio/spotify-direct.js';
import { resolveSpotifyTrackMetadata } from '../dist/apps/bot/src/audio/spotify.js';
import { safeError } from '../dist/apps/bot/src/audio/diagnostics.js';
const id = process.argv[2] ?? '0NTMtAO2BV4tnGvw9EgBVq';
if (!/^[A-Za-z0-9]{22}$/.test(id)) throw new Error('Supply a Spotify track ID.');
const source = new SpotifyOriginalAudio(process.env.SPOTIFY_DIRECT_BINARY ?? '/opt/botsvc/audiobot-tools/musicmaid-spotify-stream', process.env.SPOTIFY_DIRECT_AUTH_FILE ?? '/var/lib/audiobot/spotify-direct.json');
const address = process.env.LAVALINK_URL ?? '127.0.0.1:2333';
const base = new URL(address.startsWith('http') ? address : 'http://' + address);
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('Original Spotify audio requires Lavalink on this host.');
try {
  const metadata = await resolveSpotifyTrackMetadata('https://open.spotify.com/track/' + id);
  if (!metadata?.durationMs || metadata.id !== id) throw new Error('The exact Spotify recording metadata is unavailable.');
  const record = { id, title: metadata.name, artists: metadata.artists, durationMs: metadata.durationMs, isrc: metadata.isrc, artworkUrl: metadata.artworkUrl };
  for (const position of [0, Math.min(120000, Math.floor(record.durationMs / 2))]) {
    const abort = new AbortController();
    try {
      const track = await source.resolve(record, async uri => {
        const url = new URL('/v4/loadtracks', base); url.searchParams.set('identifier', uri);
        const response = await fetch(url, { headers: { Authorization: process.env.LAVALINK_AUTH ?? 'youshallnotpass' }, signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Audio lookup HTTP ' + response.status); return response.json();
      }, abort.signal, position);
      console.log(JSON.stringify({ check: 'Spotify original audio', id, title: record.title, positionMs: position, verifiedOffsetMs: track.data.pluginInfo.spotifyOffsetMs, durationMs: track.data.info.length, quality: track.data.pluginInfo.audioQuality, seekable: track.data.info.isSeekable }));
    } finally { abort.abort(); }
  }
  console.log('Original Spotify source and positioned stream checks passed. Discord listening remains the final acceptance test.');
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
finally { source.close(); }
