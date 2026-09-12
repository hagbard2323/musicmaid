#!/usr/bin/env python3
"""Exercise legacy rollback functions against temporary trees, never services."""
import json
import hashlib
import os
from pathlib import Path
import shlex
import shutil
import sqlite3
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent


def database_version(path, value=None):
    with sqlite3.connect(path) as connection:
        if value is not None:
            connection.execute('CREATE TABLE IF NOT EXISTS version(value TEXT)')
            connection.execute('DELETE FROM version')
            connection.execute('INSERT INTO version VALUES (?)', (value,))
        return connection.execute('SELECT value FROM version').fetchone()[0]


class LegacyRollbackTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='musicmaid-legacy-rollback-')
        self.root = Path(self.temporary.name)
        self.app = self.root / 'runtime'
        self.state = self.root / 'state'
        self.backup = self.root / 'backup'
        self.release = self.root / 'release'
        self.bin = self.root / 'bin'
        for directory in (self.app, self.state, self.backup, self.release / 'scripts', self.bin):
            directory.mkdir(parents=True)
        (self.app / 'code').write_text('old')
        (self.app / '.env').write_text('old-environment')
        database_version(self.state / 'music.sqlite', 'old')
        self.grant = self.state / 'spotify-direct.json'
        self.write_grant('fixture-old-refresh')
        (self.state / 'spotify-user.json').write_text('fixture-old-user-grant')
        (self.state / 'youtube-cookies.txt').write_text('fixture-old-cookies')
        (self.state / 'youtube-embedded-cache').mkdir()
        (self.state / 'youtube-embedded-cache/decoder').write_text('old-cache')
        shutil.copytree(self.app, self.backup / 'runtime')
        shutil.copytree(self.state, self.backup / 'state')
        shutil.copy2(self.app / '.env', self.backup / 'env')
        shutil.copy2(self.grant, self.backup / 'auth')
        (self.backup / 'binary').write_text('old-helper')
        self.helper = self.root / 'spotify-helper'
        self.helper.write_text('new-helper')
        (self.app / 'code').write_text('new-release')
        (self.app / '.env').write_text('new-environment')
        (self.app / 'new-only').write_text('new runtime artifact')
        database_version(self.state / 'music.sqlite', 'new')
        self.write_grant('fixture-rotated-refresh')
        (self.state / 'spotify-user.json').write_text('fixture-rotated-user-grant')
        (self.state / 'youtube-cookies.txt').write_text('fixture-refreshed-cookies')
        (self.state / 'youtube-embedded-cache/decoder').write_text('new-cache')
        restore = (SCRIPTS / 'restore-bot-database.py').read_text().replace('/var/lib/audiobot/music.sqlite', str(self.state / 'music.sqlite'))
        (self.release / 'scripts/restore-bot-database.py').write_text(restore)
        self.log = self.root / 'services.log'
        command = self.bin / 'systemctl'
        command.write_text('''#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "$SERVICE_LOG"
if [[ "${FAIL_STOP_UNIT:-}" == "${2:-}" && "${1:-}" == stop ]]; then exit 1; fi
''')
        command.chmod(0o700)
        self.environment = {**os.environ, 'PATH': str(self.bin) + ':' + os.environ['PATH'], 'SERVICE_LOG': str(self.log)}

    def tearDown(self):
        self.temporary.cleanup()

    def write_grant(self, refresh):
        self.grant.write_text(json.dumps({'version': 1, 'clientId': '65b708073fc0480ea92a077233ca87bd',
                                         'deviceId': 'a' * 40, 'refreshToken': refresh, 'scope': 'streaming user-read-private'}))
        self.grant.chmod(0o600)

    def rollback(self, installer, bot_started=False):
        contents = (SCRIPTS / installer).read_text()
        start = contents.index('rollback() {')
        function = contents[start:contents.index('\n}\n', start) + 2]
        variables = {'APP_DIR': self.app, 'BACKUP_DIR': self.backup, 'RELEASE_DIR': self.release,
                     'AUDIO_AUTH': self.grant, 'AUDIO_BINARY': self.helper,
                     'SNAPSHOT_READY': 'true',
                     'BOT_UPDATE_STARTED': 'true' if bot_started else 'false'}
        script = '\n'.join(['set -euo pipefail', *[name + '=' + shlex.quote(str(value)) for name, value in variables.items()],
                            'config_files=()', function, 'trap rollback ERR INT TERM', 'false'])
        return subprocess.run(['/bin/bash', '-c', script], env=self.environment, text=True, capture_output=True, timeout=10)

    def assert_rotated_accounts(self):
        self.assertEqual(json.loads(self.grant.read_text())['refreshToken'], 'fixture-rotated-refresh')
        self.assertEqual(self.grant.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.state / 'spotify-user.json').read_text(), 'fixture-rotated-user-grant')
        self.assertEqual((self.state / 'youtube-cookies.txt').read_text(), 'fixture-refreshed-cookies')
        self.assertEqual((self.state / 'youtube-embedded-cache/decoder').read_text(), 'new-cache')

    def test_full_release_restores_database_and_runtime_without_rewinding_accounts(self):
        for suffix in ('-wal', '-shm'):
            (self.state / ('music.sqlite' + suffix)).write_text('stale new sidecar')
        result = self.rollback('deploy-release.sh')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual((self.app / 'code').read_text(), 'old')
        self.assertFalse((self.app / 'new-only').exists())
        self.assertEqual(database_version(self.state / 'music.sqlite'), 'old')
        self.assertFalse((self.state / 'music.sqlite-wal').exists())
        self.assertFalse((self.state / 'music.sqlite-shm').exists())
        self.assert_rotated_accounts()
        self.assertIn('start audiobot\n', self.log.read_text())

    def test_full_release_preserves_runtime_and_database_if_bot_cannot_stop(self):
        self.environment['FAIL_STOP_UNIT'] = 'audiobot'
        result = self.rollback('deploy-release.sh')
        self.assertEqual(result.returncode, 1)
        self.assertIn('left untouched', result.stderr)
        self.assertEqual((self.app / 'code').read_text(), 'new-release')
        self.assertEqual(database_version(self.state / 'music.sqlite'), 'new')
        self.assert_rotated_accounts()
        self.assertEqual(self.log.read_text(), 'stop audiobot\n')

    def test_full_release_keeps_bot_stopped_if_cipher_cannot_stop(self):
        self.environment['FAIL_STOP_UNIT'] = 'audiobot-cipher'
        result = self.rollback('deploy-release.sh')
        self.assertEqual(result.returncode, 1)
        self.assertIn('remains stopped', result.stderr)
        self.assertEqual((self.app / 'code').read_text(), 'new-release')
        self.assertEqual(database_version(self.state / 'music.sqlite'), 'new')
        self.assertEqual(self.log.read_text(), 'stop audiobot\nstop audiobot-cipher\n')

    def test_spotify_rollback_keeps_grant_rotated_by_preflight(self):
        result = self.rollback('deploy-spotify-direct.sh')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual((self.app / '.env').read_text(), 'old-environment')
        self.assertEqual(self.helper.read_text(), 'old-helper')
        self.assert_rotated_accounts()
        self.assertFalse(self.log.exists(), 'preflight failure must not interrupt the running bot')

    def test_first_spotify_install_failure_does_not_delete_its_fresh_grant(self):
        (self.backup / 'auth').unlink()
        result = self.rollback('deploy-spotify-direct.sh')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assert_rotated_accounts()

    def test_spotify_outer_rollback_aborts_if_updated_bot_cannot_stop(self):
        self.environment['FAIL_STOP_UNIT'] = 'audiobot'
        result = self.rollback('deploy-spotify-direct.sh', bot_started=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('left untouched', result.stderr)
        self.assertEqual((self.app / '.env').read_text(), 'new-environment')
        self.assertEqual(self.helper.read_text(), 'new-helper')
        self.assert_rotated_accounts()
        self.assertEqual(self.log.read_text(), 'stop audiobot\n')

    def test_youtube_wrapper_uses_the_shared_release_transaction(self):
        wrapper = self.release / 'scripts/deploy-youtube-update.sh'
        wrapper.write_text((SCRIPTS / wrapper.name).read_text())
        wrapper.chmod(0o700)
        release = self.release / 'scripts/deploy-release.sh'
        release.write_text('#!/bin/bash\nset -eu\nprintf "%s\\n" "$YOUTUBE_COOKIE_SOURCE"\n')
        release.chmod(0o700)
        cookies = str(self.state / 'youtube-cookies.txt')
        result = subprocess.run([str(wrapper), cookies], env=self.environment, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), cookies)


