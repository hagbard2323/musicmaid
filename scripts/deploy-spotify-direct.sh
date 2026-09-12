#!/usr/bin/env bash
set -euo pipefail
if [[ "$EUID" -ne 0 ]]; then echo 'Run this reviewed update with sudo.' >&2; exit 1; fi
RELEASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/botsvc/audiobot
AUDIO_AUTH=/var/lib/audiobot/spotify-direct.json
if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo 'Usage: sudo ./scripts/deploy-spotify-direct.sh /absolute/path/to/authorization.json' >&2
  exit 1
fi
AUTH_SOURCE="$1"
AUDIO_BINARY=/opt/botsvc/audiobot-tools/musicmaid-spotify-stream
BACKUP_DIR="/var/backups/audiobot/spotify-direct-$(date -u +%Y%m%dT%H%M%SZ)"
test -f "$APP_DIR/.env"
test -f "$AUTH_SOURCE"
test -f "$RELEASE_DIR/dist/apps/bot/src/audio/spotify-direct.js"
test -d "$RELEASE_DIR/node_modules"
(cd "$RELEASE_DIR/bin" && sha256sum --check SHA256SUMS)
"$RELEASE_DIR/bin/musicmaid-spotify-stream" --version
install -d -m 700 "$BACKUP_DIR"
cp -a "$APP_DIR/.env" "$BACKUP_DIR/env"
if [[ -f "$AUDIO_AUTH" ]]; then cp -a "$AUDIO_AUTH" "$BACKUP_DIR/auth"; fi
if [[ -f "$AUDIO_BINARY" ]]; then cp -a "$AUDIO_BINARY" "$BACKUP_DIR/binary"; fi
rollback() {
  trap - ERR INT TERM
  if [[ "${BOT_UPDATE_STARTED:-false}" == true ]] && ! systemctl stop audiobot; then
    echo "Could not stop MusicMaid for rollback; settings, helper and account grant were left untouched. Backup: $BACKUP_DIR" >&2
    exit 1
  fi
  cp -a "$BACKUP_DIR/env" "$APP_DIR/.env"
  # The preflight or running bot may have rotated this grant. Credentials are
  # live account state, not release configuration; never rewind or delete them.
  if [[ -f "$BACKUP_DIR/binary" ]]; then cp -a "$BACKUP_DIR/binary" "$AUDIO_BINARY"; else rm -f "$AUDIO_BINARY"; fi
  rm -f "$AUDIO_BINARY.next"
  if [[ "${BOT_UPDATE_STARTED:-false}" == true ]]; then systemctl start audiobot || true; fi
  echo "Spotify update failed; previous settings restored from $BACKUP_DIR. Current account grant preserved." >&2
  exit 1
}
BOT_UPDATE_STARTED=false
trap rollback ERR INT TERM
install -d -m 700 -o botsvc -g botsvc /var/lib/audiobot
install -d -m 755 /opt/botsvc/audiobot-tools
install -m 755 "$RELEASE_DIR/bin/musicmaid-spotify-stream" "$AUDIO_BINARY.next"
mv -f "$AUDIO_BINARY.next" "$AUDIO_BINARY"
if [[ "$(realpath "$AUTH_SOURCE")" != "$(realpath -m "$AUDIO_AUTH")" ]]; then install -m 600 -o botsvc -g botsvc "$AUTH_SOURCE" "$AUDIO_AUTH"; fi
chown botsvc:botsvc "$AUDIO_AUTH"
chmod 600 "$AUDIO_AUTH"
# Verify the actual protected account, helper and local audio engine before enabling.
runuser -u botsvc -- env SPOTIFY_DIRECT_BINARY="$AUDIO_BINARY" SPOTIFY_DIRECT_AUTH_FILE="$AUDIO_AUTH" /usr/bin/node --env-file="$APP_DIR/.env" "$RELEASE_DIR/scripts/spotify-direct-check.mjs"
python3 - "$APP_DIR/.env" <<'PY'
import json, os, re, sys, tempfile
from pathlib import Path
path=Path(sys.argv[1]); info=path.stat()
settings={"SPOTIFY_DIRECT_ENABLED":"true", "SPOTIFY_DIRECT_AUTH_FILE":"/var/lib/audiobot/spotify-direct.json", "SPOTIFY_DIRECT_BINARY":"/opt/botsvc/audiobot-tools/musicmaid-spotify-stream"}
pattern=r'^\s*(?:export\s+)?(?:'+'|'.join(settings)+r')\s*='
lines=[line for line in path.read_text().splitlines() if not re.match(pattern,line)]
lines.extend(key+'='+json.dumps(value) for key,value in settings.items())
fd, temporary=tempfile.mkstemp(dir=path.parent,prefix='.env.spotify-direct-')
try:
    with os.fdopen(fd,'w') as output:
        os.fchown(output.fileno(),info.st_uid,info.st_gid)
        output.write('\n'.join(lines)+'\n'); output.flush(); os.fsync(output.fileno())
    os.replace(temporary,path)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
BOT_UPDATE_STARTED=true
"$RELEASE_DIR/scripts/deploy-bot-update.sh"
trap - ERR INT TERM
echo "Original Spotify audio enabled. Account/helper backup: $BACKUP_DIR"
