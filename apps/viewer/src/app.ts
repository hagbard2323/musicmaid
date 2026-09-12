import { DiscordSDK, RPCCloseCodes } from "@discord/embedded-app-sdk";
import { videoPosition, type ViewerSnapshot } from "../../bot/src/video/protocol.js";
import "./app.css";
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = element<HTMLVideoElement>("video"), overlay = element("overlay"), start = element<HTMLButtonElement>("start");
const prefix = location.hostname.endsWith(".discordsays.com") ? "/.proxy" : "";
let sdk: DiscordSDK | undefined, bearer = "", snapshot: ViewerSnapshot | undefined, clockOffset = 0;
let activeEntry = "", loadingEntry = "", failedEntry = "", closed = false, polling = false, lastGood = Date.now(), mediaLoadedAt = 0;
let mediaAbort: AbortController | undefined;
let delay = 0;
try { delay = Math.max(-1500, Math.min(1500, Number(localStorage.getItem("musicmaid-video-delay")) || 0)); } catch { /* Storage is optional in an embedded browser. */ }
const delayInput = element<HTMLInputElement>("delay"); delayInput.value = String(delay);
const show = (title: string, detail: string, canStart = false) => { element("status-title").textContent = title; element("status-detail").textContent = detail; overlay.hidden = false; start.hidden = !canStart; };
class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function api<T>(path: string, input?: unknown, signal?: AbortSignal): Promise<T> {
  const sent = Date.now();
  const response = await fetch(prefix + path, { method: input === undefined ? "GET" : "POST", signal: AbortSignal.any([AbortSignal.timeout(path === "/api/video" ? 35000 : 15000), ...(signal ? [signal] : [])]),
    headers: { ...(input === undefined ? {} : { "Content-Type": "application/json" }), ...(bearer ? { Authorization: "Bearer " + bearer } : {}) }, body: input === undefined ? undefined : JSON.stringify(input) });
  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, typeof data.error === "string" ? data.error : "The viewer could not connect.");
  if (typeof data.serverTime === "number") clockOffset = data.serverTime + (Date.now() - sent) / 2 - Date.now();
  return data as T;
}
function stopVideo() { mediaAbort?.abort(); mediaAbort = undefined; loadingEntry = ""; activeEntry = ""; video.pause(); video.removeAttribute("src"); video.load(); }
function end(title = "That’s the end of this video session.") {
  if (closed) return; closed = true; stopVideo();
  if (bearer) void api("/api/end", {}).catch(() => {});
  show(title, "MusicMaid keeps playing in voice. Open Watch video again for a later YouTube track.");
  element("state-label").textContent = "Finished";
  setTimeout(() => sdk?.close(RPCCloseCodes.CLOSE_NORMAL, "Video session ended"), 1400);
}
const time = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; };
async function sync(force = false) {
  const track = snapshot?.track;
  if (!track || activeEntry !== track.entryId || !video.src || video.readyState < 1 || video.error) return;
  video.muted = true;
  const requested = Math.max(0, Math.min(track.durationMs - 100, videoPosition(track, Date.now() + clockOffset) + delay)) / 1000;
  const target = Math.max(0, Math.min(video.duration - 0.05, requested));
  if (force || Math.abs(video.currentTime - target) > 0.6) { try { video.currentTime = target; } catch { return; } }
  if (track.state === "playing") {
    if (requested >= video.duration - 0.05) { video.pause(); overlay.hidden = true; return; }
    try { await video.play(); if (!closed && snapshot?.track?.entryId === activeEntry) { overlay.hidden = true; start.hidden = true; } }
    catch { show("Ready when you are.", "Tap to start the video. You’ll keep hearing MusicMaid in voice.", true); }
  } else {
    video.pause();
    // A loaded paused frame is ready too; clear loading/reconnection text even
    // though play() will not run until MusicMaid resumes the voice audio.
    if (track.state === "paused") { overlay.hidden = true; start.hidden = true; }
  }
}
async function prepare(state: ViewerSnapshot, refresh = false) {
  const track = state.track;
  if (!track || track.state === "waiting" || closed || loadingEntry === track.entryId) return;
  stopVideo(); loadingEntry = track.entryId; failedEntry = "";
  const abort = new AbortController(); mediaAbort = abort;
  show("Bringing the video into view…", "Your music keeps playing while the video catches up.");
  try {
    const media = await api<{ path: string; height: number }>("/api/video", { entryId: track.entryId, refresh }, abort.signal);
    if (closed || abort.signal.aborted || snapshot?.track?.entryId !== track.entryId) return;
    if (!/^\/media\/[a-f0-9]{64}$/.test(media.path)) throw new Error("Invalid video response.");
    activeEntry = track.entryId; mediaLoadedAt = Date.now();
    element("quality").textContent = `${media.height}p`;
    video.muted = true; video.src = prefix + media.path; video.load();
    element<HTMLButtonElement>("resync").disabled = false; element<HTMLButtonElement>("fullscreen").disabled = false;
  } catch (error) {
    if (abort.signal.aborted || closed) return;
    failedEntry = track.entryId;
    show("Video isn’t available right now.", "The music is unaffected. You can retry the video or keep listening.", true);
    start.textContent = "Retry video";
  } finally { if (mediaAbort === abort) loadingEntry = ""; }
}
function update(next: ViewerSnapshot) {
  snapshot = next;
  const track = next.track;
  if (!track) {
    if (!next.waitingForYoutube) { end(); return; }
    stopVideo(); show("Waiting for the next YouTube video.", "Music keeps playing in voice. The video will resume when the next YouTube track starts.");
    element("title").textContent = "Music continues in voice"; element("artist").textContent = "Another YouTube track is waiting in the queue.";
    element("state-label").textContent = "Waiting for YouTube"; element("quality").textContent = ""; element("time").textContent = "— / —";
    element("progress").style.width = "0%"; element("dot").classList.remove("playing");
    for (const id of ["source", "resync", "fullscreen"]) element<HTMLButtonElement>(id).disabled = true;
    return;
  }
  element("title").textContent = track.title;
  element("artist").textContent = track.artist;
  element("state-label").textContent = track.state === "playing" ? "Following MusicMaid" : track.state === "paused" ? "Paused" : "Waiting for playback";
  element("dot").classList.toggle("playing", track.state === "playing");
  element<HTMLButtonElement>("source").disabled = false;
  if (activeEntry !== track.entryId && loadingEntry !== track.entryId && failedEntry !== track.entryId) {
    if (track.state === "waiting") { stopVideo(); show("The next video is on its way.", "This window stays open while YouTube tracks remain in the queue."); }
    else void prepare(next);
  } else void sync();
  element("time").textContent = `${time(videoPosition(track, Date.now() + clockOffset))} / ${time(track.durationMs)}`;
  element("progress").style.width = `${Math.min(100, videoPosition(track, Date.now() + clockOffset) / Math.max(1, track.durationMs) * 100)}%`;
}
async function poll() {
  if (closed || polling || !bearer) return; polling = true;
  try { const next = await api<ViewerSnapshot>("/api/state"); lastGood = Date.now(); update(next); }
  catch (error) {
    video.pause();
    if (error instanceof ApiError && [401, 403, 410].includes(error.status)) end(error.message);
    else { show("Reconnecting the viewer…", "Voice playback is independent. The video will catch up shortly."); if (Date.now() - lastGood > 20000) end("The viewer lost its connection."); }
  } finally { polling = false; }
}
async function bootstrap() {
  try {
    const config = await api<{ clientId: string }>("/config");
    if (!new URLSearchParams(location.search).has("frame_id")) { show("Open this inside Discord.", "Press Watch video on MusicMaid’s current YouTube track."); return; }
    sdk = new DiscordSDK(config.clientId, { disableConsoleLogOverride: true }); await sdk.ready();
    if (!sdk.guildId) { show("Open MusicMaid in your server.", "The viewer follows the music in your server’s voice channel."); return; }
    const { code } = await sdk.commands.authorize({ client_id: config.clientId, response_type: "code", state: crypto.randomUUID(), prompt: "none", scope: ["identify"] });
    const result = await api<{ token: string; accessToken: string; snapshot: ViewerSnapshot }>("/api/auth", { code, guildId: sdk.guildId });
    bearer = result.token;
    await sdk.commands.authenticate({ access_token: result.accessToken });
    result.accessToken = "";
    clockOffset = result.snapshot.serverTime - Date.now(); lastGood = Date.now(); update(result.snapshot);
    setInterval(() => void poll(), 1000);
  } catch (error) { show("Couldn’t open the viewer.", error instanceof ApiError ? error.message : "Close this window and try Watch video again. Your music is unaffected."); }
}
video.addEventListener("loadedmetadata", () => {
  const track = snapshot?.track;
  if (track && (!Number.isFinite(video.duration) || Math.abs(video.duration * 1000 - track.durationMs) > Math.max(5000, track.durationMs * 0.02))) {
    failedEntry = track.entryId; stopVideo(); show("This video’s timing could not be verified.", "Music keeps playing. Try a different YouTube recording if you want its video."); return;
  }
  void sync(true);
});
video.addEventListener("error", () => {
  if (!video.getAttribute("src") || closed) return;
  if (snapshot && Date.now() - mediaLoadedAt > 240000) { void prepare(snapshot, true); return; }
  show("The video needs a fresh connection.", "Your music keeps playing. Retry to catch up.", true); start.textContent = "Retry video";
});
start.addEventListener("click", () => { start.textContent = "Start video"; if (snapshot && (!video.src || video.error || Date.now() - mediaLoadedAt > 240000)) void prepare(snapshot, true); else void sync(true); });
element("resync").addEventListener("click", () => { if (snapshot && (video.error || Date.now() - mediaLoadedAt > 240000)) void prepare(snapshot, true); else void sync(true); });
element("close").addEventListener("click", () => end("You’ve closed the video."));
element("fullscreen").addEventListener("click", () => { const stage = document.querySelector(".stage") as HTMLElement; void stage.requestFullscreen?.().catch(() => {}); });
element("source").addEventListener("click", () => { if (sdk && snapshot?.track) void sdk.commands.openExternalLink({ url: "https://www.youtube.com/watch?v=" + snapshot.track.videoId }); });
delayInput.addEventListener("input", () => { delay = Number(delayInput.value); element("delay-value").textContent = `${delay > 0 ? "+" : ""}${delay} ms`; try { localStorage.setItem("musicmaid-video-delay", String(delay)); } catch { /* Optional preference. */ } void sync(true); });
element("delay-value").textContent = `${delay > 0 ? "+" : ""}${delay} ms`;
document.addEventListener("visibilitychange", () => { if (!document.hidden) void poll(); });
void bootstrap();
