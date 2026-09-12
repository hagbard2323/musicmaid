import type { ReleaseInfo } from "../runtime/release-info.js";
import type { Session } from "../audio/model.js";
import { failureScope } from "../audio/diagnostics.js";

export type DiagnosticAudio = { nodes: number; connectedNodes: number; players: number; connections: number; info?: unknown };
export async function diagnosticAudioSnapshot(counts: Omit<DiagnosticAudio, "info">, lookup?: (signal: AbortSignal) => Promise<unknown>, timeoutMs = 4000): Promise<DiagnosticAudio> {
  if (!lookup) return { ...counts };
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const info = await Promise.race([
      Promise.resolve().then(() => lookup(controller.signal)).catch(() => undefined),
      new Promise<undefined>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, timeoutMs); }),
    ]);
    return { ...counts, info };
  } finally { if (timer) clearTimeout(timer); }
}
export type DiagnosticInput = {
  release: ReleaseInfo;
  versions: { node: string; discordJs: string; shoukaku: string };
  session: Session;
  audio: DiagnosticAudio;
  health: { discordReady: boolean; voiceConnected: boolean; serverMuted: boolean; viewerReady: boolean };
  configuration: { youtubeAccount: boolean; spotifyMetadata: boolean; spotifyOriginalAudio: boolean; viewer: boolean };
  providers: unknown;
};
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
const flag = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
function known(value: unknown, choices: readonly string[]): string { return typeof value === "string" && choices.includes(value) ? value : "unknown"; }
function version(value: unknown): string {
  // Retain only the numeric version core, never a URL, custom build label or path.
  if (typeof value !== "string" || value.length > 80) return "unknown";
  const match = /^v?(\d{1,4}\.\d{1,4}\.\d{1,4})(?:[-+][A-Za-z0-9.-]{1,50})?$/.exec(value);
  return match?.[1] ?? "unknown";
}
function buildTime(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function category(reason: unknown): string {
  if (typeof reason !== "string") return "other";
  if (/^Version mismatch:/i.test(reason)) return "recording_version";
  if (/^Voice:|voice connection|voice closed|discord gateway/i.test(reason)) return "voice";
  if (/429|rate.limit|cooling down/i.test(reason)) return "rate_limit";
  if (/authorization|session expired|account login|sign.in|premium could not|not configured/i.test(reason)) return "account_access";
  if (/^Lavalink\b|audio service|connection refused|fetch failed/i.test(reason)) return "audio_service";
  if (/progress|stuck|timeout|timed out/i.test(reason)) return "no_progress";
  if (/incomplete|ended early|finished early/i.test(reason)) return "early_end";
  if (/unavailable|private|preview|paywall|restricted|not found/i.test(reason)) return "recording_unavailable";
  if (/^Control:/i.test(reason)) return "control";
  return "other";
}
function incidentSummary(value: unknown) {
  const incident = object(value);
  const reason = typeof incident.reason === "string" ? incident.reason : "";
  const explicit = known(incident.scope, ["recording", "environment", "control"]);
  return { scope: failureScope(reason, explicit === "unknown" ? undefined : explicit as "recording" | "environment" | "control"), category: category(reason) };
}

/** Construct a fresh whitelist. Never redact and then serialize a session or log. */
export function diagnosticDownload(input: DiagnosticInput, now = Date.now()) {
  const info = object(input.audio.info), infoVersion = object(info.version);
  const plugins = Array.isArray(info.plugins) ? info.plugins.slice(0, 64).map(object) : [];
  const youtube = plugins.find(plugin => plugin.name === "youtube-plugin" || plugin.name === "youtube");
  const history = Array.isArray(input.session.history) ? input.session.history : [];
  const retainedFailures = history.filter(item => item.outcome === "failed");
  const failureScopes = { recording: 0, environment: 0, control: 0 };
  for (const item of retainedFailures) failureScopes[incidentSummary(item).scope]++;
  const observedProviders = Array.isArray(input.providers) ? input.providers.slice(0, 16).map(object) : [];
  const providers = Object.fromEntries(["youtube", "soundcloud", "spotify"].map(source => {
    const provider = observedProviders.find(item => item.source === source);
    return [source, { observed: Boolean(provider), cooldownActive: provider ? typeof provider.cooldownUntil === "number" && provider.cooldownUntil > now : false,
      failuresObserved: provider && Array.isArray(provider.failures) ? count(provider.failures.length) : 0,
      lastIssue: provider?.lastError === undefined ? null : category(provider.lastError) }];
  }));
  return {
    schemaVersion: 1,
    release: { revision: typeof input.release.revision === "string" && /^[a-f0-9]{40}$/.test(input.release.revision) ? input.release.revision : "unknown", dirty: flag(input.release.dirty), builtAt: buildTime(input.release.builtAt) },
    versions: { node: version(input.versions.node), discordJs: version(input.versions.discordJs), shoukaku: version(input.versions.shoukaku),
      lavalink: version(infoVersion.semver), lavaplayer: version(info.lavaplayer), youtubePlugin: version(youtube?.version) },
    health: { discordReady: flag(input.health.discordReady), voiceConnected: flag(input.health.voiceConnected), serverMuted: flag(input.health.serverMuted), viewerReady: flag(input.health.viewerReady),
      audioConnected: input.audio.connectedNodes > 0, audioInfoAvailable: Object.keys(info).length > 0, providers },
    configuration: { youtubeAccount: flag(input.configuration.youtubeAccount), spotifyMetadata: flag(input.configuration.spotifyMetadata),
      spotifyOriginalAudio: flag(input.configuration.spotifyOriginalAudio), viewer: flag(input.configuration.viewer) },
    counts: { queued: count(input.session.queue.length), retainedHistory: count(history.length), retainedFailures: count(retainedFailures.length),
      audioNodes: count(input.audio.nodes), connectedAudioNodes: count(input.audio.connectedNodes), audioPlayers: count(input.audio.players), voiceConnections: count(input.audio.connections) },
    playback: { state: known(input.session.state, ["idle", "starting", "playing", "paused", "recovering", "awaiting_choice", "suspended"]), currentPresent: Boolean(input.session.current),
      queueMode: known(input.session.queueMode ?? "fifo", ["fifo", "fair"]), repeat: known(input.session.loop, ["off", "track", "queue"]) },
    incidents: { current: input.session.failure ? incidentSummary(input.session.failure) : null, retainedFailureScopes: failureScopes },
  };
}
