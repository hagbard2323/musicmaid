import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LoadType, type Node, type UpdatePlayerInfo } from "shoukaku";
import { probeStream } from "../src/audio/source-probe.js";

test("stream diagnosis catches errors after successful lookup and never supplies voice credentials", async () => {
  const node = new EventEmitter() as EventEmitter & { rest: unknown };
  let destroyed = false;
  node.rest = {
    resolve: async () => ({ loadType: LoadType.TRACK, data: { encoded: "track" } }),
    updatePlayer: async (request: UpdatePlayerInfo) => {
      assert.equal(request.guildId, "0"); assert.equal(request.playerOptions.voice, undefined);
      const track = { userData: request.playerOptions.track?.userData };
      node.emit("raw", { guildId: "0", type: "TrackStartEvent", track });
      node.emit("raw", { guildId: "0", type: "TrackExceptionEvent", track, exception: { cause: "All clients failed: login required" } });
    },
    destroyPlayer: async (id: string) => { assert.equal(id, "0"); destroyed = true; }
  };
  const result = await probeStream(node as unknown as Node, "youtube", "https://youtube.com/watch?v=probe", 0);
  assert.match(result, /stream initialization failed/); assert.equal(destroyed, true); assert.equal(node.listenerCount("raw"), 0);
});
test("diagnostic cleanup also runs when starting the synthetic player fails", async () => {
  const node = new EventEmitter() as EventEmitter & { rest: unknown }; let destroyed = false;
  node.rest = { resolve: async () => ({ loadType: LoadType.TRACK, data: { encoded: "track" } }), updatePlayer: async () => { throw new Error("Disconnected"); }, destroyPlayer: async () => { destroyed = true; } };
  assert.match(await probeStream(node as unknown as Node, "soundcloud", "https://soundcloud.com/a/b", 0), /probe failed/);
  assert.equal(destroyed, true); assert.equal(node.listenerCount("raw"), 0);
});
test("diagnosis uses the same configured resolver as playback", async () => {
  const node = new EventEmitter() as EventEmitter & { rest: unknown };
  node.rest = {
    resolve: async () => { assert.fail("legacy source lookup must not be used"); },
    updatePlayer: async (request: UpdatePlayerInfo) => {
      assert.equal(request.playerOptions.track?.encoded, "authenticated-transport");
      node.emit("raw", { guildId: "0", type: "TrackStartEvent", track: { userData: request.playerOptions.track?.userData } });
    }, destroyPlayer: async () => {}
  };
  const load = async () => ({ loadType: LoadType.TRACK as const, data: { encoded: "authenticated-transport" } } as never);
  assert.match(await probeStream(node as unknown as Node, "youtube", "https://youtube.com/watch?v=probe", 0, load), /no early stream error/);
});
