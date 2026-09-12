import type { Client } from "discord.js";
import { Constants, type Player, type Track } from "shoukaku";
import type { PlaybackBackend } from "./coordinator.js";
import type { PlaybackEvent, Recording, Session } from "./model.js";
import { getLavalink, ensureLavalinkNode } from "./lavalink.js";
import { recordingFor, resolveSelected, type Loader } from "./sources.js";
import { markSourcePlayback } from "./track-health.js";
import { env } from "../config/env.js";
import { YoutubeResolver, youtubeVideoId } from "./youtube.js";
import { voiceBlockReason, voiceReadiness } from "./voice-readiness.js";
import { incident, safeError } from "./diagnostics.js";
import { versionTerms } from "./music-text.js";
import { SpotifyOriginalAudio } from "./spotify-direct.js";
import { parseSpotifyReference, resolveSpotifyTrackMetadata } from "./spotify.js";
import type { CancellableRest } from "./lavalink-rest.js";

type Binding = { attemptId: string; startedId?: string; source: string; recording: Recording; positionOffsetMs?: number; seekBarrier?: number };
type VoiceAcknowledgement = { channelId: string | null; expiresAt: number };
type PendingStart = { controller: AbortController; phase: "resolving" | "connecting" | "playing" };
export class LavalinkBackend implements PlaybackBackend {
  onEvent: (guildId: string, event: PlaybackEvent) => void = () => {};
  onVoiceChange: (guildId: string, channelId?: string) => void = () => {};
  private bindings = new Map<Player, Binding>();
  private operations = new Map<string, Promise<unknown>>();
  private desiredVolume = new Map<string, number>();
  private pendingStarts = new Map<string, PendingStart>();
  private expectedVoiceStates = new Map<string, VoiceAcknowledgement[]>();
  private voiceTimers = new Map<string, NodeJS.Timeout>();
  private closing = new AbortController();
  private youtube = env.youtubeCookies ? new YoutubeResolver({ binary: env.youtubeBinary, cookies: env.youtubeCookies }) : undefined;
  private spotify = env.spotifyDirectEnabled ? new SpotifyOriginalAudio(env.spotifyDirectBinary, env.spotifyDirectAuthFile) : undefined;
  close(): void {
    this.closing.abort();
    this.spotify?.close();
    for (const start of this.pendingStarts.values()) start.controller.abort();
    this.pendingStarts.clear();
    for (const timer of this.voiceTimers.values()) clearTimeout(timer);
    this.voiceTimers.clear(); this.expectedVoiceStates.clear();
  }
  requiresReloadForSeek(recording: Recording): boolean { return recording.source === "spotify"; }
  constructor(private client: Client, private gateway = getLavalink, private ensureNode = ensureLavalinkNode, private now = Date.now) {}
  readonly load: Loader = (identifier, signal) => this.resolve(identifier, signal);
  video(id: string, signal: AbortSignal, refresh = false) {
    if (!this.youtube) throw new Error("Optional video needs the configured YouTube account session.");
    return this.youtube.video(id, signal, refresh);
  }
  private async resolve(identifier: string, signal?: AbortSignal, spotifyStartMs = 0, selected?: Recording) {
    signal = AbortSignal.any([this.closing.signal, ...(signal ? [signal] : [])]);
    signal.throwIfAborted();
    this.ensureNode("track lookup");
    const node = [...this.gateway().nodes.values()].find(n => n.state === 1);
    if (!node) throw new Error("The audio service is disconnected. A mod can use /music-admin repair.");
    const loadFromNode: Loader = async (uri, requestedSignal = signal) => {
      try { return await (node.rest as CancellableRest).resolve(uri, requestedSignal); }
      catch (error) { throw new Error(`Lavalink lookup failed: ${safeError(error)}`); }
    };
    const spotify = parseSpotifyReference(identifier);
    if (spotify?.type === "track") {
      if (!this.spotify) throw new Error("Spotify: original audio is disabled. Choose another recording explicitly or ask a mod to enable the tested integration.");
      const metadata = selected?.source === "spotify" && selected.identifier === spotify.id && selected.durationMs > 0
        ? { id: selected.identifier, name: selected.title, artists: selected.artists ?? [selected.author], durationMs: selected.durationMs, isrc: selected.isrc, artworkUrl: selected.artworkUrl }
        : await resolveSpotifyTrackMetadata(identifier);
      if (!metadata?.durationMs || metadata.id !== spotify.id) throw new Error("Spotify: the exact requested recording is unavailable in this market.");
      return this.spotify.resolve({ id: metadata.id, title: metadata.name, artists: metadata.artists, durationMs: metadata.durationMs, isrc: metadata.isrc, artworkUrl: metadata.artworkUrl }, loadFromNode, signal, spotifyStartMs);
    }
    const playlist = /^ytplaylist:(\d+):([A-Za-z0-9_-]{10,100})$/.exec(identifier);
    if (this.youtube && playlist) return this.youtube.playlist(playlist[2], Number(playlist[1]), signal);
    if (this.youtube && identifier.startsWith("ytmeta:")) return this.youtube.inspect(identifier.slice(7), signal);
    if (this.youtube && identifier.startsWith("ytsearch:")) return this.youtube.search(identifier.slice(identifier.indexOf(":") + 1), signal);
    if (this.youtube && youtubeVideoId(identifier)) return this.youtube.resolve(identifier, loadFromNode, signal);
    return loadFromNode(identifier, signal);
  };
  private serial<T>(guildId: string, action: () => Promise<T>): Promise<T> {
    const next = (this.operations.get(guildId) ?? Promise.resolve()).then(action, action);
    this.operations.set(guildId, next);
    void next.finally(() => { if (this.operations.get(guildId) === next) this.operations.delete(guildId); }).catch(() => {});
    return next;
  }
  private expectVoiceState(guildId: string, channelId: string | null): void {
    const pending = (this.expectedVoiceStates.get(guildId) ?? []).filter(item => item.expiresAt > this.now());
    // Gateway acknowledgements may arrive after leaveVoiceChannel resolves.
    // Match their destinations, retaining only a bounded, short-lived sequence.
    pending.push({ channelId, expiresAt: this.now() + 30_000 });
    this.expectedVoiceStates.set(guildId, pending.slice(-8));
    const previous = this.voiceTimers.get(guildId); if (previous) clearTimeout(previous);
    const timer = setTimeout(() => { this.expectedVoiceStates.delete(guildId); this.voiceTimers.delete(guildId); }, 30_000);
    timer.unref(); this.voiceTimers.set(guildId, timer);
  }
  private async leaveVoiceChannel(guildId: string): Promise<void> {
    const gateway = this.gateway(), connection = gateway.connections.get(guildId);
    if (connection?.channelId && connection.state !== Constants.State.DISCONNECTED) this.expectVoiceState(guildId, null);
    await gateway.leaveVoiceChannel(guildId);
  }
  /** Called only for this bot's gateway voice state; never infer an actor from the packet. */
  voiceStateChanged(guildId: string, previousChannelId: string | null, channelId: string | null): "unchanged" | "expected" | "external" {
    if (previousChannelId === channelId) return "unchanged";
    const pending = (this.expectedVoiceStates.get(guildId) ?? []).filter(item => item.expiresAt > this.now());
    const acknowledged = pending.findIndex(item => item.channelId === channelId);
    if (acknowledged !== -1) {
      pending.splice(0, acknowledged + 1);
      if (pending.length) this.expectedVoiceStates.set(guildId, pending);
      else {
        this.expectedVoiceStates.delete(guildId);
        const timer = this.voiceTimers.get(guildId); if (timer) clearTimeout(timer);
        this.voiceTimers.delete(guildId);
      }
      return "expected";
    }
    if (!pending.length) this.expectedVoiceStates.delete(guildId);
    // Stop a resolver or join from using a captured old channel while the
    // coordinator durably records this externally observed change.
    const start = this.pendingStarts.get(guildId);
    if (start && (channelId === null || start.phase !== "playing")) start.controller.abort();
    this.onVoiceChange(guildId, channelId ?? undefined);
    return "external";
  }
  async start(session: Session, attemptId: string, signal: AbortSignal, reconnect: boolean): Promise<void> {
    const pending: PendingStart = { controller: new AbortController(), phase: "resolving" };
    this.pendingStarts.set(session.guildId, pending);
    signal = AbortSignal.any([signal, pending.controller.signal]);
    try { await this.startPlayback(session, attemptId, signal, reconnect, pending); }
    finally { if (this.pendingStarts.get(session.guildId) === pending) this.pendingStarts.delete(session.guildId); }
  }
  private async startPlayback(session: Session, attemptId: string, signal: AbortSignal, reconnect: boolean, pending: PendingStart): Promise<void> {
    if (!session.current || !session.voiceChannelId) throw new Error("No selected track or voice channel.");
    const guild = this.client.guilds.cache.get(session.guildId);
    if (!guild) throw new Error("Voice: MusicMaid is not in this server.");
    const checkVoice = () => {
      const status = voiceReadiness(guild, session.voiceChannelId!);
      if (!status) throw new Error("Voice: MusicMaid cannot see this channel or verify its permissions. Use a channel where it has View Channel, Connect and Speak.");
      const reason = voiceBlockReason(status);
      if (reason) throw new Error(reason);
      return status;
    };
    checkVoice();
    // Resolution runs outside both the state lock and the voice-operation queue.
    const offset = session.current.recording.source === "spotify" ? Math.min(session.positionMs, Math.max(0, session.current.recording.durationMs - 1000)) : 0;
    const track = await resolveSelected((identifier, requestedSignal) => this.resolve(identifier, requestedSignal, offset, session.current!.recording), session.current.recording, signal);
    signal.throwIfAborted();
    const acceptedVersions = versionTerms(`${session.current.recording.title} ${session.current.request.spotify?.title ?? session.current.request.query}`);
    const unexpected = versionTerms(track.info.title).filter(term => term !== "remaster" && !acceptedVersions.includes(term));
    if (unexpected.length) throw new Error(`Version mismatch: this upload is a ${unexpected.join("/")} recording. Use Choose version to select it explicitly.`);
    await this.serial(session.guildId, async () => {
      signal.throwIfAborted();
      pending.phase = "connecting";
      const shoukaku = this.gateway();
      let player = shoukaku.players.get(session.guildId);
      const connection = shoukaku.connections.get(session.guildId);
      if (reconnect || (connection && connection.channelId !== session.voiceChannelId)) {
        if (player) this.unbind(player);
        if (player || connection) await this.leaveVoiceChannel(session.guildId);
        player = undefined;
      }
      signal.throwIfAborted();
      if (!player) {
        const status = checkVoice();
        incident("voice_join_requested", { guildId: session.guildId, attemptId, shardId: guild.shardId, ...status });
        try {
          this.expectVoiceState(session.guildId, session.voiceChannelId!);
          player = await shoukaku.joinVoiceChannel({ guildId: session.guildId, channelId: session.voiceChannelId!, shardId: guild.shardId, deaf: true });
        } catch (error) {
          const blocked = voiceReadiness(guild, session.voiceChannelId!);
          if (blocked && voiceBlockReason(blocked)) throw new Error(voiceBlockReason(blocked));
          throw error;
        }
      }
      signal.throwIfAborted();
      const positionOffsetMs = track.info.sourceName === "spotify" ? Number((track.pluginInfo as { spotifyOffsetMs?: number }).spotifyOffsetMs ?? 0) : 0;
      this.bind(player, { attemptId, source: track.info.sourceName, recording: recordingFor(track), positionOffsetMs });
      const position = track.info.sourceName === "spotify" ? 0 : track.info.isSeekable && !track.info.isStream ? Math.min(session.positionMs, Math.max(0, track.info.length - 1000)) : 0;
      pending.phase = "playing";
      await player.playTrack({ track: { encoded: track.encoded, userData: { attemptId, entryId: session.current!.id } }, position, volume: this.desiredVolume.get(session.guildId) ?? session.volume, paused: session.resumePaused ?? false });
      if (signal.aborted) { this.unbind(player); await player.stopTrack(); }
    });
  }
  private bind(player: Player, binding: Binding): void {
    const existed = this.bindings.has(player);
    this.bindings.set(player, binding);
    if (existed) return;
    // The library forwards the full Lavalink event, although some v4 typings omit userData/track.
    const identity = (event: unknown): string | undefined => {
      const track = (event as { track?: Track & { userData?: { attemptId?: unknown } } }).track;
      const id = track?.userData?.attemptId;
      return typeof id === "string" ? id : undefined;
    };
    player.on("start", event => {
      const current = this.bindings.get(player); const id = identity(event);
      if (!current || current.attemptId !== id) return;
      current.startedId = id;
      this.onEvent(player.guildId, { type: "start", attemptId: id, recording: current.recording });
    });
    player.on("end", event => {
      const id = identity(event); const current = this.bindings.get(player);
      if (id && current?.attemptId === id) this.onEvent(player.guildId, { type: "end", attemptId: id, reason: event.reason });
    });
    player.on("exception", event => {
      const id = identity(event); const current = this.bindings.get(player);
      if (id && current?.attemptId === id) this.onEvent(player.guildId, { type: "failure", attemptId: id, reason: `${event.exception.message} ${event.exception.cause}` });
    });
    player.on("stuck", event => {
      const id = identity(event); const current = this.bindings.get(player);
      if (id && current?.attemptId === id) this.onEvent(player.guildId, { type: "failure", attemptId: id, reason: "Track stuck: no audio frames" });
    });
    player.on("closed", event => {
      const current = this.bindings.get(player);
      if (!current) return;
      const terminal = [4014, 4021, 4022].includes(event.code);
      this.onEvent(player.guildId, { type: "failure", attemptId: current.attemptId,
        reason: terminal ? `Voice: Discord ended this connection (${event.code}). Use Resume when it is available again.` : `Voice connection closed (${event.code})`,
        scope: "environment", reconnect: !terminal });
    });
    player.on("update", event => {
      const current = this.bindings.get(player);
      if (!current?.startedId || current.startedId !== current.attemptId) return;
      if (current.seekBarrier && event.state.time < current.seekBarrier) return;
      if (event.state.connected && event.state.position > 0) markSourcePlayback(current.source, Date.now(), current.recording.uri);
      this.onEvent(player.guildId, { type: "update", attemptId: current.attemptId, positionMs: event.state.position + (current.positionOffsetMs ?? 0), connected: event.state.connected, time: event.state.time });
    });
  }
  private unbind(player: Player): void {
    this.bindings.delete(player);
    for (const event of ["start", "end", "exception", "stuck", "closed", "update"] as const) player.removeAllListeners(event);
  }
  stop(guildId: string, disconnect: boolean): Promise<void> {
    return this.serial(guildId, async () => {
      const shoukaku = this.gateway(); const player = shoukaku.players.get(guildId);
      if (player) { this.unbind(player); await player.stopTrack(); }
      if (disconnect && (player || shoukaku.connections.has(guildId))) await this.leaveVoiceChannel(guildId);
    });
  }
  pause(guildId: string, paused: boolean): Promise<void> {
    return this.serial(guildId, async () => { const player = this.gateway().players.get(guildId); if (player) await player.setPaused(paused); });
  }
  seek(guildId: string, positionMs: number): Promise<void> {
    return this.serial(guildId, async () => {
      const player = this.gateway().players.get(guildId);
      if (player) { const binding = this.bindings.get(player); if (binding) binding.seekBarrier = Date.now(); await player.seekTo(positionMs); }
    });
  }
  volume(guildId: string, volume: number): Promise<void> {
    this.desiredVolume.set(guildId, volume);
    return this.serial(guildId, async () => { const player = this.gateway().players.get(guildId); if (player) await player.setGlobalVolume(volume); });
  }
  restoreVolumeIntent(guildId: string, attemptedVolume: number, previousVolume: number): void {
    if (this.desiredVolume.get(guildId) === attemptedVolume) this.desiredVolume.set(guildId, previousVolume);
  }
}
