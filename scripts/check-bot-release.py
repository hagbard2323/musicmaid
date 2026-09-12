#!/usr/bin/env python3
"""Validate a built release before any installed runtime or unit is changed."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

NODE = '/usr/bin/node'
NOTIFY = '/usr/bin/systemd-notify'


def regular(path, maximum=None):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or not info.st_size or (maximum and info.st_size > maximum):
        raise ValueError('The release contains a missing, empty, linked or oversized required file.')
    return path.read_bytes()


def validate(release):
    root_manifest = regular(release / 'release-manifest.json', 65536)
    if root_manifest != regular(release / 'dist/release.json', 65536):
        raise ValueError('Root and compiled release manifests do not match.')
    manifest = json.loads(root_manifest)
    if (not isinstance(manifest, dict) or type(manifest.get('version')) is not int
            or manifest['version'] != 1 or manifest.get('dirty') is not False
            or not isinstance(manifest.get('revision'), str)
            or not re.fullmatch(r'[a-f0-9]{40}', manifest['revision'])):
        raise ValueError('Deployment requires a clean release manifest with a known commit revision.')
    if not isinstance(manifest.get('sourceHash'), str) or not re.fullmatch(r'[a-f0-9]{64}', manifest['sourceHash']):
        raise ValueError('The release manifest needs a valid source hash.')
    built_at = manifest.get('builtAt')
    if not isinstance(built_at, str):
        raise ValueError('The release manifest needs a valid build timestamp.')
    try:
        timestamp = datetime.datetime.fromisoformat(built_at.replace('Z', '+00:00'))
        if timestamp.tzinfo is None:
            raise ValueError()
    except ValueError:
        raise ValueError('The release manifest needs a valid build timestamp.') from None
    lock = regular(release / 'package-lock.json', 20 * 1024 * 1024)
    if manifest.get('dependencyHash') != hashlib.sha256(lock).hexdigest():
        raise ValueError('The release dependency lock does not match its manifest.')
    package = json.loads(regular(release / 'package.json', 1024 * 1024))
    if not isinstance(package, dict) or package.get('type') != 'module':
        raise ValueError('The built bot requires its module package.json at the runtime root.')
    entry = release / 'dist/apps/bot/src/index.js'
    regular(entry)
    if not (release / 'node_modules').is_dir():
        raise ValueError('The release is missing its installed Node dependencies.')
    # A backup or installed runtime may be writable by the bot. Its script is
    # checked as data; only this reviewed toolset's checker may execute as root.
    regular(release / 'scripts/release-manifest.mjs', 1024 * 1024)
    manifest_checker = Path(__file__).resolve().with_name('release-manifest.mjs')
    regular(manifest_checker, 1024 * 1024)
    for name in ('bot-service-unit.py', 'restore-bot-database.py'):
        regular(release / 'scripts' / name, 1024 * 1024)
    unit = regular(release / 'deploy/audiobot.service', 65536).decode('utf8')
    if not re.search(r'^ExecStart=/usr/bin/node dist/apps/bot/src/index\.js\s*$', unit, re.M):
        raise ValueError('The bot unit must start the matching compiled runtime with the supported Node executable.')
    if not os.access(NODE, os.X_OK):
        raise ValueError('The bot Node executable is unavailable.')
    runtime_helpers = []
    if re.search(r'^Type=notify\s*$', unit, re.M):
        if not os.access(NOTIFY, os.X_OK):
            raise ValueError('The notify service requires an executable /usr/bin/systemd-notify.')
        for name in ('watchdog.js', 'release-info.js'):
            helper = release / 'dist/apps/bot/src/runtime' / name
            regular(helper)
            runtime_helpers.append(helper)
    checks = [
        [NODE, '-e', 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major<22||(major===22&&minor<13)?1:0)'],
        [NODE, '--check', str(entry)],
        [NODE, '--input-type=module', '-e',
         'import {createRequire} from "node:module"; import {pathToFileURL} from "node:url";'
         'const require=createRequire(pathToFileURL(process.argv[1]));'
         'for(const name of ["discord.js","shoukaku","dotenv/config"]) require.resolve(name);',
         str(release / 'package.json')],
    ]
    checks.extend([NODE, '--check', str(helper)] for helper in runtime_helpers)
    checks.append([NODE, str(manifest_checker), '--check', str(release)])
    for command in checks:
        result = subprocess.run(command, capture_output=True, timeout=15,
                                env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
        if result.returncode:
            raise ValueError('Node version, compiled entry syntax or runtime dependency resolution failed preflight.')
    return manifest


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: check-bot-release.py <built-release-directory>')
    try:
        validate(Path(sys.argv[1]))
    except (OSError, ValueError, subprocess.SubprocessError):
        raise SystemExit('Release preflight failed: verify the clean build manifest, dependency lock, compiled runtime, Node dependencies and bot unit prerequisites. This preflight made no deployment changes.') from None
    print('Release manifest, compiled runtime and bot unit prerequisites verified.')
