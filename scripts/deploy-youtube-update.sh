#!/usr/bin/env bash
set -euo pipefail
RELEASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo 'Usage: sudo ./scripts/deploy-youtube-update.sh /absolute/path/to/youtube-cookies.txt' >&2
  exit 1
fi
export YOUTUBE_COOKIE_SOURCE="$1"
# The shared release transaction restores only its stopped database; account
# cookies and refreshed grants are deliberately outside software rollback.
exec "$RELEASE_DIR/scripts/deploy-release.sh"
