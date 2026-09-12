"""Ownership-gated maintenance for the fixed MusicMaid self-host installation.

The CLI has no path/environment overrides for installed files. Layout injection is
only an importable fixture seam. Existing operator installations are never adopted.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import fcntl
from functools import wraps
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile
import time
import uuid


class MaintenanceError(Exception):
    """A fixed, safe operator-facing explanation; never a subprocess trace."""


class Layout:
    def __init__(self, root=Path('/')):
        self.root = Path(root)
        self.app = self.path('/opt/botsvc/audiobot')
        self.state = self.path('/var/lib/audiobot')
        self.backups = self.path('/var/backups/audiobot')
        self.viewer = self.path('/opt/musicmaid-viewer')
        self.marker = self.state / 'installation.json'
        self.config = {
            'bot-unit': self.path('/etc/systemd/system/audiobot.service'),
            'viewer-unit': self.path('/etc/systemd/system/audiobot-viewer.service'),
            'viewer-tmpfiles': self.path('/etc/tmpfiles.d/audiobot-viewer.conf'),
            'restart-rule': self.path('/etc/polkit-1/rules.d/50-audiobot-restart.rules'),
            'viewer-site': self.path('/etc/caddy/musicmaid-video/site.conf'),
            'caddy': self.path('/etc/caddy/Caddyfile'),
            'viewer-env': self.path('/etc/audiobot-viewer.env'),
        }

    def path(self, absolute):
        return self.root / absolute.lstrip('/')


BACKUP_ID = re.compile(r'self-host-\d{8}T\d{6}Z-[a-f0-9]{8}')
CLEANUP_ID = re.compile(r'cleanup-[a-f0-9]{32}')
SAFE_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}
INSPECT_ENV = r'''
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
const e=parseEnv(readFileSync(process.argv[1],'utf8'));
const result={databasePath:e.MUSIC_DATABASE_PATH||'/var/lib/audiobot/music.sqlite',
 viewerEnabled:e.VIEWER_ENABLED==='true', youtubeSessionConfigured:Boolean(e.YOUTUBE_COOKIE_FILE),
 spotifyMetadataConfigured:Boolean(e.SPOTIFY_CLIENT_ID&&e.SPOTIFY_CLIENT_SECRET),
 spotifyOriginalEnabled:e.SPOTIFY_DIRECT_ENABLED==='true'};
if(process.argv[2]==='probe'){
 result.audio={reachable:false,authenticated:false};
 try{
  const base=new URL(e.LAVALINK_URL?.includes('://')?e.LAVALINK_URL:'http://'+(e.LAVALINK_URL||'127.0.0.1:2333'));
  if(base.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||base.port!=='2333'||base.username||base.password) throw Error();
  const response=await fetch(new URL('/v4/info',base),{headers:{Authorization:e.LAVALINK_AUTH||'youshallnotpass'},redirect:'error',signal:AbortSignal.timeout(5000)});
  result.audio={reachable:true,authenticated:response.ok};
  if(response.ok){const info=await response.json();result.audio.version=typeof info?.version?.semver==='string'&&/^\d+\.\d+\.\d+$/.test(info.version.semver)?info.version.semver:'unknown';}
  else await response.body?.cancel();
 }catch{}
}
process.stdout.write(JSON.stringify(result));
'''


def command(args, timeout=30):
    if timeout is None:
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=SAFE_ENV)
        interrupted = False
        while True:
            try:
                stdout, stderr = process.communicate()
                break
            except KeyboardInterrupt:
                # The foreground Bash process receives the same terminal SIGINT
                # and owns its rollback trap. subprocess.run would SIGKILL it
                # here; wait for the transaction instead of defeating that trap.
                interrupted = True
        if interrupted:
            raise MaintenanceError('The interrupted installer has exited. Check its rollback state with doctor.')
        return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=SAFE_ENV)


def exclusive(action):
    @wraps(action)
    def guarded(self, *args, **kwargs):
        self.owned()
        with self._lock():
            return action(self, *args, **kwargs)
    return guarded


@contextmanager
def installation_lock(layout=None, *, owner_uid=0):
    """Serialize an already ownership-checked managed installation mutation."""
    with Maintenance(layout=layout, owner_uid=owner_uid)._lock():
        yield


class Maintenance:
    def __init__(self, layout=None, runner=command, owner_uid=0, sleep=time.sleep):
        self.layout = layout or Layout()
        self.run = runner
        self.owner_uid = owner_uid
        self.sleep = sleep
        self.restart_status = {}
        self.restart_results = {}
        self._lock_depth = 0
        self.scripts = Path(__file__).resolve().parent.parent

    @contextmanager
    def _lock(self):
        if self._lock_depth:
            self._lock_depth += 1
            try:
                yield
            finally:
                self._lock_depth -= 1
            return
        self.layout.backups.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._directory(self.layout.backups, root_owned=True)
        path = self.layout.backups / '.self-host-maintenance.lock'
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            self._regular(path, private=True, root_owned=True, maximum=16)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise MaintenanceError('Another self-host maintenance transaction is running. Wait for it to finish.') from None
            self._lock_depth = 1
            try:
                yield
            finally:
                self._lock_depth = 0
                fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)

    def _regular(self, path, private=False, maximum=None, root_owned=False):
        try:
            info = path.lstat()
        except OSError:
            raise MaintenanceError('A required regular file is missing; run doctor before maintenance.') from None
        if (not stat.S_ISREG(info.st_mode) or (maximum and info.st_size > maximum)
                or (private and info.st_mode & 0o077) or (root_owned and info.st_uid != self.owner_uid)):
            raise MaintenanceError('A required file is linked, unsafe, oversized or has incorrect ownership.')
        return info

    def _directory(self, path, private=False, root_owned=False):
        try:
            info = path.lstat()
        except OSError:
            raise MaintenanceError('A required installation directory is missing.') from None
        if (not stat.S_ISDIR(info.st_mode) or (private and info.st_mode & 0o077)
                or (root_owned and (info.st_uid != self.owner_uid or info.st_mode & 0o022))):
            raise MaintenanceError('A required directory is linked, unsafe or has incorrect ownership.')

    def _checked(self, args, explanation, timeout=30):
        try:
            result = self.run(args, timeout=timeout)
        except (OSError, subprocess.SubprocessError):
            raise MaintenanceError(explanation) from None
        if result.returncode:
            raise MaintenanceError(explanation)
        return result

    def owned(self):
        self._directory(self.layout.state)
        self._regular(self.layout.marker, private=True, root_owned=True, maximum=16384)
        try:
            marker = json.loads(self.layout.marker.read_text())
        except (ValueError, OSError):
            raise MaintenanceError('The self-host installation marker is invalid.') from None
        if (not isinstance(marker, dict) or type(marker.get('version')) is not int or marker['version'] != 1
                or marker.get('managedBy') != 'musicmaid-self-host'
                or marker.get('appDir') != '/opt/botsvc/audiobot'
                or marker.get('stateDir') != '/var/lib/audiobot'
                or not isinstance(marker.get('units'), list)
                or not all(isinstance(unit, str) for unit in marker['units'])
                or not {'audiobot.service', 'lavalink.service'}.issubset(marker['units'])
                or any(unit not in {'audiobot.service', 'lavalink.service', 'audiobot-cipher.service', 'audiobot-viewer.service'} for unit in marker['units'])):
            raise MaintenanceError('This is not a recognized self-host installation. Use its existing reviewed operator updater; no conversion was performed.')
        self._directory(self.layout.app)
        self._regular(self.layout.app / '.env', private=True, maximum=1024 * 1024)
        return marker

    def _settings(self, probe=False):
        self._regular(self.layout.app / '.env', private=True, maximum=1024 * 1024)
        result = self._checked(['/usr/bin/node', '--input-type=module', '-e', INSPECT_ENV,
                                str(self.layout.app / '.env'), 'probe' if probe else 'flags'],
                               'Protected runtime configuration could not be inspected.', 12)
        try:
            value = json.loads(result.stdout)
        except (ValueError, TypeError):
            raise MaintenanceError('Runtime configuration inspection returned an invalid result.') from None
        if not isinstance(value, dict) or type(value.get('viewerEnabled')) is not bool or not isinstance(value.get('databasePath'), str):
            raise MaintenanceError('Runtime configuration inspection returned an invalid result.')
        return value

    def _database(self, settings):
        value = Path(settings['databasePath'])
        # The installed unit normally overrides .env with the state-directory
        # location. An explicit supported unit override takes precedence too.
        unit = self.layout.config['bot-unit']
        self._regular(unit, maximum=65536)
        dropins = unit.with_name(unit.name + '.d')
        if dropins.exists() or dropins.is_symlink():
            raise MaintenanceError('Custom bot unit drop-ins require the operator backup procedure; their database overrides are not guessed.')
        unit_text = unit.read_text()
        declared = re.findall(r'^Environment=MUSIC_DATABASE_PATH=([^\r\n]+)$', unit_text, re.M)
        references = [line for line in unit_text.splitlines() if line.strip().startswith(('Environment=', 'EnvironmentFile=', 'ExecStart=')) and ('MUSIC_DATABASE_PATH' in line or 'VIEWER_ENABLED' in line or line.strip().startswith('EnvironmentFile='))]
        if len(references) != len(declared):
            raise MaintenanceError('Custom unit environment overrides require the operator backup procedure; no database path was guessed.')
        if declared:
            value = Path(declared[-1])
        if not value.is_absolute():
            value = Path('/opt/botsvc/audiobot') / value
        canonical = os.path.normpath(str(value))
        allowed = {'/var/lib/audiobot/music.sqlite': ('state', self.layout.state / 'music.sqlite'),
                   '/opt/botsvc/audiobot/data/music.sqlite': ('runtime', self.layout.app / 'data/music.sqlite')}
        if canonical not in allowed:
            raise MaintenanceError('This database location is outside the two supported self-host layouts. Use the existing operator backup procedure; no database was changed.')
        kind, path = allowed[canonical]
        self._directory(path.parent)
        return kind, path

    def _active(self, unit):
        try:
            result = self.run(['/usr/bin/systemctl', 'is-active', '--quiet', unit], timeout=5)
            return result.returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    def _state(self, unit):
        result = self._checked(['/usr/bin/systemctl', 'show', unit, '-p', 'ActiveState', '--value'],
                               'Service activity could not be verified before maintenance.', 5)
        value = result.stdout.strip()
        if value not in {'active', 'inactive', 'failed'}:
            raise MaintenanceError('A service is changing state or its state is unknown. Wait for that transition before maintenance.')
        return value

    def _restart(self, unit):
        try:
            self._checked(['/usr/bin/systemctl', 'reset-failed', unit], 'Service start budget could not be reset.')
            self._checked(['/usr/bin/systemctl', 'start', unit], 'Service restart failed.', 95)
            for attempt in range(15):
                if self._active(unit):
                    return True
                if attempt < 14:
                    self.sleep(1)
        except MaintenanceError:
            pass
        return False

    @contextmanager
    def _stopped(self, viewer):
        units = ['audiobot.service'] + (['audiobot-viewer.service'] if viewer else [])
        previous = {unit: self._state(unit) for unit in units}
        stopped = []
        control = {'restart': True}
        try:
            for unit in units:
                if previous[unit] != 'active':
                    continue
                self._checked(['/usr/bin/systemctl', 'stop', unit], 'A service could not be stopped safely. No live snapshot or restoration was attempted.', 40)
                stopped.append(unit)
            yield control
        finally:
            self.restart_results = {}
            if control['restart']:
                # Restore prior activity after a successful stop, including a
                # failed snapshot. Deliberately inactive/failed services retain
                # their state and start-limit budget; backup is not Repair.
                for unit in stopped:
                    self.restart_results[unit] = self._restart(unit)
            self.restart_status = {unit: self._active(unit) for unit in units}

    def _json(self, path, value):
        fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.maintenance-')
        try:
            with os.fdopen(fd, 'w') as output:
                os.fchmod(output.fileno(), 0o600)
                os.fchown(output.fileno(), self.owner_uid, -1)
                json.dump(value, output, sort_keys=True)
                output.write('\n'); output.flush(); os.fsync(output.fileno())
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def _copy(self, source, destination):
        self._checked(['/bin/cp', '-a', '--', str(source), str(destination)],
                      'Snapshot copy failed. The installed files were not changed.', 180)

    def _tree_hash(self, root):
        digest = hashlib.sha256()
        for directory, directories, files in os.walk(root, followlinks=False):
            for name in sorted(directories + files):
                path = Path(directory) / name
                info = path.lstat()
                digest.update((str(path.relative_to(root)) + '\0' + str(stat.S_IMODE(info.st_mode)) + '\0').encode())
                if stat.S_ISLNK(info.st_mode):
                    digest.update(b'link\0' + os.readlink(path).encode())
                elif stat.S_ISREG(info.st_mode):
                    with path.open('rb') as source:
                        for chunk in iter(lambda: source.read(1024 * 1024), b''):
                            digest.update(chunk)
                elif not stat.S_ISDIR(info.st_mode):
                    raise MaintenanceError('Snapshot contains an unsupported special file.')
            directories.sort()
        return digest.hexdigest()

    def _capture(self, settings):
        self.layout.backups.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._directory(self.layout.backups, root_owned=True)
        backup_id = 'self-host-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
        backup = self.layout.backups / backup_id
        backup.mkdir(mode=0o700)
        kind, database = self._database(settings)
        self._regular(database)
        self._copy(self.layout.app, backup / 'runtime')
        self._copy(self.layout.state, backup / 'state')
        (backup / 'database').mkdir(mode=0o700)
        for suffix in ('', '-wal', '-shm'):
            source = Path(str(database) + suffix)
            if source.exists() or source.is_symlink():
                self._regular(source)
                self._copy(source, backup / 'database' / ('music.sqlite' + suffix))
        (backup / 'config').mkdir(mode=0o700)
        names = ['bot-unit']
        if settings['viewerEnabled']:
            self._directory(self.layout.viewer)
            self._copy(self.layout.viewer, backup / 'viewer')
            names = list(self.layout.config)
        for name in names:
            self._regular(self.layout.config[name])
            self._copy(self.layout.config[name], backup / 'config' / name)
        parts = ['runtime', 'state', 'database', 'config'] + (['viewer'] if settings['viewerEnabled'] else [])
        manifest = {'version': 1, 'kind': 'musicmaid-self-host-backup', 'backupId': backup_id,
                    'createdAt': datetime.now(timezone.utc).isoformat(), 'databaseLayout': kind,
                    'viewerEnabled': settings['viewerEnabled'], 'configFiles': names,
                    'hashes': {name: self._tree_hash(backup / name) for name in parts}}
        self._checked(['/usr/bin/sync', '-f', str(backup)], 'Snapshot files could not be synchronized; this backup is incomplete.', 180)
        self._json(backup / 'snapshot.json', manifest)
        return backup_id

    @exclusive
    def backup(self):
        self.owned()
        settings = self._settings()
        self._database(settings)
        with self._stopped(settings['viewerEnabled']):
            backup_id = self._capture(settings)
        return {'backupId': backup_id, 'private': True, 'serviceActive': self.restart_status, 'restartSucceeded': self.restart_results,
                'guidance': 'Private application/database snapshot saved. Account grants are included privately; rollback preserves the live grants. Service activity is not an audible playback test.'}

    def backups(self):
        self.owned()
        if not self.layout.backups.exists():
            return {'backupIds': []}
        self._directory(self.layout.backups, root_owned=True)
        ids = []
        for path in self.layout.backups.iterdir():
            if not BACKUP_ID.fullmatch(path.name):
                continue
            try:
                self._directory(path, private=True, root_owned=True)
                self._regular(path / 'snapshot.json', private=True, root_owned=True, maximum=16384)
                ids.append(path.name)
            except MaintenanceError:
                continue
        return {'backupIds': sorted(ids, reverse=True)}

    def _validate_release(self, release):
        self._checked(['/usr/bin/python3', str(self.scripts / 'check-bot-release.py'), str(release)],
                      'A clean, complete built release is required. Build and test it as the normal operator before updating.', 90)

    def _snapshot(self, backup_id, settings):
        if not isinstance(backup_id, str) or not BACKUP_ID.fullmatch(backup_id):
            raise MaintenanceError('Choose a self-host backup identifier from backups. Paths and legacy updater snapshots are not accepted by this rollback command.')
        self._directory(self.layout.backups, root_owned=True)
        backup = self.layout.backups / backup_id
        self._directory(backup, private=True, root_owned=True)
        self._regular(backup / 'snapshot.json', private=True, root_owned=True, maximum=16384)
        try:
            manifest = json.loads((backup / 'snapshot.json').read_text())
        except (OSError, ValueError):
            raise MaintenanceError('The selected snapshot is incomplete or invalid.') from None
        kind, _ = self._database(settings)
        expected_names = list(self.layout.config) if settings['viewerEnabled'] else ['bot-unit']
        parts = ['runtime', 'state', 'database', 'config'] + (['viewer'] if settings['viewerEnabled'] else [])
        if (not isinstance(manifest, dict) or type(manifest.get('version')) is not int or manifest['version'] != 1
                or manifest.get('kind') != 'musicmaid-self-host-backup' or manifest.get('backupId') != backup_id
                or manifest.get('viewerEnabled') is not settings['viewerEnabled']
                or manifest.get('databaseLayout') != kind or manifest.get('configFiles') != expected_names
                or not isinstance(manifest.get('hashes'), dict)
                or set(manifest.get('hashes', {})) != set(parts)):
            raise MaintenanceError('Snapshot layout or viewer mode differs from this installation. Refusing a partial rollback; use the recorded operator transaction.')
        for name in parts:
            self._directory(backup / name)
            if self._tree_hash(backup / name) != manifest['hashes'][name]:
                raise MaintenanceError('Snapshot contents changed or are incomplete. Nothing was restored.')
        self._regular(backup / 'database/music.sqlite')
        for name in expected_names:
            self._regular(backup / 'config' / name)
            self._regular(self.layout.config[name])
        if settings['viewerEnabled']:
            # Caddy can host unrelated applications. Never roll their changes back.
            for name in ('caddy', 'viewer-site'):
                self._regular(self.layout.config[name])
                if (backup / 'config' / name).read_bytes() != self.layout.config[name].read_bytes():
                    raise MaintenanceError('Proxy configuration changed since this snapshot. Use the reviewed viewer transaction; shared proxy settings were preserved.')
        self._validate_release(backup / 'runtime')
        return backup

    def _restore(self, backup, settings):
        _, database = self._database(settings)
        self._checked(['/usr/bin/rsync', '-a', '--checksum', '--delete', '--exclude=.env', '--exclude=data', '--',
                       str(backup / 'runtime') + '/', str(self.layout.app) + '/'],
                      'Runtime restoration failed; attempting to preserve a consistent installation.', 180)
        if settings['viewerEnabled']:
            self._checked(['/usr/bin/rsync', '-a', '--checksum', '--delete', '--', str(backup / 'viewer') + '/', str(self.layout.viewer) + '/'],
                          'Viewer restoration failed.', 180)
        names = ['bot-unit'] + (['viewer-unit', 'viewer-tmpfiles', 'restart-rule'] if settings['viewerEnabled'] else [])
        for name in names:
            self._copy(backup / 'config' / name, self.layout.config[name])
        # Import the reviewed helper, never one supplied inside a backup.
        import importlib.util
        spec = importlib.util.spec_from_file_location('musicmaid_restore_database', self.scripts / 'restore-bot-database.py')
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        helper.restore(backup / 'database', database=database)
        self._checked(['/usr/bin/systemctl', 'daemon-reload'], 'Restored service units could not be loaded.')

    @exclusive
    def rollback(self, backup_id):
        self.owned()
        settings = self._settings()
        selected = self._snapshot(backup_id, settings)
        with self._stopped(settings['viewerEnabled']) as control:
            rescue_id = self._capture(settings)
            try:
                self._restore(selected, settings)
            except (MaintenanceError, OSError, ValueError):
                try:
                    self._restore(self.layout.backups / rescue_id, settings)
                except (MaintenanceError, OSError, ValueError):
                    control['restart'] = False
                    raise MaintenanceError('Rollback and recovery failed; services remain stopped to avoid a mixed runtime/database. Preserve the private backup ' + rescue_id + ' for operator recovery.') from None
                raise MaintenanceError('Rollback failed; the pre-rollback snapshot was restored. Recovery backup: ' + rescue_id) from None
        return {'restoredBackupId': backup_id, 'recoveryBackupId': rescue_id, 'serviceActive': self.restart_status, 'restartSucceeded': self.restart_results,
                'guidance': 'Matching runtime, database and units restored; live environment, refreshed account grants and caches were preserved. Run doctor and a listening check.'}

    @exclusive
    def update(self, release):
        self.owned()
        try:
            release = Path(release).resolve(strict=True)
        except (OSError, ValueError):
            raise MaintenanceError('Select an existing, separately built release directory.') from None
        self._directory(release)
        if any(parent == release or parent in release.parents for parent in (self.layout.app.resolve(), self.layout.backups.resolve())):
            raise MaintenanceError('Build a separate release; the installed runtime and backup directory cannot be update sources.')
        trusted_owners = {self.owner_uid}
        if os.environ.get('SUDO_UID', '').isdigit():
            trusted_owners.add(int(os.environ['SUDO_UID']))
        if release.stat().st_uid not in trusted_owners or release.stat().st_mode & 0o022:
            raise MaintenanceError('The candidate directory must belong to the invoking operator or root and must not be writable by other users.')
        settings = self._settings()
        self.layout.backups.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._directory(self.layout.backups, root_owned=True)
        # Freeze the operator's reviewed build before a privileged script runs.
        # Ownership of a previously bot-writable backup does not make it code.
        with tempfile.TemporaryDirectory(prefix='.self-host-update-', dir=self.layout.backups) as temporary:
            staged = Path(temporary) / 'release'
            self._copy(release, staged)
            self._validate_release(staged)
            installer = staged / 'scripts' / ('deploy-viewer.sh' if settings['viewerEnabled'] else 'deploy-bot-update.sh')
            self._regular(installer, maximum=1024 * 1024)
            if settings['viewerEnabled']:
                for relative in ('dist/viewer/app.js', 'dist/apps/viewer-server/src/index.js'):
                    self._regular(staged / relative)
            saved = self.backup()
            try:
                # Interactive viewer input and a transactional Bash rollback must
                # never be cut off by subprocess.run's timeout/SIGKILL behavior.
                self._checked(['/bin/bash', str(installer)], 'The reviewed update did not complete.', timeout=None)
            except (MaintenanceError, KeyboardInterrupt):
                raise MaintenanceError('Update failed or was interrupted. Run doctor to check the installer rollback; do not assume it completed. Your self-host recovery backup is ' + saved['backupId'] + '.') from None
        return {'updated': True, 'viewerIncluded': settings['viewerEnabled'], 'backupId': saved['backupId'],
                'guidance': 'Reviewed update completed. Check the installed revision in Status and perform a listening test.'}

    def doctor(self):
        report = {'managed': False, 'revision': 'unknown', 'units': {}, 'providers': {}, 'audio': {'reachable': False, 'authenticated': False}, 'guidance': []}
        try:
            self.owned(); report['managed'] = True
        except MaintenanceError:
            report['guidance'].append('No valid self-host ownership marker. Existing operator installations must use their reviewed updater; doctor does not adopt them.')
        try:
            self._regular(self.layout.app / 'dist/release.json', maximum=65536)
            manifest = json.loads((self.layout.app / 'dist/release.json').read_text())
            revision = manifest.get('revision') if isinstance(manifest, dict) else None
            if isinstance(revision, str) and re.fullmatch(r'[a-f0-9]{40}', revision):
                report['revision'] = revision
        except (MaintenanceError, OSError, ValueError):
            report['guidance'].append('Installed release metadata is unavailable; validate a clean build before updating.')
        for unit in ('audiobot.service', 'lavalink.service', 'audiobot-cipher.service', 'audiobot-viewer.service'):
            report['units'][unit] = {'active': self._active(unit)}
        try:
            settings = self._settings(probe=True)
            for key in ('youtubeSessionConfigured', 'spotifyMetadataConfigured', 'spotifyOriginalEnabled', 'viewerEnabled'):
                report['providers'][key] = settings.get(key) is True
            audio = settings.get('audio', {})
            report['audio'] = {key: audio.get(key) is True for key in ('reachable', 'authenticated')}
            version = audio.get('version')
            if isinstance(version, str) and re.fullmatch(r'\d+\.\d+\.\d+', version):
                report['audio']['version'] = version
            self._database(settings)
        except MaintenanceError:
            report['guidance'].append('Protected configuration or database layout needs operator review. No credential values were displayed.')
        if not report['units']['audiobot.service']['active']:
            report['guidance'].append('The bot service is inactive. An operator can inspect local service diagnostics and use a reviewed update or selected rollback; restarting cannot renew provider authorization.')
        if not report['audio']['authenticated']:
            report['guidance'].append('Audio service readiness was not verified. Check its unit and local configuration; Discord controls can still start independently.')
        report['guidance'].append('Provider flags show configuration only. Use Discord Diagnose for source checks and listen to a full track to confirm audible playback.')
        return report

    def _cleanup_worker(self, payload):
        helper = self.scripts / 'self_host/data_cleanup.py'
        self._regular(helper, maximum=131072)
        try:
            # SQLite's read-only WAL reader may create shared-memory sidecars.
            # The direct child is the writer: no runuser descendant can outlive
            # a timeout and commit after the bot has restarted.
            account = pwd.getpwnam('botsvc')
            if account.pw_uid <= 0 or account.pw_gid <= 0:
                raise ValueError()
            process = subprocess.Popen(['/usr/bin/python3', '-I', '-B', '-c', helper.read_text()],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, cwd=self.layout.app, env=SAFE_ENV,
                                       user=account.pw_uid, group=account.pw_gid, extra_groups=[], umask=0o077)
            try:
                stdout, _stderr = process.communicate(input=json.dumps(payload), timeout=30)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                try:
                    process.kill()
                except OSError:
                    # Even an unexpected signal failure must not release the
                    # installation lock or restart the bot ahead of its writer.
                    pass
                while True:
                    try:
                        process.communicate()
                        break
                    except KeyboardInterrupt:
                        continue
                raise MaintenanceError('Cleanup worker stopped and exited without a completion receipt. Run a fresh preview to inspect remaining rows; no background writer remains.') from None
            response = json.loads(stdout)
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            raise MaintenanceError('The cleanup worker did not report completion. Run a fresh preview to inspect the current data; raw diagnostics were withheld.') from None
        if not isinstance(response, dict) or response.get('ok') is not True or process.returncode:
            messages = {'invalid-scope': 'Only the explicit request-stats cleanup scope is supported.',
                        'invalid-guild': 'Choose one explicit 17–20 digit Discord server ID.',
                        'invalid-cutoff': 'Use a valid YYYY-MM-DD cutoff from 1970-01-01 through today; the boundary is midnight UTC.',
                        'unsupported-schema': 'This database schema is not supported by the reviewed cleanup helper.',
                        'invalid-session': 'Saved playback state could not be validated. Cleanup refuses to risk queued or recent tracks.',
                        'stale-preview': 'The reviewed cleanup selection or database changed. Run a fresh preview; no unreviewed selection was deleted.',
                        'write-failed': 'The cleanup transaction failed and was rolled back.',
                        'invalid-database': 'The database could not be inspected safely for cleanup.'}
            raise MaintenanceError(messages.get(response.get('code') if isinstance(response, dict) else None,
                                                'Cleanup was refused. Run a fresh preview; no raw database diagnostics were displayed.'))
        if not isinstance(response.get('result'), dict):
            raise MaintenanceError('The cleanup worker returned an invalid result.')
        return response['result']

    def _cleanup_proof(self, value):
        count_names = ('eligibleRequestRows', 'statsRequests', 'statsPlayed', 'statsFinished', 'statsFailed', 'protectedOldRequestRows', 'retainedRequestRows')
        try:
            selected, identity, counts = value['selection'], value['databaseIdentity'], value['counts']
            if (type(value['version']) is not int or value['version'] != 1 or value['schemaVersion'] != 3
                    or selected['scope'] != 'request-stats' or not re.fullmatch(r'[0-9]{17,20}', selected['guildId'])
                    or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', selected['before'])
                    or type(selected['cutoffMs']) is not int or selected['cutoffMs'] < 0
                    or not re.fullmatch(r'[a-f0-9]{64}', value['targetHash'])
                    or any(type(identity[key]) is not int or identity[key] < 0 for key in ('device', 'inode'))
                    or any(type(counts[key]) is not int or counts[key] < 0 for key in count_names)):
                raise ValueError()
            return {'version': 1, 'schemaVersion': 3, 'selection': {key: selected[key] for key in ('scope', 'guildId', 'before', 'cutoffMs')},
                    'databaseIdentity': {key: identity[key] for key in ('device', 'inode')},
                    'targetHash': value['targetHash'], 'counts': {key: counts[key] for key in count_names}}
        except (KeyError, TypeError, ValueError):
            raise MaintenanceError('The cleanup preview is incomplete or invalid.') from None

    def _cleanup_directory(self, create=False):
        directory = self.layout.backups / 'cleanup-previews'
        if create:
            directory.mkdir(mode=0o700, exist_ok=True)
        self._directory(directory, private=True, root_owned=True)
        return directory

    @exclusive
    def cleanup_preview(self, scope, guild_id, before):
        settings = self._settings()
        kind, database = self._database(settings)
        proof = self._cleanup_proof(self._cleanup_worker({'operation': 'preview', 'database': str(database),
                                   'selection': {'scope': scope, 'guildId': guild_id, 'before': before}}))
        preview_id = 'cleanup-' + uuid.uuid4().hex
        now = int(time.time())
        record = {'version': 1, 'kind': 'musicmaid-data-cleanup', 'previewId': preview_id, 'createdAt': now,
                  'expiresAt': now + 3600, 'databaseLayout': kind, 'proof': proof}
        self._json(self._cleanup_directory(create=True) / (preview_id + '.json'), record)
        return {'previewId': preview_id, 'scope': scope, 'guildId': guild_id, 'beforeUtc': before + 'T00:00:00Z',
                'counts': proof['counts'], 'expiresInSeconds': 3600, 'databaseChanged': False,
                'applyCommand': './scripts/setup.sh cleanup apply ' + preview_id,
                'guidance': 'Review these counts before applying. This explicitly removes old request/statistics rows and changes charts. Current/queued/recent-history requests, playlists and genre tags are retained. Apply creates a private recovery backup before any deletion; nothing is pruned automatically.'}

    def _cleanup_record(self, preview_id, kind):
        if not isinstance(preview_id, str) or not CLEANUP_ID.fullmatch(preview_id):
            raise MaintenanceError('Use the exact cleanup identifier printed by a preview, not a file path.')
        path = self._cleanup_directory() / (preview_id + '.json')
        self._regular(path, private=True, root_owned=True, maximum=16384)
        try:
            record = json.loads(path.read_text())
            if (not isinstance(record, dict) or type(record.get('version')) is not int or record['version'] != 1
                    or record.get('kind') != 'musicmaid-data-cleanup' or record.get('previewId') != preview_id
                    or record.get('databaseLayout') != kind or record.get('appliedAt') is not None
                    or type(record.get('expiresAt')) is not int or record['expiresAt'] <= time.time()):
                raise ValueError()
            record['proof'] = self._cleanup_proof(record['proof'])
        except (OSError, ValueError, KeyError, TypeError):
            raise MaintenanceError('This preview expired, was already applied or belongs to another database layout. Create a fresh preview.') from None
        return path, record

    @exclusive
    def cleanup_apply(self, preview_id):
        settings = self._settings()
        kind, database = self._database(settings)
        path, record = self._cleanup_record(preview_id, kind)
        proof = record['proof']
        verify = {'operation': 'verify', 'database': str(database), 'selection': proof['selection'], 'expected': proof}
        self._cleanup_worker(verify)
        if proof['counts']['eligibleRequestRows'] == 0:
            record['appliedAt'] = int(time.time()); self._json(path, record)
            return {'previewId': preview_id, 'deletedRequestRows': 0, 'guidance': 'No eligible rows; no database, services or backup were changed.'}
        with self._stopped(settings['viewerEnabled']):
            # Recheck after shutdown checkpointing, then save a consistent backup.
            self._cleanup_worker(verify)
            backup_id = self._capture(settings)
            if record['expiresAt'] <= time.time():
                raise MaintenanceError('The preview expired before cleanup. No rows were deleted; private backup: ' + backup_id)
            try:
                result = self._cleanup_worker({'operation': 'apply', 'database': str(database), 'expected': proof})
                if type(result.get('deletedRequestRows')) is not int or result['deletedRequestRows'] != proof['counts']['eligibleRequestRows']:
                    raise MaintenanceError('Cleanup did not return the reviewed deletion count.')
            except MaintenanceError as error:
                raise MaintenanceError(str(error) + ' Preserve private recovery backup ' + backup_id + '; a fresh preview shows current remaining rows.') from None
            record.update({'appliedAt': int(time.time()), 'backupId': backup_id})
            try:
                self._json(path, record)
            except (OSError, ValueError):
                raise MaintenanceError('Cleanup committed, but its private receipt could not be saved. Do not repeat blindly; run a fresh preview. Recovery backup: ' + backup_id) from None
        return {'previewId': preview_id, 'guildId': proof['selection']['guildId'], 'scope': 'request-stats',
                'deletedRequestRows': result['deletedRequestRows'], 'backupId': backup_id,
                'serviceActive': self.restart_status, 'restartSucceeded': self.restart_results,
                'guidance': 'Reviewed old request/statistics rows removed. Playlists, genre tags and protected playback history remain. Backup copies still contain the removed data; this is not secure erasure or disk compaction.'}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if os.geteuid() != 0:
        print('Use setup.sh for protected self-host maintenance; this helper requires root.', file=sys.stderr)
        return 1
    lengths = {'doctor': 1, 'backups': 1, 'backup': 1, 'update': 2, 'rollback': 2, 'cleanup-preview': 4, 'cleanup-apply': 2}
    if not argv or argv[0] not in lengths or len(argv) != lengths[argv[0]]:
        print('Usage: maintenance.py doctor|backups|backup|update RELEASE|rollback BACKUP_ID|cleanup-preview request-stats GUILD_ID YYYY-MM-DD|cleanup-apply PREVIEW_ID', file=sys.stderr)
        return 2
    try:
        maintenance = Maintenance()
        result = getattr(maintenance, argv[0].replace('-', '_'))(*argv[1:])
        print(json.dumps(result, sort_keys=True))
        return 0 if all(result.get('restartSucceeded', {}).values()) else 1
    except MaintenanceError as error:
        print(str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('Maintenance interrupted. Successfully stopped services were given a restart attempt; run doctor before continuing.', file=sys.stderr)
        return 130
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        print('Maintenance stopped safely. Run doctor and preserve any private backup; no raw diagnostic output or credentials were displayed.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
