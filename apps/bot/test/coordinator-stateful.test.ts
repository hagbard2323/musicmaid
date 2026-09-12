import { test } from "node:test";
import assert from "node:assert/strict";
import { CoordinatorHarness, seededRandom } from "./helpers/coordinator-harness.js";

for (const seed of [1, 0xc0ffee, 0xdeadbeef]) test(`seeded coordinator/SQLite fault trace preserves requests and ownership (seed=${seed})`, async t => {
  t.mock.method(console, "info", () => {});
  const h = new CoordinatorHarness(), random = seededRandom(seed), trace: string[] = [];
  try {
    await h.addMany(Array.from({ length: 8 }, (_, index) => h.entry(String(40000001 + index % 3))));
    for (let step = 0; step < 120; step++) {
      const choice = Math.floor(random() * 20), before = h.snapshot();
      const current = before.current, attempt = h.music.attemptId(h.guild);
      trace.push(`${step}:${choice}:${before.state}:${before.queue.length}`);
      try {
        switch (choice) {
          case 0: case 1: await h.add(h.entry(String(40000001 + Math.floor(random() * 4)))); break;
          case 2: await h.progress(); break;
          case 3: if (before.state === "playing") await h.music.pause(h.guild, current!.id); break;
          case 4: if (current && ["playing", "paused"].includes(before.state)) await h.music.seek(h.guild, Math.floor(random() * 160000), current.id); break;
          case 5: await h.music.setLoop(h.guild, (["off", "track", "queue"] as const)[Math.floor(random() * 3)]); break;
          case 6: if (current) await h.music.retry(h.guild, current.id); break;
          case 7:
            if (attempt && h.active.has(attempt)) {
              const recording = random() > 0.5;
              await h.music.event(h.guild, { type: "failure", attemptId: attempt,
                reason: recording ? "Version mismatch: fixture upload" : "The audio service is disconnected.", scope: recording ? "recording" : "environment" });
            }
            break;
          case 8: await h.music.externalVoiceChange(h.guild); break;
          case 9: if ((current || before.queue.length) && ["paused", "suspended", "idle"].includes(before.state)) await h.music.resume(h.guild, h.voice, h.channel); break;
          case 10: h.now += Math.floor(random() * 90000); await h.music.tick(); break;
          case 11: if (current) await h.music.skip(h.guild, current.id); break;
          case 12: {
            const stale = h.starts.find(start => start.signal.aborted);
            if (stale) {
              await h.music.event(h.guild, { type: "start", attemptId: stale.id });
              await h.music.event(h.guild, { type: "end", attemptId: stale.id, reason: "finished" });
              await h.music.event(h.guild, { type: "failure", attemptId: stale.id, reason: "stale failure" });
              assert.deepEqual(h.snapshot(), before, "Stale events must not alter the successor.");
            }
            break;
          }
          case 13: {
            const cancel = new AbortController(), entry = h.entry();
            const action = h.music.enqueue(h.guild, entry, h.voice, h.channel, cancel.signal);
            cancel.abort(); await assert.rejects(action, /abort/i);
            assert.deepEqual(h.snapshot(), before, "Canceled queued enqueue must not commit.");
            break;
          }
          case 14:
            await h.rejectedWrite(() => h.music.setLoop(h.guild, "queue"), Boolean(current || before.queue.length || before.history.length) && random() > 0.5);
            break;
          case 15: await h.reopen(); break;
          case 16: await h.music.setQueueMode(h.guild, random() > 0.5 ? "fair" : "fifo"); break;
          case 17:
            if (current && attempt && h.active.has(attempt)) {
              await h.progress(current.recording.durationMs);
              await h.music.event(h.guild, { type: "end", attemptId: attempt, reason: "finished" });
              const after = h.snapshot();
              await h.music.event(h.guild, { type: "end", attemptId: attempt, reason: "finished" });
              assert.deepEqual(h.snapshot(), after, "Duplicate finish must not advance twice.");
            }
            break;
          case 18: await h.music.stop(h.guild); break;
          case 19:
            if (before.queue.length) await h.music.editQueue(h.guild, before.revision, "remove", before.queue[Math.floor(random() * before.queue.length)].id);
            break;
        }
        await h.settle(); h.verify();
      } catch (error) { throw new Error(`seed=${seed}; recent trace=${trace.slice(-12).join(" | ")}`, { cause: error }); }
    }
  } finally { await h.close(); }
});
