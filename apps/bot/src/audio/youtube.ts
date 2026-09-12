import { spawn } from "node:child_process";
import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LoadType, type Track, type LavalinkResponse } from "shoukaku";
import { versionTerms } from "./music-text.js";
import { abortable } from "./source-errors.js";

export type YoutubeOptions = { binary: string; cookies: string };
export type YoutubeVideo = { id: string; url: string; durationMs: number; height: number; codec: string; expiresAt: number };
export type YoutubeRunner = (options: YoutubeOptions, args: string[], signal?: AbortSignal) => Promise<unknown>;
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const cacheDirectory = (options: YoutubeOptions) => join(dirname(options.cookies), "youtube-embedded-cache");
export async function resetYoutubeDecoderCache(options: YoutubeOptions): Promise<void> {
  // Only compiled player-signature data; the account session is never removed.
  await rm(join(cacheDirectory(options), "youtube-sigfuncs"), { recursive: true, force: true });
}

export function youtubeVideoId(input: string): string | undefined {
  let url: URL;
  try { url = new URL(input); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return undefined;
  const hosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"];
  if (!hosts.includes(url.hostname)) return undefined;
  const id = url.hostname === "youtu.be" ? url.pathname.slice(1)
    : url.pathname === "/watch" ? url.searchParams.get("v")
    : /^\/(shorts|live|embed)\//.test(url.pathname) ? url.pathname.split("/")[2] : undefined;
  return id && videoIdPattern.test(id) ? id : undefined;
}

export function validateYoutubeMediaUrl(input: unknown, now = Date.now()): string {
  if (typeof input !== "string") throw new Error("YouTube did not provide a complete audio stream.");
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("YouTube returned an invalid audio address."); }
  const expires = Number(url.searchParams.get("expire"));
  if (url.protocol !== "https:" || !url.hostname.endsWith(".googlevideo.com") || url.pathname !== "/videoplayback"
    || url.username || url.password || url.hash || (url.port && url.port !== "443")
    || !Number.isFinite(expires) || expires * 1000 < now + 60_000) {
    throw new Error("YouTube returned an unsafe or expired audio address.");
  }
  return url.href;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("YouTube returned invalid track information.");
  return value as Record<string, unknown>;
}

export function youtubeMetadata(value: unknown, expectedId?: string): Track {
  const data = object(value);
  if (typeof data.id !== "string" || !videoIdPattern.test(data.id) || (expectedId && data.id !== expectedId)) {
    throw new Error("YouTube returned a different upload; playback was refused.");
  }
  if (data.is_live === true || data.live_status === "is_live" || data.live_status === "is_upcoming") {
    throw new Error("Live YouTube streams are not supported by authenticated playback yet.");
  }
  if (typeof data.duration !== "number" || !Number.isFinite(data.duration) || data.duration <= 0
    || typeof data.title !== "string" || !data.title.trim()) throw new Error("YouTube did not provide a full track duration and title.");
  const author = [data.channel, data.uploader, data.artist].find(item => typeof item === "string" && item.trim());
  let title = data.title;
  const description = typeof data.description === "string" ? data.description : "";
  const remixer = /^.*\bRemixer\b[^:\n]*:\s*([^\r\n]+)/mi.exec(description)?.[1]?.trim();
  if (remixer && !versionTerms(title).includes("remix")) title += ` (${remixer.slice(0, 80)} remix)`;
  return {
    encoded: "", pluginInfo: { channelVerified: data.channel_is_verified === true }, info: {
      identifier: data.id, uri: `https://www.youtube.com/watch?v=${data.id}`,
      title, author: typeof author === "string" ? author : "Unknown artist",
      length: Math.round(data.duration * 1000), position: 0, sourceName: "youtube",
      isSeekable: true, isStream: false, artworkUrl: `https://i.ytimg.com/vi/${data.id}/hqdefault.jpg`
    }
  };
}

