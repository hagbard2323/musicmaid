import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http, { type ClientRequest, type RequestOptions } from "node:http";
import type { Client } from "discord.js";
import { Constants, Node } from "shoukaku";
import { createLavalink, ensureLavalinkNode, getLavalinkStatusLines } from "../src/audio/lavalink.js";
import { LavalinkBackend } from "../src/audio/player-service.js";
import { env } from "../src/config/env.js";

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("cold Lavalink startup recovers after the real Shoukaku retry budget is exhausted", async t => {
  const settings = { lavalinkName: env.lavalinkName, lavalinkUrl: env.lavalinkUrl, lavalinkAuth: env.lavalinkAuth };
  Object.assign(env, { lavalinkName: "cold-start-fixture", lavalinkUrl: "127.0.0.1:2333", lavalinkAuth: "fixture-only" });
  t.after(() => Object.assign(env, settings));
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_700_000_000_000 });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});

  let handshakes = 0;
  // Exercise Shoukaku's real connect/retry/disconnect implementation and ws's
  // failure events, replacing only HTTP I/O. No socket or account is used.
  t.mock.method(http, "request", (...args: unknown[]) => {
    const options = args[0] as RequestOptions;
    assert.equal(options.host, "127.0.0.1");
    assert.equal((options.headers as Record<string, string>).Authorization, "fixture-only");
    handshakes++;
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () => queueMicrotask(() => request.emit("error", Object.assign(new Error("Fixture audio service is not listening"), { code: "ECONNREFUSED" })));
    return request as ClientRequest;
  });

  const client = Object.assign(new EventEmitter(), { user: { id: "111111111111111111" }, guilds: { cache: new Map() } });
  const gateway = createLavalink(client as unknown as Client);
  const addNode = t.mock.method(gateway, "addNode");
  const backend = new LavalinkBackend(client as unknown as Client, () => gateway, ensureLavalinkNode);
  t.after(() => { backend.close(); gateway.nodes.clear(); client.removeAllListeners(); });

  await t.test("Discord initialization proceeds while Lavalink refuses every initial connection", async () => {
    assert.equal(gateway.nodes.size, 0, "Shoukaku waits for the Discord connector's ready event");
    client.emit("clientReady");
    await settle();
    assert.equal(gateway.id, client.user.id);
    assert.equal(addNode.mock.callCount(), 1);
    assert.equal(handshakes, 1);
    assert.equal(gateway.nodes.get(env.lavalinkName)?.state, Constants.State.CONNECTING);
    assert.match(getLavalinkStatusLines()[0], /connecting/);
    await assert.rejects(backend.load("scsearch:fixture"), /audio service is disconnected/i);
    assert.equal(handshakes, 1, "an unavailable-node lookup must fail without starting a provider request");

    assert.equal(gateway.options.reconnectTries, 5);
    for (let retry = 0; retry < gateway.options.reconnectTries; retry++) {
      t.mock.timers.tick(5_000);
      await settle();
    }
    assert.equal(handshakes, 5, "the real library exhausted its configured handshake attempts");
    assert.equal(gateway.nodes.size, 0, "Shoukaku removes the exhausted node through its disconnect listener");
    assert.equal(addNode.mock.callCount(), 1, "the 15-second recovery tick must not duplicate an existing connecting node");
    assert.match(getLavalinkStatusLines()[0], /no node registered/);
  });

  // The failed transport above was real library behavior. Subsequent transport
  // starts remain pending at the node boundary so the scheduler can be tested
  // independently of repeated HTTP failures, without leaving active I/O.
  t.mock.method(Node.prototype, "connect", async function (this: Node) { this.state = Constants.State.CONNECTING; });

  await t.test("the periodic recovery loop re-adds a removed node without any new Discord request", async () => {
    t.mock.timers.tick(5_000);
    await settle();
    assert.equal(addNode.mock.callCount(), 2);
    assert.equal(gateway.nodes.size, 1);
    assert.equal(gateway.nodes.get(env.lavalinkName)?.state, Constants.State.CONNECTING);
    assert.equal(handshakes, 5);
    ensureLavalinkNode("concurrent track lookup");
    t.mock.timers.tick(45_000);
    await settle();
    assert.equal(addNode.mock.callCount(), 2, "connecting nodes survive both demand-driven and periodic checks without duplication");
  });

  await t.test("repeated removal and concurrent demand respect the ten-second re-add throttle", async () => {
    gateway.nodes.get(env.lavalinkName)!.emit("disconnect", 0);
    assert.equal(gateway.nodes.size, 0);
    ensureLavalinkNode("first lookup after removal");
    assert.equal(addNode.mock.callCount(), 3);
    gateway.nodes.get(env.lavalinkName)!.emit("disconnect", 0);
    ensureLavalinkNode("second lookup after removal");
    t.mock.timers.tick(9_999);
    ensureLavalinkNode("still cooling down");
    assert.equal(addNode.mock.callCount(), 3);
    assert.equal(gateway.nodes.size, 0);
    t.mock.timers.tick(1);
    ensureLavalinkNode("cooldown elapsed");
    assert.equal(addNode.mock.callCount(), 4);
    assert.equal(gateway.nodes.size, 1);
    ensureLavalinkNode("already connecting");
    assert.equal(addNode.mock.callCount(), 4);
  });
});
