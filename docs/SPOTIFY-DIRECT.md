# Optional original Spotify audio

MusicMaid has two distinct Spotify modes:

| Mode | What plays |
| --- | --- |
| Catalog metadata/matching | Spotify identifies the desired song; an explicitly selected or matched YouTube/SoundCloud recording supplies audio. |
| Optional original audio | A paired eligible Premium account and an unofficial pinned librespot helper provide the selected Spotify recording. |

The Web API credentials do not provide full audio. Original audio is disabled
in the template and enabled only after source checks pass. It is an unofficial
integration with account/provider dependencies, not an official Spotify bot API.
Read the current access and service limitations in [Sources](SOURCES.md).

## Connect your account

From the supported managed checkout, as your normal operator account:

```bash
./scripts/setup.sh sources
```

Configure your own Spotify API credentials for catalog lookup, then choose the
separate original-audio pairing step. Approve its fresh code in your browser using
the account intended for the bot. Consent remains an interactive account-owner
action. Never put tokens or callback addresses into an issue or Discord message.

The helper uses a librespot client identity, so the consent flow can identify a
Spotify desktop client. The account remains subject to provider eligibility,
session, market and access restrictions. A dedicated account avoids coupling
bot operation to changes in a member's personal account; it does not eliminate
those restrictions.

The installer builds as your normal user, checks the prepared helper and source
under the runtime account, and enables the candidate settings only after success.
Activation can briefly restart the bot. Pair again through Sources if access is
revoked or you change accounts; repeated restarts cannot renew consent.

## Use and verify

Paste a Spotify track link into Add music. When original audio is enabled, the
card must identify **Spotify** as the actual source. Normal catalog searches also
include Spotify; choose it in the source selector to restrict text search.
Change version remains an explicit review/replace action.

A selected Spotify recording is not automatically swapped for a YouTube upload
after failure. Saved playlists keep their existing selected source IDs; enabling
original audio does not rewrite older metadata matches. Import a new playlist
to save Spotify IDs. Playlist access needs its own consent step; see
[Playlists](PLAYLISTS.md).

Test full playback, pause/resume, forward/backward seek, replay, queue transition
and mid-track restart recovery. Source initialization/decoder checks are useful,
but only listening confirms audible Discord delivery.

## Technical limits

The Rust helper receives short-lived credentials and an exact track ID over stdin,
checks identity/account access, and emits Ogg Vorbis packets. It does not create
a Spotify Connect device or control a personal app queue. Supported source variants
include Vorbis 320/160/96; the actual format is reported. Discord output is Opus.
Lossless delivery and identical mastering are not claimed.

Prepared portions use bounded memory: 64 MiB per preparation and 128 MiB of active
audio payloads, with additional process/copy overhead possible. Oversized media is
refused. Transport uses a short-lived loopback capability URL on the same host
as Lavalink; do not expose it through a public proxy.

Seeking creates a fresh attempt for the same recording at a verified source offset.
This avoids an initial Vorbis seek issue in the pinned playback stack and keeps
the full-song timeline and paused intent. Preparation and same-recording recovery
have deadlines; they cannot grant access to unavailable content.

The [helper README](../apps/spotify-stream/README.md),
[locked dependency inventory](../apps/spotify-stream/DEPENDENCIES.md) and
[retained upstream license](../apps/spotify-stream/LIBRESPOT-LICENSE) describe
the optional build. Follow [Operations](OPERATIONS.md) for updates and rollback;
do not restore stale account grants over refreshed live authorization.
