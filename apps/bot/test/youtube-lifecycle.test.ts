import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LoadType, type Track } from "shoukaku";
import { runYoutube, YoutubeResolver } from "../src/audio/youtube.js";

type ChildEvent = { event: string; pid: number; kind: string; previousAlive?: boolean };
const id = "2I3PLVuKNtw", uri = `https://www.youtube.com/watch?v=${id}`;
const media = `https://rr1.googlevideo.com/videoplayback?expire=${Math.floor(Date.now() / 1000) + 3600}&sig=PRIVATE_FIXTURE`;
const metadata = { id, title: "Fixture", channel: "Fixture artist", duration: 205, url: media };
const track: Track = { encoded: "fixture", pluginInfo: {}, info: { identifier: "fixture", uri: media, sourceName: "http", title: "Fixture", author: "Fixture artist", length: 205000, isStream: false, isSeekable: true, position: 0 } };
const load = async () => ({ loadType: LoadType.TRACK as const, data: track });

async function fixture(t: TestContext, behavior: string) {
  const directory = await mkdtemp(join(tmpdir(), "musicmaid-youtube-lifecycle-"));
  const eventsPath = join(directory, "events"), pidPath = join(directory, "pid");
  const cookies = join(directory, "cookies"), binary = join(directory, "extractor");
  const events = async (): Promise<ChildEvent[]> => {
    const text = await readFile(eventsPath, "utf8").catch(() => "");
    return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  };
  t.after(async () => {
    for (const { pid } of await events()) {
      try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch { /* Child already exited. */ }
    }
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(cookies, "fixture-account-session", { mode: 0o600 });
  await writeFile(binary, `#!${process.execPath}
const fs = require("node:fs");
const events = ${JSON.stringify(eventsPath)}, pidFile = ${JSON.stringify(pidPath)};
const kind = process.argv.includes("--check-formats") ? "audio" : process.argv.some(a => a.startsWith("bestvideo")) ? "video" : process.argv.at(-1);
const log = (event, fields = {}) => fs.appendFileSync(events, JSON.stringify({ event, pid: process.pid, kind, ...fields }) + "\\n");
let previousAlive = false;
try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0); previousAlive = true; } catch {}
fs.writeFileSync(pidFile, String(process.pid));
const finish = result => { log("exit"); process.stdout.write(JSON.stringify(result)); process.exit(0); };
const metadata = ${JSON.stringify(metadata)};
${behavior}
log("start", { previousAlive });
`, { mode: 0o700 });
  const started = async (kind?: string) => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const event = (await events()).find(e => e.event === "start" && (!kind || e.kind === kind));
      if (event) return event;
      await delay(10);
    }
    throw new Error("Fixture child did not start.");
  };
  return { options: { binary, cookies }, events, started };
}

test("cancelled extraction holds the cookie writer until delayed child exit", async t => {
  const f = await fixture(t, `
process.on("SIGTERM", () => { log("term"); setTimeout(() => finish({ entries: [] }), 150); });
if (kind === "ytsearch10:second") setImmediate(() => finish({ entries: [] }));
else setInterval(() => {}, 1000);
`);
  const resolver = new YoutubeResolver(f.options), abort = new AbortController();
  const first = assert.rejects(resolver.search("first", abort.signal), /aborted/);
  const firstChild = await f.started();
  abort.abort();
  const second = resolver.search("second");
  await Promise.all([first, second]);
  const events = await f.events();
  const exited = events.findIndex(e => e.pid === firstChild.pid && e.event === "exit");
  const next = events.findIndex(e => e.kind === "ytsearch10:second" && e.event === "start");
  assert.ok(exited >= 0 && next > exited, "the next writer starts only after the old writer exits");
  assert.equal(events[next].previousAlive, false);
});