class LegacySnapshotTests(unittest.TestCase):
    def run_release(self, root, fail_snapshot='', successful_install=False):
        app, state = root / 'runtime', root / 'state'
        release, binaries = root / 'release', root / 'bin'
        for directory in (app / 'data', state, release / 'scripts', release / 'dist/apps/bot/src', release / 'node_modules', release / 'deploy', binaries):
            directory.mkdir(parents=True)
        (app / '.env').write_text('fixture-environment')
        (app / 'code').write_text('installed-original')
        database_version(app / 'data/music.sqlite', 'before-stop')
        os.utime(app / 'data/music.sqlite', (1000000, 1000000))
        database_version(state / 'music.sqlite', 'production-path-fixture')
        (release / 'dist/apps/bot/src/index.js').write_text('// fixture')
        (release / 'code').write_text('release-copied')
        (release / '.setup/bin').mkdir(parents=True)
        (release / '.setup/settings.json').write_text('fixture private operator settings')
        (release / '.setup/settings.json').chmod(0o000)
        (release / '.setup/bin/SHA256SUMS').write_text('fixture local helper checksum')
        (root / 'etc/systemd/system').mkdir(parents=True)
        (release / 'deploy/audiobot.service').write_text('[Service]\nType=simple\nExecStart=/usr/bin/node dist/apps/bot/src/index.js\n')
        (release / 'package.json').write_text('{"type":"module"}\n')
        (release / 'package-lock.json').write_text('{"lockfileVersion":3}\n')
        manifest = json.dumps({'version': 1, 'revision': 'a' * 40, 'dirty': False, 'builtAt': '2026-09-12T01:00:00Z',
                               'sourceHash': 'b' * 64,
                               'dependencyHash': hashlib.sha256((release / 'package-lock.json').read_bytes()).hexdigest()}) + '\n'
        (release / 'release-manifest.json').write_text(manifest)
        (release / 'dist/release.json').write_text(manifest)
        preflight = (SCRIPTS / 'check-bot-release.py').read_text().replace("NODE = '/usr/bin/node'", 'NODE = ' + repr(str(binaries / 'node')))
        (release / 'scripts/check-bot-release.py').write_text(preflight)
        shutil.copy2(SCRIPTS / 'release-manifest.mjs', release / 'scripts/release-manifest.mjs')
        shutil.copy2(SCRIPTS / 'bot-service-unit.py', release / 'scripts/bot-service-unit.py')
        # This commit represents the final write made before the service finishes
        # stopping. A runtime backup taken before stop must not lose it on restore.
        mutate = root / 'last-commit.py'
        mutate.write_text('''import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as connection:
    connection.execute("UPDATE version SET value='stopped-consistent'")
''')
        service_log, stopped = root / 'services.log', root / 'stopped'
        commands = {
            'node': 'if [[ "${1:-}" == */release-manifest.mjs ]]; then exec ' + shlex.quote(shutil.which('node')) + ' "$@"; fi\n'
                    'for argument in "$@"; do if [[ "$argument" == --env-file=* ]]; then exit 19; fi; done\nexit 0\n',
            'podman': 'exit 0\n', 'systemd-analyze': 'exit 0\n',
            'chown': 'exit 0\n', 'sleep': 'exit 0\n',
            'runuser': '''[[ "$1" == -u && "$2" == botsvc && "$3" == -- && "$4" == /usr/bin/node ]]
[[ "$5" == "--env-file=$FIXTURE_APP/.env" ]]
if [[ "$6" != -e && "$6" != "$FIXTURE_APP/scripts/service-check.mjs" && "$6" != "$FIXTURE_APP/scripts/youtube-check.mjs" ]]; then exit 19; fi
printf '%s\n' "$*" >> "$READINESS_LOG"
''',
            'journalctl': "printf 'Registered MusicMaid guild commands.\\nMusicMaid ready.\\n'\n",
            'date': "printf '20260912T020001Z\\n'\n",
            'systemctl': '''printf '%s\n' "$*" >> "$SERVICE_LOG"
if [[ "$*" == 'stop audiobot' && ! -f "$STOPPED" ]]; then
  python3 "$LAST_COMMIT" "$FIXTURE_APP/data/music.sqlite"
  touch "$STOPPED"
fi
''',
            'cp': '''if [[ "$1" == '-a' && "$2" == "${FAIL_COPY_SOURCE:-}" ]]; then
  mkdir -p "$3"
  printf 'incomplete fixture snapshot\n' > "$3/partial-only"
  exit 1
fi
exec /bin/cp "$@"
'''
        }
        for name, body in commands.items():
            target = binaries / name
            target.write_text('#!/bin/bash\nset -euo pipefail\n' + body)
            target.chmod(0o700)
        installer = release / 'scripts/deploy-release.sh'
        contents = (SCRIPTS / installer.name).read_text()
        for production, fixture in (('/opt/botsvc/audiobot', app), ('/var/lib/audiobot', state), ('/var/backups/audiobot', root / 'backups'), ('/etc/', root / 'etc/'), ('/opt/lavalink/', root / 'lavalink/')):
            contents = contents.replace(production, str(fixture) + ('/' if production.endswith('/') else ''))
        contents = '\n'.join(line for line in contents.splitlines() if '"$EUID"' not in line) + '\n'
        installer.write_text(contents)
        installer.chmod(0o700)
        install_services = release / 'scripts/install-services.sh'
        install_services.write_text('#!/bin/bash\nexit ' + ('0' if successful_install else '1') + '\n')
        install_services.chmod(0o700)
        restore = (SCRIPTS / 'restore-bot-database.py').read_text().replace('/var/lib/audiobot/music.sqlite', str(state / 'music.sqlite'))
        (release / 'scripts/restore-bot-database.py').write_text(restore)
        environment = {**os.environ, 'PATH': str(binaries) + ':' + os.environ['PATH'], 'SERVICE_LOG': str(service_log),
                       'STOPPED': str(stopped), 'LAST_COMMIT': str(mutate), 'FIXTURE_APP': str(app),
                       'READINESS_LOG': str(root / 'readiness.log'),
                       'FAIL_COPY_SOURCE': str(app if fail_snapshot == 'runtime' else state) if fail_snapshot else ''}
        environment.pop('YOUTUBE_COOKIE_SOURCE', None)
        result = subprocess.run([str(installer)], env=environment, text=True, capture_output=True, timeout=10)
        return result, app, service_log

    def test_default_database_snapshot_includes_last_commit_before_stop(self):
        with tempfile.TemporaryDirectory(prefix='musicmaid-legacy-snapshot-') as directory:
            result, app, service_log = self.run_release(Path(directory))
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertEqual(database_version(app / 'data/music.sqlite'), 'stopped-consistent')
            self.assertEqual((app / 'code').read_text(), 'installed-original')
            self.assertIn('start audiobot\n', service_log.read_text())

    def test_full_release_excludes_operator_setup_settings_and_helper_checksums(self):
        with tempfile.TemporaryDirectory(prefix='musicmaid-legacy-copy-') as directory:
            root = Path(directory)
            result, app, _ = self.run_release(root, successful_install=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((app / 'code').read_text(), 'release-copied')
            self.assertFalse((app / '.setup').exists())
            self.assertTrue((root / 'release/.setup/settings.json').is_file())
            self.assertNotIn('fixture private operator settings', result.stdout + result.stderr)
            calls = (root / 'readiness.log').read_text()
            self.assertIn('-u botsvc -- /usr/bin/node --env-file=' + str(app / '.env'), calls)
            self.assertIn(str(app / 'scripts/service-check.mjs'), calls)

    def test_incomplete_snapshot_restarts_original_bot_without_restoring_partial_files(self):
        for failed_copy in ('runtime', 'state'):
            with self.subTest(failed_copy=failed_copy), tempfile.TemporaryDirectory(prefix='musicmaid-legacy-snapshot-') as directory:
                result, app, service_log = self.run_release(Path(directory), fail_snapshot=failed_copy)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(database_version(app / 'data/music.sqlite'), 'stopped-consistent')
                self.assertEqual((app / 'code').read_text(), 'installed-original')
                self.assertFalse((app / 'partial-only').exists())
                self.assertIn('start audiobot\n', service_log.read_text())
                self.assertNotIn('audiobot-cipher', service_log.read_text())


if __name__ == '__main__':
    unittest.main()
