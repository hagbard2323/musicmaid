import { env } from "../config/env.js";
import type { Recording } from "./model.js";
import { assertSourceReady, rateLimited } from "./source-errors.js";

export type SpotifyTrackMetadata = {
  id: string;
  name: string;
  artists: string[];
  url?: string;
  durationMs?: number;
  isrc?: string;
  explicit?: boolean;
  artworkUrl?: string;
};

type SpotifyReference =
  | {
      type: "track";
      id: string;
    }
  | {
      type: "unsupported";
      itemType: string;
      id?: string;
    };

type CachedSpotifyToken = {
  accessToken: string;
  expiresAtMs: number;
};

type SpotifyTokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
};

type SpotifyTrackResponse = {
  id?: unknown;
  name?: unknown;
  artists?: unknown;
  external_urls?: unknown;
  duration_ms?: unknown;
  external_ids?: { isrc?: unknown };
  explicit?: unknown;
  album?: { images?: Array<{ url?: string }> };
};

export function spotifyRecording(metadata: SpotifyTrackMetadata): Recording {
  return { identifier: metadata.id, title: metadata.name, author: metadata.artists.join(", "), artists: [...metadata.artists], uri: "https://open.spotify.com/track/" + metadata.id,
    source: "spotify", durationMs: metadata.durationMs ?? 0, isSeekable: true, isStream: false, isrc: metadata.isrc, explicit: metadata.explicit, artworkUrl: metadata.artworkUrl };
}

export async function searchSpotifyMetadata(query: string, retry = true): Promise<SpotifyTrackMetadata[]> {
  assertSourceReady("spotify");
  if (!query.trim() || query.length > 500) throw new Error("Enter a song and artist, up to 500 characters.");
  const url = new URL("https://api.spotify.com/v1/search");
  url.search = new URLSearchParams({ q: query, type: "track", market: env.spotifyMarket, limit: "10" }).toString();
  const response = await fetch(url, { headers: { Authorization: "Bearer " + await getSpotifyAccessToken() }, signal: AbortSignal.timeout(8000) });
  if (response.status === 401 && retry) { cachedToken = undefined; return searchSpotifyMetadata(query, false); }
  if (!response.ok) throw spotifyApiError(response);
  const data = await response.json() as { tracks?: { items?: unknown[] } };
  const tracks: SpotifyTrackMetadata[] = [];
  for (const item of data.tracks?.items ?? []) { try { tracks.push(parseSpotifyTrack(item)); } catch { /* Unavailable catalog entries are omitted. */ } }
  return tracks;
}

export class SpotifyConfigurationError extends Error {
  constructor() {
    super("Spotify is not configured yet. A mod needs to configure a Spotify developer app owned by a Premium subscriber.");
  }
}

export class UnsupportedSpotifyReferenceError extends Error {
  constructor(readonly itemType: string) {
    super(`Unsupported Spotify ${itemType} link.`);
  }
}

let cachedToken: CachedSpotifyToken | undefined;
let tokenRequest: Promise<string> | undefined;

export async function resolveSpotifyTrackMetadata(
  input: string
): Promise<SpotifyTrackMetadata | undefined> {
  const reference = await resolveSpotifyReference(input);

  if (!reference) {
    return undefined;
  }

  if (reference.type === "unsupported") {
    throw new UnsupportedSpotifyReferenceError(reference.itemType);
  }

  return fetchSpotifyTrack(reference.id);
}

export function isSpotifyInput(input: string): boolean {
  const value = unwrapLink(input.trim());
  return parseSpotifyReference(value) !== undefined || isSpotifyShortUrl(value);
}

export function spotifyTrackToSearchQuery(track: SpotifyTrackMetadata): string {
  return [track.name, ...track.artists.slice(0, 3)].join(" ");
}

export async function resolveSpotifyReference(
  input: string
): Promise<SpotifyReference | undefined> {
  input = unwrapLink(input.trim());
  const direct = parseSpotifyReference(input);

  if (direct) {
    return direct;
  }

  if (!isSpotifyShortUrl(input)) {
    return undefined;
  }

  const resolvedUrl = await resolveSpotifyShortUrl(input);
  return resolvedUrl ? parseSpotifyReference(resolvedUrl) : undefined;
}

export function parseSpotifyReference(input: string): SpotifyReference | undefined {
  const value = unwrapLink(input.trim());
  const uriMatch = /^spotify:([a-z]+):([A-Za-z0-9]{22})$/i.exec(value);

  if (uriMatch) {
    return spotifyReference(uriMatch[1], uriMatch[2]);
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (!isSpotifyHost(url.hostname) || url.protocol !== "https:" || url.username || url.password || url.port) {
    return undefined;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const itemTypeIndex = parts.findIndex((part) =>
    ["album", "playlist", "track", "episode", "show"].includes(part)
  );

  if (itemTypeIndex === -1) {
    return undefined;
  }

  return spotifyReference(parts[itemTypeIndex], parts[itemTypeIndex + 1]);
}

function unwrapLink(value: string): string {
  if (value.startsWith("<") && value.endsWith(">")) {
    return value.slice(1, -1).trim();
  }

  return value;
}

function spotifyReference(
  itemType: string | undefined,
  id: string | undefined
): SpotifyReference | undefined {
  if (!itemType) {
    return undefined;
  }

  if (itemType !== "track") {
    return { type: "unsupported", itemType, ...(id && /^[A-Za-z0-9]{22}$/.test(id) ? { id } : {}) };
  }

  if (!id || !/^[A-Za-z0-9]{22}$/.test(id)) {
    return undefined;
  }

  return { type: "track", id };
}

function isSpotifyHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "open.spotify.com" || host === "play.spotify.com";
}

function isSpotifyShortUrl(input: string): boolean {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase();
    return host === "spotify.link" || host === "spotify.app.link";
  } catch {
    return false;
  }
}

