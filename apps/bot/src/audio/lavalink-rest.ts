import { LoadType, Rest, type LavalinkResponse, type NodeInfo, type Node as LavalinkNode, type NodeOption } from 'shoukaku';

type JsonOptions = { base: string; authorization: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; fetcher?: typeof fetch };
const failure = (message: string) => new Error('Lavalink lookup failed: ' + message);
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The deadline and caller cancellation cover the response body, not only headers. */
export async function lavalinkJson(path: '/loadtracks' | '/info', identifier: string | undefined, options: JsonOptions): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(options.base.replace(/\/$/, '') + path);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw failure('invalid audio-service address.');
    if (path === '/loadtracks') {
      if (typeof identifier !== 'string' || !identifier || identifier.length > 32768) throw failure('invalid recording identifier.');
      url.searchParams.set('identifier', identifier);
    }
  } catch { throw failure('invalid audio-service request.'); }
  const abort = new AbortController();
  const canceled = () => abort.abort();
  if (options.signal?.aborted) throw failure('request was canceled.');
  options.signal?.addEventListener('abort', canceled, { once: true });
  const duration = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(60000, options.timeoutMs!)) : 8000;
  const timer = setTimeout(() => abort.abort(), duration); timer.unref();
  const maxBytes = options.maxBytes ?? (path === '/info' ? 1024 * 1024 : 8 * 1024 * 1024);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await (options.fetcher ?? fetch)(url, { redirect: 'error', signal: abort.signal, headers: { Authorization: options.authorization, Accept: 'application/json', 'Accept-Encoding': 'identity' } });
    if (!response.ok) { abort.abort(); await response.body?.cancel().catch(() => {}); throw failure('audio service returned HTTP ' + response.status + '.'); }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
      abort.abort(); await response.body?.cancel().catch(() => {}); throw failure('audio-service response exceeded its size limit.');
    }
    if (!response.body) throw failure('audio service returned no JSON body.');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > maxBytes) throw failure('audio-service response exceeded its size limit.');
      chunks.push(part.value);
    }
    if (abort.signal.aborted) throw failure('request was canceled or timed out.');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw failure('audio service returned invalid JSON.'); }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Lavalink lookup failed:')) throw error;
    throw failure(abort.signal.aborted ? 'request was canceled or timed out.' : 'audio service could not complete the request.');
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', canceled);
    abort.abort();
    await reader?.cancel().catch(() => {}); reader?.releaseLock();
  }
}

function isTrack(value: unknown): boolean {
  const track = object(value), info = object(track?.info);
  return Boolean(track && typeof track.encoded === 'string' && info
    && ['identifier', 'title', 'author', 'sourceName'].every(key => typeof info[key] === 'string')
    && typeof info.length === 'number' && Number.isFinite(info.length) && info.length >= 0
    && typeof info.position === 'number' && Number.isFinite(info.position)
    && typeof info.isStream === 'boolean' && typeof info.isSeekable === 'boolean');
}
export function loadResult(value: unknown): LavalinkResponse {
  const result = object(value), data = result?.data;
  if (result?.loadType === LoadType.TRACK && isTrack(data)) return value as LavalinkResponse;
  if (result?.loadType === LoadType.SEARCH && Array.isArray(data) && data.length <= 10000 && data.every(isTrack)) return value as LavalinkResponse;
  if (result?.loadType === LoadType.EMPTY && (data === null || object(data))) return { loadType: LoadType.EMPTY, data: {} };
  const playlist = object(data), info = object(playlist?.info);
  if (result?.loadType === LoadType.PLAYLIST && playlist && info && typeof info.name === 'string' && Number.isInteger(info.selectedTrack) && Array.isArray(playlist.tracks) && playlist.tracks.length <= 10000 && playlist.tracks.every(isTrack)) return value as LavalinkResponse;
  if (result?.loadType === LoadType.ERROR && playlist && ['common', 'suspicious', 'fault'].includes(playlist.severity as string)
      && (playlist.message == null || typeof playlist.message === 'string') && (playlist.cause == null || typeof playlist.cause === 'string')) {
    // Provider traces can contain signed URLs or account headers. Preserve the
    // response type and useful category without returning arbitrary error text.
    const reason = (playlist.message ?? '') + ' ' + (playlist.cause ?? '');
    const message = /429|rate.?limit/i.test(reason) ? 'Lavalink lookup failed: the source is rate-limiting requests.'
      : /private|restricted|unavailable|not found|404|preview|paywall/i.test(reason) ? 'The requested recording is unavailable or restricted.'
      : /login|sign.?in|unauthor|authentication|401/i.test(reason) ? 'Lavalink lookup failed: source authorization was refused.'
      : /timeout|timed out|connect|502|503/i.test(reason) ? 'Lavalink lookup failed: the source could not complete its request.'
      : 'The requested recording could not be loaded.';
    return { loadType: LoadType.ERROR, data: { message, cause: '', severity: playlist.severity as 'common' | 'suspicious' | 'fault' } };
  }
  throw failure('audio service returned an invalid load response.');
}

/** Shoukaku's documented custom-REST seam; voice/session operations stay unchanged. */
export class CancellableRest extends Rest {
  constructor(...args: unknown[]) {
    // Shoukaku types custom constructors as unknown[], and supplies this pair.
    const node = object(args[0]), options = object(args[1]);
    if (args.length !== 2 || !object(object(node?.manager)?.options) || !options || typeof options.url !== 'string' || typeof options.auth !== 'string') throw failure('invalid REST adapter configuration.');
    super(args[0] as LavalinkNode, args[1] as NodeOption);
  }
  override async resolve(identifier: string, signal?: AbortSignal): Promise<LavalinkResponse | undefined> {
    return loadResult(await lavalinkJson('/loadtracks', identifier, { base: this.url, authorization: this.auth, signal, timeoutMs: this.node.manager.options.restTimeout * 1000 }));
  }
  override async getLavalinkInfo(signal?: AbortSignal): Promise<NodeInfo | undefined> {
    const value = await lavalinkJson('/info', undefined, { base: this.url, authorization: this.auth, signal, timeoutMs: this.node.manager.options.restTimeout * 1000 });
    const info = object(value), version = object(info?.version);
    if (!info || !version || typeof version.semver !== 'string' || !Array.isArray(info.plugins)) throw failure('audio service returned invalid information.');
    return value as NodeInfo;
  }
}
export function lavalinkInfo(rest: Rest, signal?: AbortSignal): Promise<NodeInfo | undefined> {
  return (rest as CancellableRest).getLavalinkInfo(signal);
}
