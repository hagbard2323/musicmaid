import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder, GuildMember,
  MessageFlags, ModalBuilder, PermissionFlagsBits, StringSelectMenuBuilder, TextInputBuilder,
  TextInputStyle, type ButtonInteraction, type ChatInputCommandInteraction,
  version as discordVersion, type Interaction, type ModalSubmitInteraction, type StringSelectMenuInteraction
} from "discord.js";
import { Constants as ShoukakuConstants } from "shoukaku";
import { MusicCoordinator } from "../audio/coordinator.js";
import { metadataText } from "./metadata-text.js";
import { duration, entryFor, sourceLabel, type MusicRequest, type QueueEntry, type Recording, type Session } from "../audio/model.js";
import { recordingFor, searchTracks, type Loader, type SearchResult } from "../audio/sources.js";
import { isSpotifyInput, parseSpotifyReference, resolveSpotifyTrackMetadata } from "../audio/spotify.js";
import { bestMatch, clearMatch } from "../audio/matching.js";
import { failureMessage, incident, safeError } from "../audio/diagnostics.js";
import { sourceHealth } from "../audio/track-health.js";
import { probeStream } from "../audio/source-probe.js";
import { resetYoutubeDecoderCache } from "../audio/youtube.js";
import { voiceBlockReason, voiceReadiness, voiceReadinessLine } from "../audio/voice-readiness.js";
import { getLavalink, getLavalinkStatusLines } from "../audio/lavalink.js";
import { lavalinkInfo } from "../audio/lavalink-rest.js";
import { assertGuildScope, env } from "../config/env.js";
import type { MusicStorage } from "../storage/types.js";
import { InteractionState, parsePosition } from "./interaction-state.js";
import { reserveRestart, restartService, type RestartTarget } from "./service-admin.js";
import { PublicPlayerFeed } from "./public-player.js";
import { LibraryController } from "./library.js";
import { musicRequestFields, musicRequestForm, sourceBadge } from "./request-form.js";
import { MemberSearches, SearchReplaced } from "./request-search.js";
import { getReleaseInfo } from "../runtime/release-info.js";
import { abortable } from "../audio/source-errors.js";
import { diagnosticAudioSnapshot, diagnosticDownload, type DiagnosticAudio } from "./diagnostic-download.js";

type MusicInteraction = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;
type Menu =
  | { kind: "spotify_input"; voiceChannelId: string; forceChoices: boolean }
  | { kind: "music_input"; voiceChannelId: string; forceChoices: boolean; source: MusicRequest["source"]; native?: boolean }
  | { kind: "volume_input" }
  | { kind: "picker"; result: SearchResult; voiceChannelId: string; failedEntryId?: string; tried?: string[]; replaceOnly?: boolean }
  | { kind: "recording_confirmation"; result: SearchResult; recording: Recording; voiceChannelId: string; failedEntryId?: string; replaceOnly?: boolean }
  | { kind: "queue"; revision: number; page: number; entryId?: string }
  | { kind: "history"; page: number }
  | { kind: "restart"; target: RestartTarget };
