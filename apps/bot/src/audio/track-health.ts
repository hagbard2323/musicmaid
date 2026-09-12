type ProviderState = { failures: Array<{ uri: string; at: number }>; cooldownUntil: number; lastError?: string; lastPlaybackAt?: number };
const providers = new Map<string, ProviderState>();
const tracks = new Map<string, { reason: string; until: number }>();
export function markSourceFailure(source: string, uri: string, reason: string, now = Date.now()): void {
  for (const [id, failure] of tracks) if (failure.until <= now) tracks.delete(id);
  if (tracks.size >= 2000) tracks.delete(tracks.keys().next().value!);
  tracks.set(uri, { reason, until: now + 30 * 60_000 });
  const state = providers.get(source) ?? { failures: [], cooldownUntil: 0 };
  state.lastError = reason;
  // A single missing/restricted recording is not a whole-provider outage.
  if (/429|all clients|sign.in|source.*timeout|source.*unreachable/i.test(reason) || (source === "spotify" && /authorization|account login|premium could not|audio-key/i.test(reason))) {
    state.failures = [...state.failures.filter(f => now - f.at < 120_000), { uri, at: now }];
    if (state.failures.length >= 3 && new Set(state.failures.map(f => f.uri)).size >= 2) state.cooldownUntil = now + 300_000;
  }
  providers.set(source, state);
}
export function markSourcePlayback(source: string, now = Date.now(), uri?: string): void {
  if (uri) tracks.delete(uri);
  const state = providers.get(source) ?? { failures: [], cooldownUntil: 0 };
  state.lastPlaybackAt = now; state.failures = []; state.cooldownUntil = 0;
  providers.set(source, state);
}
export function trackFailure(uri: string, now = Date.now()): string | undefined {
  const failure = tracks.get(uri);
  if (failure && failure.until <= now) tracks.delete(uri);
  return failure && failure.until > now ? failure.reason : undefined;
}
export function sourceAvailable(source: string, now = Date.now()): boolean { return !sourceRetryAt(source, now) && (providers.get(source)?.cooldownUntil ?? 0) <= now; }
export function sourceHealth(): Array<{ source: string } & ProviderState> {
  return ["youtube", "soundcloud", ...(providers.has("spotify") || sourceRetryAt("spotify") ? ["spotify"] : [])].map(source => {
    const state = structuredClone(providers.get(source) ?? { failures: [], cooldownUntil: 0 });
    return { source, ...state, cooldownUntil: Math.max(state.cooldownUntil, sourceRetryAt(source)) };
  });
}
import { sourceRetryAt } from "./source-errors.js";
