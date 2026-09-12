#!/usr/bin/env bash
set -euo pipefail

if [[ "$EUID" -eq 0 ]]; then
  echo "Run this wrapper as your normal account. Only the final reviewed installer uses sudo; builds and tests must not run as root." >&2
  exit 1
fi

REPO_URL="${AUDIOBOT_REPO_URL:-https://github.com/hagbard2323/musicmaid.git}"
BRANCH="${AUDIOBOT_BRANCH:-main}"
APP_DIR="${AUDIOBOT_APP_DIR:-/opt/botsvc/audiobot}"
APP_USER="${AUDIOBOT_APP_USER:-botsvc}"
APP_GROUP="${AUDIOBOT_APP_GROUP:-botsvc}"
DEPLOY_KEY="${AUDIOBOT_DEPLOY_KEY:-$HOME/.ssh/audiobot_github}"

if [[ "$APP_DIR" != /opt/botsvc/audiobot || "$APP_USER" != botsvc || "$APP_GROUP" != botsvc ]]; then
  echo "This updater supports the reviewed /opt/botsvc/audiobot installation owned by botsvc:botsvc. Custom runtime or account overrides are not supported." >&2
  exit 1
fi
if [[ -n "${AUDIOBOT_SRC_DIR:-}" ]]; then
  echo "AUDIOBOT_SRC_DIR is no longer used. Existing checkouts are left untouched; each deployment gets an isolated build." >&2
fi
if [[ -z "${GIT_SSH_COMMAND:-}" && -f "$DEPLOY_KEY" ]]; then
  printf -v quoted_deploy_key '%q' "$DEPLOY_KEY"
  export GIT_SSH_COMMAND="ssh -i $quoted_deploy_key -o IdentitiesOnly=yes"
fi

RELEASE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/musicmaid-github-XXXXXXXX")"
trap 'rm -rf -- "$RELEASE_DIR"' EXIT
git clone --depth 1 --single-branch --branch "$BRANCH" -- "$REPO_URL" "$RELEASE_DIR"
cd "$RELEASE_DIR"
RELEASE_COMMIT="$(git rev-parse --verify HEAD)"

if [[ ! -f package.json || ! -f package-lock.json ]]; then
  echo "Refusing to build: the selected branch is not an npm project with a lockfile." >&2
  exit 1
fi

npm ci
npm run check
npm test
npm run build

if [[ ! -s dist/apps/bot/src/index.js ]]; then
  echo "Refusing to deploy: build output dist/apps/bot/src/index.js is missing." >&2
  exit 1
fi
if [[ ! -f scripts/deploy-bot-update.sh || ! -f scripts/restore-bot-database.py ]]; then
  echo "Refusing to deploy: this branch lacks the reviewed transactional updater. Publish the tested release first." >&2
  exit 1
fi

echo "Build and checks passed for $RELEASE_COMMIT. Starting the reviewed deployment transaction."
# Only fixed inline code reads the protected runtime settings. No repository
# lifecycle script runs as root before this final installer handoff.
sudo /usr/bin/node --input-type=module - "$RELEASE_DIR" <<'NODE'
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
try {
  const release = process.argv[2];
  const runtimeEnv = '/opt/botsvc/audiobot/.env';
  if (!lstatSync(runtimeEnv).isFile()) throw new Error('The existing MusicMaid runtime needs a regular .env file. This wrapper cannot perform a fresh installation.');
  const settings = parseEnv(readFileSync(runtimeEnv, 'utf8'));
  if (settings.VIEWER_ENABLED !== undefined && !['true', 'false'].includes(settings.VIEWER_ENABLED)) throw new Error('VIEWER_ENABLED must be true or false before deployment.');
  const viewer = settings.VIEWER_ENABLED === 'true';
  const installer = join(release, 'scripts', viewer ? 'deploy-viewer.sh' : 'deploy-bot-update.sh');
  const required = [installer, join(release, 'scripts/restore-bot-database.py')];
  if (viewer) required.push(join(release, 'dist/viewer/app.js'), join(release, 'dist/apps/viewer-server/src/index.js'));
  if (required.some(path => !lstatSync(path).isFile())) throw new Error('The selected release lacks the required reviewed installer or viewer build.');
  console.log(viewer ? 'Updating MusicMaid and its installed viewer together.' : 'Updating MusicMaid through the bot rollback transaction.');
  const result = spawnSync('/bin/bash', [installer], { stdio: 'inherit' });
  if (result.error) throw new Error('The reviewed installer could not start.');
  process.exit(result.status ?? 1);
} catch {
  console.error('Deployment refused: verify the existing runtime .env and required transactional installer/viewer artifacts. No direct copy or service restart was attempted.');
  process.exit(1);
}
NODE