test("a child ignoring TERM is killed before the next cookie writer starts", async t => {
  const f = await fixture(t, `
process.on("SIGTERM", () => log("term"));
if (kind === "ytsearch10:second") setImmediate(() => finish({ entries: [] }));
else setInterval(() => {}, 1000);
`);
  const resolver = new YoutubeResolver(f.options), abort = new AbortController();
  const first = assert.rejects(resolver.search("first", abort.signal), /aborted/);
  const firstChild = await f.started();
  const at = Date.now(); abort.abort();
  await Promise.all([first, resolver.search("second")]);
  assert.ok(Date.now() - at < 5000, "TERM escalates without waiting for the extraction deadline");
  assert.throws(() => process.kill(firstChild.pid, 0), { code: "ESRCH" });
  assert.equal((await f.events()).find(e => e.kind === "ytsearch10:second" && e.event === "start")?.previousAlive, false);
});

test("stdout and stderr overflow kill and reap the child without exposing its output", async t => {
  for (const stream of ["stdout", "stderr"]) {
    await t.test(stream, async sub => {
      const f = await fixture(sub, `
process.on("SIGTERM", () => log("term"));
setImmediate(() => process.${stream}.write("PRIVATE_COOKIE_SIGNED_URL".repeat(200000)));
setInterval(() => {}, 1000);
`);
      const result = assert.rejects(runYoutube(f.options, ["flood"]), error => {
        assert.match(String(error), /too much track information/);
        assert.doesNotMatch(String(error), /PRIVATE|COOKIE|SIGNED_URL/); return true;
      });
      const child = await f.started(); await result;
      assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    });
  }
});

test("a timed out extractor ignoring TERM is killed and reaped", { timeout: 30000 }, async t => {
  const f = await fixture(t, `
process.on("SIGTERM", () => log("term"));
setInterval(() => {}, 1000);
`);
  const result = assert.rejects(runYoutube(f.options, ["timeout"]), /source timeout/);
  const child = await f.started(); await result;
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("spawn failures and invalid output release the writer without leaking executable details", async t => {
  const f = await fixture(t, `setImmediate(() => { process.stdout.write("PRIVATE_SIGNED_URL"); process.exit(0); });`);
  await assert.rejects(runYoutube({ ...f.options, binary: join(tmpdir(), "missing-private-executable") }, []), error => {
    assert.match(String(error), /could not resolve/); assert.doesNotMatch(String(error), /missing-private-executable/); return true;
  });
  await assert.rejects(runYoutube(f.options, ["invalid"]), error => {
    assert.match(String(error), /invalid track information/); assert.doesNotMatch(String(error), /PRIVATE|SIGNED_URL/); return true;
  });
});

test("urgent audio preempts active optional video and waits for its actual exit", async t => {
  const f = await fixture(t, `
process.on("SIGTERM", () => log("term"));
let earlierVideo = false;
try { earlierVideo = fs.readFileSync(events, "utf8").split("\\n").filter(Boolean).map(line => JSON.parse(line)).some(e => e.event === "start" && e.kind === "video"); } catch {}
if (kind === "audio") setImmediate(() => finish(metadata));
else if (earlierVideo) setImmediate(() => finish({ ...metadata, height: 720, fps: 30, vcodec: "avc1", acodec: "none" }));
else setInterval(() => {}, 1000);
`);
  const resolver = new YoutubeResolver(f.options);
  const firstViewer = assert.rejects(resolver.video(id), /aborted/);
  const secondViewer = assert.rejects(resolver.video(id), /aborted/);
  const video = await f.started("video"), at = Date.now();
  const audio = await resolver.resolve(uri, load);
  await Promise.all([firstViewer, secondViewer]);
  assert.equal(audio.loadType, LoadType.TRACK);
  assert.ok(Date.now() - at < 5000, "audio does not wait for the optional 25-second deadline");
  assert.throws(() => process.kill(video.pid, 0), { code: "ESRCH" });
  const events = await f.events();
  assert.equal(events.filter(e => e.kind === "video" && e.event === "start").length, 1, "viewers shared one preparation");
  assert.equal(events.find(e => e.kind === "audio" && e.event === "start")?.previousAlive, false);
  assert.equal((await resolver.video(id)).id, id, "a preempted shared preparation can be retried once audio starts");
});
