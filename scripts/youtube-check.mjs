import "dotenv/config";
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { YoutubeResolver } from "../dist/apps/bot/src/audio/youtube.js";
import { probeStream } from "../dist/apps/bot/src/audio/source-probe.js";

if (!process.env.YOUTUBE_COOKIE_FILE || !process.env.YTDLP_BINARY) throw new Error("Configure the dedicated YouTube session and extractor first.");
const base = new URL(process.env.LAVALINK_URL?.includes("://") ? process.env.LAVALINK_URL : "http://" + (process.env.LAVALINK_URL ?? "127.0.0.1:2333"));
const auth = process.env.LAVALINK_AUTH ?? "youshallnotpass";
const endpoint = new URL("/v4/websocket", base); endpoint.protocol = base.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(endpoint, { headers: { Authorization: auth, "User-Id": "100000000000000001", "Client-Name": "MusicMaid-Authenticated-Check/1.0" } });
const node = new EventEmitter();
const session = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { ws.terminate(); reject(new Error("Lavalink handshake timed out")); }, 10000);
  ws.on("error", error => { clearTimeout(timer); reject(error); });
  ws.on("message", data => { const message = JSON.parse(String(data)); if (message.op === "ready") { clearTimeout(timer); resolve(message.sessionId); } node.emit("raw", message); });
});
async function request(path, method = "GET", body) {
  const response = await fetch(new URL(path, base), { method, headers: { Authorization: auth, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Lavalink HTTP " + response.status);
  return response.status === 204 ? undefined : response.json();
}
node.rest = {
  resolve: uri => request("/v4/loadtracks?identifier=" + encodeURIComponent(uri)),
  updatePlayer: data => request(`/v4/sessions/${session}/players/${data.guildId}`, "PATCH", data.playerOptions),
  destroyPlayer: id => request(`/v4/sessions/${session}/players/${id}`, "DELETE")
};
const resolver = new YoutubeResolver({ binary: process.env.YTDLP_BINARY, cookies: process.env.YOUTUBE_COOKIE_FILE });
let failed = false;
try {
  for (const id of ["2I3PLVuKNtw", "85CLbxM8gQ8"]) {
    const result = await probeStream(node, "youtube", "https://www.youtube.com/watch?v=" + id, 10000, uri => resolver.resolve(uri, node.rest.resolve));
    const pass = result.startsWith("no early stream error");
    console.log(JSON.stringify({ id, pass, result }));
    failed ||= !pass;
  }
} finally { ws.close(); }
if (failed) process.exitCode = 1;
else console.log("Authenticated YouTube initialization verified. Discord listening remains required.");
