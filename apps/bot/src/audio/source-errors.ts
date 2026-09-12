export type SourceErrorKind = "rate_limit" | "authorization" | "unavailable" | "timeout";
export class SourceError extends Error {
  constructor(readonly source: string, readonly kind: SourceErrorKind, message: string, readonly retryAt?: number) { super(message); }
}
const cooldowns = new Map<string, number>();
export function sourceRetryAt(source: string, now = Date.now()): number {
  const until = cooldowns.get(source) ?? 0;
  if (until <= now) { cooldowns.delete(source); return 0; }
  return until;
}
export function rateLimited(source: string, header: string | null, now = Date.now()): SourceError {
  const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : NaN;
  const parsed = Number.isFinite(seconds) ? now + seconds * 1000 : header ? Date.parse(header) : NaN;
  const until = Math.max(sourceRetryAt(source, now), now + Math.min(86400000, Math.max(1000, Number.isFinite(parsed) ? parsed - now : 60000)));
  cooldowns.set(source, until);
  return new SourceError(source, "rate_limit", `${source} is rate-limiting requests. Try again in ${Math.ceil((until - now) / 1000)} seconds.`, until);
}
export function assertSourceReady(source: string): void {
  const until = sourceRetryAt(source);
  if (until) throw new SourceError(source, "rate_limit", `${source} is cooling down. Try again in ${Math.ceil((until - Date.now()) / 1000)} seconds.`, until);
}
/** Bound waits even for an adapter whose underlying client cannot abort a request. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new SourceError("Search", "timeout", "Search timed out or was cancelled. Try a more specific request."));
    if (signal.aborted) { work.catch(() => {}); aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
