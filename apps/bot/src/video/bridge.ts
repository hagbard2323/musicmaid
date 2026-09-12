import { createServer, type Server } from "node:http";
import { chmod, lstat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Client } from "discord.js";
import type { MusicCoordinator } from "../audio/coordinator.js";
import { youtubeVideoId, type YoutubeVideo } from "../audio/youtube.js";
import type { ViewerSnapshot } from "./protocol.js";

export type ViewerScope = { guildId: string; userId: string; voiceChannelId?: string };
export type ViewerReader = (scope: ViewerScope) => ViewerSnapshot;
export class ViewerUnavailable extends Error {}
export function viewerReader(client: Client, music: MusicCoordinator): ViewerReader {
  const runId = randomUUID();
  return scope => {
    if (!client.isReady()) throw new ViewerUnavailable("MusicMaid is reconnecting.");
    const session = music.snapshot(scope.guildId);
    const guild = client.guilds.cache.get(scope.guildId);
    const member = guild?.members.cache.get(scope.userId);
    const memberChannel = guild?.voiceStates?.cache.get(scope.userId)?.channelId ?? member?.voice.channelId;
    const voiceChannelId = session.voiceChannelId ?? (!session.current ? scope.voiceChannelId : undefined);
    if (!voiceChannelId || memberChannel !== voiceChannelId || (scope.voiceChannelId && scope.voiceChannelId !== voiceChannelId)) throw new Error("Join MusicMaid’s voice channel to watch.");
    const current = session.current;
    const videoId = current?.recording.source === "youtube" ? youtubeVideoId(current.recording.uri) : undefined;
    const track = current && videoId ? {
      entryId: current.id, videoId, title: current.recording.title.slice(0, 300), artist: current.recording.author.slice(0, 200),
      durationMs: current.recording.durationMs, positionMs: session.positionMs,
      observedAt: session.positionUpdatedAt ?? session.lastVerifiedAt ?? Date.now(),
      state: session.state === "playing" ? "playing" as const : session.state === "paused" ? "paused" as const : "waiting" as const
    } : null;
    const waitingForYoutube = !track && session.queue.some(e => e.recording.source === "youtube" && Boolean(youtubeVideoId(e.recording.uri)));
    return { serverTime: Date.now(), voiceChannelId, runId, track, waitingForYoutube };
  };
}
/** Private, read-only IPC: the public viewer cannot change queues or voice playback. */
export class ViewerBridge {
  private server?: Server;
  private controllers = new Set<AbortController>();
  ready = false;
  constructor(private path: string, private read: ViewerReader, private video: (id: string, signal: AbortSignal, refresh?: boolean) => Promise<YoutubeVideo>) {}
  async start(): Promise<void> {
    const existing = await lstat(this.path).catch(() => undefined);
    if (existing) { if (!existing.isSocket()) throw new Error("Viewer IPC path is not a socket."); await unlink(this.path); }
    this.server = createServer(async (req, res) => {
      const json = (status: number, value: unknown) => { if (!res.destroyed) res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value)); };
      if (req.method !== "POST" || !["/state", "/video"].includes(req.url ?? "")) { json(404, {}); return; }
      const controller = new AbortController(); this.controllers.add(controller);
      res.on("close", () => { if (!res.writableEnded) controller.abort(); });
      try {
        let body = "";
        for await (const chunk of req) { body += chunk.toString(); if (body.length > 2048) throw new Error("Invalid viewer request."); }
        const input = JSON.parse(body) as ViewerScope & { entryId?: string; refresh?: boolean };
        if (![input.guildId, input.userId].every(id => /^\d{5,22}$/.test(id ?? "")) || (input.voiceChannelId && !/^\d{5,22}$/.test(input.voiceChannelId))) throw new Error("Invalid viewer request.");
        const snapshot = this.read(input);
        if (req.url === "/state") json(200, snapshot);
        else {
          if (!snapshot.track || snapshot.track.entryId !== input.entryId) throw new Error("The YouTube track changed.");
          const video = await this.video(snapshot.track.videoId, controller.signal, input.refresh === true);
          if (this.read(input).track?.entryId !== input.entryId) throw new Error("The YouTube track changed.");
          json(200, video);
        }
      } catch (error) { json(error instanceof ViewerUnavailable ? 503 : 403, { error: "Viewer unavailable or access expired. Reopen Watch video from the current player." }); }
      finally { this.controllers.delete(controller); }
    });
    this.server.requestTimeout = 35000; this.server.headersTimeout = 5000;
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.path, resolve); });
    await chmod(this.path, 0o660); this.ready = true;
  }
  close(): void { this.ready = false; for (const controller of this.controllers) controller.abort(); this.server?.closeAllConnections(); this.server?.close(); }
}
