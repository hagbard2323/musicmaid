#!/usr/bin/env bash
set -euo pipefail
if [[ "$EUID" -ne 0 ]]; then echo 'Run this setup with sudo.' >&2; exit 1; fi
test -f /opt/botsvc/audiobot/scripts/authorize-spotify-playlists.mjs
cd /opt/botsvc/audiobot
exec runuser -u botsvc -- env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/node --env-file=/opt/botsvc/audiobot/.env /opt/botsvc/audiobot/scripts/authorize-spotify-playlists.mjs
