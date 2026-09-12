import type { Client } from "discord.js";
import type { MusicCoordinator } from "../audio/coordinator.js";
import type { Session } from "../audio/model.js";
import { failureScope, incident, safeError } from "../audio/diagnostics.js";

/** Called when Discord and the audio node are ready; it never enumerates foreign sessions. */
export async function restoreConfiguredSession(client: Client, music: MusicCoordinator, guildId: string, changed: (session: Session) => void): Promise<void> {
  if (!client.isReady()) return;
  const session = music.snapshot(guildId);
  if (session.state !== "suspended" || session.resumePaused || !session.voiceChannelId || !session.textChannelId) return;
  if (session.failure && failureScope(session.failure.reason, session.failure.scope) === "environment" && session.failure.reason.startsWith("Voice:")) return;
  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.get(session.voiceChannelId);
  if (channel?.isVoiceBased() && channel.members.some(member => !member.user.bot)) {
    await music.resume(guildId, session.voiceChannelId, session.textChannelId).catch(error => incident("restore_failed", { guildId, error: safeError(error) }));
  }
  changed(music.snapshot(guildId));
}
