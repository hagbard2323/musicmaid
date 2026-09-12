#!/usr/bin/env bash
set -euo pipefail
if [[ "$EUID" -ne 0 ]]; then echo "Run this reviewed release with sudo." >&2; exit 1; fi
RELEASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/botsvc/audiobot
BACKUP_DIR="/var/backups/audiobot/release-$(date -u +%Y%m%dT%H%M%SZ)"
test "$RELEASE_DIR" != "$APP_DIR"
test -s "$RELEASE_DIR/dist/apps/bot/src/index.js"
test -d "$RELEASE_DIR/node_modules"
test -f "$APP_DIR/.env"
python3 "$RELEASE_DIR/scripts/check-bot-release.py" "$RELEASE_DIR"
systemd-analyze verify "$RELEASE_DIR/deploy/audiobot.service"
node -e 'if (+process.versions.node.split(".")[0] < 22) process.exit(1)'
node "$RELEASE_DIR/scripts/deploy-preflight.mjs"
if [[ -n "${YOUTUBE_COOKIE_SOURCE:-}" ]]; then
  python3 "$RELEASE_DIR/scripts/configure-youtube.py" "$YOUTUBE_COOKIE_SOURCE" --check-only
  install -d -m 755 /opt/botsvc/audiobot-tools
  python3 -m venv /opt/botsvc/audiobot-tools/venv
  /opt/botsvc/audiobot-tools/venv/bin/python -m pip install --disable-pip-version-check --no-input -r "$RELEASE_DIR/infra/lavalink/youtube-requirements.txt"
fi
install -d -m 700 "$BACKUP_DIR"
config_files=(
  /etc/systemd/system/audiobot.service
  /etc/polkit-1/rules.d/50-audiobot-restart.rules
  /etc/containers/systemd/lavalink.container
  /etc/containers/systemd/audiobot-cipher.container
  /opt/lavalink/application.yml
  /opt/lavalink/application-production.yml
)
for path in "${config_files[@]}"; do
  if [[ -f "$path" ]]; then cp --parents --preserve=mode,ownership,timestamps "$path" "$BACKUP_DIR/"; else printf '%s\n' "$path" >> "$BACKUP_DIR/new-files"; fi
done
# Download before interrupting any playback.
podman pull ghcr.io/lavalink-devs/lavalink:4.2.2
podman pull ghcr.io/kikkia/yt-cipher@sha256:4c5ec381ff57336cfc24822d2b526a5ad7cd0171f61065a1bbc87bb736842449
SNAPSHOT_READY=false
rollback() {
  trap - ERR INT TERM
  if [[ "$SNAPSHOT_READY" != true ]]; then
    echo "Release snapshot did not complete; original runtime, database and settings were left unchanged. Restarting MusicMaid. Backup: $BACKUP_DIR" >&2
    systemctl reset-failed audiobot
    systemctl start audiobot || true
    exit 1
  fi
  echo "Deployment failed. Restoring $BACKUP_DIR" >&2
  if ! systemctl stop audiobot; then
    echo "Could not stop MusicMaid for rollback; runtime, database and settings were left untouched. Backup: $BACKUP_DIR" >&2
    exit 1
  fi
  if ! systemctl stop audiobot-cipher; then
    echo "Could not stop the cipher for rollback; MusicMaid remains stopped and backup files were not restored. Backup: $BACKUP_DIR" >&2
    exit 1
  fi
  rsync -a --checksum --delete "$BACKUP_DIR/runtime/" "$APP_DIR/"
  for path in "${config_files[@]}"; do
    if [[ -f "$BACKUP_DIR$path" ]]; then cp -a "$BACKUP_DIR$path" "$path"; else rm -f -- "$path"; fi
  done
  # Restore only the database and matching sidecars. Refreshed Spotify grants,
  # YouTube cookies and extractor caches must retain their current state.
  python3 "$RELEASE_DIR/scripts/restore-bot-database.py" "$BACKUP_DIR/state"
  systemctl daemon-reload
  systemctl start audiobot-cipher || true
  systemctl restart lavalink || true
  systemctl reset-failed audiobot
  systemctl start audiobot || true
  exit 1
}
trap rollback ERR INT TERM
systemctl stop audiobot
# The default database may live inside APP_DIR/data. Both snapshots therefore
# require a stopped bot; an incomplete copy must never become a rollback source.
cp -a "$APP_DIR" "$BACKUP_DIR/runtime"
if [[ -d /var/lib/audiobot ]]; then cp -a /var/lib/audiobot "$BACKUP_DIR/state"; fi
SNAPSHOT_READY=true
if [[ -n "${YOUTUBE_COOKIE_SOURCE:-}" ]]; then
  python3 "$RELEASE_DIR/scripts/configure-youtube.py" "$YOUTUBE_COOKIE_SOURCE"
fi
"$RELEASE_DIR/scripts/install-services.sh"
rsync -a --checksum --delete --exclude .env --exclude .setup --exclude logs --exclude .git --exclude data --exclude canary "$RELEASE_DIR/" "$APP_DIR/"
chown -R botsvc:botsvc "$APP_DIR"
chmod 600 "$APP_DIR/.env"
# Install the bot unit only after its matching compiled runtime is in place.
install -m 644 "$RELEASE_DIR/deploy/audiobot.service" /etc/systemd/system/audiobot.service
systemctl daemon-reload
systemctl restart audiobot-cipher.service
systemctl restart lavalink.service
cd "$APP_DIR"
ready=false
for attempt in {1..30}; do
  if CIPHER_URL=http://127.0.0.1:18001 runuser -u botsvc -- /usr/bin/node --env-file="$APP_DIR/.env" "$APP_DIR/scripts/service-check.mjs"; then
    ready=true
    break
  else
    check_status=$?
    if [[ "$check_status" -eq 2 ]]; then break; fi
  fi
  sleep 2
done
if [[ "$ready" != true ]]; then false; fi
if runuser -u botsvc -- /usr/bin/node --env-file="$APP_DIR/.env" -e 'process.exit(process.env.YOUTUBE_COOKIE_FILE ? 0 : 1)'; then
  # Check the same authenticated resolver before declaring this release healthy.
  runuser -u botsvc -- /usr/bin/node --env-file="$APP_DIR/.env" "$APP_DIR/scripts/youtube-check.mjs"
fi
systemctl reset-failed audiobot
systemctl start audiobot
invocation="$(systemctl show audiobot -p InvocationID --value)"
bot_ready=false
for attempt in {1..30}; do
  if systemctl is-active --quiet audiobot && journalctl "_SYSTEMD_INVOCATION_ID=$invocation" -n 100 --no-pager -o cat | awk '/^Registered MusicMaid guild commands\.$/ {registered=1} /^MusicMaid ready\.$/ {ready=1} END {exit !(registered && ready)}'; then
    bot_ready=true
    break
  fi
  sleep 1
done
if [[ "$bot_ready" != true ]]; then false; fi
systemctl is-active --quiet audiobot lavalink audiobot-cipher
trap - ERR INT TERM
echo "Deployment complete. Rollback snapshot: $BACKUP_DIR"
echo "Run /music-admin diagnose and the listening checklist in docs/OPERATIONS.md."
