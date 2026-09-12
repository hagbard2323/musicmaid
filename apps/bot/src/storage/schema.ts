export const musicSchemaVersion = 3;
export const musicSchemaSql = `
CREATE TABLE IF NOT EXISTS music_sessions (
  guild_id TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS music_values (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS music_playlists (
  guild_id TEXT NOT NULL, id TEXT NOT NULL, name_key TEXT NOT NULL, creator TEXT NOT NULL,
  revision INTEGER NOT NULL, snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  PRIMARY KEY(guild_id,id), UNIQUE(guild_id,name_key)
) STRICT;
CREATE TABLE IF NOT EXISTS music_requests (
  guild_id TEXT NOT NULL, entry_id TEXT NOT NULL, requester TEXT NOT NULL, added_at INTEGER NOT NULL,
  title TEXT NOT NULL, author TEXT NOT NULL, uri TEXT NOT NULL,
  played INTEGER NOT NULL, finished INTEGER NOT NULL, failed INTEGER NOT NULL, counted INTEGER NOT NULL,
  PRIMARY KEY(guild_id,entry_id)
) STRICT;
CREATE INDEX IF NOT EXISTS music_requests_period ON music_requests(guild_id,added_at);
CREATE TABLE IF NOT EXISTS music_genres (
  guild_id TEXT NOT NULL, uri TEXT NOT NULL, genres TEXT NOT NULL CHECK(json_valid(genres)),
  actor TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(guild_id,uri)
) STRICT;
`;
