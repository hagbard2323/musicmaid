import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createViewerServer } from "../../viewer-server/src/server.js";

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Viewer admission fixture timed out.");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture(fetcher: typeof fetch, now = Date.now) {
  const server = createViewerServer({ clientId: "12345678", clientSecret: "fixture-only", publicOrigin: "https://viewer.example", socketPath: "unused", assetsDir: "/tmp", fetcher, now });
  const received: IncomingMessage[] = [];
  server.on("request", req => { received.push(req); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const partial = (code: string) => {
    const payload = JSON.stringify({ code, guildId: "12345678" });
    let complete!: (status: number) => void;
    const result = new Promise<number>(resolve => { complete = resolve; });
    const req = request({ host: "127.0.0.1", port, path: "/api/auth", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, res => {
      res.resume(); res.on("end", () => complete(res.statusCode ?? 0));
    });
    req.on("error", () => complete(0)); req.flushHeaders(); req.write(payload.slice(0, 1));
    return { req, result, finish: () => req.end(payload.slice(1)) };
  };
  const post = (body: string) => fetch(`http://127.0.0.1:${port}/api/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  return { received, partial, post, close: () => { server.closeAllConnections(); server.close(); } };
}

test("viewer reserves OAuth admission before reading concurrent partial bodies", async () => {
  let exchanges = 0, running = 0, peak = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const viewer = await fixture(async () => {
    exchanges++; peak = Math.max(peak, ++running); await gate; running--;
    return Response.json({}, { status: 401 });
  });
  const requests = Array.from({ length: 12 }, (_, index) => viewer.partial("fixture-code-" + index));
  try {
    await until(() => viewer.received.length === 12);
    assert.equal(exchanges, 0, "Incomplete bodies must not reach Discord.");
    for (const request of requests) request.finish();
    await until(() => exchanges === 4);
    release();
    const statuses = await Promise.all(requests.map(request => request.result));
    assert.equal(statuses.filter(status => status === 401).length, 4);
    assert.equal(statuses.filter(status => status === 429).length, 8);
    assert.equal(peak, 4);
  } finally { release(); for (const { req } of requests) req.destroy(); viewer.close(); }
});

test("viewer releases OAuth reservations after canceled and malformed request bodies", async () => {
  let exchanges = 0;
  const viewer = await fixture(async () => { exchanges++; return Response.json({}, { status: 401 }); });
  const requests = Array.from({ length: 4 }, (_, index) => viewer.partial("fixture-code-" + index));
  try {
    await until(() => viewer.received.length === 4);
    assert.equal((await viewer.post(JSON.stringify({ code: "fixture-over-cap", guildId: "12345678" }))).status, 429);
    const closed = viewer.received.slice(0, 4).map(req => once(req, "close").catch(() => undefined));
    for (const { req } of requests) req.destroy();
    await Promise.all(closed);
    assert.equal((await viewer.post("{")).status, 400);
    assert.equal((await viewer.post(JSON.stringify({ code: "fixture-after-cancel", guildId: "12345678" }))).status, 401);
    assert.equal(exchanges, 1);
  } finally { for (const { req } of requests) req.destroy(); viewer.close(); }
});

test("viewer admission counts rejected input and resumes after its bounded rate window", async () => {
  let clock = Date.now(), exchanges = 0;
  const viewer = await fixture(async () => { exchanges++; return Response.json({}, { status: 401 }); }, () => clock);
  try {
    for (let index = 0; index < 40; index++) assert.equal((await viewer.post("{")).status, 400);
    const input = JSON.stringify({ code: "fixture-after-window", guildId: "12345678" });
    assert.equal((await viewer.post(input)).status, 429);
    assert.equal(exchanges, 0);
    clock += 60001;
    assert.equal((await viewer.post(input)).status, 401);
    assert.equal(exchanges, 1);
  } finally { viewer.close(); }
});
