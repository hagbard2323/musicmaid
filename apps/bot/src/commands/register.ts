import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { env, requireConfiguredGuildId } from "../config/env.js";
const command = (name: string, description: string) => new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false);
export const musicCommands = [
  command("music", "Open current music controls without scrolling through old posts."),
  command("play", "Add music; play clear matches or review versions first.")
    .addStringOption(o => o.setName("query").setDescription("Artist and song, or a track link; leave empty for the input box").setMaxLength(500))
    .addStringOption(o => o.setName("source").setDescription("Search source").addChoices({ name: "All sources", value: "auto" }, { name: "YouTube", value: "youtube" }, { name: "SoundCloud", value: "soundcloud" }, ...(env.spotifyDirectEnabled ? [{ name: "Spotify original", value: "spotify" }] : [])))
    .addBooleanOption(o => o.setName("choices").setDescription("Always show recordings to choose from")),
  command("spotify", env.spotifyDirectEnabled ? "Find and play an original Spotify recording by name or track link." : "Use a Spotify link to find matching YouTube or SoundCloud audio.")
    .addStringOption(o => o.setName("url").setDescription(env.spotifyDirectEnabled ? "Artist and song, or a Spotify track link; leave empty for the input box" : "Spotify track link; leave empty to open the input box").setMaxLength(500))
    .addBooleanOption(o => o.setName("choices").setDescription("Always show recordings to choose from")),
  command("queue", "View or edit upcoming songs.")
    .addStringOption(o => o.setName("action").setDescription("Queue action").addChoices(...["list", "move", "remove", "clear", "shuffle"].map(value => ({ name: value, value }))))
    .addIntegerOption(o => o.setName("from").setDescription("Song position to move or remove").setMinValue(1))
    .addIntegerOption(o => o.setName("to").setDescription("New queue position").setMinValue(1)),
  command("pause", "Pause the current song."),
  command("resume", "Resume playback or a saved queue."),
  command("skip", "Skip the current song."),
  command("stop", "Stop, clear the queue, and disconnect."),
  command("replay", "Play the selected recording again from the beginning."),
  command("seek", "Jump to a position in the current song.").addStringOption(o => o.setName("position").setDescription("Seconds, mm:ss, or hh:mm:ss").setRequired(true)),
  command("volume", "Set playback volume (0–100%).").addIntegerOption(o => o.setName("percent").setDescription("Volume percentage").setRequired(true).setMinValue(0).setMaxValue(100)),
  command("loop", "Set repeat mode.").addStringOption(o => o.setName("mode").setDescription("Repeat mode").setRequired(true).addChoices(...["off", "track", "queue"].map(value => ({ name: value, value })))),
  command("history", "View recent songs and requeue or replace failed requests."),
  command("playlist", "Create, save, import and play your server's playlists.")
    .addSubcommand(o => o.setName("list").setDescription("Browse saved playlists."))
    .addSubcommand(o => o.setName("create").setDescription("Create a named playlist."))
    .addSubcommand(o => o.setName("save").setDescription("Save the current track and upcoming queue."))
    .addSubcommand(o => o.setName("import").setDescription("Import a YouTube or Spotify playlist into your library."))
    .addSubcommand(o => o.setName("import-file").setDescription("Create a playlist from a MusicMaid JSON export.")
      .addAttachmentOption(v => v.setName("file").setDescription("MusicMaid playlist JSON file").setRequired(true))
      .addStringOption(v => v.setName("name").setDescription("Optional name for this imported copy").setMaxLength(60)))
    .addSubcommand(o => o.setName("export").setDescription("Download a saved playlist as a portable JSON file.")
      .addStringOption(v => v.setName("name").setDescription("Saved playlist name").setRequired(true).setMaxLength(60)))
    .addSubcommand(o => o.setName("play").setDescription("Append a saved playlist to the queue.").addStringOption(v => v.setName("name").setDescription("Saved playlist name").setRequired(true).setMaxLength(60))),
  command("music-stats", "Browse your server's top songs, contributors and genre mix."),
  command("music-admin", "Moderator diagnostics and recovery.")
    .addSubcommand(o => o.setName("panel").setDescription("Create or pin the permanent MusicMaid console."))
    .addSubcommand(o => o.setName("status").setDescription("Show playback and service health."))
    .addSubcommand(o => o.setName("diagnostic").setDescription("Download a private diagnostic summary without listening details or identities."))
    .addSubcommand(o => o.setName("diagnose").setDescription("Probe source lookup, cipher, and voice readiness."))
    .addSubcommand(o => o.setName("repair").setDescription("Reconnect this session and retry its selected recording."))
    .addSubcommand(o => o.setName("restart").setDescription("Confirm a service restart; keep the queue.").addStringOption(v => v.setName("target").setDescription("Service to restart").addChoices(...["bot", "audio", "cipher", "viewer"].map(value => ({ name: value, value })))) )
];
export async function registerCommands(options: { guildId?: string; rest?: Pick<REST, "put"> } = {}): Promise<void> {
  const guildId = requireConfiguredGuildId(options.guildId ?? env.discordGuildId);
  const rest = options.rest ?? new REST({ version: "10" }).setToken(env.discordToken);
  await rest.put(Routes.applicationGuildCommands(env.discordClientId, guildId), { body: musicCommands.map(c => c.toJSON()) });
  console.info("Registered MusicMaid guild commands.");
}
