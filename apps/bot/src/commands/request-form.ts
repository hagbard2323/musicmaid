import { LabelBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, type ModalSubmitInteraction } from "discord.js";
import { env } from "../config/env.js";
import { sourceLabel, type MusicRequest, type RecordingSource } from "../audio/model.js";

export function configuredSearchSources(): RecordingSource[] {
  return [...(env.spotifyDirectEnabled ? ["spotify" as const] : []), "youtube", "soundcloud"];
}
export function sourceBadge(source: RecordingSource): string {
  return `${{ spotify: "🟢", youtube: "🔴", soundcloud: "🟠" }[source]} ${sourceLabel(source)}`;
}
export function musicRequestForm(id: string, source: MusicRequest["source"], review: boolean): ModalBuilder {
  const available = configuredSearchSources();
  const sources = new StringSelectMenuBuilder().setCustomId("sources").setMinValues(1).setMaxValues(available.length).setRequired(true)
    .addOptions(available.map(value => ({ label: sourceBadge(value), value, default: source === "auto" || source === value,
      description: value === "spotify" ? "Original Spotify recordings" : value === "youtube" ? "YouTube music and videos" : "SoundCloud uploads" })));
  const selection = new StringSelectMenuBuilder().setCustomId("selection").setRequired(true).setMinValues(1).setMaxValues(1).addOptions(
    { label: "Auto · ask when unsure", value: "auto", default: !review, description: "Play a clear match; review uncertain results" },
    { label: "Review versions first", value: "review", default: review, description: "Choose a recording before it is queued" });
  return new ModalBuilder().setCustomId(`music-input:${id}`).setTitle("Add music").addLabelComponents(
    new LabelBuilder().setLabel("Song or track link").setDescription("Artist and title work best. A track link selects that recording.")
      .setTextInputComponent(new TextInputBuilder().setCustomId("query").setPlaceholder("Artist — Song, or a track link").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500)),
    new LabelBuilder().setLabel("Search sources").setDescription("Keep all, or choose where to search. Exact playable links take priority.").setStringSelectMenuComponent(sources),
    new LabelBuilder().setLabel("Recording selection").setStringSelectMenuComponent(selection));
}
export function musicRequestFields(fields: Pick<ModalSubmitInteraction["fields"], "getStringSelectValues" | "getTextInputValue">): { query: string; sources: RecordingSource[]; review: boolean } {
  const sources = fields.getStringSelectValues("sources"), selection = fields.getStringSelectValues("selection");
  const available = configuredSearchSources();
  if (!sources.length || sources.length > available.length || new Set(sources).size !== sources.length || sources.some(source => !available.includes(source as RecordingSource))) throw new Error("Choose at least one configured music source.");
  if (selection.length !== 1 || !["auto", "review"].includes(selection[0])) throw new Error("Choose Auto or Review versions first.");
  return { query: fields.getTextInputValue("query"), sources: [...sources] as RecordingSource[], review: selection[0] === "review" };
}