function extractionFailure(stderr: string, timedOut: boolean): Error {
  if (/sign in|login|cookies.*(expired|invalid|rotated)|not a bot/i.test(stderr)) {
    return new Error("YouTube session expired or was refused. A server operator must refresh the dedicated account session.");
  }
  if (/429|too many requests/i.test(stderr)) return new Error("YouTube is rate-limiting this connection. Try again later.");
  if (/private|unavailable|not available|members.only|premium|paid content/i.test(stderr)) return new Error("This YouTube upload is unavailable or restricted.");
  return new Error(timedOut ? "YouTube source timeout while resolving the selected upload." : "YouTube could not resolve the selected upload. A mod can run Diagnose.");
}

/** Never include the child error object: it contains stdout, stderr and signed URLs. */
export const runYoutube: YoutubeRunner = async (options, args, signal) => {
  let file;
  try { file = await lstat(options.cookies); } catch { throw new Error("YouTube account session is not configured on this server."); }
  if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error("YouTube session file must be private (mode 0600).");
  const cache = cacheDirectory(options);
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const cacheInfo = await lstat(cache);
  if (!cacheInfo.isDirectory() || (cacheInfo.mode & 0o077) !== 0) throw new Error("YouTube decoder cache must be a private directory.");
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(options.binary, [
      "--ignore-config", "--no-plugin-dirs", "--cache-dir", cache, "--no-playlist", "--no-progress",
      "--force-ipv4", "--proxy", "", "--cookies", options.cookies,
      "--user-agent", "Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0",
      "--js-runtimes", "node:/usr/bin/node", "--socket-timeout", "10", "--retries", "0",
      "--extractor-retries", "0", "--dump-single-json", ...args
    ], {
      detached, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" }
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outputBytes = 0, errorBytes = 0, failed = false;
    let termination: "aborted" | "timeout" | "output_limit" | "failure" | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (kind: "SIGTERM" | "SIGKILL") => {
      // The extractor's JavaScript helpers must close too; never leave inherited
      // pipes or account-session work alive after releasing the writer queue.
      try { if (detached && child.pid) process.kill(-child.pid, kind); else child.kill(kind); } catch { /* close remains the only completion signal. */ }
    };
    const terminate = (reason: NonNullable<typeof termination>) => {
      if (termination) return;
      termination = reason; kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 1000); killTimer.unref();
    };
    const aborted = () => terminate("aborted");
    const timeout = setTimeout(() => terminate("timeout"), 25000); timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      if (termination) return;
      outputBytes += chunk.length;
      if (outputBytes > 4 * 1024 * 1024) terminate("output_limit"); else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (termination) return;
      errorBytes += chunk.length;
      if (errorBytes > 4 * 1024 * 1024) terminate("output_limit"); else stderr.push(chunk);
    });
    const failure = () => { failed = true; terminate("failure"); };
    child.on("error", failure); child.stdout.on("error", failure); child.stderr.on("error", failure);
    // AbortSignal's execFile callback can run before SIGTERM has stopped the
    // child. Only close proves that the next cookie writer can safely begin.
    child.once("close", code => {
      clearTimeout(timeout); if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", aborted);
      if (termination === "aborted" || signal?.aborted) { reject(new Error("YouTube resolution aborted.")); return; }
      if (termination === "output_limit") { reject(new Error("YouTube returned too much track information.")); return; }
      if (failed || code !== 0 || termination) { reject(extractionFailure(Buffer.concat(stderr).toString("utf8"), termination === "timeout")); return; }
      try { resolve(JSON.parse(Buffer.concat(stdout).toString("utf8"))); } catch { reject(new Error("YouTube returned invalid track information.")); }
    });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
};

