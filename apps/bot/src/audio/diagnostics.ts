import { randomUUID } from "node:crypto";
import type { FailureScope } from "./model.js";

/** Small compatibility boundary for existing adapters and saved failure messages. */
export function failureScope(reason: string, scope?: FailureScope): FailureScope {
  if (scope) return scope;
  if (/^Control:/i.test(reason)) return "control";
  if (/^(?:Voice:|Voice (?:connection|closed)|Discord gateway|The audio service is disconnected|Lavalink\b|No selected track or voice channel\.|Can't find any nodes to connect on|Playback made no progress$)/i.test(reason)) return "environment";
  if (/^(?:The voice connection is not established (?:due to missing session id|due to missing connection endpoint|in \d+ seconds)|No available nodes to move to)$/.test(reason)) return "environment";
  // These are controlled account/configuration messages, not arbitrary provider
  // text containing "private", "account" or "unavailable" about one recording.
  if (/^YouTube (?:session expired or was refused\.|account session is not configured on this server\.|session file must be private \(mode 0600\)\.|decoder cache must be a private directory\.|is rate-limiting this connection\.|searches are busy\.)/.test(reason)) return "environment";
  if (/^Spotify: (?:the original-audio account is not connected\.|direct-audio authorization expired or was refused\.|invalid account token response\.|account changed during authorization\.|account login was refused$|Premium could not be confirmed for this account$|original audio is disabled\.|audio preparation is busy\.|active audio buffers are full\.|the original-audio helper could not start\.|private audio transport (?:could not start|has no address)\.)/.test(reason)) return "environment";
  if (/^(?:Spotify (?:is not configured yet\.|access was refused\.|is unavailable \(HTTP \d+\)\.|token response was missing access_token\/expires_in\.)|(?:spotify|youtube|soundcloud) is (?:rate-limiting requests|cooling down)\.)/.test(reason)) return "environment";
  return "recording";
}
export function isRecordingFailure(reason: string, scope?: FailureScope): boolean {
  return failureScope(reason, scope) === "recording" && !/^Version mismatch:/i.test(reason);
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\n\s*at [^\n]+/g, "")
    .replace(/http:\/\/127\.0\.0\.1:\d+\/spotify\/[a-f0-9]+\.ogg/g, "[private Spotify stream]")
    .replace(/https?:\/\/[^\s]+/g, (value) => {
      try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return "[URL]"; }
    })
    .replace(/(authorization|password|refresh.?token|access.?token|visitor.?data|client.?secret|cookie|po.?token)\s*[=:]\s*[^,\s]+/gi, "$1=[redacted]")
    .slice(0, 500);
}
export function incident(event: string, fields: Record<string, unknown> = {}): string {
  const id = randomUUID().slice(0, 8);
  console.info(JSON.stringify({ at: new Date().toISOString(), incidentId: id, event, ...fields }));
  return id;
}
export function failureMessage(reason: string): string {
  if (reason.startsWith("Spotify:")) return reason;
  if (reason.startsWith("Voice:") || reason.startsWith("Version mismatch:")) return reason;
  if (/voice connection is not established/i.test(reason)) return "Discord did not complete the voice join. A mod can run Diagnose to check this channel’s permissions and user limit, then use Repair.";
  if (/youtube session|youtube account session/i.test(reason)) return "YouTube needs its dedicated account session refreshed by a server operator. Restarting the bot will not renew it.";
  if (failureScope(reason) !== "recording") return `${safeError(reason)}. The request and queue are preserved; use Resume or ask a mod to Repair.`;
  if (/preview|paywall|restricted|unavailable|private|not available|not found/i.test(reason)) return "This upload is unavailable or only provides a preview. Choose another upload or skip it.";
  if (/403|401|sign.in|bot|all clients/i.test(reason)) return "The source is refusing access. A mod can check source health; you can choose another upload.";
  if (/429|rate.limit/i.test(reason)) return "The source is rate-limiting requests. Try again later or choose another source.";
  if (/404/i.test(reason)) return "The source returned a missing audio stream. Choose another upload or retry later.";
  if (/early|incomplete/i.test(reason)) return "This upload ended before the full song finished. It may be a preview or a broken stream.";
  if (/voice|connect/i.test(reason)) return "The voice connection could not recover. A mod can use Repair.";
  return "Playback could not recover. Retry this upload, choose an alternative, or skip it.";
}
