#!/usr/bin/env bash
set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "Run with sudo from the reviewed Audiobot checkout." >&2
  exit 1
fi
REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="/var/backups/audiobot/services-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$BACKUP_DIR"

install_service_file() {
  local relative="$1" destination="$2"
  if [[ -f "$destination" ]]; then
    cp --parents --preserve=mode,ownership,timestamps "$destination" "$BACKUP_DIR/"
  fi
  install -D -m 644 "$REPO_DIR/$relative" "$destination"
}

command -v podman >/dev/null
command -v systemctl >/dev/null
id botsvc >/dev/null
test -d /etc/polkit-1/rules.d
test -f /opt/botsvc/audiobot/.env
install -d -m 700 -o botsvc -g botsvc /var/lib/audiobot
# The bot unit is coupled to its compiled runtime and is installed by the
# enclosing release transaction after its stopped-bot snapshot and runtime copy.
install_service_file deploy/50-audiobot-restart.rules /etc/polkit-1/rules.d/50-audiobot-restart.rules
install_service_file infra/lavalink/lavalink.container /etc/containers/systemd/lavalink.container
install_service_file infra/lavalink/audiobot-cipher.container /etc/containers/systemd/audiobot-cipher.container
install_service_file infra/lavalink/application.yml /opt/lavalink/application.yml
install_service_file infra/lavalink/application-production.yml /opt/lavalink/application-production.yml
systemctl daemon-reload
echo "Installed service files; backup: $BACKUP_DIR"
echo "No services restarted. After the application build passes, start audiobot-cipher, then restart lavalink and audiobot."
echo "The matching bot service unit is installed only by deploy-release.sh or deploy-bot-update.sh."
