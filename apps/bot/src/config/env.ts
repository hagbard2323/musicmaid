import "dotenv/config";
import { validateConfiguredGuildId } from "./guild-scope.js";
export { assertGuildScope } from "./guild-scope.js";

type Env = {
  discordToken: string;
  discordClientId: string;
  discordGuildId?: string;
  discordMusicTextChannelId?: string;
  discordBotAdminRoleId?: string;
  discordBotAdminRoleIds: string[];
  lavalinkName: string;
  lavalinkUrl: string;
  lavalinkAuth: string;
  searchSource: string;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  spotifyMarket: string;
  spotifyUserTokenFile: string;
  spotifyDirectEnabled: boolean;
  spotifyDirectAuthFile: string;
  spotifyDirectBinary: string;
  musicIdleDisconnectSeconds: number;
  musicDatabasePath: string;
  cipherUrl: string;
  youtubeCookies?: string;
  youtubeBinary: string;
  viewerEnabled: boolean;
  viewerSocket: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export const env: Env = {
  discordToken: requireEnv("DISCORD_TOKEN"),
  discordClientId: requireEnv("DISCORD_CLIENT_ID"),
  discordGuildId: process.env.DISCORD_GUILD_ID,
  discordMusicTextChannelId: process.env.DISCORD_MUSIC_TEXT_CHANNEL_ID,
  discordBotAdminRoleId: process.env.DISCORD_BOT_ADMIN_ROLE_ID,
  discordBotAdminRoleIds: parseList(
    process.env.DISCORD_BOT_ADMIN_ROLE_IDS ||
      process.env.DISCORD_BOT_ADMIN_ROLE_ID
  ),
  lavalinkName: process.env.LAVALINK_NAME ?? "local",
  lavalinkUrl: process.env.LAVALINK_URL ?? "localhost:2333",
  lavalinkAuth: process.env.LAVALINK_AUTH ?? "youshallnotpass",
  searchSource: process.env.SEARCH_SOURCE ?? "scsearch",
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID,
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  spotifyMarket: parseSpotifyMarket(process.env.SPOTIFY_MARKET, "DE"),
  spotifyUserTokenFile: process.env.SPOTIFY_USER_TOKEN_FILE ?? "/var/lib/audiobot/spotify-user.json",
  spotifyDirectEnabled: process.env.SPOTIFY_DIRECT_ENABLED === "true",
  spotifyDirectAuthFile: process.env.SPOTIFY_DIRECT_AUTH_FILE ?? "/var/lib/audiobot/spotify-direct.json",
  spotifyDirectBinary: process.env.SPOTIFY_DIRECT_BINARY ?? "/opt/botsvc/audiobot-tools/musicmaid-spotify-stream",
  musicDatabasePath: process.env.MUSIC_DATABASE_PATH ?? "./data/music.sqlite",
  cipherUrl: process.env.CIPHER_URL ?? "http://127.0.0.1:18001",
  youtubeCookies: process.env.YOUTUBE_COOKIE_FILE,
  youtubeBinary: process.env.YTDLP_BINARY ?? "/opt/botsvc/audiobot-tools/venv/bin/yt-dlp",
  viewerEnabled: process.env.VIEWER_ENABLED === "true",
  viewerSocket: process.env.VIEWER_SOCKET ?? "/run/musicmaid-viewer/reader.sock",
  musicIdleDisconnectSeconds: parseNonNegativeInteger(
    "MUSIC_IDLE_DISCONNECT_SECONDS",
    300
  )
};

/** Startup/registration must choose one community; reusable unit fixtures may stay unscoped. */
export function requireConfiguredGuildId(value: unknown = env.discordGuildId): string {
  return validateConfiguredGuildId(value);
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNonNegativeInteger(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  if (!/^\d+$/.test(value)) {
    console.warn(
      `Invalid ${name} value "${value}", using default ${fallback}.`
    );
    return fallback;
  }

  return Number(value);
}

function parseSpotifyMarket(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }

  const market = value.trim().toUpperCase();

  if (!/^[A-Z]{2}$/.test(market)) {
    console.warn(
      `Invalid SPOTIFY_MARKET value "${value}", using default ${fallback}.`
    );
    return fallback;
  }

  return market;
}
