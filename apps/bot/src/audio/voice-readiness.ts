import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";

export type VoiceReadiness = {
  channelId: string; channelName: string; regularVoice: boolean;
  view: boolean; connect: boolean; speak: boolean; moveMembers: boolean;
  otherMembers: number; userLimit: number; muted: boolean; timedOut: boolean;
  alreadyConnected: boolean;
};

export function voiceReadiness(guild: Guild, channelId: string): VoiceReadiness | undefined {
  const channel = guild.channels.cache.get(channelId);
  const me = guild.members.me;
  if (!channel?.isVoiceBased() || !me) return undefined;
  const permissions = channel.permissionsFor(me);
  return {
    channelId, channelName: channel.name, regularVoice: channel.type === ChannelType.GuildVoice,
    view: permissions.has(PermissionFlagsBits.ViewChannel), connect: permissions.has(PermissionFlagsBits.Connect),
    speak: permissions.has(PermissionFlagsBits.Speak), moveMembers: permissions.has(PermissionFlagsBits.MoveMembers),
    otherMembers: guild.voiceStates.cache.filter(state => state.channelId === channelId && state.id !== me.id).size,
    userLimit: channel.userLimit, muted: me.voice.serverMute === true,
    alreadyConnected: me.voice.channelId === channelId,
    timedOut: Boolean(me.communicationDisabledUntilTimestamp && me.communicationDisabledUntilTimestamp > Date.now())
  };
}

export function voiceBlockReason(status: VoiceReadiness): string | undefined {
  if (!status.regularVoice) return "Voice: use a regular voice channel for music.";
  const missing = [!status.view && "View Channel", !status.connect && "Connect", !status.speak && "Speak"].filter(Boolean);
  if (missing.length) return `Voice: MusicMaid needs ${missing.join(", ")} permission in ${status.channelName}. A moderator can grant it for this channel.`;
  if (status.timedOut) return "Voice: a moderator needs to remove MusicMaid’s server timeout.";
  if (status.muted) return "Voice: a moderator needs to unmute MusicMaid in voice.";
  if (!status.alreadyConnected && status.userLimit > 0 && status.otherMembers >= status.userLimit && !status.moveMembers) {
    return `Voice: ${status.channelName} is full (${status.otherMembers}/${status.userLimit}). Free a place or let a moderator give MusicMaid Move Members permission in this channel to bypass its limit.`;
  }
  return undefined;
}

export function voiceReadinessLine(status: VoiceReadiness): string {
  return `Voice ${status.channelName}: view=${status.view}, connect=${status.connect}, speak=${status.speak}, others=${status.otherMembers}/${status.userLimit || "unlimited"}, bypass limit=${status.moveMembers}`;
}
