import { request } from "node:http";
import type { ViewerScope } from "../../bot/src/video/bridge.js";
export function bridgeClient(socketPath: string) {
  return <T>(path: "/state" | "/video", scope: ViewerScope & { entryId?: string; refresh?: boolean }, signal?: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "POST", signal, headers: { "Content-Type": "application/json" } }, res => {
      let data = "";
      res.on("data", chunk => { data += chunk.toString(); if (data.length > 16384) res.destroy(new Error("Viewer response too large.")); });
      res.on("error", reject);
      res.on("end", () => {
        if (res.statusCode !== 200) { reject(new BridgeError(res.statusCode === 403 ? 403 : 503)); return; }
        try { resolve(JSON.parse(data) as T); } catch { reject(new BridgeError(503)); }
      });
    });
    req.setTimeout(path === "/video" ? 30000 : 3000, () => req.destroy(new BridgeError(503)));
    req.on("error", error => reject(error instanceof BridgeError ? error : new BridgeError(503)));
    req.end(JSON.stringify(scope));
  });
}
export class BridgeError extends Error { constructor(readonly status: number) { super(status === 403 ? "Join MusicMaid’s voice channel to watch." : "MusicMaid is reconnecting. Your voice audio is independent of this viewer."); } }
