import { test } from "node:test";
import assert from "node:assert/strict";
import { type APIEmbed, type Client, type EmbedBuilder } from "discord.js";
import { MusicController } from "../src/commands/music.js";
import { LibraryController } from "../src/commands/library.js";
import { metadataText } from "../src/commands/metadata-text.js";
import { SqliteMusicStorage } from "../src/storage/sqlite-storage.js";
import type { MusicCoordinator } from "../src/audio/coordinator.js";
import { entryFor, newSession } from "../src/audio/model.js";

const source = "https://soundcloud.com/artist/selected-recording";
const spotify = "https://open.spotify.com/track/0NTMtAO2BV4tnGvw9EgBVq";
const hostile = "https://injected.example";
type Payload = { embeds: EmbedBuilder[]; allowedMentions?: { parse: string[] } };
// Read unescaped masked-link delimiters in these fixtures. This intentionally
// does not claim to implement Discord's complete Markdown/autolink renderer.
function linkTargets(value: string): string[] {
  const targets: string[] = []; let labels = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "\\") { index++; continue; }
    if (value[index] === "[") labels++;
    if (value[index] !== "]" || !labels) continue;
    labels--;
    if (value[index + 1] !== "(") continue;
    const end = value.indexOf(")", index + 2);
    if (end !== -1) { targets.push(value.slice(index + 2, end)); index = end; }
  }
  return targets;
}
const literal = (value: string) => value.replace(/\\(.)/gs, "$1");
function fixture(title: string, author: string) {
  const store = new SqliteMusicStorage(":memory:");
  const session = newSession("guild"); session.voiceChannelId = "voice"; session.textChannelId = "text"; session.state = "playing";
  session.current = entryFor({ query: "fixture", source: "auto", requestedBy: "12345678", spotify: { id: "0NTMtAO2BV4tnGvw9EgBVq", title, artists: [author], durationMs: 180000 } },
    { identifier: "selected-recording", title, author, uri: source, source: "soundcloud", durationMs: 180000, isStream: false, isSeekable: true });
  session.queue.push(entryFor(session.current.request, session.current.recording));
  store.saveSession(session);
  const music = { snapshot: () => session } as unknown as MusicCoordinator;
  const controller = new MusicController({} as Client, music, async () => undefined, store);
  const library = new LibraryController(music, store.library, async () => undefined, () => ({ guildId: "guild", voiceChannelId: "voice" }), () => false);
  let reply!: Payload;
  const interaction = { guildId: "guild", user: { id: "12345678" }, editReply: async (payload: Payload) => { reply = payload; } };
  return { store, session, controller, library, interaction, reply: () => reply,
    close: () => { controller.close(); library.close(); store.close(); } };
}
function assertPlayer(embed: APIEmbed): void {
  assert.deepEqual(linkTargets(embed.description!), [source]);
  assert.equal(embed.fields!.find(field => field.name === "Requested via Spotify"), undefined, "catalog/codec details stay in the private Details view");
  assert.equal(embed.fields!.find(field => field.name === "Requested by")!.value, "<@12345678>");
  assert.deepEqual(linkTargets(embed.fields!.find(field => field.name.startsWith("Up next"))!.value), []);
}

test("metadata escaping preserves ordinary track text and cannot leave partial link escapes at a length boundary", () => {
  const normal = "Sarà perché ti amo (Original) [1981] — Ricchi & Poveri 🎵 \\";
  assert.equal(literal(metadataText(normal)), normal);
  const input = `Song\\](https://injected.example) [🎵 **Artist** [account](${hostile})`;
  for (let limit = 0; limit <= metadataText(input).length; limit++) {
    const escaped = metadataText(input, limit);
    assert.ok(escaped.length <= limit);
    assert.equal((/\\+$/.exec(escaped)?.[0].length ?? 0) % 2, 0, "A cut escape must not consume our closing bracket.");
    assert.doesNotMatch(escaped, /[\uD800-\uDBFF]$/);
    assert.deepEqual(linkTargets(`[${escaped}](${source})`), [source]);
  }
});

