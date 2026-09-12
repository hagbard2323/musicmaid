#!/usr/bin/env bash
set -euo pipefail
if [[ "$EUID" -ne 0 ]]; then echo 'Run this reviewed viewer update with sudo.' >&2; exit 1; fi
RELEASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/botsvc/audiobot
VIEWER_DIR=/opt/musicmaid-viewer
BACKUP_DIR="/var/backups/audiobot/viewer-$(date -u +%Y%m%dT%H%M%SZ)"
test -f "$RELEASE_DIR/dist/viewer/app.js"
test -f "$RELEASE_DIR/dist/apps/viewer-server/src/index.js"
test -f "$APP_DIR/.env"
test -f /etc/caddy/Caddyfile
python3 "$RELEASE_DIR/scripts/check-bot-release.py" "$RELEASE_DIR"
systemd-analyze verify "$RELEASE_DIR/deploy/audiobot.service"
command -v caddy >/dev/null
python3 - <<'PY'
import re,subprocess
listeners=subprocess.check_output(['ss','-H','-ltnp','sport = :18080'],text=True)
pid=subprocess.run(['systemctl','show','audiobot-viewer','-p','MainPID','--value'],capture_output=True,text=True).stdout.strip()
if listeners and (not pid.isdigit() or pid=='0' or any('pid='+pid+',' not in line for line in listeners.splitlines())):
    raise SystemExit('Viewer port 18080 belongs to another service. Nothing was changed.')
PY
install -d -m 700 "$BACKUP_DIR"
cp -a "$APP_DIR/.env" "$BACKUP_DIR/bot.env"
cp -a /etc/caddy/Caddyfile "$BACKUP_DIR/Caddyfile"
for path in /etc/audiobot-viewer.env /etc/caddy/musicmaid-video/site.conf /etc/systemd/system/audiobot-viewer.service /etc/tmpfiles.d/audiobot-viewer.conf /etc/polkit-1/rules.d/50-audiobot-restart.rules; do
  if [[ -f "$path" ]]; then cp -a "$path" "$BACKUP_DIR/$(basename -- "$path")"; fi
done
if [[ -d "$VIEWER_DIR" ]]; then cp -a "$VIEWER_DIR" "$BACKUP_DIR/viewer-runtime"; fi
VIEWER_WAS_ACTIVE=false
if systemctl is-active --quiet audiobot-viewer; then VIEWER_WAS_ACTIVE=true; fi
VIEWER_WAS_ENABLED=false
if systemctl is-enabled --quiet audiobot-viewer 2>/dev/null; then VIEWER_WAS_ENABLED=true; fi
INSTALL_STARTED=false
rollback() {
  trap - ERR INT TERM
  if [[ "$INSTALL_STARTED" != true ]]; then
    # Only the configuration helper could have changed a file at this point.
    if [[ -f "$BACKUP_DIR/audiobot-viewer.env" ]]; then cp -a "$BACKUP_DIR/audiobot-viewer.env" /etc/audiobot-viewer.env; else rm -f /etc/audiobot-viewer.env; fi
    echo "Viewer setup stopped before installation. Existing services were not changed. Backup: $BACKUP_DIR" >&2
    exit 1
  fi
  echo "Viewer setup failed. Restoring settings from $BACKUP_DIR" >&2
  if [[ "$(systemctl show audiobot-viewer -p LoadState --value)" != "not-found" ]]; then
    systemctl stop audiobot-viewer || true
    if [[ "$VIEWER_WAS_ENABLED" != true ]]; then systemctl disable audiobot-viewer || true; fi
  fi
  if [[ -e "$BACKUP_DIR/bot-update.backup" || -L "$BACKUP_DIR/bot-update.backup" ]]; then
    local bot_backup
    bot_backup="$(python3 - "$BACKUP_DIR/bot-update.backup" <<'PY'
import os,re,stat,sys
from pathlib import Path
marker=Path(sys.argv[1]); info=marker.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o077 or info.st_size>512:
    raise SystemExit('Bot rollback marker is not a private regular file. Restore the recorded backups manually.')
backup=Path(marker.read_text().strip())
if backup.parent!=Path('/var/backups/audiobot') or not re.fullmatch(r'bot-update-\d{8}T\d{6}Z',backup.name):
    raise SystemExit('Bot rollback marker names an invalid backup directory.')
info=backup.lstat()
if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o077 or not (backup/'runtime/.env').is_file():
    raise SystemExit('Bot rollback snapshot is incomplete or its directory is not private.')
print(backup)
PY
)"
    # The inner updater may already have succeeded and disarmed its own rollback.
    # Restore its matching runtime/state/unit before restoring original viewer flags.
    python3 "$RELEASE_DIR/scripts/bot-service-unit.py" validate "$bot_backup"
    systemctl stop audiobot
    rsync -a --checksum --delete "$bot_backup/runtime/" "$APP_DIR/"
    python3 "$RELEASE_DIR/scripts/bot-service-unit.py" restore "$bot_backup"
    python3 "$RELEASE_DIR/scripts/restore-bot-database.py" "$bot_backup/state"
  fi
  cp -a "$BACKUP_DIR/bot.env" "$APP_DIR/.env"
  cp -a "$BACKUP_DIR/Caddyfile" /etc/caddy/Caddyfile
  for path in /etc/audiobot-viewer.env /etc/caddy/musicmaid-video/site.conf /etc/systemd/system/audiobot-viewer.service /etc/tmpfiles.d/audiobot-viewer.conf /etc/polkit-1/rules.d/50-audiobot-restart.rules; do
    if [[ -f "$BACKUP_DIR/$(basename -- "$path")" ]]; then cp -a "$BACKUP_DIR/$(basename -- "$path")" "$path"; else rm -f "$path"; fi
  done
  if [[ -d "$BACKUP_DIR/viewer-runtime" ]]; then rsync -a --checksum --delete "$BACKUP_DIR/viewer-runtime/" "$VIEWER_DIR/"; fi
  systemctl daemon-reload
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && systemctl reload caddy || true
  if [[ "$VIEWER_WAS_ACTIVE" == true ]]; then systemctl start audiobot-viewer || true; fi
  if [[ "${BOT_UPDATED:-false}" == true ]]; then systemctl reset-failed audiobot; systemctl restart audiobot || true; fi
  exit 1
}
trap rollback ERR INT TERM
VIEWER_HOST="$(python3 "$RELEASE_DIR/scripts/configure-viewer.py")"
INSTALL_STARTED=true
if [[ "$VIEWER_WAS_ACTIVE" == true ]]; then systemctl stop audiobot-viewer; fi
if ! getent passwd musicmaid-viewer >/dev/null; then useradd --system --user-group --home-dir /nonexistent --shell /sbin/nologin musicmaid-viewer; fi
install -d -m 755 "$VIEWER_DIR"
rsync -a --checksum --delete "$RELEASE_DIR/dist/" "$VIEWER_DIR/dist/"
rsync -a --checksum --delete "$RELEASE_DIR/node_modules/" "$VIEWER_DIR/node_modules/"
install -m 644 "$RELEASE_DIR/package.json" "$VIEWER_DIR/package.json"
chown -R root:root "$VIEWER_DIR"
chmod -R a+rX "$VIEWER_DIR"
install -m 644 "$RELEASE_DIR/deploy/audiobot-viewer.service" /etc/systemd/system/audiobot-viewer.service
install -m 644 "$RELEASE_DIR/deploy/audiobot-viewer.tmpfiles" /etc/tmpfiles.d/audiobot-viewer.conf
install -m 644 "$RELEASE_DIR/deploy/50-audiobot-restart.rules" /etc/polkit-1/rules.d/50-audiobot-restart.rules
systemd-tmpfiles --create /etc/tmpfiles.d/audiobot-viewer.conf
python3 - "$APP_DIR/.env" "$VIEWER_HOST" <<'PY'
import json,os,re,sys,tempfile
from pathlib import Path
path=Path(sys.argv[1]); info=path.stat()
settings={'VIEWER_ENABLED':'true','VIEWER_SOCKET':'/run/musicmaid-viewer/reader.sock'}
pattern=r'^\s*(?:export\s+)?(?:'+'|'.join(settings)+r')\s*='
lines=[line for line in path.read_text().splitlines() if not re.match(pattern,line)]
lines.extend(key+'='+json.dumps(value) for key,value in settings.items())
fd,temporary=tempfile.mkstemp(dir=path.parent,prefix='.env.viewer-')
with os.fdopen(fd,'w') as output:
    os.fchown(output.fileno(),info.st_uid,info.st_gid); output.write('\n'.join(lines)+'\n'); output.flush(); os.fsync(output.fileno())
