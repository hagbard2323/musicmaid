import { Client, Events, GatewayIntentBits } from "discord.js";
import { env, requireConfiguredGuildId } from "./config/env.js";
import { createLavalink } from "./audio/lavalink.js";
import { LavalinkBackend } from "./audio/player-service.js";
import { MusicCoordinator } from "./audio/coordinator.js";
import { SqliteMusicStorage } from "./storage/sqlite-storage.js";
import { MusicController } from "./commands/music.js";
import { registerCommands } from "./commands/register.js";
import { markSourceFailure } from "./audio/track-health.js";
import { incident, isRecordingFailure, safeError } from "./audio/diagnostics.js";
import { ViewerBridge, viewerReader } from "./video/bridge.js";
import { startRuntimeWatchdog } from "./runtime/watchdog.js";
import { getReleaseInfo } from "./runtime/release-info.js";
import { restoreConfiguredSession } from "./runtime/session-restore.js";

// Reject missing scope before opening persistent state or creating network clients.
const configuredGuildId = requireConfiguredGuildId();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates], allowedMentions: { parse: [] } });
const storage = new SqliteMusicStorage(env.musicDatabasePath, { guildId: configuredGuildId });
const lavalink = createLavalink(client);
const backend = new LavalinkBackend(client);
let controller: MusicController;
const music = new MusicCoordinator(storage, backend, {
  guildId: configuredGuildId,
  idleMs: env.musicIdleDisconnectSeconds * 1000,
  onChange: session => controller?.changed(session),
  onFailure: (entry, reason, scope) => {
    if (isRecordingFailure(reason, scope)) markSourceFailure(entry.recording.source, entry.recording.uri, reason);
  }
});
controller = new MusicController(client, music, backend.load, storage, undefined, configuredGuildId);
const viewer = env.viewerEnabled ? new ViewerBridge(env.viewerSocket, viewerReader(client, music), (id, signal, refresh) => backend.video(id, signal, refresh)) : undefined;
controller.viewerReady = () => viewer?.ready ?? false;
if (viewer) void viewer.start().catch(() => incident("viewer_bridge_unavailable", { message: "Optional video could not start; voice playback is unaffected." }));
backend.onEvent = (guildId, event) => { if (guildId === configuredGuildId) void music.event(guildId, event).catch(error => incident("playback_event_error", { guildId, error: safeError(error) })); };
backend.onVoiceChange = (guildId, channelId) => { if (guildId === configuredGuildId) void music.externalVoiceChange(guildId, channelId).catch(error => incident("voice_presence_update_failed", { guildId, error: safeError(error) })); };

let restoring = false;
async function restore(): Promise<void> {
  if (restoring || !client.isReady() || ![...lavalink.nodes.values()].some(n => n.state === 1)) return;
  restoring = true;
  try {
    await restoreConfiguredSession(client, music, configuredGuildId, session => controller.changed(session));
  } finally { restoring = false; }
}
controller.onRestore = restore;
lavalink.on("ready", () => { void restore(); });
client.once(Events.ClientReady, async () => {
  try { await registerCommands({ guildId: configuredGuildId }); } catch (error) { incident("command_registration_failed", { error: safeError(error) }); }
  await restore();
  for (const session of music.all()) controller.changed(session);
  void controller.verifySpotify();
  console.info("MusicMaid ready.");
  console.info(`MusicMaid build: ${getReleaseInfo().revision}`);
});
client.on(Events.InteractionCreate, i => { void controller.handle(i); });
client.on(Events.VoiceStateUpdate, (previous, current) => {
  if (exiting || current.id !== client.user?.id || current.guild.id !== configuredGuildId) return;
  backend.voiceStateChanged(current.guild.id, previous.channelId, current.channelId);
});
client.on(Events.Error, error => incident("discord_error", { error: safeError(error) }));
let ticking = false;
const tick = setInterval(() => {
  if (ticking) return;
  ticking = true;
  void music.tick().catch(error => incident("playback_tick_failed", { error: safeError(error) })).finally(() => { ticking = false; });
}, 1000);
tick.unref();
let exiting = false;
const stopWatchdog = startRuntimeWatchdog({ onFailure: () => incident("runtime_watchdog_notification_failed", { message: "Local service notification failed; check the installed bot unit and systemd-notify helper." }) });
async function shutdown(): Promise<void> {
  if (exiting) return; exiting = true;
  stopWatchdog();
  controller.close();
  viewer?.close();
  clearInterval(tick);
  for (const session of music.all()) await music.disconnectPreservingQueue(session.guildId).catch(error => incident("shutdown_disconnect_failed", { error: safeError(error) }));
  backend.close(); client.destroy(); storage.close(); process.exit(0);
}
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
void client.login(env.discordToken).catch(error => { incident("login_failed", { error: safeError(error) }); process.exitCode = 1; });