const ephemeral = MessageFlags.Ephemeral;
const button = (id: string, label: string, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const buttons = (...items: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(items);
const text = (value: string, limit = 100) => value.slice(0, limit);
const label = (r: Recording, limit = Infinity) => metadataText(`${r.title} — ${r.author}`, limit);
type PlaybackReceipt = { interaction: MusicInteraction; entry: QueueEntry; voiceChannelId: string; components: ActionRowBuilder<ButtonBuilder>[]; pending: Promise<void>; lastContent?: string; timer: NodeJS.Timeout };
type QueueViewOptions = { entryId?: string; notice?: string; followSelection?: boolean };

export class MusicController {
  private menus = new InteractionState<Menu>();
  private searches = new MemberSearches();
  private panels = new Map<string, { dirty: boolean; timer?: NodeJS.Timeout; running: boolean; pending?: Promise<void> }>();
  private seen = new Map<string, number>();
  private receipts = new Map<string, PlaybackReceipt>();
  private publicPlayer: PublicPlayerFeed;
  private library?: LibraryController;
  private closing = false;
  onRestore: () => Promise<void> = async () => {};
  viewerReady: () => boolean = () => false;
  constructor(private client: Client, readonly music: MusicCoordinator, private load: Loader, private store: MusicStorage, private restart = restartService, private allowedGuildId?: string) {
    this.publicPlayer = new PublicPlayerFeed(store, session => this.panel(session));
    if (store.library) this.library = new LibraryController(music, store.library, load, (i, voice) => this.access(i, false, voice), i => {
      try { this.access(i, true, false); return true; } catch { return false; }
    });
  }
  close(): void {
    this.closing = true; this.library?.close(); this.searches.close();
    for (const receipt of this.receipts.values()) clearTimeout(receipt.timer);
    this.receipts.clear();
    for (const panel of this.panels.values()) if (panel.timer) clearTimeout(panel.timer);
  }

  async verifySpotify(): Promise<string> {
    if (!env.spotifyClientId || !env.spotifyClientSecret) return "not configured";
    try {
      const track = await resolveSpotifyTrackMetadata("spotify:track:0fahUDIRujvV16hAQNtWha");
      const result = track ? "verified — " + track.name : "no track found";
      incident("spotify_metadata_check", { success: Boolean(track), trackId: track?.id, title: track?.name });
      return result;
    } catch (error) { const result = safeError(error); incident("spotify_metadata_check", { success: false, error: result }); return result; }
  }

  changed(session: Session): void {
    if (this.closing) return;
    for (const receipt of this.receipts.values()) if (receipt.interaction.guildId === session.guildId) this.refreshReceipt(receipt);
    if (!session.textChannelId) return;
    const work = this.panels.get(session.guildId) ?? { dirty: false, running: false };
    work.dirty = true; this.panels.set(session.guildId, work);
    if (work.running || work.timer) return;
    work.timer = setTimeout(() => { work.timer = undefined; work.pending = this.updatePanel(session.guildId); }, 1000);
    work.timer.unref();
  }
  private async confirmPlayback(i: MusicInteraction, entry: QueueEntry, voiceChannelId: string, components: ActionRowBuilder<ButtonBuilder>[] = []): Promise<void> {
    const timer = setTimeout(() => this.receipts.delete(i.id), 120_000);
    timer.unref();
    const receipt: PlaybackReceipt = { interaction: i, entry, voiceChannelId, components, pending: Promise.resolve(), timer };
    this.receipts.set(i.id, receipt);
    this.refreshReceipt(receipt);
    await receipt.pending;
  }
  private refreshReceipt(receipt: PlaybackReceipt): void {
    receipt.pending = receipt.pending.then(async () => {
      const i = receipt.interaction;
      if (this.receipts.get(i.id) !== receipt) return;
      const session = this.music.snapshot(i.guildId!);
      const recording = session.current?.id === receipt.entry.id ? session.current.recording : receipt.entry.recording;
      const track = `${label(recording, 650)} · ${duration(recording.durationMs)} · ${sourceBadge(recording.source)} audio${receipt.entry.request.spotify ? " (Spotify request)" : ""}`;
      const place = `<#${receipt.voiceChannelId}>`;
      const position = session.queue.findIndex(entry => entry.id === receipt.entry.id) + 1;
      let content: string, finished = false;
      let components = receipt.components;
      if (session.current?.id === receipt.entry.id) {
        if (session.state === "playing") { content = `Playing in ${place}: ${track}`; finished = true; }
        else if (session.state === "paused") { content = `Paused in ${place}: ${track}`; finished = true; }
        else if (session.failure && ["awaiting_choice", "suspended"].includes(session.state)) {
          content = `Couldn’t start in ${place}: ${track}\n${failureMessage(session.failure.reason)}\nIncident ${session.failure.incidentId}`;
          components = receipt.components.length ? receipt.components : [buttons(button(`m:retry:${receipt.entry.id}`, "Retry"), button(`m:alternative:${receipt.entry.id}`, "Choose another recording"))];
          finished = true;
        } else if (session.state === "suspended") { content = `Saved and paused: ${track}. Use Resume to start in ${place}.`; finished = true; }
        else content = `${session.state === "recovering" ? "Retrying" : "Starting"} in ${place}: ${track}`;
      } else if (position) content = `Queued #${position} for ${place}: ${track}`;
      else {
        const history = session.history.find(item => item.entry.id === receipt.entry.id);
        content = history?.outcome === "failed" ? `Couldn’t play: ${track}\n${failureMessage(history.reason ?? "Playback failed")}` : `This request is no longer queued: ${track}`;
        finished = true; components = [];
      }
      if (content !== receipt.lastContent) {
        receipt.lastContent = content;
        await i.editReply({ content, components, embeds: [], flags: MessageFlags.SuppressEmbeds, allowedMentions: { parse: [] } });
      }
      if (finished) { clearTimeout(receipt.timer); this.receipts.delete(i.id); }
    }).catch(() => {
      clearTimeout(receipt.timer); this.receipts.delete(receipt.interaction.id);
      incident("playback_receipt_unavailable", { guildId: receipt.interaction.guildId, entryId: receipt.entry.id });
    });
  }
  private async updatePanel(guildId: string): Promise<void> {
    const work = this.panels.get(guildId)!;
    if (work.running) return;
    work.running = true; work.dirty = false;
    try {
      let session = this.music.snapshot(guildId);
      const channel = session.textChannelId ? await this.client.channels.fetch(session.textChannelId) : null;
      if (!channel?.isTextBased() || !("send" in channel)) return;
      const message = session.panelMessageId ? await channel.messages.fetch(session.panelMessageId).catch((error: unknown) => {
        if ((error as { code?: number }).code === 10008) return null;
        throw error;
      }) : null;
      // Discord fetches may outlast a track transition. Render from the current
      // coordinator state, never the snapshot taken before those requests.
      session = this.music.snapshot(guildId);
      if (session.textChannelId !== channel.id) return;
      const payload = this.panel(session);
      if (message) await message.edit(payload);
      else { const sent = await channel.send(payload); await this.music.setPanel(guildId, sent.id); }
      await this.publicPlayer.update(channel, this.music.snapshot(guildId), () => this.music.snapshot(guildId));
    } catch (error) { incident("panel_update_failed", { guildId, error: safeError(error) }); }
    finally {
      work.running = false;
      if (work.dirty) { work.timer = setTimeout(() => { work.timer = undefined; work.pending = this.updatePanel(guildId); }, 4000); work.timer.unref(); }
    }
  }
  private async currentPlayer(i: MusicInteraction): Promise<void> {
    const session = this.music.snapshot(i.guildId!);
    const payload = this.panel(session);
    payload.embeds[0].setTitle(session.current ? "Current player" : "MusicMaid");
    const current = this.publicPlayer.currentMessage(session);
    if (env.discordMusicTextChannelId && i.channelId !== env.discordMusicTextChannelId) {
      const target = current ?? (session.panelMessageId && session.textChannelId ? { messageId: session.panelMessageId, channelId: session.textChannelId } : undefined);
      await i.editReply({ embeds: payload.embeds, allowedMentions: payload.allowedMentions,
        content: `Music controls are in <#${env.discordMusicTextChannelId}>.`,
        components: target ? [buttons(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(current ? "Open playing message" : "Open music console").setURL(`https://discord.com/channels/${session.guildId}/${target.channelId}/${target.messageId}`))] : [] });
      return;
    }
    const navigation = buttons(button("m:current", "Refresh player"));
    if (current) navigation.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Jump to playing message").setURL(`https://discord.com/channels/${session.guildId}/${current.channelId}/${current.messageId}`));
    payload.components.push(navigation);
    await i.editReply({ ...payload, content: "Controls for the current session. Refresh after the song changes." });
  }
  private panel(session: Session, showProgress = true) {
    const current = session.current;
    const embed = new EmbedBuilder().setColor(session.failure ? 0xe59c35 : 0xf5b301).setTitle("MusicMaid Console")
      .setDescription(current ? `[${label(current.recording, 500)}](${current.recording.uri})` : "Ready for music. **Add music** opens song input, source choices and version selection.")
      .setFooter({ text: `${session.queue.length} queued · ${(session.queueMode ?? "fifo") === "fair" ? "Fair turns" : "FIFO order"} · Repeat: ${session.loop} · Volume: ${session.volume}%` });
    if (current) {
      embed.addFields({ name: "Playback", value: `${session.state.replaceAll("_", " ")} · ${showProgress ? duration(session.positionMs) + " / " : ""}${current.recording.isStream ? "Live" : duration(current.recording.durationMs)}` },
        { name: "Audio source", value: `${sourceBadge(current.recording.source)}${current.recording.source === "spotify" ? " · original audio" : current.request.spotify ? " · matched from Spotify request" : ""}`, inline: true }, { name: "Requested by", value: `<@${current.request.requestedBy}>`, inline: true });
      if (current.recording.artworkUrl?.startsWith("https://")) embed.setThumbnail(current.recording.artworkUrl);
    }
    embed.addFields({ name: `Up next · ${session.queue.length} queued`, value: session.queue.length ? text(session.queue.slice(0, 3).map((entry, index) => `${index + 1}. ${label(entry.recording)} · ${duration(entry.recording.durationMs)}`).join("\n"), 1024) : "Queue is empty. Add music to keep it going." });
    if (session.failure) embed.addFields({ name: "Playback needs attention", value: `${failureMessage(session.failure.reason)}\nIncident ${session.failure.incidentId}${session.state === "awaiting_choice" && session.failure.deadline !== undefined ? ` · Next queued song <t:${Math.floor(session.failure.deadline / 1000)}:R>` : ""}` });
    const canResume = session.state === "paused" || session.state === "suspended";
    const id = current?.id ?? "idle";
    const components = [
      buttons(button("m:play", "Add music", ButtonStyle.Primary), button(`m:${canResume ? "resume" : "pause"}:${id}`, canResume ? "Resume" : "Pause").setDisabled(canResume ? !current && !session.queue.length : !current || session.state !== "playing"), button(`m:skip:${id}`, "Skip").setDisabled(!current), button(`m:stop:${id}`, "Stop and clear", ButtonStyle.Danger).setDisabled(!current && !session.queue.length), button("m:queue", "Queue")),
      buttons(button(`m:alternative:${id}`, "Change version").setDisabled(!current), button(`m:retry:${id}`, "Retry same track").setDisabled(!current), button(`pl:add:${id}`, "Save track").setDisabled(!current), button("pl:list", "Playlists"), button("m:history", "History"))
    ];
    components.push(buttons(button("m:loop", `Repeat: ${session.loop}`), button("m:volume", `Volume: ${session.volume}%`), button("stats:tracks:30", "Stats"), button("m:details", "Details")));
    if (this.viewerReady() && current?.recording.source === "youtube") components[2].addComponents(button(`m:watch:${id}`, "Watch video", ButtonStyle.Primary));
    if (!current) embed.addFields({ name: "Choose how to play", value: "**Auto** starts clear matches and asks when unsure. **Review versions first** lets you choose. Select one or more sources in Add music; a playable track link selects that recording." });
    return { embeds: [embed], components, allowedMentions: { parse: [] as [] } };
  }
  private async detailsView(i: MusicInteraction): Promise<void> {
    const session = this.music.snapshot(i.guildId!), current = session.current;
    const embed = new EmbedBuilder().setColor(0xf5b301).setTitle("Playback details");
    if (current) {
      embed.setDescription(`[${label(current.recording, 500)}](${current.recording.uri})`);
      embed.addFields({ name: "Actual audio source", value: sourceBadge(current.recording.source) }, { name: "Uploader / artist", value: metadataText(current.recording.author, 500) });
      const quality = current.recording.audioQuality;
      embed.addFields({ name: "Source format", value: quality && quality.codec !== "unknown" ? `${quality.codec.startsWith("mp4a") ? "AAC" : metadataText(quality.codec.toUpperCase(), 50)}${quality.bitrateKbps ? ` · ~${quality.bitrateKbps} kb/s` : ""}${quality.sampleRateHz ? ` · ${quality.sampleRateHz / 1000} kHz` : ""}` : "Not reported by this source." });
      if (current.request.spotify) embed.addFields({ name: "Requested via Spotify", value: `[${metadataText(current.request.spotify.title, 500)}](https://open.spotify.com/track/${current.request.spotify.id}) — ${metadataText(current.request.spotify.artists.join(", "), 300)}\n${current.recording.source === "spotify" ? "Original Spotify audio." : `Matched ${sourceLabel(current.recording.source)} audio; metadata alone cannot verify an identical master.`}` });
    } else embed.setDescription("Nothing is playing yet.");
    embed.addFields({ name: "Queue policy", value: (session.queueMode ?? "fifo") === "fair" ? `Fair turns between requesters.${session.loop === "track" ? " Repeat-one temporarily holds the turn until repeat is changed." : ""}` : "FIFO: songs play in queue order." });
    await i.editReply({ content: null, embeds: [embed], components: [buttons(button("m:current", "Current player"), button("m:queue", "Queue"))], allowedMentions: { parse: [] } });
  }
  private access(i: MusicInteraction, admin = false, needsVoice = true): { guildId: string; voiceChannelId: string } {
    assertGuildScope(i.guildId, this.allowedGuildId);
    if (!i.guildId || !i.guild) throw new Error("Use this command in the server.");
    const member = i.member instanceof GuildMember ? i.member : i.guild.members.cache.get(i.user.id);
    if (admin) {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) && !env.discordBotAdminRoleIds.some(role => member?.roles.cache.has(role))) throw new Error("You need Manage Server or a configured moderator role.");
      return { guildId: i.guildId, voiceChannelId: this.music.snapshot(i.guildId).voiceChannelId ?? member?.voice.channelId ?? "" };
    }
    if (env.discordMusicTextChannelId && i.channelId !== env.discordMusicTextChannelId && !(i.isChatInputCommand() && i.commandName === "music")) throw new Error("Use the music text channel for music commands.");
    const voiceChannelId = member?.voice.channelId ?? "";
    if (needsVoice && !voiceChannelId) throw new Error("Join a voice channel first.");
    const session = this.music.snapshot(i.guildId);
    const me = i.guild.members.me;
    const emptyAndDisconnected = me && !me.voice.channelId && !session.current && !session.queue.length;
    if (needsVoice && !emptyAndDisconnected && session.voiceChannelId && session.voiceChannelId !== voiceChannelId) throw new Error("Join the bot’s voice channel to control its music.");
    const startsPlayback = i.isChatInputCommand() ? ["play", "resume", "spotify"].includes(i.commandName) : (i.isButton() && (/^(?:m:(resume|retry):|confirm-track:|try-next:)/.test(i.customId) || ["m:spotify", "m:play", "m:choose"].includes(i.customId))) || (i.isStringSelectMenu() && i.customId.startsWith("pick:"));
    if (needsVoice && startsPlayback && member?.voice.channel) {
      const permissions = me ? member.voice.channel.permissionsFor(me) : null;
      if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) throw new Error("MusicMaid needs View Channel, Connect and Speak permissions in your voice channel.");
      const status = voiceReadiness(i.guild, voiceChannelId);
      if (status) { const reason = voiceBlockReason(status); if (reason) throw new Error(reason); }
      if (member.voice.channel.type === ChannelType.GuildStageVoice) throw new Error("Use a regular voice channel for music.");
      if (me?.voice.serverMute) throw new Error("A moderator needs to unmute the bot in voice.");
    }
    return { guildId: i.guildId, voiceChannelId };
  }
  async handle(raw: Interaction): Promise<void> {
    if (!(raw.isChatInputCommand() || raw.isButton() || raw.isStringSelectMenu() || raw.isModalSubmit())) return;
    const i = raw;
    try {
      assertGuildScope(i.guildId, this.allowedGuildId);
      if (this.seen.has(i.id)) return;
      this.seen.set(i.id, Date.now());
      for (const [id, at] of this.seen) if (Date.now() - at > 300_000) this.seen.delete(id);
      if (this.closing) throw new Error("MusicMaid is restarting. Your queue is saved; try again shortly.");
      if (this.library?.handles(i)) { await this.library.handle(i); return; }
      const isAdmin = i.isChatInputCommand() ? i.commandName === "music-admin" : i.customId.startsWith("admin:");
      this.access(i, isAdmin, !this.viewOnly(i));
      if (i.isButton() && i.customId.startsWith("m:watch:")) {
        const current = this.music.snapshot(i.guildId!).current;
        if (!this.viewerReady()) throw new Error("The optional viewer is not ready. Music playback continues normally.");
        if (!current || current.id !== i.customId.slice(8) || current.recording.source !== "youtube") throw new Error("That video is no longer current. Use Watch video on the current player.");
        await i.launchActivity(); return;
      }
      if ((i.isButton() && ["m:play", "m:choose", "m:youtube"].includes(i.customId)) || (i.isChatInputCommand() && i.commandName === "play" && !i.options.getString("query"))) {
        const forceChoices = i.isButton() ? i.customId === "m:choose" : i.options.getBoolean("choices") ?? false;
        await this.musicModal(i, forceChoices);
        return;
      }
      if (i.isButton() && i.customId === "m:volume") {
        const id = this.menus.create(i.user.id, i.guildId!, { kind: "volume_input" });
        const field = new TextInputBuilder().setCustomId("volume").setLabel("Volume (0–100%)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3).setValue(String(this.music.snapshot(i.guildId!).volume));
        await i.showModal(new ModalBuilder().setCustomId(`volume:${id}`).setTitle("Playback volume").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(field)));
        return;
      }
      if ((i.isButton() && i.customId === "m:spotify") || (i.isChatInputCommand() && i.commandName === "spotify" && !i.options.getString("url"))) {
        await this.spotifyModal(i);
        return;
      }
      if (i.isButton() && i.customId.startsWith("qmove:")) {
        const id = i.customId.split(":")[1]; const menu = this.menus.read(id, i.user.id, i.guildId!);
        if (menu.kind !== "queue" || !menu.entryId) throw new Error("Choose a queued song first.");
        const session = this.music.snapshot(i.guildId!);
        if (session.revision !== menu.revision || session.queueMode === "fair" || !session.queue.some(entry => entry.id === menu.entryId)) {
          if (i.message.flags.has(ephemeral)) await i.deferUpdate(); else await i.deferReply({ flags: ephemeral });
          await this.queueView(i, menu.page, { entryId: menu.entryId, notice: session.queueMode === "fair" ? "Fair turns control the order. A moderator can select FIFO for manual moves." : "The queue changed. Review its current order before moving this song." }); return;
        }
        const field = new TextInputBuilder().setCustomId("position").setLabel("New queue position").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3).setValue(String(session.queue.findIndex(entry => entry.id === menu.entryId) + 1));
        await i.showModal(new ModalBuilder().setCustomId(`qmove:${id}`).setTitle("Move song").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(field)));
        return;
      }
      if (i.isModalSubmit() && i.customId.startsWith("qmove:") && i.isFromMessage() && i.message.flags.has(ephemeral)) await i.deferUpdate();
      else if ((i.isButton() || i.isStringSelectMenu()) && (["m:current", "m:details"].includes(i.customId) || /^(?:qpage|qmode|hpage|qedit|qselect|hselect|pickpage|pick|confirm-track|back-versions):/.test(i.customId)) && i.message.flags.has(ephemeral)) await i.deferUpdate();
      else await i.deferReply({ flags: ephemeral });
      if (i.isChatInputCommand()) await this.command(i);
      else if (i.isStringSelectMenu()) await this.select(i);
      else if (i.isModalSubmit()) await this.modal(i);
      else await this.click(i);
    } catch (error) {
      const id = error instanceof SearchReplaced ? undefined : incident("interaction_failed", { error: safeError(error), guildId: i.guildId });
      const content = `${safeError(error)}${id ? `\nIncident ${id}` : ""}`;
      if (i.deferred || i.replied) await i.editReply({ content, components: [], embeds: [], allowedMentions: { parse: [] } }).catch(() => {});
      else await i.reply({ content, flags: ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
    }
  }
  private viewOnly(i: MusicInteraction): boolean {
    if (i.isChatInputCommand()) return ["music", "queue", "history"].includes(i.commandName);
    if (i.isButton()) return ["m:current", "m:details", "m:queue", "m:history"].includes(i.customId) || /^(?:qpage|qmode|hpage):/.test(i.customId);
    return i.isStringSelectMenu() && /^(?:qselect|hselect):/.test(i.customId);
  }
  private async command(i: ChatInputCommandInteraction): Promise<void> {
    const { guildId, voiceChannelId } = this.access(i, i.commandName === "music-admin", !this.viewOnly(i));
    const session = this.music.snapshot(guildId);
    switch (i.commandName) {
      case "music": {
        await this.currentPlayer(i);
        return;
      }
      case "spotify": await this.spotifySearch(i, i.options.getString("url", true), voiceChannelId, i.options.getBoolean("choices") ?? false); return;
      case "play": {
        const choices = i.options.getBoolean("choices") ?? false;
        await this.search(i, { query: i.options.getString("query", true), source: (i.options.getString("source") ?? "auto") as MusicRequest["source"], requestedBy: i.user.id }, choices,
          (result, signal) => this.presentSearch(i, result, voiceChannelId, choices, signal));
        return;
      }
      case "queue": {
        const action = i.options.getString("action") ?? "list";
        if (action !== "list") {
          this.access(i);
          if (!["move", "remove", "clear", "shuffle"].includes(action)) throw new Error("Unknown queue action.");
          const from = i.options.getInteger("from");
          await this.music.editQueue(guildId, session.revision, action as "move" | "remove" | "clear" | "shuffle", from ? session.queue[from - 1]?.id : undefined, i.options.getInteger("to") ?? undefined);
        }
        await this.queueView(i); return;
      }
      case "history": await this.historyView(i); return;
      case "pause": await this.music.pause(guildId, session.current?.id); break;
      case "resume": await this.music.resume(guildId, voiceChannelId, i.channelId); break;
      case "skip": await this.music.skip(guildId, session.current?.id); break;
      case "stop": await this.music.stop(guildId); break;
      case "replay": await this.music.seek(guildId, 0, session.current?.id); break;
      case "seek": await this.music.seek(guildId, parsePosition(i.options.getString("position", true)), session.current?.id); break;
      case "volume": await this.music.setVolume(guildId, i.options.getInteger("percent", true)); break;
      case "loop": await this.music.setLoop(guildId, i.options.getString("mode", true) as Session["loop"]); break;
      case "music-admin": await this.admin(i); return;
      default: throw new Error("This command is no longer supported. Use /play or /queue.");
    }
    await i.editReply("Done.");
  }
  private async search(i: MusicInteraction, request: MusicRequest, review: boolean, present: (result: SearchResult, signal: AbortSignal) => Promise<void>): Promise<void> {
    await this.searches.run(i.guildId!, i.user.id, async signal => {
      const result = await searchTracks(this.load, request, review, { signal });
      signal.throwIfAborted();
      await present(result, signal);
    });
  }
  private async presentSearch(i: MusicInteraction, result: SearchResult, voiceChannelId: string, forceChoices: boolean, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!i.channelId) throw new Error("Use music controls in a server text channel.");
    if (this.access(i).voiceChannelId !== voiceChannelId) throw new Error("You changed voice channels. Submit the request again from your current channel.");
    if (forceChoices) { await this.picker(i, result, voiceChannelId); return; }
    const selected = result.direct ? result.candidates[0] : clearMatch(result);
    if (!selected) {
      if (!result.candidates.length) { await this.picker(i, result, voiceChannelId); return; }
      await this.picker(i, result, voiceChannelId);
      return;
    }
    await this.startChosen(i, result, selected, voiceChannelId, undefined, [], signal);
  }
  private async startChosen(i: MusicInteraction, result: SearchResult, selected: Recording, voiceChannelId: string, replaceId?: string, tried: string[] = [], signal?: AbortSignal): Promise<void> {
    if (!i.channelId) throw new Error("Use the music text channel for music requests.");
    const textChannelId = i.channelId;
    if (this.access(i).voiceChannelId !== voiceChannelId) throw new Error("You changed voice channels. Submit the request again from your current channel.");
    signal?.throwIfAborted();
    const entry = entryFor(result.request, selected);
    if (replaceId) await this.music.chooseAlternative(i.guildId!, replaceId, entry, voiceChannelId, textChannelId, signal);
    else await this.music.enqueue(i.guildId!, entry, voiceChannelId, textChannelId, signal);
    const components = [];
    if (!result.direct) {
      const previous = [...new Set([...tried, selected.uri])];
      const id = this.menus.create(i.user.id, i.guildId!, { kind: "picker", result, voiceChannelId, failedEntryId: entry.id, tried: previous });
      components.push(buttons(button(`try-next:${id}`, "Try next match").setDisabled(!result.moreAvailable && !bestMatch(result, previous)), button(`versions:${id}`, "Choose version")));
    }
    incident("search_selected", { guildId: i.guildId, entryId: entry.id, mode: result.direct ? "exact_link" : "automatic", source: selected.source, title: selected.title, author: selected.author, durationMs: selected.durationMs, spotifyId: result.request.spotify?.id });
    await this.confirmPlayback(i, entry, voiceChannelId, components);
  }
  private async picker(i: MusicInteraction, result: SearchResult, voiceChannelId: string, failedEntryId?: string, requestedPage = 0, existingId?: string, replaceOnly = false): Promise<void> {
    if (!result.candidates.length) {
      await i.editReply({ content: `No matching uploads were found.${result.notices.length ? "\n" + result.notices.map(n => text(n, 250)).join("\n") : ""}`, components: [] }); return;
    }
    const id = existingId ?? this.menus.create(i.user.id, i.guildId!, { kind: "picker", result, voiceChannelId, failedEntryId, replaceOnly });
    const page = Math.max(0, Math.min(Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0, Math.ceil(result.candidates.length / 3) - 1));
    const candidates = result.candidates.slice(page * 3, page * 3 + 3);
    const menu = new StringSelectMenuBuilder().setCustomId(`pick:${id}`).setPlaceholder("Select a version to review")
      .addOptions(candidates.map((r, index) => ({ label: text(r.title), description: text(`${sourceBadge(r.source)} · ${r.author} · ${r.isStream ? "Live" : duration(r.durationMs)}${r.explicit ? " · explicit" : ""}`), value: String(page * 3 + index) })));
    const rows: (ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>)[] = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
    if (result.candidates.length > 3) rows.push(buttons(button(`pickpage:${id}:${page - 1}`, "Previous").setDisabled(page === 0), button(`pickpage:${id}:${page + 1}`, "More choices").setDisabled((page + 1) * 3 >= result.candidates.length)));
    await i.editReply({
      content: `**${replaceOnly ? "Change this request’s version" : "Choose a version"} for <#${voiceChannelId}>**\nSelect below to review it, then press **${replaceOnly ? "Replace with this version" : "Play this version"}**. Page ${page + 1}/${Math.ceil(result.candidates.length / 3)} · expires in 2 minutes.${result.notices.length ? "\nSome sources are unavailable." : ""}`,
      components: rows, embeds: [], flags: MessageFlags.SuppressEmbeds, allowedMentions: { parse: [] }
    });
  }
  private async musicModal(i: ButtonInteraction | ChatInputCommandInteraction, forceChoices: boolean): Promise<void> {
    const { voiceChannelId } = this.access(i);
    const source = i.isChatInputCommand() ? (i.options.getString("source") ?? "auto") as MusicRequest["source"] : i.customId === "m:youtube" ? "youtube" : "auto";
    const id = this.menus.create(i.user.id, i.guildId!, { kind: "music_input", voiceChannelId, forceChoices, source, native: true });
    await i.showModal(musicRequestForm(id, source, forceChoices));
  }
  private async spotifySetup(i: MusicInteraction): Promise<void> {
    let isMod = false;
    try { this.access(i, true); isMod = true; } catch { /* Ordinary listeners see a short setup message. */ }
    const content = isMod
      ? "Spotify setup is needed. Create a Web API app in the Spotify Developer Dashboard using the Premium account, then configure SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the server’s bot .env file and restart MusicMaid. Keep the secret on the server; do not paste it into Discord."
      : "Spotify is not connected yet. Ask a moderator to finish Spotify setup, then try this button again.";
    const components = isMod ? [buttons(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Spotify Developer Dashboard").setURL("https://developer.spotify.com/dashboard"))] : [];
    if (i.deferred || i.replied) await i.editReply({ content, components });
    else await i.reply({ content, components, flags: ephemeral });
  }
  private async spotifyModal(i: ButtonInteraction | ChatInputCommandInteraction): Promise<void> {
    const { voiceChannelId } = this.access(i);
    if (!env.spotifyClientId || !env.spotifyClientSecret) { await this.spotifySetup(i); return; }
    const forceChoices = i.isChatInputCommand() ? i.options.getBoolean("choices") ?? false : false;
    const id = this.menus.create(i.user.id, i.guildId!, { kind: "spotify_input", voiceChannelId, forceChoices });
    const field = new TextInputBuilder().setCustomId("url").setLabel(env.spotifyDirectEnabled ? "Artist and song, or a Spotify track link" : "Spotify track link")
      .setPlaceholder(env.spotifyDirectEnabled ? "Rihanna — Bitch Better Have My Money, or a link" : "https://open.spotify.com/track/…").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500);
    await i.showModal(new ModalBuilder().setCustomId(`spotify:${id}`).setTitle(env.spotifyDirectEnabled ? "Play from Spotify" : "Add a Spotify track").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(field)));
  }
  private async spotifySearch(i: MusicInteraction, url: string, voiceChannelId: string, forceChoices = false): Promise<void> {
    if (!env.spotifyDirectEnabled && !isSpotifyInput(url)) throw new Error("Paste a Spotify track link, such as https://open.spotify.com/track/…");
    if (parseSpotifyReference(url)?.type === "unsupported") throw new Error("Use a Spotify track link here. Open Playlists → Import link for playlists; album import is not available yet.");
    if (!env.spotifyClientId || !env.spotifyClientSecret) { await this.spotifySetup(i); return; }
    await this.search(i, { query: url, source: env.spotifyDirectEnabled ? "spotify" : "auto", requestedBy: i.user.id }, forceChoices,
      (result, signal) => this.presentSearch(i, result, voiceChannelId, forceChoices, signal));
  }
  private async select(i: StringSelectMenuInteraction): Promise<void> {
    const [action, id] = i.customId.split(":");
    const { guildId, voiceChannelId } = this.access(i, false, !this.viewOnly(i));
    const menu = this.menus.read(id, i.user.id, guildId);
    if (action === "pick" && menu.kind === "picker") {
      if (voiceChannelId !== menu.voiceChannelId) throw new Error("You changed voice channels. Search again in your current channel.");
      const recording = menu.result.candidates[Number(i.values[0])];
      if (!recording) throw new Error("That selection is invalid.");
      this.menus.read(id, i.user.id, guildId, true);
      await this.searches.run(guildId, i.user.id, signal => this.reviewRecording(i, menu, recording, voiceChannelId, signal));
      return;
    }
    if (action === "qselect" && menu.kind === "queue") {
      const session = this.music.snapshot(guildId);
      if (session.revision !== menu.revision) { await this.queueView(i, menu.page, { entryId: i.values[0], notice: "The queue changed. Review the selected song in the refreshed order." }); return; }
      const entry = session.queue.find(e => e.id === i.values[0]);
      if (!entry) throw new Error("That song is no longer queued.");
      await this.queueView(i, menu.page, { entryId: entry.id }); return;
    }
    if (action === "hselect" && menu.kind === "history") {
      const item = this.music.snapshot(guildId).history.find(h => h.id === i.values[0]);
      if (!item) throw new Error("That request is no longer in recent history.");
      await i.editReply({ content: `${label(item.entry.recording)} · ${item.outcome}`, components: [buttons(button(`h:requeue:${item.id}`, "Requeue this upload"), button(`h:alternative:${item.id}`, "Choose alternative"))] }); return;
    }
    throw new Error("This menu is no longer supported.");
  }
  private async reviewRecording(i: StringSelectMenuInteraction, menu: Extract<Menu, { kind: "picker" }>, selected: Recording, voiceChannelId: string, signal: AbortSignal): Promise<void> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
    let recording = selected;
    if (recording.source === "youtube") {
      const details = await abortable(this.load(`ytmeta:${recording.identifier}`, bounded), bounded).catch(() => { bounded.throwIfAborted(); return undefined; });
      if (details?.loadType === "track" && details.data.info.identifier === recording.identifier) recording = recordingFor(details.data);
    }
    bounded.throwIfAborted();
    const confirmation = this.menus.create(i.user.id, i.guildId!, { kind: "recording_confirmation", result: menu.result, recording, voiceChannelId, failedEntryId: menu.failedEntryId, replaceOnly: menu.replaceOnly });
    await i.editReply({ content: `**${label(recording, 600)}**\n${duration(recording.durationMs)} · ${sourceBadge(recording.source)} audio${recording.source === "spotify" ? " · original Spotify recording" : menu.result.request.spotify ? " · matched from your Spotify request" : ""}\n${menu.replaceOnly ? "Confirm to replace the selected request; nothing changes until then." : `Press Play to use this recording in <#${voiceChannelId}>.`}`, components: [buttons(button(`confirm-track:${confirmation}`, menu.replaceOnly ? "Replace with this version" : "Play this version", ButtonStyle.Primary), button(`back-versions:${confirmation}`, "Back to versions"), new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Preview source").setURL(recording.uri))], embeds: [], flags: MessageFlags.SuppressEmbeds, allowedMentions: { parse: [] } });
  }
  private async queueView(i: MusicInteraction, requestedPage = 0, options: QueueViewOptions = {}): Promise<void> {
    const s = this.music.snapshot(i.guildId!);
    const selectedAt = s.queue.findIndex(entry => entry.id === options.entryId);
    const selected = selectedAt >= 0 ? s.queue[selectedAt] : undefined;
    if (selected && options.followSelection !== false) requestedPage = Math.floor(selectedAt / 10);
    const page = Math.max(0, Math.min(Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0, Math.ceil(s.queue.length / 10) - 1));
    const entries = s.queue.slice(page * 10, page * 10 + 10);
    const id = this.menus.create(i.user.id, i.guildId!, { kind: "queue", revision: s.revision, page, entryId: selected?.id });
    const rows: (ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>)[] = [];
    if (entries.length) rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`qselect:${id}`).setPlaceholder("Select a song to move or remove").addOptions(entries.map((e, n) => ({ label: text(`${page * 10 + n + 1}. ${e.recording.title}`), description: text(`${e.recording.author} · ${duration(e.recording.durationMs)}`), value: e.id, default: e.id === selected?.id })))));
    const fair = s.queueMode === "fair";
    rows.push(buttons(button(`qpage:previous:${id}`, "Previous page").setDisabled(page === 0), button(`qpage:next:${id}`, "Next page").setDisabled((page + 1) * 10 >= s.queue.length), button(`qpage:refresh:${id}`, "Refresh"), button(`qedit:shuffle:${id}`, "Shuffle").setDisabled(fair || s.queue.length < 2), button(`qedit:clear:${id}`, "Clear upcoming", ButtonStyle.Danger).setDisabled(!s.queue.length)));
    if (selected) rows.push(buttons(button(`qedit:up:${id}`, "Move up").setDisabled(fair || selectedAt === 0), button(`qedit:down:${id}`, "Move down").setDisabled(fair || selectedAt === s.queue.length - 1), button(`qmove:${id}`, "Move to…").setDisabled(fair), button(`qedit:next:${id}`, "Play next").setDisabled(fair || selectedAt === 0), button(`qedit:remove:${id}`, "Remove", ButtonStyle.Danger)));
    const actions = buttons(button("pl:save", "Save queue").setDisabled(!s.current && !s.queue.length), button("pl:list", "Playlists"));
    try { this.access(i, true, false); actions.addComponents(button(`qmode:${fair ? "fifo" : "fair"}:${id}`, fair ? "Use FIFO order" : "Use fair turns")); } catch { /* Queue policy belongs to moderators. */ }
    if (selected && !entries.some(entry => entry.id === selected.id)) actions.addComponents(button(`qpage:selected:${id}`, "Show selected"));
    rows.push(actions);
    const policy = fair ? `Fair turns · one request per member per turn${s.loop === "track" ? " · repeat-one holds this turn" : ""}` : "FIFO · songs play in queue order";
    const selection = selected ? `Selected #${selectedAt + 1}: ${label(selected.recording, 160)}` : options.entryId ? "The selected song has left the queue. Choose another song to edit." : "Choose a song below to edit it.";
    const lines = [`Now: ${s.current ? label(s.current.recording, 180) : "Nothing playing"}`, ...entries.map((e, n) => `${e.id === selected?.id ? "▸ " : ""}${page * 10 + n + 1}. ${label(e.recording, 120)}`)];
    if (!entries.length) lines.push("No upcoming songs.");
    lines.push(`${s.queue.length} queued · Page ${page + 1}`, selection, policy);
    if (options.notice) lines.push(metadataText(options.notice, 180));
    await i.editReply({ content: text(lines.join("\n"), 1950), components: rows, embeds: [], allowedMentions: { parse: [] } });
  }
  private async queueEdit(i: MusicInteraction, menu: Extract<Menu, { kind: "queue" }>, action: "move" | "remove" | "clear" | "shuffle", position?: number): Promise<void> {
    const session = this.music.snapshot(i.guildId!);
    if (session.revision !== menu.revision) {
      await this.queueView(i, menu.page, { entryId: menu.entryId, notice: "The queue changed. No edit was applied; review the refreshed order." }); return;
    }
    try { await this.music.editQueue(i.guildId!, menu.revision, action, menu.entryId, position); }
    catch (error) {
      const id = incident("queue_edit_failed", { guildId: i.guildId, error: safeError(error) });
      await this.queueView(i, menu.page, { entryId: menu.entryId, notice: `Incident ${id}: ${safeError(error)}` }); return;
    }
    await this.queueView(i, menu.page, { entryId: menu.entryId, notice: ({ move: "Moved the selected song.", remove: "Removed the selected song.", clear: "Cleared upcoming songs.", shuffle: "Shuffled upcoming songs." })[action] });
  }
  private async historyView(i: MusicInteraction, requestedPage = 0): Promise<void> {
    const history = this.music.snapshot(i.guildId!).history;
    const page = Math.max(0, Math.min(requestedPage, Math.ceil(history.length / 10) - 1));
    const entries = history.slice(page * 10, page * 10 + 10);
    if (!entries.length) { await i.editReply("No playback history yet."); return; }
    const id = this.menus.create(i.user.id, i.guildId!, { kind: "history", page });
    await i.editReply({ content: "Recent requests — choose one to requeue or find another upload.", components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`hselect:${id}`).setPlaceholder("Choose a recent request").addOptions(entries.map(h => ({ label: text(h.entry.recording.title), description: text(`${h.entry.recording.author} · ${h.outcome}${h.incidentId ? " · " + h.incidentId : ""}`), value: h.id })))), buttons(button(`hpage:${Math.max(0, page - 1)}`, "Previous page").setDisabled(page === 0), button(`hpage:${page + 1}`, "Next page").setDisabled((page + 1) * 10 >= history.length))] });
  }
  private async alternatives(i: MusicInteraction, request: MusicRequest, selected: Recording, voiceChannelId: string, failedEntryId: string, replaceOnly = false): Promise<void> {
    const query = request.spotify ? `${request.spotify.title} ${request.spotify.artists.join(" ")}` : `${selected.title} ${selected.author}`;
    const sources = request.sources ?? (request.source === "auto" ? undefined : [request.source]);
    await this.search(i, { ...request, query, source: "auto", ...(sources ? { sources } : {}), requestedBy: i.user.id }, true, async result => {
      result.candidates = result.candidates.filter(r => r.uri !== selected.uri);
      await this.picker(i, result, voiceChannelId, failedEntryId, 0, undefined, replaceOnly);
    });
  }
  private async click(i: ButtonInteraction): Promise<void> {
    const [prefix, action, id] = i.customId.split(":");
    const { guildId, voiceChannelId } = this.access(i, prefix === "admin", !this.viewOnly(i));
    const s = this.music.snapshot(guildId);
    if (prefix === "confirm-track" || prefix === "back-versions") {
      const menu = this.menus.read(action, i.user.id, guildId, true);
      if (menu.kind !== "recording_confirmation") throw new Error("That recording confirmation has expired.");
      if (voiceChannelId !== menu.voiceChannelId) throw new Error("You changed voice channels. Start a fresh request.");
      if (prefix === "back-versions") { await this.picker(i, menu.result, voiceChannelId, menu.failedEntryId, 0, undefined, menu.replaceOnly); return; }
      if (menu.replaceOnly && menu.failedEntryId !== s.current?.id && !s.queue.some(entry => entry.id === menu.failedEntryId)) throw new Error("That request has already left the queue. Open the current player to change its version.");
      const entry = entryFor(menu.result.request, menu.recording);
      if (menu.failedEntryId) await this.music.chooseAlternative(guildId, menu.failedEntryId, entry, voiceChannelId, i.channelId, undefined, menu.replaceOnly);
      else await this.music.enqueue(guildId, entry, voiceChannelId, i.channelId);
      incident("search_selected", { guildId, entryId: entry.id, mode: "manual", source: menu.recording.source, title: menu.recording.title, author: menu.recording.author, durationMs: menu.recording.durationMs, spotifyId: menu.result.request.spotify?.id });
      await this.confirmPlayback(i, entry, voiceChannelId); return;
    }
    if (prefix === "try-next") {
      const menu = this.menus.read(action, i.user.id, guildId, true);
      if (menu.kind !== "picker" || !menu.failedEntryId) throw new Error("This match control has expired. Start a fresh search.");
      if (menu.result.moreAvailable) {
        await this.search(i, menu.result.request, true, async (result, signal) => {
          const next = bestMatch(result, menu.tried ?? []);
          if (!next) throw new Error("No more suitable matches. Use Change version for a manual choice.");
          await this.startChosen(i, result, next, voiceChannelId, menu.failedEntryId, menu.tried, signal);
        }); return;
      }
      const next = bestMatch(menu.result, menu.tried ?? []);
      if (!next) throw new Error("No more suitable matches. Use Choose version for a manual choice.");
      await this.startChosen(i, menu.result, next, voiceChannelId, menu.failedEntryId, menu.tried);
      return;
    }
    if (prefix === "pickpage" || prefix === "versions") {
      const menu = this.menus.read(action, i.user.id, guildId);
      if (menu.kind !== "picker") throw new Error("This recording menu is no longer available.");
      if (menu.result.moreAvailable) {
        await this.search(i, menu.result.request, true, async result => {
          menu.result = result;
          await this.picker(i, result, menu.voiceChannelId, menu.failedEntryId, prefix === "pickpage" ? Number(id) : 0, action, menu.replaceOnly);
        }); return;
      }
      await this.picker(i, menu.result, menu.voiceChannelId, menu.failedEntryId, prefix === "pickpage" ? Number(id) : 0, action, menu.replaceOnly);
      return;
    }
    if (prefix === "qpage") {
      if (id && !Number.isFinite(Number(id))) {
        const menu = this.menus.read(id, i.user.id, guildId);
        if (menu.kind !== "queue" || !["previous", "next", "refresh", "selected"].includes(action)) throw new Error("Invalid queue navigation.");
        const page = menu.page + (action === "previous" ? -1 : action === "next" ? 1 : 0);
        await this.queueView(i, page, { entryId: menu.entryId, followSelection: action === "refresh" || action === "selected", notice: menu.revision !== s.revision ? "The queue changed; this is its current order." : undefined });
      } else await this.queueView(i, Number(id ?? action));
      return;
    }
    if (prefix === "qmode") {
      this.access(i, true, false);
      if (!["fifo", "fair"].includes(action)) throw new Error("Choose FIFO order or fair turns.");
      const menu = id ? this.menus.read(id, i.user.id, guildId) : undefined;
      if (menu && menu.kind !== "queue") throw new Error("Invalid queue policy control.");
      await this.music.setQueueMode(guildId, action as "fifo" | "fair");
      await this.queueView(i, menu?.kind === "queue" ? menu.page : 0, { entryId: menu?.kind === "queue" ? menu.entryId : undefined }); return;
    }
    if (prefix === "hpage") { await this.historyView(i, Number(action)); return; }
    if (prefix === "qedit") {
      const menu = this.menus.read(id, i.user.id, guildId);
      if (menu.kind !== "queue") throw new Error("Invalid queue menu.");
      const at = s.queue.findIndex(e => e.id === menu.entryId) + 1;
      if (action === "clear" || action === "shuffle" || action === "remove") await this.queueEdit(i, menu, action);
      else if (["up", "down", "next"].includes(action)) await this.queueEdit(i, menu, "move", action === "next" ? 1 : Math.max(1, Math.min(s.queue.length, at + (action === "up" ? -1 : 1))));
      else throw new Error("Unknown queue edit.");
      return;
    }
    if (prefix === "h") {
      const item = s.history.find(h => h.id === id);
      if (!item) throw new Error("This request is no longer in history.");
      if (action === "alternative") { await this.alternatives(i, item.entry.request, item.entry.recording, voiceChannelId, item.entry.id); return; }
      await this.music.enqueue(guildId, entryFor({ ...item.entry.request, requestedBy: i.user.id }, item.entry.recording), voiceChannelId, i.channelId);
      await i.editReply("Added that upload to the queue."); return;
    }
    if (prefix === "admin") { await this.confirmRestart(i, action, id); return; }
    if (prefix !== "m") throw new Error("This button belongs to an older release. Open /queue or /play again.");
    if (action === "current") { await this.currentPlayer(i); return; }
    if (action === "details") { await this.detailsView(i); return; }
    if (action === "queue") { await this.queueView(i); return; }
    if (action === "history") { await this.historyView(i); return; }
    if (action === "loop") {
      const modes: Session["loop"][] = ["off", "track", "queue"];
      const mode = modes[(modes.indexOf(s.loop) + 1) % modes.length];
      await this.music.setLoop(guildId, mode);
      await i.editReply(`Repeat: ${mode}.${mode === "track" && s.queueMode === "fair" ? " Repeat-one temporarily holds this member’s turn; change repeat to continue fair turns." : ""}`);
      return;
    }
    if (action === "stop" && id === "idle" && !s.current) { await this.music.stop(guildId, null); await i.editReply("Stopped and cleared the queue."); return; }
    if (action === "resume" && id === "idle" && !s.current) { await this.music.resume(guildId, voiceChannelId, i.channelId, null); await i.editReply("Resuming the saved queue."); return; }
    if (!s.current || s.current.id !== id) throw new Error("This song has already changed. Use the current playback panel.");
    switch (action) {
      case "pause": await this.music.pause(guildId, id); break;
      case "resume": await this.music.resume(guildId, voiceChannelId, i.channelId, id); break;
      case "skip": await this.music.skip(guildId, id); break;
      case "stop": await this.music.stop(guildId, id); break;
      case "retry": await this.music.retry(guildId, id); break;
      case "alternative": await this.alternatives(i, s.current.request, s.current.recording, voiceChannelId, id, true); return;
      default: throw new Error("Unknown playback control.");
    }
    await i.editReply("Done.");
  }
  private async modal(i: ModalSubmitInteraction): Promise<void> {
    const { guildId, voiceChannelId } = this.access(i);
    const id = i.customId.split(":")[1]; const menu = this.menus.read(id, i.user.id, guildId, !i.customId.startsWith("qmove:"));
    if (i.customId.startsWith("music-input:") && menu.kind === "music_input") {
      if (voiceChannelId !== menu.voiceChannelId) throw new Error("You changed voice channels. Press Play again from your current channel.");
      const input = menu.native ? musicRequestFields(i.fields) : { query: i.fields.getTextInputValue("query"), sources: undefined, review: menu.forceChoices };
      await this.search(i, { query: input.query, source: menu.native ? "auto" : menu.source, ...(input.sources ? { sources: input.sources } : {}), requestedBy: i.user.id }, input.review,
        (result, signal) => this.presentSearch(i, result, voiceChannelId, input.review, signal));
      return;
    }
    if (i.customId.startsWith("volume:") && menu.kind === "volume_input") {
      await this.music.setVolume(guildId, Number(i.fields.getTextInputValue("volume")));
      await i.editReply("Volume updated."); return;
    }
    if (i.customId.startsWith("spotify:") && menu.kind === "spotify_input") {
      if (voiceChannelId !== menu.voiceChannelId) throw new Error("You changed voice channels. Open Spotify again from your current channel.");
      await this.spotifySearch(i, i.fields.getTextInputValue("url"), voiceChannelId, menu.forceChoices);
      return;
    }
    if (menu.kind !== "queue" || !i.customId.startsWith("qmove:")) throw new Error("Invalid queue menu.");
    await this.queueEdit(i, menu, "move", Number(i.fields.getTextInputValue("position")));
  }
  private async admin(i: ChatInputCommandInteraction): Promise<void> {
    const { guildId, voiceChannelId } = this.access(i, true);
    const subcommand = i.options.getSubcommand();
    const s = this.music.snapshot(guildId);
    if (subcommand === "panel") {
      const channelId = env.discordMusicTextChannelId ?? i.channelId;
      await this.music.setPanelChannel(guildId, channelId);
      const work = this.panels.get(guildId)!;
      if (work.timer) { clearTimeout(work.timer); work.timer = undefined; }
      await work.pending;
      work.pending = this.updatePanel(guildId);
      await work.pending;
      const session = this.music.snapshot(guildId);
      if (!session.panelMessageId) throw new Error("Could not create the console. Check the bot’s text-channel permissions.");
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !("send" in channel)) throw new Error("Choose a text channel for the console.");
      const message = await channel.messages.fetch(session.panelMessageId);
      let pinNote = "Pinned for quick access.";
      if (!message.pinned) {
        try { await message.pin("MusicMaid permanent console"); }
        catch { pinNote = "Panel created. Give the bot Pin Messages permission or pin it manually."; }
      }
      await i.editReply({ content: `${pinNote} Searches, Queue, and History open privately.`, components: [buttons(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Open MusicMaid").setURL(message.url))] });
      return;
    }
    if (subcommand === "repair") {
      if (env.youtubeCookies && s.current?.recording.source === "youtube") {
        // Keep persistence failures fatal, but a broken audio connection must not
        // prevent repair. Backend voice operations remain serialized after timeout.
        await this.music.suspend(guildId);
        await this.disconnectForMaintenance(guildId, "repair");
        await resetYoutubeDecoderCache({ binary: env.youtubeBinary, cookies: env.youtubeCookies });
      }
      if (s.current) await this.music.retry(guildId, s.current.id, true);
      else if (s.queue.length && voiceChannelId) await this.music.resume(guildId, voiceChannelId, s.textChannelId ?? i.channelId);
      else { await i.editReply("No active request to repair. Use /play, or Diagnose to check the sources."); return; }
      await i.editReply("Reconnecting this session and retrying its selected upload. The queue is preserved; no services are being restarted."); return;
    }
    if (subcommand === "restart") {
      const target = (i.options.getString("target") ?? "bot") as RestartTarget;
      const id = this.menus.create(i.user.id, guildId, { kind: "restart", target });
      await i.editReply({ content: target === "viewer" ? "Restart the optional video viewer? Voice audio and the queue will continue." : `Restart ${target}? Playback may be interrupted. The saved queue will be retained.`, components: [buttons(button(`admin:confirm:${id}`, "Confirm restart", ButtonStyle.Danger), button(`admin:cancel:${id}`, "Cancel"))] }); return;
    }
    if (subcommand === "diagnostic") { await this.diagnosticFile(i); return; }
    const node = [...getLavalink().nodes.values()].find(n => n.state === 1);
    const info = node ? await lavalinkInfo(node.rest).catch(() => undefined) : undefined;
    const release = getReleaseInfo();
    const lines = [`Release: ${release.revision}${release.dirty ? " (modified build)" : ""}${release.builtAt ? ` · built ${release.builtAt}` : ""}`, ...getLavalinkStatusLines(), `Playback: ${s.state}; position ${duration(s.positionMs)}; ${s.queue.length} queued`,
      `Last confirmed progress: ${s.lastVerifiedAt ? new Date(s.lastVerifiedAt).toISOString() : "none"}`,
      `Last completed track: ${s.lastCompletedAt ? new Date(s.lastCompletedAt).toISOString() : "none"}`,
      `Lavalink: ${info?.version.semver ?? "unknown"}; plugins: ${info?.plugins.map(p => `${p.name} ${p.version}`).join(", ") ?? "unknown"}`,
      ...sourceHealth().map(h => `${h.source}: ${h.cooldownUntil > Date.now() ? "cooling down" : "available for requests"}${h.lastError ? " · " + failureMessage(h.lastError) : ""}`),
      `YouTube account session: ${env.youtubeCookies ? "configured" : "not configured"}`,
      `Spotify credentials: ${env.spotifyClientId && env.spotifyClientSecret ? "configured" : "missing"}`,
      `Original Spotify audio: ${env.spotifyDirectEnabled ? "enabled; verify with a stream probe" : "disabled"}`,
      `Optional YouTube viewer: ${this.viewerReady() ? "reader ready; use Watch video to verify viewing" : env.viewerEnabled ? "reader unavailable; voice playback is independent" : "not enabled"}`];
    const voiceStatus = i.guild ? voiceReadiness(i.guild, voiceChannelId || s.voiceChannelId || "") : undefined;
    if (voiceStatus) {
      lines.unshift(voiceReadinessLine(voiceStatus));
      const reason = voiceBlockReason(voiceStatus);
      if (reason) lines.unshift(reason);
    }
    if (subcommand === "diagnose") {
      const checks = await Promise.allSettled([this.load("ytsearch:Tinariwen Sastanàqqàm"), this.load("scsearch:Yosi Horikawa Bubbles"), fetch(new URL("/metrics", env.cipherUrl), { signal: AbortSignal.timeout(5000) }).then(async r => { await r.body?.cancel(); return { loadType: r.ok ? "reachable" : `HTTP ${r.status}` }; })]);
      checks.forEach((r, n) => lines.push(`${["YouTube lookup", "SoundCloud lookup", "Cipher health"][n]}: ${r.status === "fulfilled" ? r.value?.loadType ?? "no response" : safeError(r.reason)}`));
      if (node) {
        lines.push(`YouTube stream: ${await probeStream(node, "youtube", "https://www.youtube.com/watch?v=2I3PLVuKNtw", 6500, this.load)}`);
        lines.push(`SoundCloud stream: ${await probeStream(node, "soundcloud", "https://soundcloud.com/yosi-horikawa/bubbles")}`);
        if (env.spotifyDirectEnabled) lines.push(`Spotify original stream: ${await probeStream(node, "spotify", "https://open.spotify.com/track/0NTMtAO2BV4tnGvw9EgBVq", 6500, this.load)}`);
      }
      if (env.spotifyClientId && env.spotifyClientSecret) {
        lines.push(`Spotify metadata: ${await this.verifySpotify()}`);
      }
      const guild = this.client.guilds.cache.get(guildId); const me = guild?.members.me;
      lines.push(`Voice: ${me?.voice.channelId ? "connected" : "not connected"}; server muted: ${me?.voice.serverMute ?? false}`);
      lines.push("Probes use no voice connection. Full audible playback requires the listening smoke test.");
    }
    await i.editReply({ content: text(lines.join("\n"), 1950), allowedMentions: { parse: [] } });
  }
  private async diagnosticAudio(): Promise<DiagnosticAudio> {
    let gateway: ReturnType<typeof getLavalink>;
    try { gateway = getLavalink(); }
    catch { return { nodes: 0, connectedNodes: 0, players: 0, connections: 0 }; }
    const nodes = [...gateway.nodes.values()], connected = nodes.filter(node => node.state === 1);
    return diagnosticAudioSnapshot({ nodes: nodes.length, connectedNodes: connected.length, players: gateway.players.size, connections: gateway.connections.size }, connected[0] ? signal => lavalinkInfo(connected[0].rest, signal) : undefined);
  }
  private async diagnosticFile(i: ChatInputCommandInteraction): Promise<void> {
    this.access(i, true, false);
    const audio = await this.diagnosticAudio();
    const session = this.music.snapshot(i.guildId!), voice = i.guild?.members.me?.voice;
    const report = diagnosticDownload({
      release: getReleaseInfo(),
      versions: { node: process.versions.node, discordJs: discordVersion, shoukaku: /^shoukaku\/(\d+\.\d+\.\d+)(?: |$)/.exec(ShoukakuConstants.ShoukakuClientInfo)?.[1] ?? "unknown" },
      session, audio,
      health: { discordReady: this.client.isReady(), voiceConnected: Boolean(voice?.channelId), serverMuted: voice?.serverMute === true, viewerReady: this.viewerReady() },
      configuration: { youtubeAccount: Boolean(env.youtubeCookies), spotifyMetadata: Boolean(env.spotifyClientId && env.spotifyClientSecret), spotifyOriginalAudio: env.spotifyDirectEnabled, viewer: env.viewerEnabled },
      providers: sourceHealth(),
    });
    await i.editReply({ content: "Download a diagnostic summary containing build versions, health, counts and incident categories. It excludes listening details, identities, credentials, paths and URLs.",
      files: [new AttachmentBuilder(Buffer.from(JSON.stringify(report, null, 2) + "\n"), { name: "musicmaid-diagnostic.json" })], embeds: [], components: [], allowedMentions: { parse: [] } });
  }
  private async disconnectForMaintenance(guildId: string, action: "repair" | "restart"): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.music.disconnectPreservingQueue(guildId).catch(error => incident(`${action}_cleanup_failed`, { guildId, error: safeError(error) })),
        new Promise<void>(resolve => {
          timer = setTimeout(() => { incident(`${action}_cleanup_timed_out`, { guildId }); resolve(); }, 10000);
          timer.unref();
        })
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async confirmRestart(i: ButtonInteraction, action: string, id: string): Promise<void> {
    this.access(i, true);
    const menu = this.menus.read(id, i.user.id, i.guildId!, true);
    if (menu.kind !== "restart") throw new Error("Invalid restart prompt.");
    if (action === "cancel") { await i.editReply("Restart cancelled."); return; }
    if (action !== "confirm") throw new Error("Invalid restart action.");
    reserveRestart(this.store, menu.target, i.user.id);
    if (menu.target === "viewer") { await i.editReply("Restarting the optional viewer. Voice audio and the queue are unaffected."); await this.restart("viewer"); return; }
    // Persist every session before touching an audio service that may be broken.
    // A failed cleanup must not prevent the very restart requested to repair it.
    const sessions = this.music.all();
    for (const session of sessions) await this.music.suspend(session.guildId);
    for (const session of sessions) await this.disconnectForMaintenance(session.guildId, "restart");
    await i.editReply("Restart requested. The queue is saved.");
    if (menu.target === "bot") this.close();
    try { await this.restart(menu.target); }
    finally { if (menu.target !== "bot") await this.onRestore(); }
  }
}
