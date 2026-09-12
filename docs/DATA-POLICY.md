# Data and retention

MusicMaid is operated on your host. This document describes the beta's behavior;
it is not a hosted-service privacy policy. Tell community members what your
installation records and how you handle access, retention and backups.

## What is stored

SQLite retains server/member identifiers needed for music requests and ownership,
selected recordings and metadata, queue/checkpoint state, recent request history,
saved playlists, request statistics and explicit community genre tags. The visible
recent history is limited to 100 entries; the statistics ledger persists beyond
that window until deliberately cleaned up. Operational logs and backups can also
contain identifiers and request information.

Provider credentials and sessions are private runtime files. Expiring media
transport addresses are not saved as playlist/history recording references.
Playlist JSON export contains public recording references and display metadata,
without requester IDs, listening history or account grants. It is a shareable
list, not a complete personal-data export.

## Preview old statistics

For a managed self-hosted installation, run as your normal operator account:

```bash
read -r -p "Server ID: " musicmaid_guild_id
read -r -p "Remove statistics before date (YYYY-MM-DD): " musicmaid_before
./scripts/setup.sh cleanup preview request-stats "$musicmaid_guild_id" "$musicmaid_before"
```

The server ID must be 17–20 decimal digits and the date must be between
1970-01-01 and today. The cutoff means **strictly before 00:00 UTC on that date**.
An explicit server ID can target that server's existing records in the managed
database, including legacy data; it does not silently apply to every server.

Preview reads the database and writes a private manifest valid for **one hour**.
It does not delete rows, change services or stop playback. Review the reported
scope/counts and the printed `cleanup-…` identifier before applying it.

## Apply the reviewed cleanup

```bash
read -r -p "Cleanup manifest ID: " musicmaid_cleanup_id
./scripts/setup.sh cleanup apply "$musicmaid_cleanup_id"
```

Apply verifies the manifest, database identity and eligible rows again, creates
a standard private self-host backup, and removes the selected old
`music_requests` rows in a transaction. It briefly stops previously active
bot/viewer services and restores their activity. Previously inactive services
remain inactive. If there are no eligible rows, apply does not stop services or
make a backup. An expired or changed preview must be generated again.

Cleanup preserves requests referenced by the current track, upcoming queue or
recent history, including original request IDs used by retries/loops. It preserves
playlists, genre tags and account credentials. It does not delete channel messages.

**Deleted statistics no longer contribute to song/member/genre charts.** Backup
copies still contain those records, and restoring an earlier database can bring
them back. Protect and manage backups according to your own retention decision.

This is manual statistics retention, not automatic pruning, secure erasure,
complete per-member deletion, or guaranteed disk-space reclamation. It does not
run VACUUM or erase information from logs, exports, Discord messages or other
copies. More complete data-lifecycle tooling remains future work.

Use [Operations](OPERATIONS.md) for backups/rollback and [Security](../SECURITY.md)
for safe reporting. Never attach a database or backup to a public issue.
