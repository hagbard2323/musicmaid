import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { bridgeClient, BridgeError } from "./bridge-client.js";
import type { ViewerSnapshot } from "../../bot/src/video/protocol.js";
import type { ViewerScope } from "../../bot/src/video/bridge.js";
import { validateYoutubeMediaUrl, type YoutubeVideo } from "../../bot/src/audio/youtube.js";

type Session = { scope: ViewerScope; until: number; ended: boolean; lastEntryId: string; runId: string; cached?: ViewerSnapshot; readAt?: number; reading?: Promise<ViewerSnapshot>; prepareAt?: number; prepareEntry?: string };
type Ticket = { session: Session; entryId: string; video: YoutubeVideo; until: number };
type Bridge = ReturnType<typeof bridgeClient>;
export type ViewerOptions = { clientId: string; clientSecret: string; socketPath: string; assetsDir: string; publicOrigin: string; bridge?: Bridge; fetcher?: typeof fetch; now?: () => number };
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "Use JSON.");
  let input = "";
  for await (const chunk of req) { input += chunk.toString(); if (input.length > 4096) throw new HttpError(413, "Request too large."); }
  try { const value = JSON.parse(input); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new HttpError(400, "Invalid request."); }
}
function text(value: unknown, pattern: RegExp): string { if (typeof value !== "string" || !pattern.test(value)) throw new HttpError(400, "Invalid request."); return value; }
const snowflake = /^\d{5,22}$/;
const uuid = /^[a-f0-9-]{36}$/;
/** The only public capabilities are OAuth, reading playback, and video for that playback. */
export function createViewerServer(options: ViewerOptions) {
  const bridge = options.bridge ?? bridgeClient(options.socketPath), fetcher = options.fetcher ?? fetch, now = options.now ?? Date.now;
  const sessions = new Map<string, Session>(), tickets = new Map<string, Ticket>(), usedCodes = new Map<string, number>();
  const streams = new Map<Session, number>();
  let authRunning = 0, authWindow = 0, authCount = 0, streamCount = 0;
  const allowedOrigins = new Set([options.publicOrigin, `https://${options.clientId}.discordsays.com`]);
  const prune = () => {
    for (const [key, session] of sessions) if (session.until <= now() || session.ended) sessions.delete(key);
    for (const [key, ticket] of tickets) if (ticket.until <= now() || ticket.session.ended || ticket.session.until <= now()) tickets.delete(key);
    for (const [key, until] of usedCodes) if (until <= now()) usedCodes.delete(key);
  };
  const state = async (session: Session, signal?: AbortSignal): Promise<ViewerSnapshot> => {
    if (session.ended || session.until <= now()) throw new HttpError(410, "This viewing session ended. Reopen Watch video.");
    if (session.reading) return session.reading;
    if (session.cached && now() - (session.readAt ?? 0) < 500) return session.cached;
    session.reading = bridge<ViewerSnapshot>("/state", session.scope, signal);
    let snapshot: ViewerSnapshot;
    try { snapshot = await session.reading; } finally { session.reading = undefined; }
    if (session.ended) throw new HttpError(410, "This viewing session ended.");
    session.cached = snapshot; session.readAt = now();
    if (!snapshot.track && !snapshot.waitingForYoutube) session.ended = true;
    // Keep the viewer while a later YouTube entry remains, without changing intervening audio.
    if (snapshot.track) session.lastEntryId = snapshot.track.entryId;
    return snapshot;
  };
  const fromAuth = (req: IncomingMessage) => {
    const value = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "")?.[1];
    const session = value ? sessions.get(value) : undefined;
    if (!session) throw new HttpError(401, "Reopen Watch video to connect.");
    return session;
  };
  const json = (res: ServerResponse, status: number, value: unknown) => {
    if (!res.destroyed) res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    prune();
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self' https://discord.com https://*.discord.com https://${options.clientId}.discordsays.com`);
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    try {
      if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) throw new HttpError(403, "Unsupported origin.");
      const url = new URL(req.url ?? "/", "http://viewer.local");
      const path = url.pathname.replace(/^\/\.proxy(?=\/)/, "");
      if (path === "/health" && req.method === "GET") { json(res, 200, { ready: true }); return; }
      if (path === "/config" && req.method === "GET") { json(res, 200, { clientId: options.clientId }); return; }
      if (path === "/api/auth" && req.method === "POST") {
        if (now() - authWindow > 60000) { authWindow = now(); authCount = 0; }
        if (authRunning >= 4 || authCount >= 40 || sessions.size >= 128) throw new HttpError(429, "Viewer sign-in is busy. Try again shortly.");
        // Reserve admission before reading a body: partial requests must not all
        // pass the limit and later start concurrent Discord token exchanges.
        authRunning++; authCount++;
        try {
          const input = await body(req);
          const code = text(input.code, /^[A-Za-z0-9._-]{8,512}$/), guildId = text(input.guildId, snowflake);
          const codeHash = createHash("sha256").update(code).digest("hex");
          if (usedCodes.has(codeHash)) throw new HttpError(409, "This sign-in was already used. Reopen Watch video.");
          usedCodes.set(codeHash, now() + 600000);
          const tokenResponse = await fetcher("https://discord.com/api/v10/oauth2/token", { method: "POST", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
            headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, grant_type: "authorization_code", code }) });
          if (!tokenResponse.ok) throw new HttpError(401, "Discord sign-in expired. Reopen Watch video.");
          const token = await tokenResponse.json() as { access_token?: string; expires_in?: number; scope?: string };
          if (typeof token.access_token !== "string" || !token.access_token || typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0 || !token.scope?.split(" ").includes("identify")) throw new HttpError(401, "Discord sign-in could not be verified.");
          const userResponse = await fetcher("https://discord.com/api/v10/users/@me", { redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]), headers: { Authorization: "Bearer " + token.access_token } });
          if (!userResponse.ok) throw new HttpError(401, "Discord sign-in could not be verified.");
          const user = await userResponse.json() as { id?: string };
          const userId = text(user.id, snowflake);
          const snapshot = await bridge<ViewerSnapshot>("/state", { guildId, userId }, controller.signal);
          if (!snapshot.track) throw new HttpError(409, "Watch video is available while MusicMaid plays YouTube.");
          if (sessions.size >= 128) throw new HttpError(429, "The viewer is busy. Try again shortly.");
          const session: Session = { scope: { guildId, userId, voiceChannelId: snapshot.voiceChannelId }, until: now() + Math.min(token.expires_in, 7200) * 1000, ended: false, lastEntryId: snapshot.track.entryId, runId: snapshot.runId };
          const previous = [...sessions.values()].filter(s => s.scope.userId === userId && s.scope.guildId === guildId);
          if (previous.length >= 3) previous[0].ended = true;
          const bearer = randomBytes(32).toString("hex"); sessions.set(bearer, session);
          json(res, 200, { token: bearer, accessToken: token.access_token, snapshot });
        } finally { authRunning--; }
        return;
      }
      if (path === "/api/state" && req.method === "GET") { json(res, 200, { ...await state(fromAuth(req), controller.signal), serverTime: now() }); return; }
      if (path === "/api/end" && req.method === "POST") { fromAuth(req).ended = true; json(res, 200, { ended: true }); return; }
      if (path === "/api/video" && req.method === "POST") {
        const session = fromAuth(req), input = await body(req), entryId = text(input.entryId, uuid);
        const snapshot = await state(session, controller.signal);
        if (snapshot.track?.entryId !== entryId || snapshot.track.state === "waiting") throw new HttpError(409, "Waiting for the current YouTube track.");
        const cached = input.refresh === true ? undefined : [...tickets].find(([, t]) => t.session === session && t.entryId === entryId && t.until > now() + 30000);
        if (cached) { json(res, 200, { path: "/media/" + cached[0], height: cached[1].video.height }); return; }
        if (session.prepareEntry === entryId && now() - (session.prepareAt ?? 0) < 3000) throw new HttpError(429, "Wait a few seconds before retrying this video.");
        session.prepareAt = now(); session.prepareEntry = entryId;
        const video = await bridge<YoutubeVideo>("/video", { ...session.scope, entryId, refresh: input.refresh === true }, controller.signal);
        validateYoutubeMediaUrl(video.url, now());
        if (video.id !== snapshot.track.videoId || Math.abs(video.durationMs - snapshot.track.durationMs) > Math.max(5000, snapshot.track.durationMs * 0.02) || video.height > 720 || !video.codec.startsWith("avc1")) throw new HttpError(502, "This video could not be verified.");
        if ((await state(session, controller.signal)).track?.entryId !== entryId) throw new HttpError(409, "The YouTube track changed.");
        for (const [key, t] of tickets) if (t.session === session) tickets.delete(key);
        if (tickets.size >= 128) throw new HttpError(429, "The viewer is busy. Try again shortly.");
        const key = randomBytes(32).toString("hex"); tickets.set(key, { session, entryId, video, until: Math.min(now() + 300000, video.expiresAt - 60000, session.until) });
        json(res, 200, { path: "/media/" + key, height: video.height }); return;
      }
      const media = /^\/media\/([a-f0-9]{64})$/.exec(path);
      if (media && ["GET", "HEAD"].includes(req.method ?? "")) {
        const ticket = tickets.get(media[1]);
        if (!ticket || ticket.until <= now()) throw new HttpError(410, "Video link expired. Resync the viewer.");
        const snapshot = await state(ticket.session, controller.signal);
        if (snapshot.track?.entryId !== ticket.entryId) throw new HttpError(410, "The YouTube track changed.");
        if ((streams.get(ticket.session) ?? 0) >= 3 || streamCount >= 24) throw new HttpError(429, "Too many video connections.");
        const range = req.headers.range;
        if (range && !/^bytes=\d{0,12}-\d{0,12}$/.test(range)) throw new HttpError(416, "Invalid video range.");
        streams.set(ticket.session, (streams.get(ticket.session) ?? 0) + 1);
        streamCount++;
        const timeout = setTimeout(() => controller.abort(), 120000); timeout.unref();
        let checking = false;
        const monitor = setInterval(() => {
          if (checking) return; checking = true;
          void state(ticket.session, controller.signal).then(s => { if (s.track?.entryId !== ticket.entryId) controller.abort(); }).catch(() => controller.abort()).finally(() => { checking = false; });
        }, 5000); monitor.unref();
        try {
          let upstream: Response | undefined, target = ticket.video.url;
          for (let redirects = 0; redirects <= 2; redirects++) {
            validateYoutubeMediaUrl(target, now());
            upstream = await fetcher(target, { method: req.method, redirect: "manual", signal: controller.signal, headers: range ? { Range: range } : {} });
            if (upstream.status < 300 || upstream.status >= 400) break;
            const location = upstream.headers.get("location"); await upstream.body?.cancel();
            if (!location) throw new HttpError(502, "Video source unavailable.");
            target = new URL(location, target).href;
          }
          if (!upstream || ![200, 206].includes(upstream.status) || !upstream.headers.get("content-type")?.startsWith("video/mp4")) { await upstream?.body?.cancel(); throw new HttpError(502, "Video source unavailable. Music continues normally."); }
          const length = Number(upstream.headers.get("content-length"));
          if (!Number.isSafeInteger(length) || length <= 0 || length > 512 * 1024 * 1024) { await upstream.body?.cancel(); throw new HttpError(502, "Video size is unsupported."); }
          const headers: Record<string, string> = { "Content-Type": "video/mp4", "Content-Length": String(length), "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
          const contentRange = upstream.headers.get("content-range");
          if (upstream.status === 206) { if (!contentRange || !/^bytes \d+-\d+\/\d+$/.test(contentRange)) { await upstream.body?.cancel(); throw new HttpError(502, "Invalid video range response."); } headers["Content-Range"] = contentRange; }
          res.writeHead(upstream.status, headers);
          if (req.method === "HEAD" || !upstream.body) { await upstream.body?.cancel(); res.end(); }
          else await pipeline(Readable.fromWeb(upstream.body as never), res, { signal: controller.signal });
        } finally { streamCount--; clearTimeout(timeout); clearInterval(monitor); const count = (streams.get(ticket.session) ?? 1) - 1; if (count) streams.set(ticket.session, count); else streams.delete(ticket.session); }
        return;
      }
      const assets: Record<string, [string, string]> = { "/": ["index.html", "text/html; charset=utf-8"], "/index.html": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "text/javascript; charset=utf-8"], "/app.css": ["app.css", "text/css; charset=utf-8"] };
      const asset = assets[path];
      if (!asset || !["GET", "HEAD"].includes(req.method ?? "")) throw new HttpError(404, "Not found.");
      const bytes = await readFile(join(options.assetsDir, asset[0]));
      res.writeHead(200, { "Content-Type": asset[1], "Content-Length": bytes.length, "Cache-Control": "no-cache" }); res.end(req.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError || error instanceof BridgeError ? error.status : 503;
      const message = error instanceof HttpError || error instanceof BridgeError ? error.message : "The optional viewer is unavailable. Music playback continues normally.";
      json(res, status, { error: message });
    }
  });
  server.requestTimeout = 35000; server.headersTimeout = 10000; server.keepAliveTimeout = 2000; server.maxHeadersCount = 40;
  return server;
}
