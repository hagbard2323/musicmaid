import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type MessageCreateOptions, type MessageEditOptions } from "discord.js";
import { duration, type QueueEntry, type Session } from "../audio/model.js";
import type { MusicStorage } from "../storage/types.js";

type Card = { entry: QueueEntry; messageId: string; channelId: string; fingerprint: string };
type FeedChannel = {
  id: string;
  send(payload: MessageCreateOptions): Promise<{ id: string }>;
  messages: { fetch(id: string): Promise<{ edit(payload: MessageEditOptions): Promise<unknown> }> };
};
async function findMessage(channel: FeedChannel, id: string) {
  try { return await channel.messages.fetch(id); }
  catch (error) { if ((error as { code?: number }).code === 10008) return null; throw error; }
}

/** One public card per playing queue entry; earlier cards remain as the channel's history. */
export class PublicPlayerFeed {
  constructor(private store: MusicStorage, private render: (session: Session) => MessageCreateOptions & MessageEditOptions) {}
  private card(guildId: string): Card | undefined {
    let card: Card | undefined;
    try { card = JSON.parse(this.store.getValue(`music-public-player:${guildId}`) ?? "null") ?? undefined; } catch { /* Rebuild a damaged display record. */ }
    if (card && (!card.entry?.id || typeof card.messageId !== "string" || typeof card.channelId !== "string")) card = undefined;
    return card;
  }
  /** The saved card is only a navigation target while it represents the current entry. */
  currentMessage(session: Session): { messageId: string; channelId: string } | undefined {
    const card = this.card(session.guildId);
    return card && card.entry.id === session.current?.id && card.channelId === session.textChannelId
      ? { messageId: card.messageId, channelId: card.channelId } : undefined;
  }
  async update(channel: FeedChannel, session: Session, latest = () => session): Promise<void> {
    const key = `music-public-player:${session.guildId}`;
    let card = this.card(session.guildId);
    session = latest();
    if (session.textChannelId !== channel.id) return;
    if (card && (card.entry.id !== session.current?.id || card.channelId !== channel.id)) {
      if (card.channelId === channel.id) {
        const previous = await findMessage(channel, card.messageId);
        session = latest();
        if (session.textChannelId !== channel.id || session.current?.id === card.entry.id) return;
        if (previous) {
          const outcome = session.history.find(item => item.entry.id === card!.entry.id)?.outcome;
          const snapshot = { ...session, current: card.entry, queue: [], failure: undefined };
          const payload = this.render(snapshot);
          const embed = EmbedBuilder.from(payload.embeds![0]).setTitle(outcome === "finished" ? "Played" : outcome === "skipped" ? "Skipped" : outcome === "failed" ? "Playback failed" : "Previous track");
          embed.setFields((embed.toJSON().fields ?? []).filter(field => field.name !== "Playback" && !field.name.startsWith("Up next")));
          embed.setFooter({ text: `${duration(card.entry.recording.durationMs)} · ${card.entry.recording.source}` });
          // Resolve the current player on click. A URL saved here would forever
          // point at one old message, even after another track starts.
          const open = new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Open current player").setCustomId("m:current");
          const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(open,
            new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Add music").setCustomId("m:play"),
            new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Playlists").setCustomId("pl:list"),
            new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Stats").setCustomId("stats:tracks:30"));
          await previous.edit({ embeds: [embed], components: [controls], allowedMentions: { parse: [] } });
        }
      }
      this.store.setValue(key, "null"); card = undefined;
    }
    session = latest();
    if (session.textChannelId !== channel.id) return;
    const entry = session.current;
    if (!entry || (!card && !["playing", "paused"].includes(session.state))) return;
    let fingerprint = this.fingerprint(session);
    if (card?.fingerprint === fingerprint) return;
    const existing = card ? await findMessage(channel, card.messageId) : null;
    session = latest();
    if (session.textChannelId !== channel.id || session.current?.id !== entry.id) return;
    if (!existing && !["playing", "paused"].includes(session.state)) return;
    fingerprint = this.fingerprint(session);
    const payload = this.render(session);
    const title = session.state === "paused" ? "Paused" : session.state === "recovering" || session.state === "starting" ? "Recovering playback" : session.failure ? "Playback needs attention" : "Now playing";
    const embeds = [EmbedBuilder.from(payload.embeds![0]).setTitle(title)];
    if (existing) await existing.edit({ ...payload, embeds });
    else {
      const sent = await channel.send({ ...payload, embeds, nonce: `p${entry.id.replaceAll("-", "").slice(0, 24)}`, enforceNonce: true });
      card = { entry: structuredClone(entry), messageId: sent.id, channelId: channel.id, fingerprint };
    }
    this.store.setValue(key, JSON.stringify({ ...card, entry: structuredClone(entry), fingerprint }));
  }
  private fingerprint(session: Session): string {
    // Keep visible progress useful without a message edit for every position tick.
    return JSON.stringify([session.current?.id, session.state, session.queue.map(item => item.id), session.volume, session.loop, session.queueMode ?? "fifo", Math.floor(session.positionMs / 15_000), session.failure?.incidentId]);
  }
}
