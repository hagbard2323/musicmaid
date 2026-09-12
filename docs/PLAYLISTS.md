# Playlists and stats

Open **Playlists** from the player or use `/playlist list`. The library belongs
to your Discord server; playback uses the normal voice-channel permissions.

## Save and play

- **Create playlist** opens a name form. **Save queue** captures the current
  recording and upcoming order as a new list. Saving never starts or interrupts audio.
- **Save track** adds the selected recording to an owned list, even if playback
  advances while its menu is open. Adding the same recording this way twice is a no-op.
- **Play playlist** appends its entries; an idle queue starts automatically.
  **Browse tracks** allows individual selection. In Fair mode the requester's
  entries alternate with other members' turns without changing the saved list.
- Creators and moderators can rename, import into, reorder, remove from or delete
  a list. Deletion requires confirmation. Everyone can browse, play and export.
  Revision checks reject stale edits; duplicate names are refused.

Limits are **50 playlists per server**, **500 recordings per list**, and
**500 upcoming queue entries**. A bulk queue append over capacity adds nothing.
Saved lists retain selected public source IDs and metadata, not expiring audio
URLs. Source playlist changes do not silently alter a saved list. Unavailable
recordings require the existing recovery/choice flow, not silent replacement.

## Export and import a copy

**Export** or `/playlist export name:<name>` returns:

- `musicmaid-playlist.json`: a versioned document for import.
- `musicmaid-track-links.txt`: readable titles, artists and public links.

Exports include ordered public recording references and display metadata. They
exclude account grants, signed transport URLs, requester IDs, listening history
and artwork payloads. They are shareable playlists, not installation backups.

Use **Import JSON** or `/playlist import-file file:<attachment> [name:<name>]`.
The document must be a MusicMaid export, at most **2 MiB** and **500 finite
recordings**. Validation checks its version and canonical public references.
Import creates a new list owned by the importer; it does not overwrite another
list, transfer ownership or queue music. External download links and arbitrary
local paths are not accepted. Availability and display metadata are checked when played.

## Import a YouTube or Spotify playlist link

**Import link** or `/playlist import` asks for a name, source URL and starting
track. It prepares up to **100 entries per batch**. A preview reports matched,
skipped and unmatched entries; **Save imported tracks** commits the result.
Import alone never starts music. Use later starting positions, such as 101, to
append subsequent batches to an existing list.

Only one link import runs per server, with an eight-minute deadline. Cancellation,
failed access and abandoned previews leave the saved library unchanged. Imports
can run alongside playback.

YouTube imports preserve usable video IDs and playlist order; private/deleted/live
entries and unusable metadata are reported as skipped. A normal Play watch URL
containing both `v` and `list` still requests one video. Bulk import is explicit.

Spotify needs separate playlist consent through `./scripts/setup.sh sources`.
Original-audio pairing alone does not authorize playlist access. When original
Spotify audio is enabled, imports save its recording IDs. Otherwise they save
matched YouTube/SoundCloud recordings; a metadata match cannot prove identical
sound or master. Account/list-access conditions are in [Sources](SOURCES.md).

Enabling original Spotify audio later does not rewrite existing saved matches.
Import a new list if you want to save Spotify recording IDs instead.

## Stats

**Stats** or `/music-stats` shows Songs, Members and Genres for 7 days, 30 days or
all retained ledger history, with the top ten in each view.

- **Songs:** distinct requests with confirmed playback progress. Retries, duplicate
  callbacks, restarts, seeking and repeat loops do not create extra requests.
- **Members:** individual requests attributed to the member who queued them.
  Each played playlist entry is credited to that requester; saving/importing adds no plays.
- **Genres:** explicit community tags, up to three per recording. Tags are not
  inferred from titles. Coverage is shown; totals may overlap for multi-tag recordings.

The request ledger outlives the last 100 history entries. It cannot reconstruct
older requests that were already discarded before the ledger existed. Tagging
requires access to the current voice session. See [Data policy](DATA-POLICY.md)
for stored information and operator retention controls.
