import { randomUUID } from "node:crypto";
import { LoadType, type Node } from "shoukaku";
import { safeError } from "./diagnostics.js";
import { markSourceFailure } from "./track-health.js";
import type { Loader } from "./sources.js";
const running = new WeakSet<Node>();

/** Exercise stream initialization without voice credentials or a real Discord guild. */
export async function probeStream(node: Node, source: "youtube" | "soundcloud" | "spotify", uri: string, observationMs = 6500, load: Loader = identifier => node.rest.resolve(identifier)): Promise<string> {
  if (running.has(node)) return "another stream probe is running; try again shortly";
  running.add(node);
  const attemptId = randomUUID();
  let started = false;
  let error: string | undefined;
  let created = false;
  const abort = new AbortController();
  const onRaw = (payload: unknown) => {
    const event = payload as { guildId?: string; type?: string; track?: { userData?: { attemptId?: string } }; exception?: { message?: string; cause?: string } };
    if (event.guildId !== "0" || event.track?.userData?.attemptId !== attemptId) return;
    if (event.type === "TrackStartEvent") started = true;
    if (event.type === "TrackExceptionEvent") error = safeError(`${event.exception?.message ?? "Stream failed"} ${event.exception?.cause ?? ""}`);
    if (event.type === "TrackStuckEvent") error = "Track stopped producing audio frames";
  };
  try {
    const result = await load(uri, abort.signal);
    if (result?.loadType !== LoadType.TRACK) return "track lookup unavailable; stream could not be tested";
    node.on("raw", onRaw);
    created = true;
    // Zero is not a Discord guild snowflake. No voice field is ever supplied.
    await node.rest.updatePlayer({ guildId: "0", playerOptions: { track: { encoded: result.data.encoded, userData: { attemptId } } } });
    await new Promise(resolve => setTimeout(resolve, observationMs));
    if (error) { markSourceFailure(source, uri, error); return `stream initialization failed: ${error}`; }
    return started ? "no early stream error observed; full playback remains unverified" : "no start event observed; playback unverified";
  } catch (failure) { return `probe failed: ${safeError(failure)}`; }
  finally {
    abort.abort();
    node.off("raw", onRaw);
    if (created) await node.rest.destroyPlayer("0").catch(() => {});
    running.delete(node);
  }
}
