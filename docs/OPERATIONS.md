# Operations

These instructions apply to the supported self-hosting installer. Use a normal
operator account in a clean reviewed checkout. The setup entrypoint requests sudo
when needed; never load service-owned settings into a root Node process.

## Diagnose before restarting

In Discord, moderators can use `/music-admin status`, `/music-admin diagnose` and
`/music-admin repair`. Status includes the installed revision. Repair preserves
the queue and retries the selected recording. Confirmed scoped restarts have a
cooldown; targets include the bot, audio service, cipher and optional viewer.
Restarting the viewer should leave voice audio alone.

`/music-admin diagnostic` downloads a private JSON report for a bug report. It
contains release/version information, health, counts and categorized failures.
It omits member/server identities, requested songs, listening-history records,
raw errors, paths, media URLs and credentials. Audio information is optional and
times out after four seconds. Review any attachment before sharing it publicly;
do not substitute a database dump or raw log export.

For a host-level check:

```bash
./scripts/setup.sh doctor
```

A healthy process does not prove a correct recording or audible full playback.
Provider authorization must be repaired through **Sources**, not repeated
restarts. Use [Troubleshooting](TROUBLESHOOTING.md) for failure-specific actions.

The installed systemd unit expects an event-loop heartbeat every 10 seconds, with
a 60-second watchdog and at most three starts in ten minutes. A frozen process
can therefore restart without receiving a Discord command. A permanently broken
runtime can hit the start limit and still need its operator. The watchdog measures
responsiveness, not source availability or audio quality.

## Back up

```bash
./scripts/setup.sh backup
```

The installer briefly stops active bot/viewer services for a consistent snapshot
of runtime, database and configuration, then restores their prior activity.
Deliberately inactive services remain inactive. Audio services and unrelated
applications are not backup targets. Keep the printed identifier and protect the
snapshot: it contains private account and community data.

The standard runtime and service names retain `audiobot` for compatibility:

| Item | Default location/name |
| --- | --- |
| Bot runtime | `/opt/botsvc/audiobot` |
| Bot state and SQLite | `/var/lib/audiobot/` |
| Bot service | `audiobot.service` |
| Audio services | `lavalink.service`, `audiobot-cipher.service` |
| Optional viewer | `audiobot-viewer.service`, `/opt/musicmaid-viewer` |

Do not edit or copy the SQLite database/sidecars while the bot is writing them.
Playlist JSON exports are portable lists, not a backup of the whole installation.
The optional [statistics cleanup flow](DATA-POLICY.md) previews old rows and
requires a separate backed-up apply step. It does not delete Discord messages.

## Update a reviewed revision

From the new clean candidate checkout:

```bash
./scripts/setup.sh update
```

Alternatively, the existing entrypoint accepts an absolute candidate directory:

```bash
./scripts/setup.sh update /path/to/reviewed/musicmaid
```

The build records commit, dependencies and source inputs. Installation verifies
that metadata before changing services. Do not modify a built release or bypass
the clean-revision check. Updating may interrupt playback for backup and again
for activation; use an idle window and retain the printed backup identifier.

After activation, run Doctor, inspect Status, and complete a short listening
check. If original Spotify audio is enabled, repeat its Sources step to rebuild
the helper from the new revision; see [Spotify audio](SPOTIFY-DIRECT.md). A failed transaction restores matching runtime, bot unit and database;
refreshed provider grants are kept separate from historical code/database state.

## Roll back deliberately

List compatible managed backups without restoring anything:

```bash
./scripts/setup.sh rollback
```

Then supply the chosen exact identifier through the local prompt:

```bash
read -r -p "Backup ID: " musicmaid_backup_id
./scripts/setup.sh rollback "$musicmaid_backup_id"
```

Rollback makes a rescue snapshot first. It restores the selected runtime and
database state, so queue/library changes made after that snapshot are not merged
into it. Current environment settings, refreshed account grants and caches are
preserved. Use Configure or Sources for account/settings repair.

Restore requires compatible database layout and viewer mode. It refuses changed
shared-proxy configuration rather than reverting unrelated sites; custom unit
drop-ins also require operator review. Do not combine files from different
backups, replace the whole live state directory with an old copy, or run an older
bot over a newer unsupported database. Preserve a failed restore and its short
diagnostic result instead of disabling validation.

## Repair configuration or accounts

```bash
./scripts/setup.sh configure
./scripts/setup.sh sources
```

Configure can repair the token and core channel/moderator settings of a managed
installation. Its explicit apply-and-restart step preserves provider/viewer
credentials and restores settings if login fails. Changing the managed guild is
refused. Sources handles separate provider sessions and grants. Never post tokens,
callbacks, cookies, database dumps or unfiltered logs in an issue.
