#!/usr/bin/env bash
set -euo pipefail
if [[ "$EUID" -ne 0 ]]; then echo "Run this reviewed bot update with sudo." >&2; exit 1; fi
RELEASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/botsvc/audiobot
BACKUP_DIR="/var/backups/audiobot/bot-update-$(date -u +%Y%m%dT%H%M%SZ)"
test "$RELEASE_DIR" != "$APP_DIR"
test -f "$APP_DIR/.env"
for helper in bot-service-unit.py restore-bot-database.py; do
  if [[ ! -s "$RELEASE_DIR/scripts/$helper" ]]; then echo "Required release transaction helper is missing." >&2; exit 1; fi
done
python3 "$RELEASE_DIR/scripts/check-bot-release.py" "$RELEASE_DIR"
systemd-analyze verify "$RELEASE_DIR/deploy/audiobot.service"
# This update changes only the bot. Check, but never restart, the audio services.
cd "$APP_DIR"
CIPHER_URL=http://127.0.0.1:18001 runuser -u botsvc -- /usr/bin/node --env-file="$APP_DIR/.env" "$APP_DIR/scripts/service-check.mjs"
install -d -m 700 "$BACKUP_DIR"
SNAPSHOT_READY=false
BOT_STOPPED=false
rollback() {
  trap - ERR INT TERM
  if [[ "$SNAPSHOT_READY" != true ]]; then
    echo "Bot snapshot did not complete; original runtime, database and unit were left unchanged. Backup: $BACKUP_DIR" >&2
    if [[ "$BOT_STOPPED" == true ]]; then systemctl reset-failed audiobot; systemctl start audiobot || true; fi
    exit 1
  fi
  echo "Bot update failed. Restoring $BACKUP_DIR" >&2
  if ! systemctl stop audiobot; then
    echo "Could not stop MusicMaid for rollback; runtime, database and unit were left untouched. Backup: $BACKUP_DIR" >&2
    exit 1
  fi
  python3 "$RELEASE_DIR/scripts/bot-service-unit.py" validate "$BACKUP_DIR"
  rsync -a --checksum --delete "$BACKUP_DIR/runtime/" "$APP_DIR/"
  python3 "$RELEASE_DIR/scripts/bot-service-unit.py" restore "$BACKUP_DIR"
  python3 "$RELEASE_DIR/scripts/restore-bot-database.py" "$BACKUP_DIR/state"
  systemctl daemon-reload
  systemctl reset-failed audiobot
  systemctl start audiobot || true
  exit 1
}
trap rollback ERR INT TERM
systemctl stop audiobot
BOT_STOPPED=true
cp -a "$APP_DIR" "$BACKUP_DIR/runtime"
if [[ -d /var/lib/audiobot ]]; then cp -a /var/lib/audiobot "$BACKUP_DIR/state"; fi
python3 "$RELEASE_DIR/scripts/bot-service-unit.py" snapshot "$BACKUP_DIR"
SNAPSHOT_READY=true
if [[ -n "${BOT_UPDATE_BACKUP_MARKER:-}" ]]; then
  # An enclosing viewer install may fail after this update succeeds. Publish its
  # recovery handle only after runtime, database and unit snapshots are complete.
  python3 - "$BOT_UPDATE_BACKUP_MARKER" "$BACKUP_DIR" <<'PY'
import os,re,stat,sys,tempfile
from pathlib import Path
marker,backup=map(Path,sys.argv[1:])
parent=marker.parent
info=parent.lstat()
if (marker.name!='bot-update.backup' or parent.parent!=Path('/var/backups/audiobot')
    or not re.fullmatch(r'viewer-\d{8}T\d{6}Z',parent.name)
    or not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o077
    or marker.exists() or marker.is_symlink()):
    raise SystemExit('Bot backup marker must be a new file in the private viewer backup directory.')
fd,temporary=tempfile.mkstemp(dir=parent,prefix='.bot-update-backup-')
try:
    with os.fdopen(fd,'w') as output:
        output.write(str(backup)+'\n'); output.flush(); os.fsync(output.fileno())
    os.replace(temporary,marker)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
fi
rsync -a --checksum --delete --exclude .env --exclude .setup --exclude logs --exclude .git --exclude data --exclude canary "$RELEASE_DIR/" "$APP_DIR/"
chown -R botsvc:botsvc "$APP_DIR"
chmod 600 "$APP_DIR/.env"
install -m 644 "$RELEASE_DIR/deploy/audiobot.service" /etc/systemd/system/audiobot.service
systemctl daemon-reload
# A reviewed replacement gets a fresh start budget; runtime crash limits remain.
systemctl reset-failed audiobot
systemctl start audiobot
invocation="$(systemctl show audiobot -p InvocationID --value)"
ready=false
for attempt in {1..30}; do
  if systemctl is-active --quiet audiobot && journalctl "_SYSTEMD_INVOCATION_ID=$invocation" -n 100 --no-pager -o cat | awk '/^Registered MusicMaid guild commands\.$/ {registered=1} /^MusicMaid ready\.$/ {ready=1} END {exit !(registered && ready)}'; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then false; fi
trap - ERR INT TERM
echo "Bot update complete; Discord commands registered. Backup: $BACKUP_DIR"
