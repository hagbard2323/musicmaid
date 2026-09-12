# Optional YouTube video

**Watch video** launches a Discord Activity for the exact YouTube recording already
selected for voice playback. It is optional for each listener and has no audio
track; the bot continues providing voice audio independently.

The viewer stays open while any current or queued YouTube recording remains,
including across Spotify/SoundCloud gaps. It waits during those gaps and resumes
for the next YouTube track. It closes when playback stops or none remains. Closing
the viewer does not change the queue. Resync and a per-device timing adjustment
are available. This feature uses an Activity, not a Go Live user account.

## Set it up

First complete [Self-hosting](SELF-HOSTING.md) and the authorized YouTube source
setup. Prepare a real hostname you control, resolving to your host, with public
HTTPS and inbound TCP 80/443. Keep audio/internal ports private.

```bash
./scripts/setup.sh video
```

The guided installer needs that hostname and the **same Discord application's
OAuth2 Client Secret** at a hidden prompt. It is separate from the Bot Token and
Spotify secret. Setup checks shared-proxy ownership before using Caddy and can
briefly restart the bot.

In that application's Developer Portal:

1. Enable **Activities** and save.
2. Add a root URL mapping: prefix `/`, target your viewer hostname without `https://`.
3. Configure the intended platforms and test access; check an ordinary member,
   not just the application owner.
4. If an OAuth2 Redirect URI is required, Discord documents `https://127.0.0.1`
   as an Activity development placeholder. The Embedded App SDK handles the
   Activity return flow; no local callback web server is needed.

Portal controls and distribution conditions can change. Follow the current
[Discord Activity setup](https://docs.discord.com/developers/activities/building-an-activity)
and [networking documentation](https://docs.discord.com/developers/activities/development-guides/networking).
An **EMBEDDED flag** error means Activities are not enabled for the app; server
reinstallation or credential resets do not enable that setting.

## What runs on the host

The separate viewer worker has its own service account and Discord OAuth secret.
It accesses a restricted Unix socket for state reads and preparation of the
currently selected video. It receives neither the bot token nor provider grants
or cookies. OAuth identifies the member; the bot checks voice membership before
serving the session. Short-lived opaque tickets authorize media requests.

The worker binds to loopback; Caddy serves public HTTPS. Signed upstream media
addresses remain server-side. The public viewer has no pause, skip, queue-edit or
restart API. Audio requests take priority over optional extractor work.

Video is video-only HTTPS MP4/H.264 at up to 720p/30 fps. Unsupported formats fail
only the optional video. Streams use backpressure and bounded concurrency, without
transcoding or a persistent video cache. Source compatibility depends on YouTube.

## Test and recover

Open Watch video partway through a YouTube track; check audio, timing, pause,
seek and skip. Queue YouTube → another source → YouTube and verify waiting and
resumption in the same viewer. Remove the last queued YouTube entry and verify
closure. Repeat with an ordinary member and Discord mobile.

`/music-admin diagnose` includes reader status. A moderator can confirm
`/music-admin restart target:viewer` to restart only the web worker without
disconnecting voice. An expired viewing session should be reopened from the
current player. Source account restrictions still need an operator.

Use the managed [update/rollback flow](OPERATIONS.md) for paired bot/viewer
changes. Retain current provider grants when restoring historical code/database state.
