# Self-host MusicMaid

This beta supports **AlmaLinux 10, x86_64, one Discord community per host**.
Use your own Discord application and provider accounts. The installer has been
exercised in a clean AlmaLinux 10.2 VM; fresh-account playback and independent
member/mobile acceptance remain pending. See [Validation](VALIDATION.md).

## Prepare

Use a normal Linux account with Bash, Python 3, Git, an interactive sudo session
and an SSH terminal. You also need a browser for account consent. The installer
bootstraps supported system dependencies, including Node, and builds the
application as your normal account. Do not start setup with sudo.

Obtain a clean checkout of a reviewed MusicMaid revision on the target host:

```bash
git clone https://github.com/hagbard2323/musicmaid.git
cd musicmaid
```

The initial beta is source-based. Choose the reviewed release/tag or commit you
intend to install; a checkout of an arbitrary future branch is not a tested release.
Installers validate clean source/build metadata and do not accept a modified
working tree as an unchanged release. Keep the checkout for later maintenance.

## Create your Discord application

1. Create an app in the [Developer Portal](https://discord.com/developers/applications).
   Keep its **Application ID** and **Bot Token**. The token goes into the installer's
   hidden prompt; it is not the OAuth2 Client Secret.
2. Configure **Guild Install** with `bot` and `applications.commands` scopes. Open
   the install link and select your server. Setup does not invite the bot for you.
   [Discord installation guide](https://docs.discord.com/developers/quick-start/getting-started)
3. In the music text channel, allow **View Channel, Send Messages, Embed Links,
   Attach Files and Read Message History**. In intended voice channels, allow
   **View Channel, Connect and Speak**. **Pin Messages** is optional for console
   pinning. Ordinary playback does not require Administrator or member-management
   permissions.
4. Leave privileged Gateway intents disabled. MusicMaid requests only Guilds and
   Guild Voice States. Enable Developer Mode in your Discord client to copy the
   **Server ID**, **music text Channel ID** and optional **moderator Role IDs**.

Members need access to those channels and application commands. Moderator actions
require Manage Server or a configured moderator role. Use a regular voice channel
with room for the bot for initial testing.

## Install the base bot

Run from the checkout as your normal Linux user:

```bash
./scripts/setup.sh check
./scripts/setup.sh configure
./scripts/setup.sh install
```

Or run `./scripts/setup.sh` for the menu. Check reports prerequisites and host
conflicts. Configure prompts for Discord settings, generates a Lavalink password
and writes local `.setup/settings.json` privately. On a fresh host it does not
change services or contact Discord. Enter retains an existing value; `-` clears
optional moderator roles.

Install requests sudo for package/service-account setup and protected activation.
Dependency installation, checks, tests and compilation run unprivileged. It refuses
to overwrite an existing installation; use Update later. The runtime has its own
service account, and an optional viewer has a different account.

Keep `.setup/`, runtime settings and backups private. Never copy another
operator's token, session, grants or database. Existing installations created
outside this installer are not automatically adopted: do not forge an ownership
marker to bypass that check.

## Connect only the sources you need

```bash
./scripts/setup.sh sources
```

| Setup step | Purpose |
| --- | --- |
| YouTube session | Configure your own authorized session for the host's extractor. Account and host-network restrictions can still block a recording. |
| Spotify API credentials | Enable catalog metadata/search through your developer app. These credentials do not supply original audio. |
| Spotify playlist consent | Permit playlist metadata access available to the consenting account. This is separate from audio pairing. |
| Spotify original-audio pairing | Enable the optional unofficial helper using an eligible Premium account. Read [Spotify audio](SPOTIFY-DIRECT.md) first. |

For YouTube, place your own Netscape-format cookie export on the target host as a
file owned by your setup user, mode 0600, at most 64 KiB. Enter its absolute path
when prompted. Setup accepts only the relevant cookies and requires a source
check before activation. It does not read your everyday browser profile or
provide a shared account. An authorized browser elsewhere does not prove that
this host can play the recording.

For Spotify, use your own app from the
[developer dashboard](https://developer.spotify.com/dashboard). Follow the
separate metadata, playlist-consent and audio-pairing prompts. For playlist
consent, register the exact Redirect URI shown by setup. Open the authorization
URL, then paste the complete callback address only into the waiting terminal.
A loopback connection error can be expected because the helper has no callback
web server. Do not publish that address or open an inbound callback port.
Current access conditions are in [Sources](SOURCES.md).

Source builds remain unprivileged; source checks must pass before candidate
settings are enabled. YouTube, Spotify API and original-audio activation can
briefly restart the bot. Playlist consent alone does not need a playback restart.
On an existing installation, use an idle window.

SoundCloud is a configured source; restricted, preview-only, removed or paywalled
uploads may be refused. No integration promises access to every catalog entry.
Now playing shows the actual source, including when a Spotify metadata request
was matched to another provider.

## Add optional video later

Voice audio works independently of the viewer. If you want **Watch video**, prepare
a hostname you control pointing to the host and public HTTPS. Configure DNS and
inbound TCP 80/443 yourself; keep internal service ports private.

```bash
./scripts/setup.sh video
```

Setup checks existing web-service ownership and asks before using shared Caddy
configuration. It also needs the **same Discord application's OAuth2 Client
Secret**, entered privately. Portal Activity enablement and URL mapping remain
manual steps: follow [YouTube viewer](YOUTUBE-VIEWER.md). Installation/update can
briefly restart the bot.

## Verify with real listeners

```bash
./scripts/setup.sh doctor
```

Join voice, use `/music` → **Add music**, and play a known full recording. Listen
to confirm the version and audio, inspect the source, then test pause/resume,
skip and a playlist. Test each enabled provider separately. Successful lookup,
process readiness and decoder output are different from audible Discord playback.

Before accepting the installation, record `/music-admin status`, listen for more
than two hours and test with another member and a Discord mobile client. Include
FIFO/Fair queues, playlist sharing, recovery and optional video. Use the
[member checklist](COMMUNITY-BETA.md#beta-acceptance) and
[troubleshooting guide](TROUBLESHOOTING.md).

## Keep it maintainable

Use the same setup entrypoint for **doctor, backup, update and rollback**.
[Operations](OPERATIONS.md) explains interruption, compatibility and data-restoration
behavior. Updates remain reviewed manual actions; do not schedule unattended
pull-and-execute jobs.
