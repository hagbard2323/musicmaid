"""Fixed-layout AlmaLinux installation transactions. No build runs with root privileges."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import tempfile
import time
import urllib.request

from .config import SettingsError, load_settings
from .maintenance import Layout, MaintenanceError, installation_lock

APP = '/opt/botsvc/audiobot'
STATE = '/var/lib/audiobot'
MARKER = STATE + '/installation.json'
LAVA = '/opt/lavalink'
TOOLS = '/opt/botsvc/audiobot-tools'
LAVA_ENV = '/etc/audiobot-lavalink.env'
UNITS = ('audiobot.service', 'lavalink.service', 'audiobot-cipher.service')
LAVA_IMAGE = 'ghcr.io/lavalink-devs/lavalink:4.2.2'
CIPHER_IMAGE = 'ghcr.io/kikkia/yt-cipher@sha256:4c5ec381ff57336cfc24822d2b526a5ad7cd0171f61065a1bbc87bb736842449'
FILES = ('/etc/systemd/system/audiobot.service', '/etc/containers/systemd/lavalink.container',
         '/etc/containers/systemd/audiobot-cipher.container', '/etc/polkit-1/rules.d/50-audiobot-restart.rules', LAVA_ENV)
ROOT_INPUTS = ('package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.viewer.json', 'docker-compose.yml',
               'apps/viewer/index.html', 'apps/spotify-stream/Cargo.toml', 'apps/spotify-stream/Cargo.lock', 'bin/SHA256SUMS')
SOURCE_DIRS = ('apps/bot/src', 'apps/viewer/src', 'apps/viewer-server/src', 'apps/spotify-stream/src', 'scripts', 'deploy', 'infra')


class SetupError(RuntimeError):
    """Safe operator feedback; subprocess diagnostics and configuration stay private."""


class Host:
    """Filesystem/runner seam for fixture tests; never exposed as a CLI root option."""
    def __init__(self, root=Path('/'), runner=None):
        self.root = Path(root)
        self.runner = runner or subprocess.run

    def path(self, path):
        return self.root / str(path).lstrip('/')

    def uid(self):
        return os.geteuid()

    def caller_uid(self):
        value = os.environ.get('SUDO_UID')
        if value is not None and not re.fullmatch(r'\d+', value):
            raise SetupError('The invoking account could not be verified.')
        return int(value) if value is not None else os.geteuid()

    def architecture(self):
        return platform.machine()

    def executable(self, name):
        return self.command_path(name) is not None

    def command_path(self, name):
        choices = ('/usr/sbin/ss', '/usr/bin/ss') if name == 'ss' else ('/usr/bin/' + name,)
        return next((path for path in choices if os.access(self.path(path), os.X_OK)), None)

    def run(self, args, check=True, timeout=30):
        try:
            result = self.runner(args, capture_output=True, text=True, timeout=timeout,
                                 env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
        except (OSError, subprocess.SubprocessError):
            raise SetupError('A required host command did not complete: ' + Path(args[0]).name) from None
        if check and result.returncode:
            raise SetupError('A required host command failed: ' + Path(args[0]).name + '. Run doctor for the installed service state.')
        return result

    def chown(self, path, uid, gid):
        os.chown(path, uid, gid, follow_symlinks=False)

    def info(self, path):
        return Path(path).lstat()

    def sleep(self, seconds):
        time.sleep(seconds)

    def audio_ready(self, password):
        try:
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *_args, **_kwargs):
                    return None
            # Local service authentication must never follow redirects or an
            # inherited HTTP proxy to another host.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            request = urllib.request.Request('http://127.0.0.1:2333/v4/info', headers={'Authorization': password})
            with opener.open(request, timeout=2) as response:
                info = json.load(response)
            if info.get('version', {}).get('semver') != '4.2.2' or not any(p.get('name') == 'youtube-plugin' and p.get('version') == '1.18.2' for p in info.get('plugins', [])):
                return False
            with opener.open('http://127.0.0.1:18001/metrics', timeout=2) as response:
                return response.status == 200
        except (OSError, ValueError):
            return False


def _root(host):
    if host.uid() != 0:
        raise SetupError('This fixed host operation requires the reviewed sudo step.')


def _regular(path, maximum=20 * 1024 * 1024):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= maximum:
        raise SetupError('A required file is missing, linked, empty or oversized.')
    return path.read_bytes()


def _no_link_components(path):
    for item in [Path(path), *Path(path).parents]:
        if item.is_symlink():
            raise SetupError('Linked setup or managed paths are not supported.')


def require_managed_root(release=None, *, host=None):
    host = host or Host(); _root(host)
    path = host.path(MARKER)
    try:
        _no_link_components(path)
        info = host.info(path)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError()
        marker = json.loads(_regular(path, 65536))
        units = marker.get('units')
        release_info = marker.get('release')
        if (type(marker.get('version')) is not int or marker['version'] != 1 or marker.get('managedBy') != 'musicmaid-self-host'
                or marker.get('appDir') != APP or marker.get('stateDir') != STATE or not isinstance(units, list)
                or len(set(units)) != len(units) or not set(UNITS).issubset(units)
                or not set(units).issubset((*UNITS, 'audiobot-viewer.service'))
                or not isinstance(release_info, dict)
                or not re.fullmatch(r'[a-f0-9]{40}', release_info.get('commit', ''))
                or not re.fullmatch(r'[a-f0-9]{64}', release_info.get('manifestSha256', ''))
                or not isinstance(marker.get('installedAt'), str)):
            raise ValueError()
        if datetime.fromisoformat(marker['installedAt'].replace('Z', '+00:00')).tzinfo is None:
            raise ValueError()
        return {**{key: marker[key] for key in ('version', 'managedBy', 'appDir', 'stateDir', 'units', 'installedAt')},
                'release': {key: release_info[key] for key in ('commit', 'manifestSha256')}}
    except (OSError, ValueError, KeyError, TypeError):
        raise SetupError('This host has no valid root-owned MusicMaid ownership marker. Legacy or unrelated installations will not be changed.') from None


def _version(host):
    if not host.executable('node'):
        return None
    result = host.run(['/usr/bin/node', '--version'], check=False)
    match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)\s*', result.stdout) if result.returncode == 0 else None
    return tuple(map(int, match.groups())) if match else None


def check_host(release, *, host=None):
    host = host or Host()
    issues, conflicts, pending = [], [], []
    def visible_exists(target):
        path = host.path(target)
        try:
            return path.exists() or path.is_symlink()
        except PermissionError:
            message = 'Protected path requires root verification: ' + target
            (conflicts if host.uid() == 0 else pending).append(message)
            return False
    try:
        values = dict(line.split('=', 1) for line in host.path('/etc/os-release').read_text().splitlines() if '=' in line)
        supported_os = values.get('ID', '').strip('"') == 'almalinux' and values.get('VERSION_ID', '').strip('"').split('.')[0] == '10'
    except OSError:
        supported_os = False
    systemd = host.path('/run/systemd/system').is_dir() and host.executable('systemctl')
    supported = supported_os and host.architecture() == 'x86_64' and systemd
    if not supported:
        issues.append('Supported profile: AlmaLinux 10 x86_64 with systemd running as the host service manager.')
    version = _version(host)
    dependencies = {name: host.executable(name) for name in ('npm', 'podman', 'rsync', 'git', 'curl', 'python3', 'pip3', 'openssl', 'ss', 'systemd-notify')}
    dependencies['node'] = version is not None and version >= (22, 13, 0)
    if not all(dependencies.values()):
        issues.append('Host prerequisites need the guided bootstrap step.')
    existing_paths = [path for path in (APP, STATE, LAVA, TOOLS, *FILES) if visible_exists(path)]
    for parent in ('/opt', '/opt/botsvc'):
        path = host.path(parent)
        if visible_exists(parent):
            info = host.info(path)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
                conflicts.append('The tools ancestor ' + parent + ' must already be a root-owned directory without group/world write access; it will not be converted.')
    managed = False
    if host.uid() == 0 and visible_exists(MARKER):
        try:
            require_managed_root(host=host); managed = True
        except SetupError:
            pass
    if existing_paths:
        conflicts.append('Reserved MusicMaid installation paths already exist; use managed update/configure or inspect a legacy installation.')
    for database in ('passwd', 'group'):
        result = host.run(['/usr/bin/getent', database, 'botsvc'], check=False)
        if result.returncode == 0:
            conflicts.append('The reserved botsvc ' + database + ' entry already exists; it will not be reused by a fresh install.')
    if systemd:
        for unit in (*UNITS, 'audiobot-ipv6.service'):
            result = host.run(['/usr/bin/systemctl', 'show', unit, '-p', 'LoadState', '--value'], check=False)
            if result.stdout.strip() not in ('', 'not-found'):
                conflicts.append('Reserved service already exists: ' + unit)
    if dependencies['ss']:
        for port in (2333, 18001):
            result = host.run([host.command_path('ss'), '-H', '-ltn', 'sport = :' + str(port)], check=False)
            if result.returncode:
                conflicts.append('Could not verify the required local listener port ' + str(port) + '.')
            elif result.stdout.strip():
                conflicts.append('Required port ' + str(port) + ' is already in use.')
    if dependencies['podman'] and host.uid() == 0:
        for name in ('audiobot-lavalink', 'audiobot-cipher'):
            result = host.run(['/usr/bin/podman', 'container', 'exists', name], check=False)
            if result.returncode == 0:
                conflicts.append('Reserved container already exists: ' + name)
            elif result.returncode != 1:
                conflicts.append('Could not inspect the reserved Podman containers.')
    issues.extend(conflicts); issues.extend(pending)
    return {'supported': supported, 'existing': bool(existing_paths), 'managed': managed, 'issues': issues,
            'conflicts': conflicts, 'rootVerificationPending': bool(pending), 'dependencies': dependencies, 'nodeVersion': '.'.join(map(str, version)) if version else None}


def bootstrap(release, *, host=None):
    host = host or Host(); _root(host)
    report = check_host(release, host=host)
    if not report['supported'] or report['conflicts']:
        raise SetupError('Fresh-host bootstrap refused: ' + ' '.join(report['conflicts'] or report['issues']))
    packages = {'node': ('nodejs', 'nodejs-npm'), 'npm': ('nodejs-npm',), 'podman': ('podman',), 'rsync': ('rsync',),
                'git': ('git',), 'curl': ('curl',), 'python3': ('python3',), 'pip3': ('python3-pip',), 'openssl': ('openssl',), 'ss': ('iproute',), 'systemd-notify': ('systemd',)}
    missing = sorted({package for name, ready in report['dependencies'].items() if not ready for package in packages[name]})
    # Polkit is needed for the fixed moderator restart rule, not passwordless sudo.
    if not host.path('/etc/polkit-1/rules.d').is_dir():
        missing.append('polkit')
    if missing:
        print('Installing the fixed AlmaLinux prerequisites from configured signed repositories. This can take several minutes.', flush=True)
        try:
            host.run(['/usr/bin/dnf', 'install', '-y', *sorted(set(missing))], timeout=600)
        except SetupError:
            raise SetupError('Prerequisite installation did not complete. Check the AlmaLinux signed repositories and outbound HTTPS, then rerun setup; no MusicMaid runtime was installed by this step.') from None
        print('AlmaLinux prerequisite installation completed; verifying the installed tools.', flush=True)
    result = check_host(release, host=host)
    if not all(result['dependencies'].values()) or not host.path('/etc/polkit-1/rules.d').is_dir():
        raise SetupError('Bootstrap completed without all required tools. Node must be at least 22.13.0 at /usr/bin/node; check AlmaLinux AppStream repositories.')
    return result


def _release(release):
    release = Path(release).absolute(); _no_link_components(release)
    try:
        raw = _regular(release / 'release-manifest.json', 65536)
        manifest = json.loads(raw)
        if raw != _regular(release / 'dist/release.json', 65536):
            raise ValueError()
        if (type(manifest.get('version')) is not int or manifest['version'] != 1 or manifest.get('dirty') is not False
                or not re.fullmatch(r'[a-f0-9]{40}', manifest.get('revision', ''))
                or manifest.get('dependencyHash') != hashlib.sha256(_regular(release / 'package-lock.json')).hexdigest()
                or not re.fullmatch(r'[a-f0-9]{64}', manifest.get('sourceHash', ''))):
            raise ValueError()
        stamp = datetime.fromisoformat(manifest['builtAt'].replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            raise ValueError()
        inputs = []
        def collect(name):
            path = release / name
            if not path.exists() and not path.is_symlink():
                return
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise ValueError()
            if stat.S_ISDIR(info.st_mode):
                for child in path.iterdir():
                    if child.name != '__pycache__':
                        collect(name + '/' + child.name)
            elif stat.S_ISREG(info.st_mode) and (not name.startswith('scripts/') or path.suffix in ('.mjs', '.py', '.sh', '.java')):
                inputs.append(name)
        for name in (*ROOT_INPUTS, *SOURCE_DIRS):
            collect(name)
        digest = ''.join(name + '\0' + hashlib.sha256((release / name).read_bytes()).hexdigest() + '\n' for name in sorted(inputs))
        if hashlib.sha256(digest.encode()).hexdigest() != manifest['sourceHash']:
            raise ValueError()
        for name in ('apps/bot/src/index.ts', 'dist/apps/bot/src/index.js', 'dist/apps/bot/src/runtime/watchdog.js',
                     'dist/apps/bot/src/runtime/release-info.js', 'deploy/audiobot.service', 'deploy/50-audiobot-restart.rules', 'infra/lavalink/application.yml'):
            _regular(release / name)
        if json.loads(_regular(release / 'package.json')).get('type') != 'module':
            raise ValueError()
        node_modules = release / 'node_modules'
        if node_modules.is_symlink() or not node_modules.is_dir():
            raise ValueError()
        for name in ('discord.js', 'shoukaku', 'dotenv'):
            _regular(node_modules / name / 'package.json')
        unit = (release / 'deploy/audiobot.service').read_text()
        if not re.search(r'^ExecStart=/usr/bin/node dist/apps/bot/src/index\.js\s*$', unit, re.M) or not re.search(r'^Type=notify\s*$', unit, re.M) or not re.search(r'^WatchdogSec=60\s*$', unit, re.M):
            raise ValueError()
        # npm's relative .bin links are expected; links out of the release are not.
        for directory, dirs, files in os.walk(release, followlinks=False):
            dirs[:] = [name for name in dirs if name not in ('.git', '.setup', '.agents', '.codex', '__pycache__', 'data', 'logs', 'canary')]
            for name in [*dirs, *files]:
                path = Path(directory) / name
                if path.is_symlink() and (node_modules not in path.parents or os.path.isabs(os.readlink(path)) or not path.resolve().is_relative_to(node_modules)):
                    raise ValueError()
        return release, manifest, hashlib.sha256(raw).hexdigest()
    except (OSError, ValueError, TypeError, KeyError):
        raise SetupError('A clean, complete built release is required. Run npm ci, check, test and build as your normal account; verify its manifest before sudo install.') from None


def _settings(path, host):
    try:
        _no_link_components(path)
        info = Path(path).lstat()
        if stat.S_IMODE(info.st_mode) != 0o600:
            raise SettingsError('Settings must use mode 0600.')
        return load_settings(path, expected_uid=host.caller_uid())
    except (SettingsError, OSError):
        raise SetupError('Setup needs a mode-0600 settings file in a private directory owned by the invoking account; linked paths are refused.') from None


def _env(settings):
    discord = settings['discord']
    values = {'DISCORD_TOKEN': discord['token'], 'DISCORD_CLIENT_ID': discord['clientId'], 'DISCORD_GUILD_ID': discord['guildId'],
              'DISCORD_MUSIC_TEXT_CHANNEL_ID': discord['musicTextChannelId'], 'DISCORD_BOT_ADMIN_ROLE_IDS': ','.join(discord.get('adminRoleIds', [])),
              'LAVALINK_NAME': 'local', 'LAVALINK_URL': '127.0.0.1:2333', 'LAVALINK_AUTH': settings['lavalink']['password'],
              'MUSIC_DATABASE_PATH': STATE + '/music.sqlite', 'MUSIC_IDLE_DISCONNECT_SECONDS': '300', 'CIPHER_URL': 'http://127.0.0.1:18001',
              'VIEWER_ENABLED': 'false', 'VIEWER_SOCKET': '/run/musicmaid-viewer/reader.sock', 'SPOTIFY_DIRECT_ENABLED': 'false',
              'SPOTIFY_MARKET': 'DE', 'SPOTIFY_USER_TOKEN_FILE': STATE + '/spotify-user.json', 'SPOTIFY_DIRECT_AUTH_FILE': STATE + '/spotify-direct.json',
              'SPOTIFY_DIRECT_BINARY': '/opt/botsvc/audiobot-tools/musicmaid-spotify-stream', 'YTDLP_BINARY': '/opt/botsvc/audiobot-tools/venv/bin/yt-dlp'}
    return ''.join(key + '=' + json.dumps(value) + '\n' for key, value in values.items())


def _new_file(path, contents, mode, host, uid=0, gid=0, created=None):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    if created is not None:
        created.append(path)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(contents.encode() if isinstance(contents, str) else contents)
        stream.flush(); os.fsync(stream.fileno())
    os.chmod(path, mode); host.chown(path, uid, gid)


def _replace_private(path, contents, host, uid, gid):
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.musicmaid-settings-')
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o600); stream.write(contents); stream.flush(); os.fsync(stream.fileno())
        host.chown(temporary, uid, gid); os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _ready(host, password=None, attempts=30):
    bot_ready = audio_ready = False
    for attempt in range(attempts):
        if password is not None:
            audio_ready = host.audio_ready(password)
        active = host.run(['/usr/bin/systemctl', 'is-active', '--quiet', 'audiobot.service'], check=False).returncode == 0
        invocation = host.run(['/usr/bin/systemctl', 'show', 'audiobot.service', '-p', 'InvocationID', '--value'], check=False).stdout.strip()
        if active and re.fullmatch(r'[a-f0-9]{32}', invocation):
            logs = host.run(['/usr/bin/journalctl', '_SYSTEMD_INVOCATION_ID=' + invocation, '-n', '150', '--no-pager', '-o', 'cat'], check=False).stdout.splitlines()
            bot_ready = 'Registered MusicMaid guild commands.' in logs and 'MusicMaid ready.' in logs
        if bot_ready and (audio_ready or password is None):
            break
        if attempt < attempts - 1:
            host.sleep(2)
    return bot_ready, audio_ready


def install(release, config_path, *, host=None):
    host = host or Host(); _root(host)
    release, manifest, digest = _release(release)
    settings = _settings(config_path, host)
    if settings.get('viewer', {}).get('enabled') or settings.get('sources'):
        raise SetupError('Install the core first with optional integrations disabled; configure providers and the viewer afterward through their separate workflows.')
    report = check_host(release, host=host)
    if not report['supported'] or report['conflicts'] or not all(report['dependencies'].values()):
        raise SetupError('Fresh installation refused: ' + ' '.join(report['issues']))
    base = (release / 'infra/lavalink/application.yml').read_text()
    if not re.search(r'^  address: 127\.0\.0\.1\s*$', base, re.M) or '${LAVALINK_SERVER_PASSWORD:youshallnotpass}' not in base:
        raise SetupError('The reviewed Lavalink base configuration must bind localhost and accept the private generated password.')
    for target in (APP, STATE, LAVA, TOOLS, *FILES):
        _no_link_components(host.path(target))
    for image in (LAVA_IMAGE, CIPHER_IMAGE):
        print('Downloading the pinned ' + ('Lavalink' if image == LAVA_IMAGE else 'YouTube cipher') + ' container image.', flush=True)
        host.run(['/usr/bin/podman', 'pull', image], timeout=600)
    created, started = [], []
    account_created = False
    def directory(target, mode=0o755, uid=0, gid=0):
        path = host.path(target)
        if target in (APP, STATE, LAVA, TOOLS) and path.exists() and path not in created:
            raise SetupError('A reserved installation directory appeared after preflight. It was not adopted or changed: ' + target)
        absent = []; current = path
        while not current.exists():
            absent.append(current); current = current.parent
        _no_link_components(current)
        for item in reversed(absent):
            item.mkdir(mode=mode if item == path else 0o755); created.append(item)
        if absent:
            os.chmod(path, mode); host.chown(path, uid, gid)
        return path
    def write(target, contents, mode=0o644, uid=0, gid=0):
        path = host.path(target); directory(str(Path(target).parent))
        _new_file(path, contents, mode, host, uid, gid, created)
    try:
        host.run(['/usr/sbin/useradd', '--system', '--user-group', '--home-dir', '/opt/botsvc', '--no-create-home', '--shell', '/sbin/nologin', 'botsvc'])
        account_created = True
        account = host.run(['/usr/bin/getent', 'passwd', 'botsvc']).stdout.strip().split(':')
        uid, gid = int(account[2]), int(account[3])
        if account[0] != 'botsvc' or uid <= 0 or gid <= 0:
            raise SetupError('The new botsvc service account did not receive an unprivileged user and group identity.')
        directory('/opt/botsvc'); directory(TOOLS)
        directory(APP)
        for name in ('dist', 'node_modules', 'scripts', 'deploy', 'infra', 'bin', 'package.json', 'package-lock.json', 'release-manifest.json'):
            source = release / name
            if not source.exists():
                continue
            if source.is_dir():
                shutil.copytree(source, host.path(APP) / name, symlinks=True, ignore=shutil.ignore_patterns('__pycache__', '.setup', '.env', 'logs', 'data', 'canary'))
            else:
                shutil.copy2(source, host.path(APP) / name)
        for parent, dirs, files in os.walk(host.path(APP), followlinks=False):
            host.chown(parent, uid, gid)
            for name in [*dirs, *files]:
                host.chown(Path(parent) / name, uid, gid)
        directory(STATE, 0o700, uid, gid)
        write(APP + '/.env', _env(settings), 0o600, uid, gid)
        directory(LAVA)
        write(LAVA + '/application.yml', base.replace('${LAVALINK_SERVER_PASSWORD:youshallnotpass}', '${LAVALINK_SERVER_PASSWORD}'))
        write(LAVA + '/application-production.yml', 'lavalink:\n  server:\n    ratelimit:\n      ipBlocks: []\n')
        write(LAVA_ENV, 'LAVALINK_SERVER_PASSWORD=' + settings['lavalink']['password'] + '\n', 0o600)
        write('/etc/containers/systemd/lavalink.container', '''[Unit]
Description=Lavalink audio node (MusicMaid)
After=network-online.target audiobot-cipher.service
Wants=network-online.target audiobot-cipher.service
[Container]
ContainerName=audiobot-lavalink
Image=''' + LAVA_IMAGE + '''
Network=host
Volume=/opt/lavalink/application.yml:/opt/Lavalink/application.yml:ro,Z
Volume=/opt/lavalink/application-production.yml:/opt/Lavalink/application-production.yml:ro,Z
EnvironmentFile=/etc/audiobot-lavalink.env
Environment=SPRING_PROFILES_ACTIVE=production
Environment=JAVA_TOOL_OPTIONS=-Djava.net.preferIPv4Stack=true
[Service]
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
''')
        write('/etc/containers/systemd/audiobot-cipher.container', '''[Unit]
Description=MusicMaid YouTube cipher service
After=network-online.target
Wants=network-online.target
[Container]
ContainerName=audiobot-cipher
Image=''' + CIPHER_IMAGE + '''
Network=host
Environment=HOST=127.0.0.1
Environment=PORT=18001
Environment=MAX_THREADS=2
Environment=OVERRIDE_PLAYER_VARIANT=IAS
[Service]
Restart=on-failure
RestartSec=10
[Install]
WantedBy=multi-user.target
''')
        write('/etc/polkit-1/rules.d/50-audiobot-restart.rules', (release / 'deploy/50-audiobot-restart.rules').read_bytes())
        write('/etc/systemd/system/audiobot.service', (release / 'deploy/audiobot.service').read_bytes())
        host.run(['/usr/bin/systemctl', 'daemon-reload'])
        host.run(['/usr/bin/systemd-analyze', 'verify', str(host.path('/etc/systemd/system/audiobot.service'))])
        host.run(['/usr/bin/systemctl', 'enable', 'audiobot.service'])
        for unit in ('audiobot-cipher.service', 'lavalink.service', 'audiobot.service'):
            started.append(unit)
            try:
                host.run(['/usr/bin/systemctl', 'start', unit], check=False, timeout=120)
            except SetupError:
                # Invalid Discord credentials and offline services should leave a
                # managed installation that configure/doctor can recover.
                pass
        print('Installed MusicMaid services; checking Discord startup and local audio-service readiness. This does not verify audible playback.', flush=True)
        ready, audio_ready = _ready(host, settings['lavalink']['password'])
        marker = {'version': 1, 'managedBy': 'musicmaid-self-host', 'appDir': APP, 'stateDir': STATE, 'units': list(UNITS),
                  'release': {'commit': manifest['revision'], 'manifestSha256': digest}, 'installedAt': datetime.now(timezone.utc).isoformat()}
        write(MARKER, json.dumps(marker, indent=2) + '\n', 0o600)
        return {'installed': True, 'managed': True, 'ready': ready, 'audioReady': audio_ready,
                'status': 'ready' if ready and audio_ready else 'installed_needs_attention', 'appDir': APP, 'stateDir': STATE,
                'remainingChecks': ['Audible playback requires a listening test.'] if ready and audio_ready else ['Run doctor. Use configure to repair Discord credentials; optional source authorization is a separate step.', 'Audible playback has not been verified.']}
    except BaseException as error:
        stopped = True
        for unit in reversed(started):
            try:
                stopped = host.run(['/usr/bin/systemctl', 'stop', unit], check=False, timeout=60).returncode == 0 and stopped
            except SetupError:
                stopped = False
        if not stopped:
            raise SetupError('Setup could not stop a newly started service for rollback. Its files and account were retained; inspect only the MusicMaid service units before retrying.') from None
        if host.path('/etc/systemd/system/audiobot.service') in created:
            host.run(['/usr/bin/systemctl', 'disable', 'audiobot.service'], check=False)
        for path in reversed(created):
            if path.is_dir() and not path.is_symlink():
                if path in (host.path(APP), host.path(STATE), host.path(LAVA), host.path(TOOLS)):
                    shutil.rmtree(path)
                else:
                    try: path.rmdir()
                    except OSError: pass
            else:
                path.unlink(missing_ok=True)
        host.run(['/usr/bin/systemctl', 'daemon-reload'], check=False)
        if account_created:
            host.run(['/usr/sbin/userdel', 'botsvc'], check=False)
        if isinstance(error, SetupError):
            raise error
        raise SetupError('Fresh setup failed and its new runtime, services and account were rolled back. Private setup settings were retained for retry.') from None


def configure_core(release, config_path, *, host=None):
    host = host or Host(); require_managed_root(release, host=host)
    try:
        with installation_lock(Layout(host.root), owner_uid=os.geteuid()):
            return _configure_core(config_path, host)
    except MaintenanceError as error:
        raise SetupError(str(error)) from None


def _configure_core(config_path, host):
    settings = _settings(config_path, host)
    path = host.path(APP + '/.env'); _no_link_components(path)
    try:
        original = _regular(path, 65536); info = host.info(path)
        if stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError()
        current = {}
        for line in original.decode().splitlines():
            match = re.fullmatch(r'\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*', line)
            if match:
                raw = match[2]
                current[match[1]] = json.loads(raw) if raw.startswith('"') else raw.split(' #', 1)[0].strip("'")
        if current.get('DISCORD_GUILD_ID') != settings['discord']['guildId']:
            raise ValueError()
    except (OSError, ValueError, UnicodeError):
        raise SetupError('Core configuration requires a private managed .env and the same Discord server ID. Existing configuration was preserved.') from None
    values = {'DISCORD_TOKEN': settings['discord']['token'], 'DISCORD_CLIENT_ID': settings['discord']['clientId'],
              'DISCORD_MUSIC_TEXT_CHANNEL_ID': settings['discord']['musicTextChannelId'], 'DISCORD_BOT_ADMIN_ROLE_IDS': ','.join(settings['discord'].get('adminRoleIds', [])), 'DISCORD_BOT_ADMIN_ROLE_ID': ''}
    lines = [line for line in original.decode().splitlines() if not re.match(r'^\s*(?:export\s+)?(?:' + '|'.join(values) + r')\s*=', line)]
    changed = ('\n'.join(lines + [key + '=' + json.dumps(value) for key, value in values.items()]) + '\n').encode()
    backup = host.path('/var/backups/audiobot/core-config-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + os.urandom(4).hex())
    _no_link_components(backup.parent)
    backup.mkdir(parents=True, mode=0o700); os.chmod(backup, 0o700); host.chown(backup, 0, 0)
    _new_file(backup / 'bot.env', original, 0o600, host)
    try:
        host.run(['/usr/bin/systemctl', 'stop', 'audiobot.service'], timeout=60)
        _replace_private(path, changed, host, info.st_uid, info.st_gid)
        host.run(['/usr/bin/systemctl', 'start', 'audiobot.service'], timeout=120)
        ready, _ = _ready(host)
        if not ready:
            raise SetupError('The new Discord configuration did not reach ready state.')
    except BaseException:
        if host.run(['/usr/bin/systemctl', 'stop', 'audiobot.service'], check=False, timeout=60).returncode:
            raise SetupError('The bot could not stop for configuration rollback. Both private settings copies were retained at ' + str(backup) + '.') from None
        _replace_private(path, original, host, info.st_uid, info.st_gid)
        host.run(['/usr/bin/systemctl', 'start', 'audiobot.service'], check=False, timeout=120)
        raise SetupError('The new Discord configuration failed readiness; the previous .env was restored. Check the private draft and rerun configure. Backup: ' + str(backup)) from None
    return {'configured': True, 'ready': True, 'status': 'ready', 'backup': str(backup), 'remainingChecks': ['Audible playback requires a listening test.']}