os.replace(temporary,path)
site=Path('/etc/caddy/musicmaid-video/site.conf')
site.parent.mkdir(mode=0o755,exist_ok=True)
site.write_text(sys.argv[2]+' {\n    encode zstd gzip\n    reverse_proxy 127.0.0.1:18080\n    log {\n        output discard\n    }\n}\n')
os.chmod(site,0o644)
caddy=Path('/etc/caddy/Caddyfile'); content=caddy.read_text(); include='import /etc/caddy/musicmaid-video/site.conf'
if include not in content: caddy.write_text(content.rstrip()+'\n\n# MusicMaid optional video\n'+include+'\n')
PY
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl daemon-reload
BOT_UPDATED=true
BOT_UPDATE_BACKUP_MARKER="$BACKUP_DIR/bot-update.backup" "$RELEASE_DIR/scripts/deploy-bot-update.sh"
runuser -u musicmaid-viewer -- /usr/bin/node --input-type=module -e 'import { connect } from "node:net"; const socket=connect("/run/musicmaid-viewer/reader.sock"); socket.setTimeout(3000,()=>socket.destroy(new Error("Viewer reader timeout"))); socket.on("error",()=>{console.error("Viewer user cannot reach the private reader.");process.exitCode=1;}); socket.on("connect",()=>socket.end());'
systemctl enable audiobot-viewer
systemctl restart audiobot-viewer
systemctl reload caddy
READY=false
echo 'Waiting for viewer HTTPS readiness…'
for attempt in {1..30}; do
  if curl --fail --silent --max-time 3 "https://$VIEWER_HOST/health" -o /dev/null; then READY=true; break; fi
  sleep 2
done
if [[ "$READY" != true ]]; then echo 'Viewer HTTPS did not become ready; check DNS/certificate access.' >&2; false; fi
trap - ERR INT TERM
echo "Viewer installed at https://$VIEWER_HOST"
echo "Backup: $BACKUP_DIR"
echo 'In MusicMaid’s Discord Developer Portal: enable Activities and set URL mapping / to the hostname above (without https://).'
echo 'Then play a YouTube track and use Watch video. It stays open while YouTube tracks remain in the queue.'