test("player and public cards keep only verified source links when titles and authors contain masked-link fragments", async () => {
  const h = fixture(`Known song](${hostile}) [`, `Uploader [account](${hostile})`);
  const sent: Payload[] = [], edited: Payload[] = [];
  const channel = { id: "text", send: async (payload: unknown) => { sent.push(payload as Payload); return { id: "card" }; }, messages: { fetch: async () => ({ edit: async (payload: unknown) => { edited.push(payload as Payload); } }) } };
  try {
    const panel = h.controller["panel"](h.session);
    assertPlayer(panel.embeds[0].toJSON());
    assert.deepEqual(panel.allowedMentions.parse, []);
    await h.controller["detailsView"](h.interaction as never);
    const details = h.reply().embeds[0].toJSON();
    assert.deepEqual(linkTargets(details.description!), [source]);
    assert.deepEqual(linkTargets(details.fields!.find(field => field.name === "Requested via Spotify")!.value), [spotify]);
    assert.deepEqual(h.reply().allowedMentions?.parse, []);
    assert.equal(literal(metadataText(h.session.current!.recording.title)), h.session.current!.recording.title);
    await h.controller["publicPlayer"].update(channel, h.session);
    assertPlayer(sent[0].embeds[0].toJSON());
    assert.deepEqual(sent[0].allowedMentions?.parse, []);
    h.session.history.unshift({ id: "finished", at: Date.now(), entry: h.session.current!, outcome: "finished" });
    h.session.current = undefined; h.session.state = "idle";
    await h.controller["publicPlayer"].update(channel, h.session);
    const archived = edited[0].embeds[0].toJSON();
    assert.equal(archived.title, "Played");
    assert.deepEqual(linkTargets(archived.description!), [source]);
    assert.ok(archived.fields!.every(field => !linkTargets(field.value).includes(hostile)));
  } finally { h.close(); }
});

test("saved playlist descriptions and song charts treat complete uploader links and title fragments as literal metadata", async () => {
  const h = fixture(`Song](${hostile}) [`, `Artist [account](${hostile})`);
  try {
    const list = h.store.library.create("guild", "12345678", "Normal (favorites)", [h.session.current!]);
    await h.library["detail"](h.interaction as never, list);
    const description = h.reply().embeds[0].toJSON().description!;
    assert.deepEqual(linkTargets(description), []);
    assert.ok(literal(description).includes(h.session.current!.recording.author));
    assert.equal(h.reply().embeds[0].toJSON().title, "Normal (favorites)");
    await h.library["stats"](h.interaction as never, "tracks", "30");
    assert.deepEqual(linkTargets(h.reply().embeds[0].toJSON().description!), [source]);
    assert.deepEqual(h.reply().allowedMentions?.parse, []);
  } finally { h.close(); }
});

test("player and chart link labels survive backslash, bracket and Unicode truncation while retaining source clickthroughs", async () => {
  for (const boundary of [99, 499]) for (const ending of ["[", "\\", "🎵"]) {
    const h = fixture("a".repeat(boundary) + ending + `](${hostile}) [`, "Artist (Original)");
    try {
      const panel = h.controller["panel"](h.session).embeds[0].toJSON();
      assertPlayer(panel);
      assert.ok(panel.description!.length <= 500 + source.length + 4);
      await h.controller["detailsView"](h.interaction as never);
      const spotifyField = h.reply().embeds[0].toJSON().fields!.find(field => field.name === "Requested via Spotify")!.value;
      assert.ok(spotifyField.length <= 1024); assert.deepEqual(linkTargets(spotifyField), [spotify]);
      await h.library["stats"](h.interaction as never, "tracks", "30");
      assert.deepEqual(linkTargets(h.reply().embeds[0].toJSON().description!), [source]);
    } finally { h.close(); }
  }
  const h = fixture("Long legitimate title ".repeat(100), "Long legitimate artist ".repeat(100));
  try {
    const panel = h.controller["panel"](h.session).embeds[0].toJSON();
    assertPlayer(panel);
    await h.controller["detailsView"](h.interaction as never);
    const spotifyField = h.reply().embeds[0].toJSON().fields!.find(field => field.name === "Requested via Spotify")!.value;
    assert.ok(spotifyField.length <= 1024); assert.deepEqual(linkTargets(spotifyField), [spotify]);
  } finally { h.close(); }
});
