#!/usr/bin/env node
// Manual offline benchmark; never imported by the normal test runner.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { accessSync, constants, statfsSync, statSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { CoordinatorHarness, seededRandom } from "../apps/bot/test/helpers/coordinator-harness.ts";
import { MusicController } from "../apps/bot/src/commands/music.ts";
import { env } from "../apps/bot/src/config/env.ts";

function options(args) {
  const result = { seed: 12648430, iterations: 300, report: undefined, storageDirectory: undefined };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--seed", "--iterations", "--report", "--storage-dir"].includes(key) || !value) throw new Error("Usage: stress.mjs [--seed uint32] [--iterations 1..2000] [--storage-dir existing-directory] [--report path]");
    if (key === "--report") { result.report = value; continue; }
    if (key === "--storage-dir") {
      try {
        if (!statSync(value).isDirectory()) throw new Error();
        accessSync(value, constants.W_OK);
      } catch { throw new Error("The stress storage parent must be an existing writable directory."); }
      result.storageDirectory = value; continue;
    }
    if (!/^\d+$/.test(value)) throw new Error("Seed and iterations must be unsigned integers.");
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > (key === "--seed" ? 4294967295 : 2000) || (key === "--iterations" && number < 1)) throw new Error("Seed or iteration limit is outside its supported range.");
    result[key.slice(2)] = number;
  }
  return result;
}
function distribution(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const at = percentile => ordered[Math.max(0, Math.ceil(ordered.length * percentile) - 1)] ?? 0;
  const rounded = value => Math.round(value * 1000) / 1000;
  return { count: ordered.length, p50: rounded(at(0.5)), p95: rounded(at(0.95)), max: rounded(at(1)) };
}
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function run(settings) {
  const started = performance.now(), h = new CoordinatorHarness(settings.storageDirectory), random = seededRandom(settings.seed);
  const processors = cpus(), filesystemMagic = Number(statfsSync(h.directory).type) >>> 0;
  const filesystemNames = { 0xef53: "ext-family", 0x01021994: "tmpfs", 0x9123683e: "btrfs", 0x58465342: "xfs", 0x794c7630: "overlay" };
  const before = process.memoryUsage(); let peakRss = before.rss, peakHeap = before.heapUsed, blockedNetworkCalls = 0, incidentEvents = 0;
  const timings = new Map(), deferrals = [], handlerTimes = [];
  const savedFetch = globalThis.fetch, savedInfo = console.info, savedChannel = env.discordMusicTextChannelId;
  const lag = monitorEventLoopDelay({ resolution: 10 });
  const sampleMemory = () => { const memory = process.memoryUsage(); peakRss = Math.max(peakRss, memory.rss); peakHeap = Math.max(peakHeap, memory.heapUsed); };
  const sampler = setInterval(sampleMemory, 10); sampler.unref();
  globalThis.fetch = async () => { blockedNetworkCalls++; throw new Error("Network access is disabled in the offline stress fixture."); };
  console.info = () => { incidentEvents++; };
  env.discordMusicTextChannelId = h.channel;
  const controller = new MusicController({}, h.music, async () => { blockedNetworkCalls++; throw new Error("Provider access is disabled in the offline stress fixture."); }, h.store);
  let interactions = 0, directReplies = 0, cleanup;
  const timed = async (kind, action) => {
    const begin = performance.now();
    try { return await action(); }
    finally { const values = timings.get(kind) ?? []; values.push(performance.now() - begin); timings.set(kind, values); sampleMemory(); }
  };
  async function interaction(commandName) {
    const begin = performance.now(); let deferred = false;
    const user = { id: "40000001" }, member = { voice: { channelId: h.voice }, roles: { cache: new Map() } };
    const input = {
      id: `offline-interaction-${++interactions}`, guildId: h.guild, channelId: h.channel, user,
      guild: { members: { cache: new Map([[user.id, member]]), me: { voice: { channelId: h.voice } } } },
      commandName, options: { getSubcommand: () => "list", getString: () => null, getInteger: () => null, getBoolean: () => null },
      memberPermissions: { has: () => false },
      isChatInputCommand: () => true, isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false,
      deferReply: async () => { assert.equal(deferred, false); deferred = true; input.deferred = true; deferrals.push(performance.now() - begin); },
      editReply: async () => { assert.equal(deferred, true, "Fixture handlers must acknowledge before editing their response."); },
      reply: async () => { directReplies++; },
    };
    await controller.handle(input);
    assert.equal(deferred, true, `${commandName} must reach its deferred response.`);
    handlerTimes.push(performance.now() - begin);
  }
  lag.enable();
  try {
    await wait(25); // Let the delay monitor establish a baseline before blocking work.
    await h.add(); await h.progress();
    // Concurrent admission uses the real guild action queue and SQLite commits.
    await Promise.all(Array.from({ length: 25 }, (_, batch) => timed("concurrent_20_track_batch", () =>
      h.addMany(Array.from({ length: 20 }, () => h.entry(String(40000001 + batch % 8)))))));
    assert.equal(h.snapshot().queue.length, 500); h.verify();
    const rejected = await Promise.allSettled(Array.from({ length: 16 }, () => timed("full_queue_rejection", () => h.add())));
    assert.equal(rejected.filter(result => result.status === "rejected").length, 16);
    h.store.library.create(h.guild, "40000001", "Offline fixture playlist", h.snapshot().queue);
    assert.throws(() => h.store.library.create(h.guild, "40000001", "Oversized fixture playlist", [...h.snapshot().queue, h.entry()]), /500 tracks/);
    assert.equal(h.store.library.list(h.guild).length, 1, "A rejected 501-track playlist must not leave a partial library entry.");
    await h.settle();
    for (let step = 0; step < settings.iterations; step++) {
      if (performance.now() - started > 180000) throw new Error(`Offline stress deadline exceeded at iteration ${step}; seed=${settings.seed}.`);
      const current = h.snapshot(), choice = Math.floor(random() * 6);
      if (choice === 0) await timed("progress_checkpoint", () => h.progress());
      else if (choice === 1) await timed("volume_control", () => h.music.setVolume(h.guild, 30 + Math.floor(random() * 71)));
      else if (choice === 2) await timed("queue_mode", () => h.music.setQueueMode(h.guild, random() < 0.5 ? "fifo" : "fair"));
      else if (choice === 3 && current.current) {
        await timed("concurrent_duplicate_skip_and_enqueue", async () => {
          const results = await Promise.allSettled([
            h.music.skip(h.guild, current.current.id), h.music.skip(h.guild, current.current.id),
            h.add(h.entry(String(40000001 + Math.floor(random() * 8)))),
          ]);
          assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].status, "rejected"); assert.equal(results[2].status, "fulfilled");
        });
      } else if (choice === 4 && ["playing", "paused"].includes(current.state)) await timed("seek_control", () => h.music.seek(h.guild, Math.floor(random() * 150000), current.current.id));
      else if (choice === 5 && current.state === "playing") await timed("pause_control", () => h.music.pause(h.guild, current.current.id));
      else if (current.state === "paused") await timed("resume_control", () => h.music.resume(h.guild, h.voice, h.channel));
      else await timed("progress_checkpoint", () => h.progress());
      if (step % 10 === 0) {
        await Promise.all(["queue", "history", "playlist", "music-stats"].map(interaction));
        h.verify();
      }
      assert.equal(h.snapshot().queue.length, 500);
      await h.settle();
    }
    h.verify(); assert.equal(blockedNetworkCalls, 0); assert.equal(directReplies, 0);
    assert.ok(Math.max(...deferrals) < 3000, "Local fixture defer callback exceeded its 3000ms budget; this is not a live Discord acknowledgment measurement.");
    const acceptedRequests = h.accepted.size, backendStarts = h.starts.length;
    controller.close(); cleanup = await h.close();
    await wait(25); sampleMemory(); lag.disable();
    const after = process.memoryUsage();
    return {
      schemaVersion: 1, status: "passed", scope: "offline one-community fixture; no Discord connection, provider calls or audible playback",
      seed: settings.seed, iterations: settings.iterations, durationMs: Math.round(performance.now() - started),
      environment: { node: process.version, platform: process.platform, arch: process.arch, logicalCpus: processors.length, cpuModel: processors[0]?.model ?? "unknown", totalMemoryBytes: totalmem(),
        temporaryDatabaseFilesystem: { type: filesystemNames[filesystemMagic] ?? "unknown", magicHex: "0x" + filesystemMagic.toString(16), meaning: "Filesystem containing this temporary SQLite database, not a hosted capacity estimate." } },
      workload: { upcomingQueueSize: 500, savedPlaylistSize: 500, rejectedPlaylistSize: 501, concurrentInitialBatches: 25, tracksPerBatch: 20, fullQueueRejections: 16, acceptedRequests, backendStarts, fixtureInteractions: interactions },
      latencyMs: Object.fromEntries([...timings].map(([kind, values]) => [kind, distribution(values)])),
      fixtureInteractions: { deferCallbackMs: distribution(deferrals), completeHandlerMs: distribution(handlerTimes),
        localDeferBudgetMs: 3000, localDeferBudgetPassed: true,
        meaning: "Local handle() entry to stub deferReply(); NOT real Discord acknowledgment latency. Gateway/network delay excluded." },
      eventLoopLagMs: { p50: lag.percentile(50) / 1e6, p95: lag.percentile(95) / 1e6, max: lag.max / 1e6, resolution: 10 },
      memoryBytes: { beforeRss: before.rss, peakRss, afterRss: after.rss, beforeHeapUsed: before.heapUsed, peakHeapUsed: peakHeap, afterHeapUsed: after.heapUsed, garbageCollectionForced: false },
      cleanup: { ...cleanup, controllerClosed: true, temporaryDatabaseRemoved: true, blockedNetworkCalls },
      fixtureIncidentEvents: incidentEvents,
      limitations: ["Synthetic backend resolves immediately; excludes real decoder/voice/provider cost.", "Measured on this machine and filesystem; not a hosted capacity or availability guarantee.", "Competing-writer SQLite faults are covered separately by targeted tests.", "State-machine randomized fault tests run in npm test; this command measures a bounded full-queue workload."],
    };
  } finally {
    clearInterval(sampler); lag.disable(); controller.close();
    try { if (!cleanup) await h.close(); }
    finally { globalThis.fetch = savedFetch; console.info = savedInfo; env.discordMusicTextChannelId = savedChannel; }
  }
}

try {
  const settings = options(process.argv.slice(2)), report = await run(settings);
  const json = JSON.stringify(report, null, 2) + "\n";
  if (settings.report) await writeFile(settings.report, json, { mode: 0o600 });
  process.stdout.write(json);
} catch (error) {
  process.stderr.write(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : "Offline stress failed." }) + "\n");
  process.exitCode = 1;
}
