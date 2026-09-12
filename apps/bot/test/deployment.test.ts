import { test } from "node:test";
import assert from "node:assert/strict";
const { checkCipherPort } = await import(new URL("../../../scripts/deploy-preflight.mjs", import.meta.url).href);
const { checkServices } = await import(new URL("../../../scripts/service-check.mjs", import.meta.url).href);

test("deployment preflight accepts a free cipher port without inspecting containers", () => {
  const calls: string[] = [];
  checkCipherPort((program: string) => { calls.push(program); return ""; });
  assert.deepEqual(calls, ["ss"]);
});
test("deployment preflight refuses a port owned by another service before shutdown", () => {
  assert.throws(() => checkCipherPort((program: string, args: string[]) => {
    if (program === "ss") return 'LISTEN 0 2048 127.0.0.1:18001 *:* users:(("other",pid=123,fd=5))';
    if (args[0] === "inspect") return "other.service";
    return "HPID\n123";
  }), /occupied by another service/);
});
test("deployment preflight permits its own running cipher and rejects unidentified listeners", () => {
  const run = (program: string, args: string[]) => {
    if (program === "ss") return 'LISTEN 0 2048 127.0.0.1:18001 *:* users:(("cipher",pid=123,fd=5))';
    return args[0] === "inspect" ? "audiobot-cipher.service" : "HPID\n123\n124";
  };
  assert.doesNotThrow(() => checkCipherPort(run));
  assert.throws(() => checkCipherPort((program: string, args: string[]) => program === "ss" ? run(program, args) + '\nLISTEN 0 2048 [::1]:18001 *:*' : run(program, args)), /cannot be verified/);
});
const options = { base: new URL("http://127.0.0.1:2333"), auth: "test", cipherUrl: "http://127.0.0.1:18001" };
const info = { version: { semver: "4.2.2" }, plugins: [{ name: "youtube-plugin", version: "1.18.2" }] };
test("readiness treats connection refusal as a concise retryable startup condition", async () => {
  await assert.rejects(checkServices({ ...options, fetcher: async () => { throw new Error("fetch failed", { cause: { code: "ECONNREFUSED" } }); } }), (error: unknown) => {
    const e = error as Error & { exitCode: number }; assert.equal(e.exitCode, 1); assert.match(e.message, /Lavalink.*ECONNREFUSED/); return true;
  });
});
test("readiness fails immediately on cipher 401 instead of retrying the wrong service", async () => {
  await assert.rejects(checkServices({ ...options, fetcher: async (url: URL) => url.port === "2333" ? Response.json(info) : new Response(null, { status: 401 }) }), (error: unknown) => {
    const e = error as Error & { exitCode: number }; assert.equal(e.exitCode, 2); assert.match(e.message, /Cipher.*18001.*401/); return true;
  });
});
test("readiness succeeds only with the expected audio versions and a reachable cipher", async () => {
  await checkServices({ ...options, fetcher: async (url: URL) => url.port === "2333" ? Response.json(info) : new Response("metrics") });
  await assert.rejects(checkServices({ ...options, fetcher: async () => Response.json({ version: { semver: "4.2.2" }, plugins: [] }) }), /Unexpected audio service versions/);
});
test("authenticated YouTube readiness refuses a missing HTTP audio source", async () => {
  await assert.rejects(checkServices({ ...options, requireHttp: true, fetcher: async () => Response.json(info) }), /HTTP audio source/);
  await checkServices({ ...options, requireHttp: true, fetcher: async (url: URL) => url.port === "2333" ? Response.json({ ...info, sourceManagers: ["youtube", "soundcloud", "http"] }) : new Response("metrics") });
});
