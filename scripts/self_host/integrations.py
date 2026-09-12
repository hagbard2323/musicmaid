"""Optional MusicMaid integrations; build as the operator, activate only after checks."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
if __package__ in (None, ''):  # Direct, narrowly scoped sudo entry point.
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from self_host.config import TerminalPrompt
from self_host.install import require_managed_root, SetupError
from self_host.maintenance import MaintenanceError, installation_lock

APP = Path('/opt/botsvc/audiobot')
STATE = Path('/var/lib/audiobot')
TOOLS = Path('/opt/botsvc/audiobot-tools')
CADDY_CONFIG = Path('/etc/caddy/Caddyfile')
BACKUPS = Path('/var/backups/audiobot')
CHOICES = ('youtube', 'spotify-api', 'spotify-playlists', 'spotify-audio', 'video', 'status')
SAFE_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}


class IntegrationError(Exception):
    pass


def run(command, **kwargs):
    """Only fixed commands and file paths reach argv; account values use private files."""
    try:
        if os.geteuid() == 0:
            kwargs.setdefault('env', SAFE_ENV)
        return subprocess.run([str(part) for part in command], check=True, **kwargs)
    except subprocess.CalledProcessError:
        raise IntegrationError('Optional integration step failed. Existing source settings were preserved; retry this step when ready.') from None


def regular(path, owner=None, private=False, maximum=64 * 1024 * 1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum or (owner is not None and info.st_uid != owner) or (private and info.st_mode & 0o077):
            raise IntegrationError('Use an owned regular file with the required private permissions.')
        content = source.read(maximum + 1)
        if len(content) > maximum:
            raise IntegrationError('A setup input exceeded its allowed size.')
        return content


def private_directory(path, owner=None):
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or (owner is not None and info.st_uid != owner):
        raise IntegrationError('The .setup artifact directory must be private and owned by the setup operator.')


def atomic(path, content, uid=None, gid=None, mode=0o600):
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.integration-')
    try:
        with os.fdopen(fd, 'wb') as output:
            os.fchmod(output.fileno(), mode)
            if uid is not None:
                os.fchown(output.fileno(), uid, gid)
            output.write(content if isinstance(content, bytes) else content.encode())
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def edited_environment(content, values):
    if any(not re.fullmatch(r'[A-Z][A-Z0-9_]*', key) for key in values):
        raise IntegrationError('Unsupported environment setting.')
    expression = re.compile(r'^\s*(?:export\s+)?(?:' + '|'.join(map(re.escape, values)) + r')\s*=')
    lines = [line for line in content.decode().splitlines() if not expression.match(line)]
    return ('\n'.join(lines + [key + '=' + json.dumps(value) for key, value in values.items()]) + '\n').encode()


def environment_values(path):
    result = {}
    for line in regular(path, private=True, maximum=1024 * 1024).decode().splitlines():
        match = re.match(r'^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$', line)
        if match:
            value = match[2]
            try:
                result[match[1]] = json.loads(value)
            except ValueError:
                result[match[1]] = value.strip("'\"")
    return result


def release_metadata(release):
    manifest = json.loads(regular(release / 'release-manifest.json', maximum=65536))
    if manifest.get('dirty') is not False or not re.fullmatch(r'[a-f0-9]{40}', str(manifest.get('revision', ''))) or not re.fullmatch(r'[a-f0-9]{64}', str(manifest.get('sourceHash', ''))):
        raise IntegrationError('Build a clean, committed release before setting up optional sources.')
    run(['/usr/bin/node', release / 'scripts/release-manifest.mjs', '--check', release])
    return manifest


def artifact_directory(release, kind):
    for path in (release / '.setup', release / '.setup/artifacts', release / '.setup/artifacts' / kind):
        private_directory(path, os.getuid())
    return release / '.setup/artifacts' / kind


def write_artifact(release, kind, paths):
    metadata = release_metadata(release)
    directory = artifact_directory(release, kind)
    lock = release / ('apps/spotify-stream/Cargo.lock' if kind == 'spotify' else 'infra/lavalink/youtube-requirements.txt')
    manifest = {'version': 1, 'kind': kind, 'revision': metadata['revision'], 'sourceHash': metadata['sourceHash'],
                'lockHash': hashlib.sha256(regular(lock)).hexdigest(), 'machine': platform.machine(),
                'files': {path.name: hashlib.sha256(regular(path, os.getuid())).hexdigest() for path in paths}}
    atomic(directory / 'artifact.json', json.dumps(manifest, indent=2) + '\n')
    return directory


def verify_artifact(release, directory, kind, owner):
    expected = release / '.setup/artifacts' / kind
    if directory.resolve() != expected.resolve() or directory.is_symlink():
        raise IntegrationError('Optional artifacts must come from this release’s private .setup/artifacts directory.')
    for parent in (release / '.setup', release / '.setup/artifacts', directory):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o077:
            raise IntegrationError('Artifact directories must be private and owned by the setup operator.')
    metadata = release_metadata(release)
    manifest = json.loads(regular(directory / 'artifact.json', owner, True, 65536))
    lock = release / ('apps/spotify-stream/Cargo.lock' if kind == 'spotify' else 'infra/lavalink/youtube-requirements.txt')
    if (manifest.get('version') != 1 or manifest.get('kind') != kind or manifest.get('revision') != metadata['revision']
            or manifest.get('sourceHash') != metadata['sourceHash'] or manifest.get('lockHash') != hashlib.sha256(regular(lock)).hexdigest()
            or manifest.get('machine') != platform.machine() or not isinstance(manifest.get('files'), dict) or not 1 <= len(manifest['files']) <= 100):
        raise IntegrationError('The optional artifact does not match this release, lock file or machine.')
    payloads = {}
    for name, digest in manifest['files'].items():
        if not re.fullmatch(r'[A-Za-z0-9_.+-]+', name) or (kind == 'spotify' and name != 'musicmaid-spotify-stream') or (kind == 'youtube' and not name.endswith('.whl')):
            raise IntegrationError('Unexpected file in the optional artifact.')
        content = regular(directory / name, owner)
        if hashlib.sha256(content).hexdigest() != digest:
            raise IntegrationError('Optional artifact checksum mismatch. Build it again as the normal user.')
        payloads[name] = content
    if kind == 'spotify' and (set(payloads) != {'musicmaid-spotify-stream'} or not payloads['musicmaid-spotify-stream'].startswith(b'\x7fELF')):
        raise IntegrationError('The Spotify helper must be the verified Linux build.')
    return manifest, payloads


def build_spotify(release):
    if os.geteuid() == 0:
        raise IntegrationError('Compile the Spotify helper as the normal setup user, never with sudo.')
    release_metadata(release)
    directory = artifact_directory(release, 'spotify')
    if not shutil.which('cargo'):
        root_call(release, 'rust-prerequisites')
    run(['cargo', 'build', '--release', '--locked', '--manifest-path', release / 'apps/spotify-stream/Cargo.toml', '--target-dir', directory / 'target'])
    binary = directory / 'musicmaid-spotify-stream'
    atomic(binary, regular(directory / 'target/release/musicmaid-spotify-stream'), mode=0o755)
    run([binary, '--version'])
    return write_artifact(release, 'spotify', [binary])


def build_youtube(release):
    if os.geteuid() == 0:
        raise IntegrationError('Prepare YouTube dependencies as the normal setup user, never with sudo.')
    release_metadata(release)
    directory = artifact_directory(release, 'youtube')
    run([sys.executable, '-m', 'venv', directory / 'builder'])
    # Wheel-only preparation keeps dependency build scripts out of root setup.
    run([directory / 'builder/bin/python', '-m', 'pip', 'download', '--disable-pip-version-check', '--only-binary=:all:', '--dest', directory, '-r', release / 'infra/lavalink/youtube-requirements.txt'])
    return write_artifact(release, 'youtube', sorted(directory.glob('*.whl')))


def root_call(release, choice, artifact=None):
    command = ['sudo', '/usr/bin/python3', release / 'scripts/self_host/integrations.py', '--root-action', choice, '--release', release]
    if artifact:
        command += ['--artifact', artifact]
    run(command)


def integration_status(release):
    """Read-only status; access uncertainty is explicit and no account values escape."""
    try:
        values = environment_values(APP / '.env')
        configured = {'youtube': bool(values.get('YOUTUBE_COOKIE_FILE') and values.get('YTDLP_BINARY')),
                      'spotify-api': bool(values.get('SPOTIFY_CLIENT_ID') and values.get('SPOTIFY_CLIENT_SECRET')),
                      'spotify-audio': values.get('SPOTIFY_DIRECT_ENABLED') in ('true', True),
                      'video': values.get('VIEWER_ENABLED') in ('true', True)}
    except (OSError, ValueError, IntegrationError):
        configured = {name: None for name in ('youtube', 'spotify-api', 'spotify-audio', 'video')}
    for name, path in [('spotify-playlists', STATE / 'spotify-user.json')]:
        try:
            configured[name] = path.lstat().st_size > 0
        except FileNotFoundError:
            configured[name] = False
        except PermissionError:
            configured[name] = None
    return {'configured': configured, 'note': 'Configured does not mean playback was tested today; null means protected settings are not readable as this user.'}


def run_integrations(release, choice=None):
    release = Path(release).resolve()
    if os.geteuid() == 0:
        raise IntegrationError('Run setup sources/video as your normal user; it requests sudo only for installation.')
    if choice is None:
        print('Optional integrations — choose one step; you can return to the others later.\n1 YouTube\n2 Spotify API metadata\n3 Spotify playlists\n4 Original Spotify audio (Premium)\n5 Optional video viewer\n6 Status\nEnter to return')
        answer = input('Step: ').strip()
        if not answer:
            return
        choice = CHOICES[int(answer) - 1] if answer.isdigit() and 1 <= int(answer) <= len(CHOICES) else answer
    if choice not in CHOICES:
        raise IntegrationError('Choose youtube, spotify-api, spotify-playlists, spotify-audio, video or status.')
    if choice == 'status':
        print(json.dumps(integration_status(release), indent=2))
        return
    artifact = build_youtube(release) if choice == 'youtube' else build_spotify(release) if choice == 'spotify-audio' else None
    root_call(release, choice, artifact)


def candidate_environment(values):
    owner = pwd.getpwnam('botsvc')
    fd, temporary = tempfile.mkstemp(dir=STATE, prefix='.integration-env-')
    os.close(fd)
    path = Path(temporary)
    atomic(path, edited_environment(regular(APP / '.env', private=True), values), owner.pw_uid, owner.pw_gid)
    return path


def checked_environment(values, preflight, promote=None):
    """Failed checks never replace running settings; rotated grants are never rewound."""
    target = APP / '.env'
    previous = regular(target, private=True)
    info = target.stat()
    candidate = candidate_environment(values)
    changed = False
    try:
        preflight(candidate)
        if regular(target, private=True) != previous:
            raise IntegrationError('The installed settings changed during the check. Retry this integration step.')
        if promote:
            promote()
        atomic(target, edited_environment(previous, values), info.st_uid, info.st_gid)
        changed = True
        run(['systemctl', 'restart', 'audiobot'])
    except BaseException:
        if changed:
            atomic(target, previous, info.st_uid, info.st_gid)
            subprocess.run(['systemctl', 'restart', 'audiobot'], check=False, env=SAFE_ENV)
        raise
    finally:
        candidate.unlink(missing_ok=True)


def as_bot(release, script, environment, extra=None):
    run(['runuser', '-u', 'botsvc', '--', '/usr/bin/node', '--env-file=' + str(environment), APP / 'scripts' / script, *(extra or [])], cwd=APP)


def secure_tools_directory(owner_uid=0):
    parent = TOOLS.parent
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o022:
        raise IntegrationError('The tools ancestor must be root-owned and not writable by the bot. Use the guided fresh-install profile.')
    TOOLS.mkdir(mode=0o755, exist_ok=True)
    info = TOOLS.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o022:
        raise IntegrationError('The optional tools directory must be root-owned, unlinked and not writable by the bot.')


def setup_spotify_api(release):
    with TerminalPrompt() as terminal:
        client_id = terminal.read('Spotify developer Client ID (hidden): ', secret=True).strip()
        secret = terminal.read('Spotify developer Client Secret (hidden): ', secret=True).strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{16,128}', client_id) or not re.fullmatch(r'[A-Za-z0-9_-]{16,200}', secret):
        raise IntegrationError('Enter the credentials from your own Spotify developer application.')
    probe = """try { const r=await fetch('https://accounts.spotify.com/api/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{Authorization:'Basic '+Buffer.from(process.env.SPOTIFY_CLIENT_ID+':'+process.env.SPOTIFY_CLIENT_SECRET).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'}); if(!r.ok)throw new Error(); const t=await r.json();if(typeof t.access_token!=='string')throw new Error();const m=await fetch('https://api.spotify.com/v1/tracks/0NTMtAO2BV4tnGvw9EgBVq',{redirect:'error',signal:AbortSignal.timeout(12000),headers:{Authorization:'Bearer '+t.access_token}});if(!m.ok)throw new Error();console.log('Spotify metadata access verified.'); }catch{console.error('Spotify metadata check failed; check application access, credentials and rate limits.');process.exitCode=1;}"""
    def preflight(candidate):
        run(['runuser', '-u', 'botsvc', '--', '/usr/bin/node', '--env-file=' + str(candidate), '--input-type=module', '-e', probe])
    checked_environment({'SPOTIFY_CLIENT_ID': client_id, 'SPOTIFY_CLIENT_SECRET': secret}, preflight)
    print('Spotify metadata configured. Playlist access and original audio are separate optional steps.')


def setup_spotify_playlists(release):
    values = environment_values(APP / '.env')
    if not values.get('SPOTIFY_CLIENT_ID') or not values.get('SPOTIFY_CLIENT_SECRET'):
        raise IntegrationError('Complete the Spotify API metadata step first.')
    owner = pwd.getpwnam('botsvc')
    fd, temporary = tempfile.mkstemp(dir=STATE, prefix='.spotify-playlists-')
    os.close(fd)
    grant = Path(temporary)
    os.chown(grant, owner.pw_uid, owner.pw_gid)
    candidate = candidate_environment({'SPOTIFY_USER_TOKEN_FILE': str(grant)})
    try:
        as_bot(release, 'authorize-spotify-playlists.mjs', candidate)
        document = json.loads(regular(grant, private=True))
        if (not isinstance(document.get('refresh_token'), str) or not document['refresh_token']
                or not {'playlist-read-private', 'playlist-read-collaborative'}.issubset(str(document.get('scope', '')).split())):
            raise IntegrationError('Spotify did not return playlist authorization.')
        os.replace(grant, STATE / 'spotify-user.json')
    finally:
        candidate.unlink(missing_ok=True)
        grant.unlink(missing_ok=True)
    print('Spotify playlist consent saved. Import playlists owned by or shared collaboratively with that account; no playback restart was needed.')


def setup_spotify_audio(release, directory, uid):
    _manifest, files = verify_artifact(release, directory, 'spotify', uid)
    values = environment_values(APP / '.env')
    if not values.get('SPOTIFY_CLIENT_ID') or not values.get('SPOTIFY_CLIENT_SECRET'):
        raise IntegrationError('Complete the Spotify API metadata step first.')
    owner = pwd.getpwnam('botsvc')
    secure_tools_directory()
    # Versioned immutable paths avoid replacing the helper used by live playback.
    digest = hashlib.sha256(files['musicmaid-spotify-stream']).hexdigest()
    binary = TOOLS / ('musicmaid-spotify-stream-' + digest[:16])
    if not binary.exists() or regular(binary, 0) != files['musicmaid-spotify-stream']:
        atomic(binary, files['musicmaid-spotify-stream'], 0, 0, 0o755)
    installed_grant = STATE / 'spotify-direct.json'
    grant = installed_grant
    if not installed_grant.exists() or input('Pair a different Premium account now? [y/N]: ').strip().lower() == 'y':
        fd, temporary = tempfile.mkstemp(dir=STATE, prefix='.spotify-direct-')
        os.close(fd); grant = Path(temporary); os.chown(grant, owner.pw_uid, owner.pw_gid)
        try:
            run(['runuser', '-u', 'botsvc', '--', '/usr/bin/node', APP / 'scripts/authorize-spotify-direct.mjs', grant], cwd=APP)
        except Exception:
            grant.unlink(missing_ok=True)
            raise
    settings = {'SPOTIFY_DIRECT_ENABLED': 'true', 'SPOTIFY_DIRECT_BINARY': str(binary), 'SPOTIFY_DIRECT_AUTH_FILE': str(installed_grant)}
    def preflight(candidate):
        content = edited_environment(regular(candidate, private=True), {'SPOTIFY_DIRECT_AUTH_FILE': str(grant)})
        atomic(candidate, content, owner.pw_uid, owner.pw_gid)
        as_bot(release, 'spotify-direct-check.mjs', candidate)
    try:
        checked_environment(settings, preflight, lambda: os.replace(grant, installed_grant) if grant != installed_grant else None)
    finally:
        if grant != installed_grant:
            grant.unlink(missing_ok=True)
    print('Original Spotify audio source checks passed. Confirm audible playback in your Discord server; the Premium account remains your own.')


def setup_youtube(release, directory, uid):
    manifest, files = verify_artifact(release, directory, 'youtube', uid)
    source = Path(input('Absolute path to your own exported YouTube Netscape cookie file (mode 0600): ').strip())
    if not source.is_absolute():
        raise IntegrationError('Use an absolute cookie-file path; no cookies from another installation are supplied.')
    regular(source, uid, True, 65536)
    specification = importlib.util.spec_from_file_location('youtube_cookie_config', release / 'scripts/configure-youtube.py')
    cookie_config = importlib.util.module_from_spec(specification); specification.loader.exec_module(cookie_config)
    cookies = cookie_config.youtube_cookies(source)
    owner = pwd.getpwnam('botsvc')
    secure_tools_directory()
    # Build the immutable candidate venv from verified wheels, without root network access.
    venv = TOOLS / ('youtube-' + manifest['lockHash'][:12] + '-' + uuid.uuid4().hex[:8])
    with tempfile.TemporaryDirectory(dir=TOOLS, prefix='.youtube-wheels-') as temporary:
        wheels = Path(temporary)
        for name, content in files.items():
            (wheels / name).write_bytes(content)
        run(['/usr/bin/python3', '-m', 'venv', venv])
        run([venv / 'bin/python', '-m', 'pip', 'install', '--no-index', '--disable-pip-version-check', '--find-links', wheels, '-r', release / 'infra/lavalink/youtube-requirements.txt'])
    fd, temporary = tempfile.mkstemp(dir=STATE, prefix='.youtube-cookies-')
    os.close(fd); candidate_cookies = Path(temporary)
    atomic(candidate_cookies, cookies, owner.pw_uid, owner.pw_gid)
    final_cookies = STATE / 'youtube-cookies.txt'
    settings = {'YOUTUBE_COOKIE_FILE': str(final_cookies), 'YTDLP_BINARY': str(venv / 'bin/yt-dlp')}
    def preflight(candidate):
        atomic(candidate, edited_environment(regular(candidate, private=True), {'YOUTUBE_COOKIE_FILE': str(candidate_cookies)}), owner.pw_uid, owner.pw_gid)
        as_bot(release, 'youtube-check.mjs', candidate)
    try:
        checked_environment(settings, preflight, lambda: os.replace(candidate_cookies, final_cookies))
    finally:
        candidate_cookies.unlink(missing_ok=True)
    print('Your YouTube session passed source checks. Confirm audible playback; optional video is configured separately.')


def signed_packages(packages, epel=False):
    repositories = 'baseos,appstream,extras,crb' + (',epel' if epel else '')
    run(['dnf', '-y', '--disablerepo=*', '--enablerepo=' + repositories, '--setopt=gpgcheck=1', 'install', *packages])


def setup_video(release):
    print('Use your own public hostname with DNS pointing here. The viewer needs inbound TCP 80/443; it does not change voice playback.')
    configuration = CADDY_CONFIG
    inspect = lambda command: subprocess.run(command, capture_output=True, text=True, check=False, env=SAFE_ENV)
    active = inspect(['systemctl', 'is-active', '--quiet', 'caddy']).returncode == 0
    enabled = inspect(['systemctl', 'is-enabled', '--quiet', 'caddy']).returncode == 0
    pid = inspect(['systemctl', 'show', 'caddy', '-p', 'MainPID', '--value']).stdout.strip()
    listeners = inspect(['ss', '-H', '-ltnp', '( sport = :80 or sport = :443 )'])
    if listeners.returncode or any(not pid.isdigit() or pid == '0' or 'pid=' + pid + ',' not in line for line in listeners.stdout.splitlines()):
        raise IntegrationError('HTTP/HTTPS ports belong to another service or could not be inspected. Configure the existing proxy separately; nothing was changed.')
    existing = bool(shutil.which('caddy') or configuration.exists())
    if existing:
        if input('Use the existing Caddy configuration for this viewer? This adds one site and may start Caddy. [y/N]: ').strip().lower() != 'y':
            raise IntegrationError('Viewer setup cancelled; existing web services were not changed.')
        content = regular(configuration, maximum=1024 * 1024)
        backup = BACKUPS / ('self-host-video-' + uuid.uuid4().hex)
        private_directory(backup, 0)
        atomic(backup / 'Caddyfile', content)
    else:
        signed_packages(['epel-release'])
        signed_packages(['caddy'], epel=True)
    # No COPR, curl installer or unsigned package route is enabled here.
    run(['caddy', 'validate', '--config', configuration, '--adapter', 'caddyfile'], capture_output=True, text=True)
    try:
        if not enabled:
            run(['systemctl', 'enable', 'caddy'])
        if not active:
            run(['systemctl', 'start', 'caddy'])
        run([release / 'scripts/deploy-viewer.sh'])
    except BaseException:
        if not active:
            subprocess.run(['systemctl', 'stop', 'caddy'], check=False, env=SAFE_ENV)
        if not enabled:
            subprocess.run(['systemctl', 'disable', 'caddy'], check=False, env=SAFE_ENV)
        raise
    print('Finish Activities enablement and the / URL mapping in your own Discord application, then test Watch video.')


def root_main(release, choice, artifact=None):
    if os.geteuid() != 0:
        raise IntegrationError('The internal installation step requires sudo.')
    uid = int(os.environ.get('SUDO_UID', '0'))
    if uid <= 0:
        raise IntegrationError('Start this optional step through the normal-user setup command.')
    if choice in ('youtube', 'spotify-audio') and artifact is None:
        raise IntegrationError('Prepare the optional artifact with setup sources before installing it.')
    release = Path(release).resolve()
    # Optional setup may never silently adopt an unrelated/legacy installation.
    require_managed_root(release)
    try:
        with installation_lock():
            return _root_action(release, choice, artifact, uid)
    except MaintenanceError as error:
        raise IntegrationError(str(error)) from None


def _root_action(release, choice, artifact, uid):
    release_metadata(release)
    run(['/usr/bin/python3', release / 'scripts/check-bot-release.py', release])
    if choice == 'rust-prerequisites':
        signed_packages(['rust', 'cargo', 'gcc', 'gcc-c++', 'make', 'cmake', 'pkgconf-pkg-config', 'openssl-devel'])
        return
    regular(APP / '.env', private=True)
    installed = json.loads(regular(APP / 'release-manifest.json', maximum=65536))
    prepared = json.loads(regular(release / 'release-manifest.json', maximum=65536))
    if any(installed.get(key) != prepared.get(key) for key in ('revision', 'sourceHash', 'dependencyHash')):
        raise IntegrationError('Install this matching bot release before enabling its optional integrations.')
    if choice == 'youtube': setup_youtube(release, Path(artifact), uid)
    elif choice == 'spotify-api': setup_spotify_api(release)
    elif choice == 'spotify-playlists': setup_spotify_playlists(release)
    elif choice == 'spotify-audio': setup_spotify_audio(release, Path(artifact), uid)
    elif choice == 'video': setup_video(release)
    else: raise IntegrationError('Unsupported internal integration step.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root-action', choices=[*CHOICES, 'rust-prerequisites'], required=True)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--artifact', type=Path)
    options = parser.parse_args()
    try:
        root_main(options.release, options.root_action, options.artifact)
    except (IntegrationError, SetupError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
    except (OSError, ValueError, EOFError, KeyboardInterrupt):
        print('Optional integration setup stopped. Current account grants were not rolled back. Review the last check, then rerun this step; do not paste secrets into chat.', file=sys.stderr)
        raise SystemExit(1) from None
