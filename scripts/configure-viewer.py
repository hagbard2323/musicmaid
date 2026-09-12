#!/usr/bin/env python3
"""Configure the separate viewer without placing secrets in arguments or output."""
import getpass
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

def configure(runtime=Path('/opt/botsvc/audiobot/.env'), path=Path('/etc/audiobot-viewer.env'), *, node_executable='/usr/bin/node'):
    # The bot owns its environment file: treat it as data, never as Node startup
    # configuration in this root process (NODE_OPTIONS can preload arbitrary code).
    # Tests inject a runner path; the production CLI keeps the checked fixed Node.
    script = ('import {readFileSync} from "node:fs"; import {parseEnv} from "node:util";'
              'const settings=parseEnv(readFileSync(process.argv[1],"utf8"));'
              'process.stdout.write(settings.DISCORD_CLIENT_ID ?? "");')
    client_id = subprocess.check_output([node_executable, '--input-type=module', '-e', script, str(runtime)],
                                       text=True, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}).strip()
    if not re.fullmatch(r'\d{5,22}', client_id):
        raise SystemExit('MusicMaid has no valid Discord application ID.')

    old = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if '=' in line:
                key, value = line.split('=', 1)
                try: old[key] = json.loads(value)
                except ValueError: old[key] = value

    default = str(old.get('VIEWER_PUBLIC_ORIGIN', '')).removeprefix('https://')
    # stdout is captured by the installer; /dev/tty is not seekable.
    # Separate handles avoid Python's buffered update mode requiring a seek.
    with open('/dev/tty', 'w') as terminal:
        terminal.write(f'Viewer hostname [{default}]: ' if default else 'Viewer hostname (required, e.g. music.example.com): ')
        terminal.flush()
    with open('/dev/tty', 'r') as terminal:
        line = terminal.readline()
    if not line:
        raise SystemExit('Viewer setup cancelled: no hostname input received.')
    host = line.strip() or default
    if not host:
        raise SystemExit('A viewer hostname is required for first-time setup.')
    if not re.fullmatch(r'(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}', host):
        raise SystemExit('Enter a hostname only, without https:// or a path.')
    secret = getpass.getpass('Discord application CLIENT SECRET (hidden; Enter keeps existing): ')
    secret = secret or str(old.get('DISCORD_CLIENT_SECRET', ''))
    if not re.fullmatch(r'[A-Za-z0-9_-]{20,200}', secret):
        raise SystemExit('A Discord application client secret is required. This is not the bot token or Spotify secret.')

    settings = {'DISCORD_CLIENT_ID': client_id, 'DISCORD_CLIENT_SECRET': secret, 'VIEWER_PUBLIC_ORIGIN': 'https://' + host,
                'VIEWER_SOCKET': '/run/musicmaid-viewer/reader.sock', 'VIEWER_PORT': '18080', 'VIEWER_ASSETS': '/opt/musicmaid-viewer/dist/viewer'}
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.audiobot-viewer-')
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(''.join(key + '=' + json.dumps(value) + '\n' for key, value in settings.items()))
            output.flush(); os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

    # Only the hostname is emitted for the installer, never the secret.
    print(host)


if __name__ == '__main__':
    if os.geteuid() != 0:
        raise SystemExit('Run the viewer installer with sudo.')
    try:
        configure()
    except (EOFError, KeyboardInterrupt):
        raise SystemExit('Viewer setup cancelled.') from None
