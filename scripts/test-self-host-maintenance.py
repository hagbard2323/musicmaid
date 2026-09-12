#!/usr/bin/env python3
"""Offline self-host maintenance fixtures; no services, credentials or root needed."""
import hashlib
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('self_host_maintenance', SCRIPTS / 'self_host/maintenance.py')
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


def database(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as connection:
        with connection:
            connection.execute('CREATE TABLE IF NOT EXISTS fixture(value TEXT)')
            connection.execute('DELETE FROM fixture')
            connection.execute('INSERT INTO fixture VALUES (?)', (value,))


def read_database(path):
    with closing(sqlite3.connect(path)) as connection:
        return connection.execute('SELECT value FROM fixture').fetchone()[0]


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='musicmaid-self-host-maintenance-')
        self.root = Path(self.temporary.name)
        self.trusted_tools = self.root / 'reviewed-tools'
        self.trusted_tools.mkdir(mode=0o700)
        self.configure_fixture_node()
        self.layout = maintenance.Layout(self.root)
        self.calls = []
        self.active = {'audiobot.service': True, 'lavalink.service': True, 'audiobot-cipher.service': True, 'audiobot-viewer.service': False}
        self.states = {}
        self.fail_stop = None
        self.fail_copy = None
        self.fail_rsync_once = False
        self.fail_rsync_always = False
        self.fail_validation = False
        self.delegate_error = False
        self.viewer = False
        for directory in (self.layout.app, self.layout.state, self.layout.app / 'data'):
            directory.mkdir(parents=True, exist_ok=True)
            directory.chmod(0o700)
        for name, path in self.layout.config.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('# fixture ' + name + '\n')
        self.layout.config['bot-unit'].write_text('[Service]\nType=simple\nEnvironment=MUSIC_DATABASE_PATH=/var/lib/audiobot/music.sqlite\nExecStart=/usr/bin/node dist/apps/bot/src/index.js\n')
        self.layout.config['viewer-env'].write_text('VIEWER_CLIENT_SECRET=fixture-viewer-secret\n')
        self.layout.config['viewer-env'].chmod(0o600)
        self.env_text = 'DISCORD_TOKEN=fixture-bot-secret\nSPOTIFY_CLIENT_ID=fixture-id\nSPOTIFY_CLIENT_SECRET=fixture-client-secret\nVIEWER_ENABLED=false\nMUSIC_DATABASE_PATH=./data/music.sqlite\n'
        (self.layout.app / '.env').write_text(self.env_text)
        (self.layout.app / '.env').chmod(0o600)
        marker = {'version': 1, 'managedBy': 'musicmaid-self-host', 'appDir': '/opt/botsvc/audiobot',
                  'stateDir': '/var/lib/audiobot', 'units': ['audiobot.service', 'lavalink.service', 'audiobot-cipher.service'],
                  'release': {'commit': 'a' * 40, 'manifestSha256': 'b' * 64}, 'installedAt': '2026-09-12T12:00:00Z'}
        self.layout.marker.write_text(json.dumps(marker)); self.layout.marker.chmod(0o600)
        self.database = self.layout.state / 'music.sqlite'
        database(self.database, 'old')
        (self.layout.state / 'spotify-direct.json').write_text('old-private-grant')
        (self.layout.state / 'youtube-embedded-cache').mkdir()
        (self.layout.state / 'youtube-embedded-cache/decoder').write_text('old-cache')
        self.make_release(self.layout.app)
        self.engine = maintenance.Maintenance(self.layout, runner=self.run_command, owner_uid=os.geteuid(), sleep=lambda _: None)

    def tearDown(self):
        self.temporary.cleanup()

    def configure_fixture_node(self):
        # GitHub setup-node installs under its tool cache, not /usr/bin. Keep
        # production paths fixed while giving every real fixture call an
        # explicit interpreter, including subprocesses inside the validator.
        node = shutil.which('node')
        self.assertIsNotNone(node, 'These fixtures require Node 22.13+ on PATH.')
        self.fixture_node = str(Path(node).resolve())
        checker = (SCRIPTS / 'check-bot-release.py').read_text()
        self.assertEqual(checker.count("NODE = '/usr/bin/node'"), 1)
        (self.trusted_tools / 'check-bot-release.py').write_text(
            checker.replace("NODE = '/usr/bin/node'", 'NODE = ' + repr(self.fixture_node)))
        shutil.copy2(SCRIPTS / 'release-manifest.mjs', self.trusted_tools / 'release-manifest.mjs')

    def make_release(self, path):
        path.mkdir(parents=True, exist_ok=True)
        for directory in ('dist/apps/bot/src', 'scripts', 'deploy', 'node_modules/discord.js', 'node_modules/shoukaku', 'node_modules/dotenv'):
            (path / directory).mkdir(parents=True, exist_ok=True)
        (path / 'dist/apps/bot/src/index.js').write_text('// old fixture runtime\n')
        (path / 'package.json').write_text('{"type":"module"}\n')
        lock = b'{"lockfileVersion":3}\n'; (path / 'package-lock.json').write_bytes(lock)
        manifest = {'version': 1, 'revision': 'a' * 40, 'dirty': False, 'builtAt': '2026-09-12T12:00:00Z', 'sourceHash': 'b' * 64, 'dependencyHash': hashlib.sha256(lock).hexdigest()}
        for name in ('release-manifest.json', 'dist/release.json'):
            (path / name).write_text(json.dumps(manifest))
        for name in ('discord.js', 'shoukaku'):
            (path / 'node_modules' / name / 'index.js').write_text('// resolve only\n')
        (path / 'node_modules/dotenv/config.js').write_text('// resolve only\n')
        for name in ('bot-service-unit.py', 'restore-bot-database.py', 'release-manifest.mjs'):
            (path / 'scripts' / name).write_text('// fixture checker must not execute\n')
        for name in ('deploy-bot-update.sh', 'deploy-viewer.sh'):
            (path / 'scripts' / name).write_text('#!/bin/bash\nexit 0\n')
        (path / 'deploy/audiobot.service').write_text('[Service]\nType=simple\nExecStart=/usr/bin/node dist/apps/bot/src/index.js\n')

    def run_command(self, args, timeout=30):
        self.calls.append((list(args), timeout))
        result = lambda code=0, stdout='': subprocess.CompletedProcess(args, code, stdout, 'fixture-private-diagnostic')
        if args[0] == '/usr/bin/systemctl':
            action = args[1]
            if action == 'stop':
                if args[2] == self.fail_stop:
                    return result(9)
                self.active[args[2]] = False
            elif action == 'start':
                self.active[args[2]] = True
            elif action == 'is-active':
                return result(0 if self.active[args[-1]] else 3)
            elif action == 'show':
                return result(stdout=self.states.get(args[2], 'active' if self.active[args[2]] else 'inactive') + '\n')
            return result()
        if args[0] == '/usr/bin/node':
            if args[-1] == 'probe':
                return result(stdout=json.dumps({'databasePath': '/var/lib/audiobot/music.sqlite', 'viewerEnabled': self.viewer,
                              'spotifyMetadataConfigured': True, 'spotifyOriginalEnabled': False, 'youtubeSessionConfigured': False,
                              'audio': {'reachable': True, 'authenticated': True, 'version': '4.2.2', 'untrusted': 'fixture-secret-never-report'}}))
            return subprocess.run([self.fixture_node, *args[1:]], capture_output=True, text=True,
                                  timeout=timeout, env=maintenance.SAFE_ENV)
        if args[0] == '/usr/bin/python3':
            self.assertEqual(Path(args[1]), SCRIPTS / 'check-bot-release.py', 'Only the current reviewed checker may execute as a validator')
            if self.fail_validation:
                return result(8)
            return subprocess.run([sys.executable, str(self.trusted_tools / 'check-bot-release.py'), *args[2:]],
                                  capture_output=True, text=True, timeout=timeout, env=maintenance.SAFE_ENV)
        if args[0] == '/bin/cp':
            if self.fail_copy and Path(args[-2]) == self.fail_copy:
                return result(7)
            return subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        if args[0] == '/usr/bin/rsync':
            if self.fail_rsync_once or self.fail_rsync_always:
                self.fail_rsync_once = False
                (self.layout.app / 'dist/apps/bot/src/index.js').write_text('// partial copy\n')
                return result(8)
            return subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        if args[0] == '/bin/bash':
            self.assertIsNone(timeout, 'Never force-kill a transactional delegate or its interactive viewer prompt')
            staged = Path(args[1]).parent.parent
            self.assertTrue(str(staged).startswith(str(self.layout.backups)))
            self.assertEqual(stat_mode(staged.parent), 0o700)
            return result(12 if self.delegate_error else 0)
        if args[0] == '/usr/bin/sync':
            return result()
        self.fail('Unexpected command: ' + repr(args))

    def stops(self):
        return [args for args, _ in self.calls if args[:2] == ['/usr/bin/systemctl', 'stop']]

    def enable_viewer(self):
        self.viewer = True
        path = self.layout.app / '.env'
        path.write_text(path.read_text().replace('VIEWER_ENABLED=false', 'VIEWER_ENABLED=true'))
        self.layout.viewer.mkdir(parents=True)
        (self.layout.viewer / 'code').write_text('old-viewer')
        self.active['audiobot-viewer.service'] = True

    def test_unmanaged_installation_is_read_only_and_not_adopted(self):
        self.layout.marker.unlink()
        report = self.engine.doctor()
        self.assertFalse(report['managed'])
        for action in (self.engine.backup, lambda: self.engine.update(self.root / 'release'), lambda: self.engine.rollback('invalid')):
            with self.assertRaises(maintenance.MaintenanceError):
                action()
        self.assertEqual(self.stops(), [])
        self.assertFalse(self.layout.marker.exists())

    def test_doctor_printable_result_contains_no_credentials_or_unfiltered_probe_fields(self):
        report = self.engine.doctor()
        self.assertTrue(report['managed']); self.assertTrue(report['audio']['authenticated'])
        output = json.dumps(report)
        for secret in ('fixture-bot-secret', 'fixture-client-secret', 'fixture-viewer-secret', 'fixture-secret-never-report', 'fixture-private-diagnostic'):
            self.assertNotIn(secret, output)
        self.assertEqual(self.stops(), [])

    def test_env_is_parsed_as_data_and_unit_database_setting_takes_precedence(self):
        injected = self.root / 'must-not-exist'
        with (self.layout.app / '.env').open('a') as output:
            output.write('UNTRUSTED=$(touch ' + str(injected) + ')\nNODE_OPTIONS="--import=' + str(injected) + '"\n')
        settings = self.engine._settings()
        self.assertFalse(injected.exists())
        self.assertEqual(self.engine._database(settings), ('state', self.database))

    def test_fixture_node_outside_usr_bin_handles_env_and_nested_trusted_validation(self):
        original_node = self.fixture_node
        binaries = self.root / 'tool-cache/bin'
        binaries.mkdir(parents=True)
        invocation_log = self.root / 'node-invocations.jsonl'
        launcher = binaries / 'node'
        launcher.write_text('#!' + sys.executable + '\n'
                            'import json,os,sys\n'
                            'with open(' + repr(str(invocation_log)) + ',"a") as output:\n'
                            '    output.write(json.dumps(sys.argv[1:])+"\\n")\n'
                            'os.execv(' + repr(original_node) + ',[' + repr(original_node) + ',*sys.argv[1:]])\n')
        launcher.chmod(0o700)
        with patch.dict(os.environ, {'PATH': str(binaries) + os.pathsep + os.environ.get('PATH', '')}):
            self.configure_fixture_node()
        self.assertEqual(self.fixture_node, str(launcher))
        self.assertNotEqual(launcher.parent, Path('/usr/bin'))
        original_unit = self.layout.config['bot-unit'].read_bytes()
        saved = self.engine.backup()['backupId']
        self.engine.rollback(saved)
        invocations = [json.loads(line) for line in invocation_log.read_text().splitlines()]
        self.assertTrue(any(maintenance.INSPECT_ENV in args for args in invocations), 'Runtime env parsing must use the selected fixture Node')
        self.assertTrue(any(args[:1] == ['--check'] for args in invocations), 'Nested compiled-entry checks must use it too')
        manifest_checks = [args for args in invocations if args and args[0].endswith('release-manifest.mjs')]
        self.assertEqual(len(manifest_checks), 1)
        self.assertEqual(manifest_checks[0][0], str(self.trusted_tools / 'release-manifest.mjs'))
        self.assertEqual(self.layout.config['bot-unit'].read_bytes(), original_unit, 'Production unit paths must not be rewritten by the fixture interpreter seam')

    def test_backup_is_private_consistent_and_restarts_the_stopped_bot(self):
        result = self.engine.backup(); saved = self.layout.backups / result['backupId']
        self.assertEqual(read_database(saved / 'database/music.sqlite'), 'old')
        self.assertEqual(stat_mode(saved), 0o700); self.assertEqual(stat_mode(saved / 'snapshot.json'), 0o600)
        self.assertEqual((saved / 'state/spotify-direct.json').read_text(), 'old-private-grant')
        self.assertEqual(self.engine.backups()['backupIds'], [result['backupId']])
        self.assertTrue(self.active['audiobot.service'])
        self.assertEqual([args[1] for args, _ in self.calls if args[0] == '/usr/bin/systemctl' and args[1] not in {'is-active', 'show'}], ['stop', 'reset-failed', 'start'])

    def test_inactive_or_start_limited_backup_never_revives_the_service_or_resets_its_budget(self):
        for state in ('inactive', 'failed'):
            with self.subTest(state=state):
                self.active['audiobot.service'] = False
                self.states['audiobot.service'] = state
                self.calls.clear()
                result = self.engine.backup()
                self.assertFalse(result['serviceActive']['audiobot.service'])
                self.assertEqual(result['restartSucceeded'], {})
                self.assertTrue(all(args[1] in {'show', 'is-active'} for args, _ in self.calls if args[0] == '/usr/bin/systemctl'))

    def test_copy_failure_always_attempts_restart_and_does_not_publish_partial_backup(self):
        self.fail_copy = self.layout.state
        with self.assertRaises(maintenance.MaintenanceError):
            self.engine.backup()
        self.assertTrue(self.active['audiobot.service'])
        self.assertEqual(self.engine.backups()['backupIds'], [])
        self.assertEqual(read_database(self.database), 'old')

    def test_failed_stop_prevents_snapshot_and_later_viewer_stop_failure_restarts_bot(self):
        self.fail_stop = 'audiobot.service'
        with self.assertRaises(maintenance.MaintenanceError): self.engine.backup()
        self.assertFalse(any(args[:2] == ['/bin/cp', '-a'] for args, _ in self.calls))
        self.assertFalse(any(args[:2] == ['/usr/bin/systemctl', 'start'] for args, _ in self.calls))
        self.enable_viewer(); self.fail_stop = 'audiobot-viewer.service'; self.calls.clear()
        with self.assertRaises(maintenance.MaintenanceError): self.engine.backup()
        self.assertTrue(self.active['audiobot.service'])
        self.assertFalse(any(args[:2] == ['/bin/cp', '-a'] for args, _ in self.calls))

    def test_rollback_restores_matching_database_runtime_unit_and_preserves_rotated_grants(self):
        saved = self.engine.backup()['backupId']
        database(self.database, 'new'); (self.layout.app / 'dist/apps/bot/src/index.js').write_text('// new code\n')
        self.layout.config['bot-unit'].write_text(self.layout.config['bot-unit'].read_text() + '# changed unit\n')
        current_env = self.env_text.replace('fixture-bot-secret', 'rotated-bot-secret')
        (self.layout.app / '.env').write_text(current_env)
        (self.layout.state / 'spotify-direct.json').write_text('rotated-private-grant')
        (self.layout.state / 'youtube-embedded-cache/decoder').write_text('new-cache')
        result = self.engine.rollback(saved)
        self.assertEqual(read_database(self.database), 'old')
        self.assertEqual((self.layout.app / 'dist/apps/bot/src/index.js').read_text(), '// old fixture runtime\n')
        self.assertNotIn('changed unit', self.layout.config['bot-unit'].read_text())
        self.assertEqual((self.layout.app / '.env').read_text(), current_env)
        self.assertEqual((self.layout.state / 'spotify-direct.json').read_text(), 'rotated-private-grant')
        self.assertEqual((self.layout.state / 'youtube-embedded-cache/decoder').read_text(), 'new-cache')
        self.assertNotEqual(saved, result['recoveryBackupId'])

    def test_runtime_data_database_layout_and_stale_sidecar_cleanup(self):
        self.layout.config['bot-unit'].write_text('[Service]\nExecStart=/usr/bin/node dist/apps/bot/src/index.js\n')
        self.database = self.layout.app / 'data/music.sqlite'; database(self.database, 'runtime-old')
        saved = self.engine.backup()['backupId']; database(self.database, 'runtime-new')
        Path(str(self.database) + '-wal').write_bytes(b'stale-sidecar')
        self.engine.rollback(saved)
        self.assertEqual(read_database(self.database), 'runtime-old')
        self.assertFalse(Path(str(self.database) + '-wal').exists())

    def test_corrupt_linked_or_unrecognized_backup_is_refused_before_service_changes(self):
        saved = self.engine.backup()['backupId']; self.calls.clear()
        for bad in ('../outside', '/var/backups/audiobot/' + saved, 'bot-update-20260912T120000Z'):
            with self.assertRaises(maintenance.MaintenanceError): self.engine.rollback(bad)
        (self.layout.backups / saved / 'runtime/dist/apps/bot/src/index.js').write_text('// corrupt\n')
        with self.assertRaises(maintenance.MaintenanceError): self.engine.rollback(saved)
        self.assertEqual(self.stops(), [])
        self.layout.marker.chmod(0o644)
        with self.assertRaises(maintenance.MaintenanceError): self.engine.backup()

    def test_trojan_snapshot_manifest_checker_is_never_executed(self):
        sentinel = self.root / 'trojan-executed'
        (self.layout.app / 'scripts/release-manifest.mjs').write_text('import {writeFileSync} from "node:fs"; writeFileSync(' + json.dumps(str(sentinel)) + ',"executed");\n')
        saved = self.engine.backup()['backupId']
        self.engine.rollback(saved)
        self.assertFalse(sentinel.exists())

    def test_viewer_rollback_restores_both_runtimes_and_refuses_changed_shared_proxy(self):
        self.enable_viewer(); saved = self.engine.backup()['backupId']
        (self.layout.viewer / 'code').write_text('new-viewer')
        self.layout.config['viewer-env'].write_text('VIEWER_CLIENT_SECRET=rotated-viewer-secret\n')
        self.engine.rollback(saved)
        self.assertEqual((self.layout.viewer / 'code').read_text(), 'old-viewer')
        self.assertIn('rotated-viewer-secret', self.layout.config['viewer-env'].read_text())
        self.layout.config['caddy'].write_text('# unrelated new site\n'); self.calls.clear()
        with self.assertRaises(maintenance.MaintenanceError): self.engine.rollback(saved)
        self.assertEqual(self.stops(), [])

    def test_failed_restore_recovers_pre_rollback_state_and_double_failure_stays_stopped(self):
        saved = self.engine.backup()['backupId']; database(self.database, 'new')
        (self.layout.app / 'dist/apps/bot/src/index.js').write_text('// new code\n')
        self.fail_rsync_once = True
        with self.assertRaisesRegex(maintenance.MaintenanceError, 'pre-rollback snapshot was restored'):
            self.engine.rollback(saved)
        self.assertEqual(read_database(self.database), 'new')
        self.assertEqual((self.layout.app / 'dist/apps/bot/src/index.js').read_text(), '// new code\n')
        self.assertTrue(self.active['audiobot.service'])
        self.fail_rsync_always = True
        with self.assertRaisesRegex(maintenance.MaintenanceError, 'remain stopped'):
            self.engine.rollback(saved)
        self.assertFalse(self.active['audiobot.service'])

    def test_update_requires_clean_candidate_and_delegates_matching_viewer_transaction_without_timeout(self):
        release = self.root / 'candidate'; self.make_release(release)
        self.fail_validation = True
        with self.assertRaises(maintenance.MaintenanceError): self.engine.update(release)
        self.assertEqual(self.stops(), [])
        self.fail_validation = False
        result = self.engine.update(release)
        self.assertFalse(result['viewerIncluded'])
        delegates = [Path(args[1]).name for args, _ in self.calls if args[0] == '/bin/bash']
        self.assertEqual(delegates, ['deploy-bot-update.sh'])
        self.enable_viewer()
        for relative in ('dist/viewer/app.js', 'dist/apps/viewer-server/src/index.js'):
            path = release / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('// fixture viewer\n')
        result = self.engine.update(release)
        self.assertTrue(result['viewerIncluded'])
        self.assertEqual([Path(args[1]).name for args, _ in self.calls if args[0] == '/bin/bash'][-1], 'deploy-viewer.sh')
        self.assertFalse(list(self.layout.backups.glob('.self-host-update-*')))

    def test_custom_database_override_and_concurrent_maintenance_fail_closed(self):
        dropins = self.layout.config['bot-unit'].with_name('audiobot.service.d'); dropins.mkdir()
        with self.assertRaises(maintenance.MaintenanceError): self.engine.backup()
        self.assertEqual(self.stops(), [])
        dropins.rmdir()
        second = maintenance.Maintenance(self.layout, runner=self.run_command, owner_uid=os.geteuid(), sleep=lambda _: None)
        with self.engine._lock():
            with self.assertRaisesRegex(maintenance.MaintenanceError, 'Another self-host'):
                second.backup()
        self.assertEqual(self.stops(), [])

    def test_interrupted_transaction_waits_for_delegate_instead_of_killing_rollback(self):
        process = unittest.mock.Mock()
        process.communicate.side_effect = [KeyboardInterrupt(), ('private-output', 'private-error')]
        process.returncode = 1
        with patch.object(maintenance.subprocess, 'Popen', return_value=process):
            with self.assertRaises(maintenance.MaintenanceError): maintenance.command(['/bin/bash', 'fixture'], timeout=None)
        self.assertEqual(process.communicate.call_count, 2)
        process.kill.assert_not_called(); process.terminate.assert_not_called()


def stat_mode(path):
    return path.stat().st_mode & 0o777


if __name__ == '__main__':
    unittest.main()
