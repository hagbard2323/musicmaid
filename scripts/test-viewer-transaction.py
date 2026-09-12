#!/usr/bin/env python3
"""Exercise installer rollback with temporary trees and mocked service commands."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import sqlite3
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('restore_database', SCRIPTS / 'restore-bot-database.py')
restore_database = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore_database)


def set_version(database, version):
    with sqlite3.connect(database) as connection:
        connection.execute('CREATE TABLE IF NOT EXISTS version(value TEXT)')
        connection.execute('DELETE FROM version')
        connection.execute('INSERT INTO version VALUES (?)', (version,))


def version(database):
    with sqlite3.connect(database) as connection:
        return connection.execute('SELECT value FROM version').fetchone()[0]


class DeploymentTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='musicmaid-deploy-test-')
        self.root = Path(self.temporary.name)
        self.app = self.path('/opt/botsvc/audiobot')
        self.state = self.path('/var/lib/audiobot')
        self.viewer = self.path('/opt/musicmaid-viewer')
        self.backup = self.path('/var/backups/audiobot/viewer-20260912T010000Z')
        self.release = self.root / 'release'
        self.bin = self.root / 'bin'
        for directory in (self.app, self.state, self.viewer, self.backup, self.release / 'scripts', self.bin):
            directory.mkdir(parents=True)
        self.backup.chmod(0o700)
        self.unit = self.path('/etc/systemd/system/audiobot.service')
        self.unit.parent.mkdir(parents=True)
        self.unit.write_text('# original unit\n[Service]\nType=simple\nExecStart=/bin/true\n')
        self.unit.chmod(0o640)
        self.original_unit = self.unit.read_bytes()
        for name, content in (('code', 'old'), ('.env', 'VIEWER_ENABLED=false\n')):
            (self.app / name).write_text(content)
        (self.app / 'scripts').mkdir()
        (self.app / 'scripts/service-check.mjs').write_text('// installed readiness fixture')
        (self.viewer / 'code').write_text('old-viewer')
        shutil.copy2(self.app / '.env', self.backup / 'bot.env')
        shutil.copytree(self.viewer, self.backup / 'viewer-runtime')
        caddy = self.path('/etc/caddy/Caddyfile')
        caddy.parent.mkdir(parents=True)
        caddy.write_text('old-caddy')
        shutil.copy2(caddy, self.backup / 'Caddyfile')
        set_version(self.state / 'music.sqlite', 'old')
        for name in ('spotify-direct.json', 'spotify-user.json', 'youtube-cookies.txt'):
            (self.state / name).write_text('fixture-old-grant')
        (self.state / 'youtube-embedded-cache').mkdir()
        (self.state / 'youtube-embedded-cache' / 'decoder').write_text('old-cache')
        (self.app / '.env').write_text('VIEWER_ENABLED=true\n')
        (self.release / 'code').write_text('new-release')
        (self.release / 'dist/apps/bot/src').mkdir(parents=True)
        (self.release / 'dist/apps/bot/src/index.js').write_text('// fixture')
        (self.release / 'dist/apps/bot/src/runtime').mkdir()
        (self.release / 'dist/apps/bot/src/runtime/watchdog.js').write_text('// fixture watchdog')
        (self.release / 'dist/apps/bot/src/runtime/release-info.js').write_text('// fixture release information')
        (self.release / 'node_modules').mkdir()
        (self.release / 'deploy').mkdir()
        self.new_unit = '# new unit\n[Service]\nType=notify\nExecStart=/usr/bin/node dist/apps/bot/src/index.js\n'
        (self.release / 'deploy/audiobot.service').write_text(self.new_unit)
        (self.release / 'package.json').write_text('{"type":"module"}\n')
        (self.release / 'package-lock.json').write_text('{"lockfileVersion":3}\n')
        self.manifest = {'version': 1, 'revision': 'a' * 40, 'dirty': False, 'builtAt': '2026-09-12T01:00:00Z',
                         'sourceHash': 'b' * 64,
                         'dependencyHash': hashlib.sha256((self.release / 'package-lock.json').read_bytes()).hexdigest()}
        self.write_manifest()
        for name in ('deploy-bot-update.sh', 'restore-bot-database.py', 'bot-service-unit.py', 'check-bot-release.py', 'release-manifest.mjs'):
            contents = self.relocate((SCRIPTS / name).read_text())
            if name == 'check-bot-release.py':
                contents = contents.replace("NODE = '/usr/bin/node'", 'NODE = ' + repr(str(self.bin / 'runtime-node')))
            contents = '\n'.join(line for line in contents.splitlines() if '"$EUID"' not in line) + '\n'
            target = self.release / 'scripts' / name
            target.write_text(contents)
            target.chmod(0o700)
        self.service_log = self.root / 'services.log'
        self.command('systemctl', '''
printf '%s\n' "$*" >> "$SERVICE_LOG"
if [[ "${FAIL_ROLLBACK_STOP:-}" == true && "$*" == 'stop audiobot' && "$(cat "$FIXTURE_APP/code")" == new-release ]]; then
  exit 1
fi
if [[ "${FAIL_INITIAL_STOP:-}" == true && "$*" == 'stop audiobot' ]]; then exit 1; fi
if [[ "$*" == 'reset-failed audiobot' ]]; then rm -f "$START_LIMIT_FILE"; fi
if [[ "$*" == 'start audiobot' && -f "$START_LIMIT_FILE" ]]; then exit 1; fi
if [[ "$*" == daemon-reload && "${FAIL_DAEMON_RELOAD:-}" == true && ! -f "$FAILED_RELOAD" ]]; then
  touch "$FAILED_RELOAD"; exit 1
fi
case "$*" in
  *InvocationID*) printf 'fixture-invocation\n';;
  *LoadState*) printf 'loaded\n';;
esac
if [[ "${FAIL_BOT_READY:-}" == true && "$*" == 'start audiobot' && "$(cat "$FIXTURE_APP/code")" == new-release ]]; then
  python3 "$MUTATE_FIXTURE"
  touch "$START_LIMIT_FILE"
fi
''')
        self.command('journalctl', '''
if [[ "${FAIL_BOT_READY:-}" != true ]]; then
  printf 'Registered MusicMaid guild commands.\nMusicMaid ready.\n'
fi
''')
        for name in ('chown', 'sleep', 'caddy'):
            self.command(name, 'exit 0\n')
        self.command('node', '''for argument in "$@"; do
  if [[ "$argument" == --env-file=* ]]; then exit 19; fi
done
exit 0
''')
        self.command('runuser', '''[[ "$1" == -u && "$2" == botsvc && "$3" == -- && "$4" == /usr/bin/node ]]
[[ "$5" == "--env-file=$FIXTURE_APP/.env" && "$6" == "$FIXTURE_APP/scripts/service-check.mjs" ]]
test -f "$FIXTURE_APP/scripts/service-check.mjs"
printf '%s\n' "$*" >> "$READINESS_LOG"
''')
        self.command('runtime-node', 'if [[ "${1:-}" == */release-manifest.mjs ]]; then exec '
                     + shlex.quote(shutil.which('node')) + ' "$@"; fi\nexit 0\n')
        self.command('systemd-analyze', '[[ "${FAIL_UNIT_VERIFY:-}" != true ]]\n')
        self.command('install', '''if [[ "${FAIL_UNIT_INSTALL:-}" == true && "${@: -1}" == "$FIXTURE_UNIT" ]]; then
  printf 'partial broken unit\n' > "$FIXTURE_UNIT"; exit 1
fi
exec /usr/bin/install "$@"
''')
        self.command('cp', '''if [[ "$1" == '-a' && "$2" == "${FAIL_COPY_SOURCE:-}" ]]; then
  mkdir -p "$3"; printf 'partial snapshot\n' > "$3/partial-only"; exit 1
fi
exec /bin/cp "$@"
''')
        self.command('date', "printf '20260912T010001Z\\n'\n")
        mutation = self.root / 'mutate.py'
        mutation.write_text('''import sqlite3
from pathlib import Path
state=Path(''' + repr(str(self.state)) + ''')
with sqlite3.connect(state/'music.sqlite') as connection:
    connection.execute("UPDATE version SET value='new'")
for name in ('spotify-direct.json','spotify-user.json','youtube-cookies.txt'):
    (state/name).write_text('fixture-rotated-grant')
(state/'youtube-embedded-cache/decoder').write_text('new-cache')
''')
        self.environment = {**os.environ, 'PATH': str(self.bin) + ':' + os.environ['PATH'],
                            'SERVICE_LOG': str(self.service_log), 'FIXTURE_APP': str(self.app),
                            'MUTATE_FIXTURE': str(mutation), 'FIXTURE_UNIT': str(self.unit),
                            'FAILED_RELOAD': str(self.root / 'failed-reload'),
                            'START_LIMIT_FILE': str(self.root / 'start-limit-hit'),
                            'READINESS_LOG': str(self.root / 'readiness.log')}

    def write_manifest(self):
        value = json.dumps(self.manifest) + '\n'
        (self.release / 'release-manifest.json').write_text(value)
        (self.release / 'dist/release.json').write_text(value)

    def tearDown(self):
        self.temporary.cleanup()

    def path(self, production):
        return self.root / production.lstrip('/')

    def relocate(self, contents):
        for path in ('/var/backups/audiobot', '/var/lib/audiobot', '/opt/botsvc/audiobot', '/opt/musicmaid-viewer', '/etc/'):
            contents = contents.replace(path, str(self.path(path)) + ('/' if path.endswith('/') else ''))
        return contents

    def command(self, name, body):
        target = self.bin / name
        target.write_text('#!/bin/bash\nset -euo pipefail\n' + body)
        target.chmod(0o700)

    def update(self, marker=True, fail_ready=False):
        environment = {**self.environment, 'FAIL_BOT_READY': 'true' if fail_ready else 'false'}
        environment.pop('BOT_UPDATE_BACKUP_MARKER', None)
        if marker:
            environment['BOT_UPDATE_BACKUP_MARKER'] = str(self.backup / 'bot-update.backup')
        return subprocess.run([str(self.release / 'scripts/deploy-bot-update.sh')], env=environment, capture_output=True, text=True, timeout=10)

    def outer_rollback(self):
        installer = self.relocate((SCRIPTS / 'deploy-viewer.sh').read_text())
        start = installer.index('rollback() {')
        rollback = installer[start:installer.index('\ntrap rollback ERR INT TERM', start)]
        globals = {'INSTALL_STARTED': 'true', 'BOT_UPDATED': 'true', 'VIEWER_WAS_ACTIVE': 'true',
                   'VIEWER_WAS_ENABLED': 'true', 'BACKUP_DIR': str(self.backup), 'APP_DIR': str(self.app),
                   'VIEWER_DIR': str(self.viewer), 'RELEASE_DIR': str(self.release)}
        script = '\n'.join(['set -euo pipefail', *[name + '=' + shlex.quote(value) for name, value in globals.items()],
                            rollback, 'trap rollback ERR INT TERM', 'false'])
        return subprocess.run(['/bin/bash', '-c', script], env=self.environment, capture_output=True, text=True, timeout=10)

    def assert_current_grants(self):
        for name in ('spotify-direct.json', 'spotify-user.json', 'youtube-cookies.txt'):
            self.assertEqual((self.state / name).read_text(), 'fixture-rotated-grant')
        self.assertEqual((self.state / 'youtube-embedded-cache/decoder').read_text(), 'new-cache')

    def test_late_viewer_failure_restores_matching_code_database_and_original_flags(self):
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stderr)
        marker = self.backup / 'bot-update.backup'
        self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
        nested = Path(marker.read_text().strip())
        self.assertEqual((nested / 'runtime/code').read_text(), 'old')
        self.assertEqual(version(nested / 'state/music.sqlite'), 'old')
        self.assertEqual((nested / 'audiobot.service').read_bytes(), self.original_unit)
        self.assertEqual((nested / 'bot-unit-state').read_text(), 'present\n')
        self.assertEqual((self.app / 'code').read_text(), 'new-release')
        self.assertFalse((self.release / 'apps').exists(), 'A built release does not need a TypeScript source tree.')
        self.assertEqual(self.unit.read_text(), self.new_unit)
        subprocess.run(['python3', self.environment['MUTATE_FIXTURE']], check=True)
        for suffix in ('-wal', '-shm'):
            (self.state / ('music.sqlite' + suffix)).write_text('stale-new-sidecar')
        (self.viewer / 'code').write_text('new-viewer-release')
        (self.app / 'new-release-only').write_text('remove during rollback')
        result = self.outer_rollback()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual((self.app / 'code').read_text(), 'old')
        self.assertFalse((self.app / 'new-release-only').exists())
        self.assertEqual((self.app / '.env').read_text(), 'VIEWER_ENABLED=false\n')
        self.assertEqual((self.viewer / 'code').read_text(), 'old-viewer')
        self.assertEqual(version(self.state / 'music.sqlite'), 'old')
        self.assertEqual(self.unit.read_bytes(), self.original_unit)
        self.assertEqual(self.unit.stat().st_mode & 0o777, 0o640)
        self.assertFalse((self.state / 'music.sqlite-wal').exists())
        self.assertFalse((self.state / 'music.sqlite-shm').exists())
        self.assert_current_grants()
        self.assertIn('stop audiobot\n', self.service_log.read_text())
        self.assertIn('restart audiobot\n', self.service_log.read_text())

    def test_inner_update_failure_also_preserves_rotated_grants(self):
        result = self.update(marker=False, fail_ready=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('Bot update failed', result.stderr)
        self.assertEqual((self.app / 'code').read_text(), 'old')
        self.assertEqual(version(self.state / 'music.sqlite'), 'old')
        self.assertEqual(self.unit.read_bytes(), self.original_unit)
        self.assert_current_grants()

    def test_update_and_outer_rollback_replace_equal_size_equal_mtime_code(self):
        installed, incoming = self.app / 'code', self.release / 'code'
        incoming.write_text('new')  # Both old and new payloads have three bytes.
        timestamp = 1_700_000_000_000_000_000
        for path in (installed, incoming):
            os.utime(path, ns=(timestamp, timestamp))
        self.assertEqual(installed.stat().st_size, incoming.stat().st_size)
        self.assertEqual(installed.stat().st_mtime_ns, incoming.stat().st_mtime_ns)
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(installed.read_text(), 'new', 'Update must compare bytes even when rsync quick-check metadata matches.')
        nested = Path((self.backup / 'bot-update.backup').read_text().strip())
        viewer_current, viewer_saved = self.viewer / 'code', self.backup / 'viewer-runtime/code'
        viewer_current.write_text('new-viewer')
        for path in (viewer_current, viewer_saved):
            os.utime(path, ns=(timestamp, timestamp))
        for current, saved in ((installed, nested / 'runtime/code'), (viewer_current, viewer_saved)):
            self.assertEqual(current.stat().st_size, saved.stat().st_size)
            self.assertEqual(current.stat().st_mtime_ns, saved.stat().st_mtime_ns)
            self.assertNotEqual(current.read_bytes(), saved.read_bytes())
        subprocess.run(['python3', self.environment['MUTATE_FIXTURE']], check=True)
        result = self.outer_rollback()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(installed.read_text(), 'old')
        self.assertEqual(viewer_current.read_text(), 'old-viewer')
        self.assert_current_grants()

    def test_outer_rejects_untrusted_backup_marker(self):
        marker = self.backup / 'bot-update.backup'
        marker.write_text(str(self.root / 'outside-backups'))
        marker.chmod(0o600)
        result = self.outer_rollback()
        self.assertEqual(result.returncode, 1)
        self.assertIn('invalid backup directory', result.stderr)
        self.assertEqual(version(self.state / 'music.sqlite'), 'old')
        self.assertNotIn('restart audiobot\n', self.service_log.read_text())

    def test_rollback_does_not_overwrite_a_database_when_bot_stop_fails(self):
        self.environment['FAIL_ROLLBACK_STOP'] = 'true'
        result = self.update(marker=False, fail_ready=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('runtime, database and unit were left untouched', result.stderr)
        self.assertEqual((self.app / 'code').read_text(), 'new-release')
        self.assertEqual(version(self.state / 'music.sqlite'), 'new')
        self.assertEqual(self.unit.read_text(), self.new_unit)
        self.assert_current_grants()

    def test_successful_bot_update_installs_matching_unit_without_restarting_other_services(self):
        result = self.update(marker=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.unit.read_text(), self.new_unit)
        self.assertEqual((self.app / 'code').read_text(), 'new-release')
        calls = self.service_log.read_text()
        self.assertLess(calls.index('daemon-reload\n'), calls.index('start audiobot\n'))
        self.assertNotRegex(calls, r'(?:start|stop|restart) (?:lavalink|audiobot-cipher|audiobot-viewer)')

    def test_reviewed_update_can_start_after_the_prior_service_hit_its_start_limit(self):
        Path(self.environment['START_LIMIT_FILE']).touch()
        result = self.update(marker=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(Path(self.environment['START_LIMIT_FILE']).exists())
        self.assertIn('reset-failed audiobot\nstart audiobot\n', self.service_log.read_text())

    def test_bot_update_excludes_operator_setup_settings_and_build_artifacts(self):
        setup = self.release / '.setup'
        (setup / 'bin').mkdir(parents=True)
        (setup / 'settings.json').write_text('fixture private operator settings')
        (setup / 'settings.json').chmod(0o000)
        (setup / 'bin/SHA256SUMS').write_text('fixture local helper checksum')
        (setup / 'bin/local-helper').write_text('fixture local build artifact')
        result = self.update(marker=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.app / 'code').read_text(), 'new-release')
        self.assertFalse((self.app / '.setup').exists())
        self.assertTrue((setup / 'settings.json').is_file(), 'The source setup directory must remain untouched.')
        self.assertNotIn('fixture private operator settings', result.stdout + result.stderr)

    def test_readiness_drops_to_bot_user_and_uses_installed_helper(self):
        result = self.update(marker=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = Path(self.environment['READINESS_LOG']).read_text()
        self.assertIn('-u botsvc -- /usr/bin/node --env-file=' + str(self.app / '.env'), calls)
        self.assertIn(str(self.app / 'scripts/service-check.mjs'), calls)
        self.assertNotIn(str(self.release), calls)

    def test_absent_bot_unit_override_is_removed_on_outer_rollback(self):
        self.unit.unlink()
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stderr)
        nested = Path((self.backup / 'bot-update.backup').read_text().strip())
        self.assertEqual((nested / 'bot-unit-state').read_text(), 'absent\n')
        self.assertTrue(self.unit.is_file())
        result = self.outer_rollback()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse(self.unit.exists())
        self.assertEqual((self.app / 'code').read_text(), 'old')

    def test_absent_bot_unit_override_is_removed_on_inner_rollback(self):
        self.unit.unlink()
        result = self.update(marker=False, fail_ready=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse(self.unit.exists())
        self.assertEqual((self.app / 'code').read_text(), 'old')
        self.assertEqual(version(self.state / 'music.sqlite'), 'old')
        self.assert_current_grants()

    def test_outer_rollback_stop_failure_preserves_new_runtime_database_and_unit(self):
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stderr)
        subprocess.run(['python3', self.environment['MUTATE_FIXTURE']], check=True)
        self.environment['FAIL_ROLLBACK_STOP'] = 'true'
        result = self.outer_rollback()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.unit.read_text(), self.new_unit)
        self.assertEqual((self.app / 'code').read_text(), 'new-release')
        self.assertEqual(version(self.state / 'music.sqlite'), 'new')
        self.assert_current_grants()

    def test_outer_rollback_rejects_incomplete_unit_snapshot_before_replacing_runtime(self):
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stderr)
        nested = Path((self.backup / 'bot-update.backup').read_text().strip())
        (nested / 'bot-unit-state').unlink()
        self.service_log.write_text('')
        result = self.outer_rollback()
        self.assertEqual(result.returncode, 1)
        self.assertIn('Bot unit transaction stopped', result.stderr)
        self.assertEqual(self.unit.read_text(), self.new_unit)
        self.assertEqual((self.app / 'code').read_text(), 'new-release')
        self.assertNotIn('stop audiobot\n', self.service_log.read_text())
        self.assertNotIn('restart audiobot\n', self.service_log.read_text())

    def test_database_restore_refusal_keeps_old_code_and_unit_paired_but_bot_stopped(self):
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stderr)
        nested = Path((self.backup / 'bot-update.backup').read_text().strip())
        shutil.rmtree(nested / 'state')
        self.service_log.write_text('')
        result = self.outer_rollback()
        self.assertEqual(result.returncode, 1)
        self.assertIn('No pre-update music database', result.stderr)
        self.assertEqual(self.unit.read_bytes(), self.original_unit)
        self.assertEqual((self.app / 'code').read_text(), 'old')
        self.assertIn('stop audiobot\n', self.service_log.read_text())
        self.assertNotIn('restart audiobot\n', self.service_log.read_text())

    def test_failed_initial_stop_never_snapshots_restores_or_installs_unit(self):
        self.environment['FAIL_INITIAL_STOP'] = 'true'
        result = self.update()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.unit.read_bytes(), self.original_unit)
        self.assertEqual((self.app / 'code').read_text(), 'old')
        self.assertEqual(self.service_log.read_text(), 'stop audiobot\n')
        self.assertFalse((self.backup / 'bot-update.backup').exists())

    def test_incomplete_runtime_or_state_snapshot_never_restores_partial_files_or_changes_unit(self):
        for source in (self.app, self.state):
            with self.subTest(source=source):
                self.environment['FAIL_COPY_SOURCE'] = str(source)
                result = self.update()
                self.assertEqual(result.returncode, 1)
                self.assertIn('snapshot did not complete', result.stderr)
                self.assertEqual(self.unit.read_bytes(), self.original_unit)
                self.assertEqual((self.app / 'code').read_text(), 'old')
                self.assertEqual(version(self.state / 'music.sqlite'), 'old')
                self.assertFalse((self.app / 'partial-only').exists())
                self.assertFalse((self.backup / 'bot-update.backup').exists())
                self.assertIn('start audiobot\n', self.service_log.read_text())
                for path in self.path('/var/backups/audiobot').glob('bot-update-*'):
                    shutil.rmtree(path)

    def test_failed_unit_snapshot_preserves_old_runtime_and_existing_override(self):
        target = self.unit.with_suffix('.original')
        self.unit.rename(target)
        self.unit.symlink_to(target)
        result = self.update()
        self.assertEqual(result.returncode, 1)
        self.assertIn('snapshot did not complete', result.stderr)
        self.assertTrue(self.unit.is_symlink())
        self.assertEqual(self.unit.read_bytes(), self.original_unit)
        self.assertEqual((self.app / 'code').read_text(), 'old')
        self.assertEqual(version(self.state / 'music.sqlite'), 'old')
        self.assertFalse((self.backup / 'bot-update.backup').exists())
        self.assertIn('start audiobot\n', self.service_log.read_text())

    def test_unit_install_failure_restores_original_unit_and_runtime(self):
        self.environment['FAIL_UNIT_INSTALL'] = 'true'
        result = self.update(marker=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.unit.read_bytes(), self.original_unit)
        self.assertEqual((self.app / 'code').read_text(), 'old')
        self.assertIn('daemon-reload\nreset-failed audiobot\nstart audiobot\n', self.service_log.read_text())

    def test_daemon_reload_failure_restores_matching_unit_before_original_start(self):
        self.environment['FAIL_DAEMON_RELOAD'] = 'true'
        result = self.update(marker=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.unit.read_bytes(), self.original_unit)
        self.assertEqual((self.app / 'code').read_text(), 'old')
        self.assertEqual(self.service_log.read_text().count('daemon-reload\n'), 2)
        self.assertIn('daemon-reload\nreset-failed audiobot\nstart audiobot\n', self.service_log.read_text())

    def test_invalid_unit_fails_preflight_before_any_service_change(self):
        self.environment['FAIL_UNIT_VERIFY'] = 'true'
        result = self.update()
        self.assertEqual(result.returncode, 1)
        self.assertFalse(self.service_log.exists())
        self.assertEqual(self.unit.read_bytes(), self.original_unit)
        self.assertFalse((self.backup / 'bot-update.backup').exists())

    def test_missing_notifier_node_dependency_or_compiled_entry_fails_before_stop(self):
        checker = self.release / 'scripts/check-bot-release.py'
        original_checker = checker.read_text()
        runtime_node = self.bin / 'runtime-node'
        original_node = runtime_node.read_text()
        entry = self.release / 'dist/apps/bot/src/index.js'
        watchdog = self.release / 'dist/apps/bot/src/runtime/watchdog.js'
        for failure in ('notify', 'node', 'dependencies', 'entry', 'watchdog'):
            with self.subTest(failure=failure):
                checker.write_text(original_checker)
                runtime_node.write_text(original_node); runtime_node.chmod(0o700)
                entry.write_text('// fixture')
                watchdog.write_text('// fixture watchdog')
                if failure == 'notify':
                    checker.write_text(original_checker.replace("NOTIFY = '/usr/bin/systemd-notify'", 'NOTIFY = ' + repr(str(self.root / 'missing-notifier'))))
                elif failure == 'node':
                    runtime_node.chmod(0o600)
                elif failure == 'dependencies':
                    runtime_node.write_text('#!/bin/bash\n[[ "$1" != --input-type=module ]]\n')
                elif failure == 'entry':
                    entry.unlink()
                else:
                    watchdog.unlink()
                result = self.update()
                self.assertEqual(result.returncode, 1)
                self.assertIn('Release preflight failed', result.stderr)
                self.assertFalse(self.service_log.exists())
                self.assertEqual(self.unit.read_bytes(), self.original_unit)
                self.assertEqual((self.app / 'code').read_text(), 'old')

    def test_bad_release_manifest_and_missing_module_boundary_fail_before_stop(self):
        mutations = [
            lambda: (self.release / 'release-manifest.json').unlink(),
            lambda: (self.release / 'dist/release.json').write_text('{}'),
            lambda: (self.release / 'package-lock.json').write_text('{}'),
            lambda: self.manifest.update(dirty=True),
            lambda: self.manifest.update(revision='unknown'),
            lambda: self.manifest.update(builtAt='not-a-date'),
            lambda: self.manifest.update(sourceHash='invalid'),
            lambda: (self.release / 'package.json').write_text('{}'),
        ]
        original = dict(self.manifest)
        for change in mutations:
            with self.subTest(change=change):
                self.manifest = dict(original)
                (self.release / 'package-lock.json').write_text('{"lockfileVersion":3}\n')
                (self.release / 'package.json').write_text('{"type":"module"}\n')
                self.write_manifest()
                change()
                if self.manifest != original:
                    self.write_manifest()
                result = self.update()
                self.assertEqual(result.returncode, 1)
                self.assertIn('Release preflight failed', result.stderr)
                self.assertFalse(self.service_log.exists())
                self.assertEqual(self.unit.read_bytes(), self.original_unit)
                self.assertEqual((self.app / 'code').read_text(), 'old')

    def test_changed_source_hash_is_rejected_before_stop_by_the_manifest_verifier(self):
        source = self.release / 'apps/bot/src/index.ts'
        source.parent.mkdir(parents=True)
        source.write_text('// reviewed source')
        checker = self.release / 'scripts/release-manifest.mjs'
        result = subprocess.run([shutil.which('node'), '--input-type=module', '-e',
                                 'import {sourceHash} from ' + json.dumps(str(checker)) + '; process.stdout.write(sourceHash(process.argv[1]));',
                                 str(self.release)], capture_output=True, text=True, check=True)
        self.manifest['sourceHash'] = result.stdout
        self.write_manifest()
        subprocess.run([shutil.which('node'), str(checker), '--check', str(self.release)], check=True)
        source.write_text('// changed after build')
        result = self.update()
        self.assertEqual(result.returncode, 1)
        self.assertIn('Release preflight failed', result.stderr)
        self.assertFalse(self.service_log.exists())
        self.assertEqual(self.unit.read_bytes(), self.original_unit)
        self.assertEqual((self.app / 'code').read_text(), 'old')

    def test_validating_a_backup_never_executes_its_manifest_checker(self):
        trusted = self.root / 'reviewed-tools'
        trusted.mkdir()
        shutil.copy2(self.release / 'scripts/check-bot-release.py', trusted / 'check-bot-release.py')
        shutil.copy2(SCRIPTS / 'release-manifest.mjs', trusted / 'release-manifest.mjs')
        marker = self.root / 'target-checker-executed'
        (self.release / 'scripts/release-manifest.mjs').write_text(
            'import {writeFileSync} from "node:fs"; writeFileSync(' + json.dumps(str(marker)) + ', "must not execute");\n')
        result = subprocess.run(['python3', str(trusted / 'check-bot-release.py'), str(self.release)],
                                env=self.environment, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(marker.exists(), 'Only the current reviewed checker may execute; target scripts are data.')
        self.assertFalse(self.service_log.exists())


class DatabaseRestoreTests(unittest.TestCase):
    def test_matching_sidecars_replace_stale_sidecars_without_touching_grants(self):
        with tempfile.TemporaryDirectory(prefix='musicmaid-db-restore-') as directory:
            root = Path(directory)
            saved, current = root / 'saved', root / 'current'
            saved.mkdir(); current.mkdir()
            for suffix in ('', '-wal', '-shm'):
                (saved / ('music.sqlite' + suffix)).write_text('saved' + suffix)
                (current / ('music.sqlite' + suffix)).write_text('new' + suffix)
            grant = current / 'spotify-direct.json'
            grant.write_text('fixture-rotated-grant')
            restore_database.restore(saved, current / 'music.sqlite')
            for suffix in ('', '-wal', '-shm'):
                self.assertEqual((current / ('music.sqlite' + suffix)).read_text(), 'saved' + suffix)
            self.assertEqual(grant.read_text(), 'fixture-rotated-grant')
            self.assertEqual(list(current.glob('.music-rollback-*')), [])

    def test_missing_snapshot_preserves_existing_database_and_refuses_restart(self):
        with tempfile.TemporaryDirectory(prefix='musicmaid-db-restore-') as directory:
            root = Path(directory)
            saved = root / 'missing-snapshot'
            current = root / 'music.sqlite'
            restore_database.restore(saved, current)  # No old or new database: nothing to restore.
            current.write_text('new-database')
            with self.assertRaisesRegex(ValueError, 'No pre-update music database'):
                restore_database.restore(saved, current)
            self.assertEqual(current.read_text(), 'new-database')


if __name__ == '__main__':
    unittest.main()
