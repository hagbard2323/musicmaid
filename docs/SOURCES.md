# Audio sources and their limits

Reviewed 13 September 2026. This beta is documented for **self-hosted,
noncommercial use by one community**. Its MIT code licence permits commercial
reuse; it does not grant provider access or rights in recordings. A paid hosted
service is outside the tested and supported scope of this release.

## What source support means

| Mode | What MusicMaid does | What it does not establish |
| --- | --- | --- |
| YouTube | Resolves and plays a selected video recording through the configured extraction/audio services | Permanent availability, provider approval, or access to every restricted video |
| SoundCloud | Resolves a selected upload through the configured audio backend | Access to paywalled/blocked uploads or a promise that every result is the original artist's version |
| Spotify metadata | Reads track/playlist information and searches enabled playback sources for a recording | That the resulting audio comes from Spotify |
| Optional original Spotify audio | Uses an unofficial librespot-based helper to retrieve the selected Spotify recording with an authorized Premium account | Official Spotify integration status, unrestricted concurrent use, or a commercial redistribution licence |

The Spotify Web API provides metadata and account/playback operations. Its Web
Playback SDK is a browser player; neither is the audio helper used by MusicMaid.
The distinction matters when a Spotify link becomes a search for another source's
recording. [Spotify Web API](https://developer.spotify.com/documentation/web-api),
[Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk),
[librespot project](https://github.com/librespot-org/librespot)

## Before enabling a provider

Use [setup](SELF-HOSTING.md) to configure your own application/account where needed.
Do not copy another installation's credentials, cookies or grants. Optional original
Spotify audio is off unless explicitly enabled. The helper needs its own build and
pairing; ordinary Spotify metadata access and Spotify playlist authorization are
separate concerns. Keep secrets out of issues, screenshots and exported playlists.

Spotify's current development mode requires a Premium app owner and allows up to
five allowlisted authenticated Spotify users. That is an API-account limit, not a
limit or entitlement for five Discord listeners. Extended access has separate
eligibility and review requirements. [Spotify quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)

YouTube server access can change independently of this bot's version. A successful
search, account login or health check does not prove that the complete recording
will play. Authentication material can expire or be revoked. Recovery cannot make
a removed or inaccessible upload available.

SoundCloud distinguishes fully playable tracks, previews and blocked tracks in its
API. A subscription or playable result in the SoundCloud app does not establish
availability through this bot's backend. Restricted uploads must not be treated as
full recordings. [SoundCloud playback/access guide](https://developers.soundcloud.com/docs/api/guide#playing)

## Recording choice and quality

A plain search can choose a clear artist/title match or ask for a version. A direct
YouTube/SoundCloud link selects that upload. A Spotify link identifies catalog
metadata; its playback path depends on whether original Spotify audio is enabled
and which source the request uses.

Once a playback recording is selected, automatic recovery retries that recording.
Choosing another version is a separate member action. Matching uses metadata such
as title, artist, duration and available recording identifiers; it does not perform
an audio-fingerprint proof that two recordings are identical. Covers, remixes,
clean/explicit edits and long music-video introductions still need human review.

The original Spotify helper prefers a 320 kbps Vorbis rendition when available
and reports the actual selected format. That describes source audio, not lossless
Discord delivery. The audio backend decodes/encodes for Discord; source bitrate,
recording identity, output settings and listener conditions are different factors.
The beta does not promise a universal bitrate or a best-quality recording for every
query. [Helper implementation](../apps/spotify-stream/src/main.rs),
[Discord voice transport](https://docs.discord.com/developers/topics/voice-connections)

## When a source fails

- Read the source/error shown in the current player; preserve the incident ID for
  a report. Include the requested link and selected version, without credentials.
- A moderator can diagnose or retry the current recording. Known service/account
  failures suspend playback with the queue retained; they cannot always be repaired
  with a restart.
- An operator may need to refresh authorization or repair a dependency. Persistent
  access refusal calls for an available recording/source, not repeated restarts.
- A listening check should cover the complete track and the next queue transition,
  including pause/seek if those controls will be used.

See [Troubleshooting](TROUBLESHOOTING.md) and [Operations](OPERATIONS.md). Automated
fixture tests are distinct from live account access and audible playback.

## Provider terms and media rights

These are relevant boundaries, not a legal verdict about every bot or every use.
Self-hosting, making code public, operating a service and redistributing music are
different activities. Operators should check the applicable provider terms and
rights for their actual audience and territories; obtain qualified advice before
offering a paid or broadly hosted service.

- **Spotify:** its policy restricts shared broadcasting, mixed-service integrations,
  commercial streaming, voice control and derived listening metrics. Using a
  dedicated account or an open-source client does not remove those restrictions.
  [Developer Policy](https://developer.spotify.com/policy)
- **YouTube:** API policies restrict audio/video separation and unauthorized
  downloading/caching; the general service terms also govern extraction and
  redistribution. The official embedded player is a different delivery model.
  [Developer Policies](https://developers.google.com/youtube/terms/developer-policies),
  [service terms](https://www.youtube.com/static?template=terms)
- **SoundCloud:** API terms restrict mixed-service/on-demand aggregation unless
  licensed and require a separate agreement for Go content. Uploader attribution,
  access controls and media rights still matter. [API Terms](https://developers.soundcloud.com/docs/api/terms-of-use)

The optional YouTube viewer follows the selected YouTube video with video-only
media while Discord voice remains independent. It is an extracted-media Activity,
not the official YouTube embedded player, and does not change these boundaries.

## Outside this beta

Audius, general internet radio, and a member-facing local/owned-media library are
future source work, not hidden features enabled by accepting arbitrary URLs.
Licensed or original files are useful acceptance fixtures, but a fixture is not a
catalog integration. Voice commands and Release Radar are postponed. See the
[roadmap](ROADMAP.md) and [voice research](VOICE-RESEARCH.md).
