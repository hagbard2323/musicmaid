import { test } from "node:test";
import assert from "node:assert/strict";
import { ComponentType } from "discord.js";
import { musicRequestFields, musicRequestForm, sourceBadge } from "../src/commands/request-form.js";
import { MemberSearches, SearchReplaced } from "../src/commands/request-search.js";
import { env } from "../src/config/env.js";

test("Add music is a native labeled modal with all configured sources selected and an explicit review choice", () => {
  const before = env.spotifyDirectEnabled;
  try {
    for (const enabled of [false, true]) {
      env.spotifyDirectEnabled = enabled;
      const modal = musicRequestForm("fixture", "auto", false).toJSON();
      assert.equal(modal.title, "Add music"); assert.equal(modal.components.length, 3);
      assert.ok(modal.components.every(component => component.type === ComponentType.Label));
      const labels = modal.components as Array<{ type: number; label: string; description?: string; component: any }>;
      assert.equal(labels[0].component.type, ComponentType.TextInput); assert.equal(labels[0].component.custom_id, "query");
      assert.equal(labels[0].component.max_length, 500);
      const sources = labels[1].component;
      assert.equal(sources.type, ComponentType.StringSelect); assert.equal(sources.min_values, 1);
      assert.equal(sources.max_values, enabled ? 3 : 2); assert.equal(sources.options.length, enabled ? 3 : 2);
      assert.ok(sources.options.every((option: { default?: boolean }) => option.default));
      assert.equal("disabled" in sources, false, "Discord prohibits disabled selects inside modals");
      assert.deepEqual(sources.options.map((option: { value: string }) => option.value), enabled ? ["spotify", "youtube", "soundcloud"] : ["youtube", "soundcloud"]);
      assert.equal(labels[2].component.options.find((option: { default?: boolean }) => option.default).value, "auto");
    }
    const shortcuts = musicRequestForm("shortcut", "youtube", true).toJSON().components as Array<{ component: any }>;
    assert.deepEqual(shortcuts[1].component.options.filter((option: { default?: boolean }) => option.default).map((option: { value: string }) => option.value), ["youtube"]);
    assert.equal(shortcuts[2].component.options.find((option: { default?: boolean }) => option.default).value, "review");
  } finally { env.spotifyDirectEnabled = before; }
});

test("modal source selections are validated without rewriting an exact track link", () => {
  const fields = (sources: string[], selection = ["auto"]) => ({ getStringSelectValues: (id: string) => id === "sources" ? sources : selection, getTextInputValue: () => "https://youtu.be/2I3PLVuKNtw" });
  assert.deepEqual(musicRequestFields(fields(["soundcloud"], ["review"])), { query: "https://youtu.be/2I3PLVuKNtw", sources: ["soundcloud"], review: true });
  for (const invalid of [[], ["unknown"], ["youtube", "youtube"]]) assert.throws(() => musicRequestFields(fields(invalid)), /configured music source/);
  assert.throws(() => musicRequestFields(fields(["youtube"], ["unknown"])), /Auto or Review/);
  assert.throws(() => musicRequestFields(fields(["youtube"], ["auto", "review"])), /Auto or Review/);
  assert.equal(sourceBadge("spotify"), "🟢 Spotify"); assert.equal(sourceBadge("youtube"), "🔴 YouTube"); assert.equal(sourceBadge("soundcloud"), "🟠 SoundCloud");
});

test("a newer member search cancels old work before it can publish, without cancelling other members", async () => {
  const searches = new MemberSearches(), published: string[] = [];
  let releaseOld!: () => void, releaseOther!: () => void;
  const old = searches.run("g", "same", async signal => {
    await new Promise<void>(resolve => { releaseOld = resolve; }); signal.throwIfAborted(); published.push("old");
  });
  const rejected = assert.rejects(old, SearchReplaced);
  const other = searches.run("g", "other", async signal => {
    await new Promise<void>(resolve => { releaseOther = resolve; }); signal.throwIfAborted(); published.push("other");
  });
  await searches.run("g", "same", async signal => { signal.throwIfAborted(); published.push("new"); });
  releaseOld(); releaseOther(); await Promise.all([rejected, other]);
  assert.deepEqual(published, ["new", "other"]); searches.close();
});

test("closing the controller's search manager cancels pending work and releases admission", async () => {
  const searches = new MemberSearches(); let release!: () => void;
  const work = searches.run("g", "u", async signal => { await new Promise<void>(resolve => { release = resolve; }); signal.throwIfAborted(); });
  const rejected = assert.rejects(work, /restarting/);
  searches.close(); release(); await rejected;
  assert.equal(searches["current"].size, 0);
});

test("completion of a cancelled search cannot clear admission for its still-running successor", async () => {
  const searches = new MemberSearches(); let releaseFirst!: () => void, releaseSecond!: () => void;
  const first = searches.run("g", "u", async signal => { await new Promise<void>(resolve => { releaseFirst = resolve; }); signal.throwIfAborted(); });
  const firstRejected = assert.rejects(first, SearchReplaced);
  const second = searches.run("g", "u", async signal => { await new Promise<void>(resolve => { releaseSecond = resolve; }); signal.throwIfAborted(); });
  const secondRejected = assert.rejects(second, SearchReplaced);
  releaseFirst(); await firstRejected;
  await searches.run("g", "u", async () => {});
  releaseSecond(); await secondRejected;
  assert.equal(searches["current"].size, 0); searches.close();
});
