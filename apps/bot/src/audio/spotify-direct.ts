import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { LoadType, type LavalinkResponse, type Track } from 'shoukaku';
import { invalidateSpotifyDirectToken, spotifyDirectToken } from './spotify-direct-auth.js';
import { abortable } from './source-errors.js';
export type OriginalRecording = { id: string; title: string; artists: string[]; durationMs: number; isrc?: string; artworkUrl?: string };
export type OriginalAudio = { startMs?: number; bytes: Buffer; recording: OriginalRecording; quality: { codec: string; bitrateKbps?: number; sampleRateHz?: number } };
export type OriginalRunner = (binary: string, authFile: string, recording: OriginalRecording, signal: AbortSignal, maxBytes: number, startMs?: number) => Promise<OriginalAudio>;
const MAX_TRACK_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const HELPER_ERRORS = new Set([
  'Spotify account login was refused', 'Spotify recording metadata is unavailable for this account',
  'The exact Spotify recording is unavailable for this account', 'Spotify duration differs from the selected recording',
  'Spotify Premium could not be confirmed for this account', 'The selected Spotify recording has no supported original Ogg stream',
  'Spotify returned a different recording; playback refused',
  'Spotify did not provide readable original audio; account or audio-key access may be refused',
  'Spotify returned no complete audio', 'Spotify player stopped without completing the recording',
  'Spotify original audio preparation timed out', 'Spotify start position is outside the recording', 'Spotify returned an unexpected start position'
]);
/** Validate the actual Vorbis identification packet, rather than assuming the requested quality. */
export function vorbisQuality(bytes: Buffer): OriginalAudio['quality'] {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 4) !== 'OggS') throw new Error('Spotify: original audio did not contain a valid Ogg stream.');
  const offset = bytes.subarray(0, 16384).indexOf(Buffer.from([1, 118, 111, 114, 98, 105, 115]));
  if (offset < 0 || offset + 30 > bytes.length || bytes[offset + 11] !== 2) throw new Error('Spotify: original stereo Vorbis audio could not be verified.');
  const sampleRateHz = bytes.readUInt32LE(offset + 12), nominal = bytes.readInt32LE(offset + 20);
  if (sampleRateHz < 8000 || sampleRateHz > 192000) throw new Error('Spotify: invalid source sample rate.');
  return { codec: 'vorbis', sampleRateHz, ...(nominal > 0 && nominal <= 1_000_000 ? { bitrateKbps: Math.round(nominal / 1000) } : {}) };
}
export const runOriginalSpotify: OriginalRunner = async (binary, authFile, expected, signal, maxBytes, startMs = 0) => {
  const auth = await spotifyDirectToken(authFile, signal); signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    const chunks: Buffer[] = []; let forceKill: NodeJS.Timeout | undefined;
    let positionMs: number | undefined;
    let length = 0, stderr = '', meta: Record<string, unknown> | undefined, completed = false, failure: Error | undefined;
    const fail = (message: string) => { failure ??= new Error(message); child.kill('SIGTERM'); forceKill ??= setTimeout(() => child.kill('SIGKILL'), 1000); forceKill.unref(); };
    const abort = () => fail('Spotify: audio preparation was cancelled.'); signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => fail('Spotify: original audio preparation timed out.'), 65_000); timeout.unref();
    const hardStop = setTimeout(() => child.kill('SIGKILL'), 70_000); hardStop.unref();
    child.on('error', () => { failure = new Error('Spotify: the original-audio helper could not start. A mod can run Diagnose.'); });
    child.stdout.on('data', (chunk: Buffer) => { length += chunk.length; if (length > maxBytes) fail('Spotify: this recording exceeds the temporary audio buffer limit.'); else chunks.push(chunk); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; if (stderr.length > 32768) fail('Spotify: the audio helper returned excessive diagnostics.'); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ accessToken: auth.accessToken, deviceId: auth.deviceId, trackId: expected.id, expectedDurationMs: expected.durationMs, startMs }) + '\n');
    child.on('close', code => {
      clearTimeout(timeout); clearTimeout(hardStop); if (forceKill) clearTimeout(forceKill); signal.removeEventListener('abort', abort);
      try {
        signal.throwIfAborted(); if (failure) throw failure;
        for (const line of stderr.trim().split('\n')) {
          let item: Record<string, unknown>; try { item = JSON.parse(line); } catch { continue; }
          if (item.event === 'metadata') meta = item;
          if (item.event === 'start_position' && typeof item.positionMs === 'number') positionMs = item.positionMs;
          if (item.event === 'complete') completed = item.trackId === expected.id && item.bytes === length;
          // Only this helper's fixed error vocabulary is exposed; subprocess traces remain private.
          if (item.event === 'error' && item.reason === 'Spotify account login was refused') invalidateSpotifyDirectToken(authFile);
          if (item.event === 'error' && item.reason === 'The selected Spotify recording has no supported original Ogg stream') throw new Error('Spotify: this catalog entry is not playable through the current integration. Search by artist and title, or choose another recording.');
          if (item.event === 'error') throw new Error('Spotify: ' + (typeof item.reason === 'string' && HELPER_ERRORS.has(item.reason) ? item.reason.replace(/^Spotify /, '') : 'original audio was refused or could not complete. A mod can run Diagnose.'));
        }
        if (code !== 0 || !completed || !meta || meta.trackId !== expected.id || typeof meta.durationMs !== 'number' || Math.abs(meta.durationMs - expected.durationMs) > 5000) throw new Error('Spotify: full audio or exact recording identity could not be verified.');
        if (positionMs === undefined || !Number.isFinite(positionMs) || positionMs < 0 || Math.abs(positionMs - startMs) > 1000) throw new Error('Spotify: the requested start position could not be verified.');
        const bytes = Buffer.concat(chunks, length); const quality = vorbisQuality(bytes);
        resolve({ bytes, startMs: positionMs, recording: { ...expected, durationMs: meta.durationMs, ...(typeof meta.title === "string" && meta.title ? { title: meta.title } : {}), ...(Array.isArray(meta.artists) && meta.artists.length && meta.artists.every(a => typeof a === "string") ? { artists: meta.artists as string[] } : {}) }, quality });
      } catch (error) { reject(error); }
    });
  });
};
/** A single byte range, including suffix ranges. Multiple ranges are deliberately unsupported. */
export function audioRange(header: string | undefined, length: number): { start: number; end: number; partial: boolean } | undefined {
  if (!header) return { start: 0, end: length - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return;
  const first = match[1] ? Number(match[1]) : undefined, last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) return;
  const start = first ?? Math.max(0, length - (last ?? 0));
  const end = first === undefined || last === undefined ? length - 1 : Math.min(length - 1, last);
  if (start < 0 || start >= length || end < start) return;
  return { start, end, partial: true };
}
type Lease = { bytes: Buffer; until: number; cleanup: () => void };
export class SpotifyOriginalAudio {
  private server?: Server;
  private opening?: Promise<string>;
  private origin?: string;
  private leases = new Map<string, Lease>();
  private pending: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private closing = new AbortController();
  constructor(private binary: string, private authFile: string, private runner: OriginalRunner = runOriginalSpotify) {}
  private listen(): Promise<string> {
    if (this.origin) return Promise.resolve(this.origin);
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.prune();
        const match = /^\/spotify\/([a-f0-9]{48})\.ogg$/.exec(req.url ?? '');
        const lease = match ? this.leases.get(match[1]) : undefined;
        if (!lease || req.headers.host !== this.origin?.slice(7) || !['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(404).end(); return; }
        const range = audioRange(req.headers.range, lease.bytes.length);
        if (!range) { res.writeHead(416, { 'Content-Range': 'bytes */' + lease.bytes.length }).end(); return; }
        const headers: Record<string, string | number> = { 'Content-Type': 'audio/ogg', 'Content-Length': range.end - range.start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
        if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${lease.bytes.length}`;
        res.writeHead(range.partial ? 206 : 200, headers);
        res.end(req.method === 'HEAD' ? undefined : lease.bytes.subarray(range.start, range.end + 1));
      });
      this.server.requestTimeout = 15000; this.server.headersTimeout = 10000; this.server.keepAliveTimeout = 1000;
      this.server.once('error', () => { this.opening = undefined; reject(new Error('Spotify: private audio transport could not start.')); });
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server!.address(); if (!address || typeof address === 'string') { reject(new Error('Spotify: private audio transport has no address.')); return; }
        this.origin = 'http://127.0.0.1:' + address.port; this.server!.unref(); resolve(this.origin);
      });
    });
    return this.opening;
  }
  private prune(): void { for (const [key, lease] of this.leases) if (lease.until <= Date.now()) { lease.cleanup(); this.leases.delete(key); } }
  async resolve(recording: OriginalRecording, loadAudio: (url: string, signal?: AbortSignal) => Promise<LavalinkResponse | undefined>, signal?: AbortSignal, startMs = 0): Promise<LavalinkResponse> {
    if (!/^[A-Za-z0-9]{22}$/.test(recording.id) || !Number.isFinite(recording.durationMs) || recording.durationMs <= 0 || recording.durationMs > 3_600_000) throw new Error('Spotify: the selected track has invalid recording metadata.');
    if (!Number.isFinite(startMs) || startMs < 0 || startMs >= recording.durationMs) throw new Error('Spotify: choose a position within this recording.');
    if (this.queued >= 4) throw new Error('Spotify: audio preparation is busy. Try again shortly.');
    this.queued++;
    const bounded = AbortSignal.any([this.closing.signal, AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]);
    const work = this.pending.catch(() => {}).then(async () => {
      bounded.throwIfAborted(); this.prune();
      const available = MAX_TOTAL_BYTES - [...this.leases.values()].reduce((n, lease) => n + lease.bytes.length, 0);
      if (available < 1024 * 1024) throw new Error('Spotify: active audio buffers are full. Finish another request first.');
      const audio = await this.runner(this.binary, this.authFile, recording, bounded, Math.min(MAX_TRACK_BYTES, available), startMs); bounded.throwIfAborted();
      if (audio.recording.id !== recording.id || !Number.isFinite(audio.recording.durationMs) || audio.recording.durationMs <= 0 || Math.abs(audio.recording.durationMs - recording.durationMs) > 5000 || audio.bytes.length > Math.min(MAX_TRACK_BYTES, available)) throw new Error('Spotify: the selected recording could not be verified.');
      const offset = audio.startMs ?? 0;
      if (!Number.isFinite(offset) || offset < 0 || offset >= audio.recording.durationMs || Math.abs(offset - startMs) > 1000) throw new Error('Spotify: source start position did not match.');
      const origin = await this.listen(); bounded.throwIfAborted();
      const key = randomBytes(24).toString('hex');
      const remove = () => { this.leases.delete(key); signal?.removeEventListener('abort', remove); };
      signal?.addEventListener('abort', remove, { once: true });
      this.leases.set(key, { bytes: audio.bytes, until: signal ? Infinity : Date.now() + 60_000, cleanup: () => signal?.removeEventListener('abort', remove) });
      try {
        const loaded = await abortable(loadAudio(origin + '/spotify/' + key + '.ogg', bounded), bounded); bounded.throwIfAborted();
        if (loaded?.loadType !== LoadType.TRACK || loaded.data.info.sourceName !== 'http') throw new Error('Spotify: the audio service could not open the original recording.');
        if (!Number.isFinite(loaded.data.info.length) || loaded.data.info.length <= 0 || !loaded.data.info.isSeekable || Math.abs(loaded.data.info.length + offset - audio.recording.durationMs) > 5000) throw new Error('Spotify: the audio service did not verify a complete seekable recording.');
        const track: Track = { encoded: loaded.data.encoded, pluginInfo: { audioQuality: audio.quality, artists: audio.recording.artists, spotifyOffsetMs: offset }, info: {
          identifier: recording.id, uri: 'https://open.spotify.com/track/' + recording.id, title: audio.recording.title, author: audio.recording.artists.join(', '),
          length: audio.recording.durationMs, position: 0, sourceName: 'spotify', isSeekable: true, isStream: false, isrc: recording.isrc, artworkUrl: recording.artworkUrl
        } };
        return { loadType: LoadType.TRACK as const, data: track };
      } catch (error) { remove(); throw error; }
    }).finally(() => { this.queued--; });
    this.pending = work; return work;
  }
  close(): void {
    this.closing.abort(); for (const lease of this.leases.values()) lease.cleanup(); this.leases.clear();
    this.server?.closeAllConnections(); this.server?.close();
  }
}