async function resolveSpotifyShortUrl(input: string): Promise<string | undefined> {
  let current = input.trim().replace(/^<(.+)>$/, "$1");
  for (let hop = 0; hop < 4; hop++) {
    const url = new URL(current);
    if (url.protocol !== "https:" || url.port || url.username || url.password || !["spotify.link", "spotify.app.link", "open.spotify.com", "play.spotify.com"].includes(url.hostname)) throw new Error("Spotify short link redirected to an unsupported address.");
    if (parseSpotifyReference(current)) return current;
    const response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(8000) });
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) throw new Error("Could not expand that Spotify short link. Paste the full track link instead.");
    current = new URL(location, current).href;
  }
  throw new Error("Spotify short link redirected too many times. Paste the full track link instead.");
}

async function fetchSpotifyTrack(id: string, retry = true): Promise<SpotifyTrackMetadata> {
  assertSourceReady("spotify");
  const token = await getSpotifyAccessToken();
  const url = new URL(`https://api.spotify.com/v1/tracks/${id}`);
  url.searchParams.set("market", env.spotifyMarket);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    if (response.status === 401 && retry) { cachedToken = undefined; return fetchSpotifyTrack(id, false); }
    throw spotifyApiError(response);
  }

  return parseSpotifyTrack(await response.json());
}

async function getSpotifyAccessToken(): Promise<string> {
  if (!env.spotifyClientId || !env.spotifyClientSecret) {
    throw new SpotifyConfigurationError();
  }

  if (cachedToken && cachedToken.expiresAtMs > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }
  if (!tokenRequest) tokenRequest = requestSpotifyToken().finally(() => { tokenRequest = undefined; });
  return tokenRequest;
}

async function requestSpotifyToken(): Promise<string> {

  const credentials = Buffer.from(
    `${env.spotifyClientId}:${env.spotifyClientSecret}`
  ).toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials" });

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    signal: AbortSignal.timeout(8000),
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    throw spotifyApiError(response);
  }

  const token = parseSpotifyToken(await response.json());
  cachedToken = token;
  return token.accessToken;
}

function spotifyApiError(response: Response): Error {
  if (response.status === 429) return rateLimited("spotify", response.headers.get("retry-after"));
  if ([400, 401, 403].includes(response.status)) return new Error("Spotify access was refused. A mod should check the developer credentials and the app owner’s Premium subscription.");
  if (response.status === 404) return new Error("That Spotify track is unavailable in the configured market.");
  return new Error(`Spotify is unavailable (HTTP ${response.status}). Try again later.`);
}

function parseSpotifyToken(data: unknown): CachedSpotifyToken {
  const token = data as SpotifyTokenResponse;

  if (
    typeof token.access_token !== "string" ||
    typeof token.expires_in !== "number"
  ) {
    throw new Error("Spotify token response was missing access_token/expires_in.");
  }

  return {
    accessToken: token.access_token,
    expiresAtMs: Date.now() + token.expires_in * 1000
  };
}

export function parseSpotifyTrack(data: unknown): SpotifyTrackMetadata {
  const track = data as SpotifyTrackResponse;

  if (typeof track.id !== "string" || typeof track.name !== "string") {
    throw new Error("Spotify track response was missing id/name.");
  }

  if (!Array.isArray(track.artists)) {
    throw new Error("Spotify track response was missing artists.");
  }

  const artists = track.artists
    .map((artist) => {
      if (
        typeof artist === "object" &&
        artist !== null &&
        "name" in artist &&
        typeof artist.name === "string"
      ) {
        return artist.name;
      }

      return undefined;
    })
    .filter((artist): artist is string => Boolean(artist));

  if (artists.length === 0) {
    throw new Error("Spotify track response did not include artist names.");
  }

  return {
    id: track.id,
    name: track.name,
    artists,
    url: parseSpotifyUrl(track.external_urls),
    durationMs: typeof track.duration_ms === "number" && Number.isFinite(track.duration_ms) ? track.duration_ms : undefined,
    isrc: typeof track.external_ids?.isrc === "string" ? track.external_ids.isrc : undefined,
    ...(typeof track.explicit === "boolean" ? { explicit: track.explicit } : {}),
    ...(track.album?.images?.[0]?.url?.startsWith("https://i.scdn.co/") ? { artworkUrl: track.album.images[0].url } : {})
  };
}

function parseSpotifyUrl(value: unknown): string | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "spotify" in value &&
    typeof value.spotify === "string"
  ) {
    return value.spotify;
  }

  return undefined;
}
