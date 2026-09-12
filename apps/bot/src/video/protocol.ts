export type ViewerTrack = {
  entryId: string; videoId: string; title: string; artist: string;
  durationMs: number; positionMs: number; observedAt: number;
  state: "playing" | "paused" | "waiting";
};
export type ViewerSnapshot = {
  serverTime: number; voiceChannelId: string; runId: string; track: ViewerTrack | null; waitingForYoutube?: boolean;
};
export function videoPosition(track: ViewerTrack, now: number): number {
  const elapsed = track.state === "playing" ? Math.max(0, Math.min(now - track.observedAt, 15000)) : 0;
  return Math.max(0, Math.min(track.durationMs, track.positionMs + elapsed));
}