export class YoutubeResolver {
  private jobs: { priority: number; work: () => Promise<void> }[] = [];
  private running = false;
  private activeOptional?: AbortController;
  private metadataCache = new Map<string, { track: Track; until: number }>();
  private videos = new Map<string, YoutubeVideo>();
  private videoWork = new Map<string, Promise<YoutubeVideo>>();
  constructor(private options: YoutubeOptions, private runner: YoutubeRunner = runYoutube) {}
  private run(args: string[], signal?: AbortSignal, priority = 0, optional = false): Promise<unknown> {
    signal?.throwIfAborted();
    if (!priority && this.jobs.length >= 8) return Promise.reject(new Error("YouTube searches are busy. Try again shortly."));
    const optionalController = optional ? new AbortController() : undefined;
    const workSignal = optionalController ? AbortSignal.any([optionalController.signal, ...(signal ? [signal] : [])]) : signal;
    // One cookie writer; urgent audio may cancel optional video, but still waits
    // for its runner to close before starting the next extraction.
    return new Promise((resolve, reject) => {
      this.jobs.push({ priority, work: async () => {
        this.activeOptional = optionalController;
        try { workSignal?.throwIfAborted(); resolve(await this.runner(this.options, args, workSignal)); }
        catch (error) { reject(error); }
        finally { this.activeOptional = undefined; }
      } });
      this.jobs.sort((a, b) => b.priority - a.priority);
      if (priority > 0) this.activeOptional?.abort();
      this.drain();
    });
  }
  private drain(): void {
    if (this.running) return;
    const job = this.jobs.shift(); if (!job) return;
    this.running = true;
    void job.work().finally(() => { this.running = false; this.drain(); });
  }
  async playlist(id: string, start: number, signal?: AbortSignal): Promise<LavalinkResponse> {
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(id) || !Number.isInteger(start) || start < 1 || start > 10_000) throw new Error("Invalid YouTube playlist or starting position.");
    const data = object(await this.run(["--yes-playlist", "--flat-playlist", "--ignore-errors", "--playlist-start", String(start), "--playlist-end", String(start + 99), "--", `https://www.youtube.com/playlist?list=${id}`], signal));
    if (!Array.isArray(data.entries)) throw new Error("This YouTube playlist is private, unavailable or empty.");
    const tracks: Track[] = []; let skipped = 0;
    for (const item of data.entries.slice(0, 100)) { try { tracks.push(youtubeMetadata(item)); } catch { skipped++; } }
    const info = { name: typeof data.title === "string" ? data.title : "YouTube playlist", selectedTrack: -1, skipped,
      hasMore: typeof data.playlist_count === "number" ? data.playlist_count >= start + 100 : data.entries.length >= 100 };
    return { loadType: LoadType.PLAYLIST, data: { encoded: "", info, pluginInfo: {}, tracks } };
  }
  async search(query: string, signal?: AbortSignal): Promise<LavalinkResponse> {
    if (!query.trim() || query.length > 500) throw new Error("Enter a song and artist, up to 500 characters.");
    const data = object(await this.run(["--flat-playlist", "--playlist-end", "10", "--", `ytsearch10:${query}`], signal));
    if (!Array.isArray(data.entries)) throw new Error("YouTube search returned invalid results.");
    const tracks: Track[] = [];
    for (const entry of data.entries.slice(0, 10)) {
      try { tracks.push(youtubeMetadata(entry)); } catch { /* Private, live or incomplete search results are not playable choices. */ }
    }
    return tracks.length ? { loadType: LoadType.SEARCH, data: tracks } : { loadType: LoadType.EMPTY, data: {} };
  }
  async inspect(id: string, signal?: AbortSignal): Promise<LavalinkResponse> {
    if (!videoIdPattern.test(id)) throw new Error("Invalid YouTube recording identifier.");
    const cached = this.metadataCache.get(id);
    if (cached && cached.until > Date.now()) return { loadType: LoadType.TRACK, data: structuredClone(cached.track) };
    const track = youtubeMetadata(await this.run(["--skip-download", "--", `https://www.youtube.com/watch?v=${id}`], signal), id);
    this.remember(track);
    return { loadType: LoadType.TRACK, data: track };
  }
  /** Optional video uses the same serialized account session, behind audio work. */
  async video(id: string, signal?: AbortSignal, refresh = false): Promise<YoutubeVideo> {
    if (!videoIdPattern.test(id)) throw new Error("Invalid YouTube video identifier.");
    signal?.throwIfAborted();
    if (refresh) this.videos.delete(id);
    const cached = this.videos.get(id);
    if (cached && cached.expiresAt > Date.now() + 120000) return { ...cached };
    let work = this.videoWork.get(id);
    if (!work) {
      work = (async () => {
        const data = object(await this.run(["--skip-download", "-f", "bestvideo[ext=mp4][vcodec^=avc1][height<=720][fps<=30][protocol=https]", "--", `https://www.youtube.com/watch?v=${id}`], AbortSignal.timeout(25000), 0, true));
        const track = youtubeMetadata(data, id);
        if (data.acodec !== "none" || typeof data.vcodec !== "string" || !data.vcodec.startsWith("avc1") || typeof data.height !== "number" || data.height < 1 || data.height > 720 || (typeof data.fps === "number" && data.fps > 30)) throw new Error("This upload has no supported video-only stream.");
        const url = validateYoutubeMediaUrl(data.url);
        const video = { id, url, durationMs: track.info.length, height: data.height, codec: data.vcodec, expiresAt: Number(new URL(url).searchParams.get("expire")) * 1000 };
        if (this.videos.size >= 8) this.videos.delete(this.videos.keys().next().value!);
        this.videos.set(id, video); return video;
      })().finally(() => this.videoWork.delete(id));
      this.videoWork.set(id, work);
    }
    const result = signal ? await abortable(work, signal) : await work; signal?.throwIfAborted(); return { ...result };
  }
  private remember(track: Track): void {
    if (this.metadataCache.size >= 200) this.metadataCache.delete(this.metadataCache.keys().next().value!);
    this.metadataCache.set(track.info.identifier, { track: { ...structuredClone(track), encoded: "" }, until: Date.now() + 3_600_000 });
  }
  async resolve(uri: string, loadAudio: (url: string) => Promise<LavalinkResponse | undefined>, signal?: AbortSignal): Promise<LavalinkResponse> {
    const id = youtubeVideoId(uri);
    if (!id) throw new Error("Use a single YouTube video link.");
    const data = object(await this.run([
      "--check-formats", "--skip-download",
      "-f", "bestaudio[acodec=opus][protocol=https]/bestaudio[protocol=https]",
      "--", `https://www.youtube.com/watch?v=${id}`
    ], signal, 1));
    const track = youtubeMetadata(data, id);
    const quality: { codec: string; bitrateKbps?: number; sampleRateHz?: number } = { codec: typeof data.acodec === "string" ? data.acodec : "unknown" };
    if (typeof data.abr === "number" && Number.isFinite(data.abr) && data.abr > 0 && data.abr < 2000) quality.bitrateKbps = Math.round(data.abr);
    if (typeof data.asr === "number" && Number.isFinite(data.asr) && data.asr > 0) quality.sampleRateHz = data.asr;
    track.pluginInfo = { ...(track.pluginInfo as Record<string, unknown>), audioQuality: quality };
    this.remember(track);
    const mediaUrl = validateYoutubeMediaUrl(data.url);
    signal?.throwIfAborted();
    const audio = await loadAudio(mediaUrl);
    signal?.throwIfAborted();
    if (audio?.loadType !== LoadType.TRACK || audio.data.info.sourceName !== "http") {
      throw new Error("The audio service could not open the YouTube stream. A mod can run Diagnose.");
    }
    const actual = audio.data.info.length;
    if (Number.isSafeInteger(actual) && actual > 0 && actual < Number.MAX_SAFE_INTEGER / 2) {
      if (Math.abs(actual - track.info.length) > Math.max(5000, track.info.length * 0.02)) {
        throw new Error("YouTube returned an incomplete or different-length stream; playback was refused.");
      }
      track.info.length = actual;
    }
    track.encoded = audio.data.encoded;
    track.info.isSeekable = audio.data.info.isSeekable;
    // Canonical identity stays YouTube. The signed transport URL is never persisted in queue/history.
    return { loadType: LoadType.TRACK, data: track };
  }
}
