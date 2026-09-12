import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type { ViewerSnapshot } from "../src/video/protocol.js";

class ElementFixture {
  hidden = false; disabled = false; textContent = ""; value = "";
  style = { width: "" };
  classList = { toggle: () => {}, remove: () => {} };
  private listeners = new Map<string, (() => void)[]>();
  addEventListener(event: string, handler: () => void) { this.listeners.set(event, [...this.listeners.get(event) ?? [], handler]); }
  emit(event: string) { for (const handler of this.listeners.get(event) ?? []) handler(); }
}
class VideoFixture extends ElementFixture {
  src = ""; readyState = 0; duration = 205; currentTime = 0; muted = false; paused = true; error: object | null = null;
  playCalls = 0;
  pause() { this.paused = true; }
  async play() { this.playCalls++; this.paused = false; }
  removeAttribute() { this.src = ""; }
  getAttribute() { return this.src; }
  load() {
    this.readyState = 0;
    if (this.src) queueMicrotask(() => { this.readyState = 1; this.emit("loadedmetadata"); });
  }
}
async function drain() { for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve)); }

test("paused viewer clears loading and recovered connection overlays without starting video", async () => {
  // Run the real browser entry point, replacing only Discord RPC and browser I/O.
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../../viewer/src/app.ts", import.meta.url))], bundle: true, write: false, platform: "browser", format: "iife", loader: { ".css": "empty" }, plugins: [{
    name: "fixture-discord-rpc",
    setup(plugin) {
      plugin.onResolve({ filter: /^@discord\/embedded-app-sdk$/ }, () => ({ path: "fixture-sdk", namespace: "fixture" }));
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        export const RPCCloseCodes = { CLOSE_NORMAL: 1000 };
        export class DiscordSDK {
          guildId = "10000001";
          commands = { authorize: async () => ({code:"fixture-code"}), authenticate: async () => ({}), openExternalLink: async () => ({}) };
          async ready() {}
          close() {}
        }` }));
    }
  }] });
  const elements = new Map<string, ElementFixture>(), video = new VideoFixture(); elements.set("video", video);
  const element = (id: string) => { let value = elements.get(id); if (!value) { value = new ElementFixture(); elements.set(id, value); } return value; };
  const snapshot: ViewerSnapshot = { serverTime: Date.now(), runId: "fixture", voiceChannelId: "30000001", track: {
    entryId: "11111111-1111-1111-1111-111111111111", videoId: "2I3PLVuKNtw", title: "Fixture", artist: "Artist", durationMs: 205000, positionMs: 27000, observedAt: Date.now(), state: "paused"
  } };
  let poll: (() => void) | undefined, failing = false;
  runInNewContext(bundle.outputFiles[0].text, {
    document: { getElementById: element, addEventListener: () => {} },
    location: { hostname: "fixture.example", search: "?frame_id=fixture" },
    localStorage: { getItem: () => null },
    fetch: async (path: string) => {
      if (path === "/config") return Response.json({ clientId: "12345678" });
      if (path === "/api/auth") return Response.json({ token: "fixture-bearer", accessToken: "fixture-access", snapshot });
      if (path === "/api/video") return Response.json({ path: "/media/" + "a".repeat(64), height: 720 });
      if (path === "/api/state") return failing ? Response.json({ error: "Fixture interruption" }, { status: 503 }) : Response.json(snapshot);
      throw new Error("Unexpected viewer request.");
    },
    crypto: webcrypto, URLSearchParams, AbortSignal, AbortController,
    setInterval: (callback: () => void) => { poll = callback; return 1; }, setTimeout, console
  });
  await drain();
  assert.ok(poll, "Viewer must have authenticated and started state polling.");
  assert.equal(video.currentTime, 27);
  assert.equal(video.paused, true);
  assert.equal(video.muted, true);
  assert.equal(element("state-label").textContent, "Paused");
  assert.equal(element("overlay").hidden, true, "The loaded paused frame must not remain behind a loading overlay.");
  assert.equal(video.playCalls, 0, "Joining a paused track must not start video or voice playback.");

  failing = true; poll(); await drain();
  assert.equal(element("overlay").hidden, false);
  assert.equal(element("status-title").textContent, "Reconnecting the viewer…");
  failing = false; poll(); await drain();
  assert.equal(element("overlay").hidden, true, "Recovery while paused clears the old connection error.");
  assert.equal(element("start").hidden, true);
  assert.equal(video.playCalls, 0);

  video.error = {}; video.emit("error");
  assert.equal(element("start").textContent, "Retry video");
  poll(); await drain();
  assert.equal(element("overlay").hidden, false, "A real media failure still needs its retry control.");
  assert.equal(element("start").hidden, false);
});
