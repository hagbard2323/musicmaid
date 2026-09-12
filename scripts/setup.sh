#!/usr/bin/env bash
set -euo pipefail
if [[ "$EUID" -eq 0 ]]; then
  echo "Run setup.sh as your normal account. It requests sudo only for system installation and protected maintenance; builds must not run as root." >&2
  exit 1
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec /usr/bin/python3 -B "$SCRIPT_DIR/self-host-setup.py" "$@"
