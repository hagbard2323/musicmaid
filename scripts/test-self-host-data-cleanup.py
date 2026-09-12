#!/usr/bin/env python3
"""Preview/apply retention regressions on disposable SQLite databases only."""
from contextlib import closing
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
from self_host import data_cleanup, maintenance
from self_host.cli import SetupCLI, SetupCLIError

spec = importlib.util.spec_from_file_location('maintenance_fixture_support', SCRIPTS / 'test-self-host-maintenance.py')
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)

GUILD = '123456789012345678'
OTHER = '123456789012345679'
BEFORE = '2026-01-01'
CUTOFF = int(datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
SCHEMA = re.search(r'`(.*?)`', (SCRIPTS.parent / 'apps/bot/src/storage/schema.ts').read_text(), re.S)[1]


def seed(database):
    with closing(sqlite3.connect(database)) as connection:
        connection.executescript(SCHEMA)
        connection.execute('PRAGMA user_version=3')
        rows = [('old-a', CUTOFF - 10000, 1, 1, 0, 1), ('old-b', CUTOFF - 9000, 0, 0, 1, 1),
                ('old-loop', CUTOFF - 8000, 1, 1, 0, 0), ('live', CUTOFF - 7000, 1, 0, 0, 1),
                ('queued', CUTOFF - 6000, 0, 0, 0, 1), ('history', CUTOFF - 5000, 1, 1, 0, 1),
                ('original-loop', CUTOFF - 4000, 1, 1, 0, 1), ('recent', CUTOFF + 1, 1, 1, 0, 1),
                ('boundary', CUTOFF, 1, 1, 0, 1)]
        for entry, added, played, finished, failed, counted in rows:
            connection.execute('INSERT INTO music_requests VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                               (GUILD, entry, 'private-member-id', added, 'private song title', 'artist',
                                'https://soundcloud.com/artist/song', played, finished, failed, counted))
        connection.execute('INSERT INTO music_requests VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                           (OTHER, 'old-a', 'other-member', CUTOFF - 10000, 'other song', 'artist',
                            'https://soundcloud.com/artist/song', 1, 1, 0, 1))
        session = {'guildId': GUILD, 'current': {'id': 'live', 'requestId': 'original-loop'},
                   'queue': [{'id': 'queued'}], 'history': [{'entry': {'id': 'history'}}], 'positionMs': 5000, 'revision': 1}
        connection.execute('INSERT INTO music_sessions VALUES (?,?,?)', (GUILD, json.dumps(session), 1))
        connection.execute('INSERT INTO music_playlists VALUES (?,?,?,?,?,?)',
                           (GUILD, 'saved-list', 'saved', 'private-member-id', 1, json.dumps({'entries': [{'id': 'old-a'}]})))
        connection.execute('INSERT INTO music_genres VALUES (?,?,?,?,?)', (GUILD, 'https://soundcloud.com/artist/song', '["folk"]', 'private-member-id', 1))
        connection.execute('INSERT INTO music_values VALUES (?,?)', ('current-panel', 'keep'))
        connection.commit()


def read(database, statement, args=()):
    with closing(sqlite3.connect(database)) as connection:
        return connection.execute(statement, args).fetchall()


def write(database, statement, args=()):
    with closing(sqlite3.connect(database)) as connection:
        connection.execute(statement, args)
        connection.commit()


class DataCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='musicmaid-data-cleanup-')
        self.root = Path(self.temporary.name)
        self.database = self.root / 'music.sqlite'
        seed(self.database)

    def tearDown(self):
        self.temporary.cleanup()

    def preview(self):
        return data_cleanup.preview(self.database, 'request-stats', GUILD, BEFORE)

    def test_preview_only_counts_eligible_rows_and_does_not_change_main_database(self):
        original = self.database.read_bytes()
        result = self.preview()
        self.assertEqual(result['counts'], {'eligibleRequestRows': 3, 'statsRequests': 2, 'statsPlayed': 1,
                         'statsFinished': 1, 'statsFailed': 1, 'protectedOldRequestRows': 4, 'retainedRequestRows': 6})
        self.assertEqual(self.database.read_bytes(), original)
        self.assertNotIn('private-member-id', json.dumps(result)); self.assertNotIn('private song title', json.dumps(result))

    def test_apply_preserves_active_queue_history_loop_originals_playlists_genres_and_other_guild(self):
        unchanged = {table: read(self.database, 'SELECT * FROM ' + table) for table in ('music_sessions', 'music_playlists', 'music_genres', 'music_values')}
        result = data_cleanup.apply(self.database, self.preview())
        self.assertEqual(result['deletedRequestRows'], 3)
        self.assertEqual({row[0] for row in read(self.database, 'SELECT entry_id FROM music_requests WHERE guild_id=?', (GUILD,))},
                         {'live', 'queued', 'history', 'original-loop', 'recent', 'boundary'})
        self.assertEqual(read(self.database, 'SELECT count(*) FROM music_requests WHERE guild_id=?', (OTHER,)), [(1,)])
        for table, rows in unchanged.items():
            self.assertEqual(read(self.database, 'SELECT * FROM ' + table), rows)

    def test_foreign_preserved_guild_can_only_be_cleaned_when_explicitly_selected(self):
        proof = data_cleanup.preview(self.database, 'request-stats', OTHER, BEFORE)
        self.assertEqual(proof['counts']['eligibleRequestRows'], 1)
        data_cleanup.apply(self.database, proof)
        self.assertEqual(read(self.database, 'SELECT count(*) FROM music_requests WHERE guild_id=?', (GUILD,)), [(9,)])

    def test_changed_target_or_new_protection_requires_a_new_preview(self):
        proof = self.preview()
        write(self.database, 'UPDATE music_requests SET title=? WHERE guild_id=? AND entry_id=?', ('different', GUILD, 'old-a'))
        with self.assertRaisesRegex(data_cleanup.CleanupError, 'stale-preview'):
            data_cleanup.apply(self.database, proof)
        proof = self.preview()
        session = json.loads(read(self.database, 'SELECT snapshot FROM music_sessions WHERE guild_id=?', (GUILD,))[0][0])
        session['queue'].append({'id': 'old-a'})
        write(self.database, 'UPDATE music_sessions SET snapshot=? WHERE guild_id=?', (json.dumps(session), GUILD))
        with self.assertRaisesRegex(data_cleanup.CleanupError, 'stale-preview'):
            data_cleanup.apply(self.database, proof)
        self.assertEqual(read(self.database, 'SELECT count(*) FROM music_requests'), [(10,)])

    def test_normal_position_checkpoint_does_not_invalidate_a_reviewed_selection(self):
        proof = self.preview()
        session = json.loads(read(self.database, 'SELECT snapshot FROM music_sessions WHERE guild_id=?', (GUILD,))[0][0])
        session['positionMs'] = 10000
        write(self.database, 'UPDATE music_sessions SET snapshot=?,updated_at=? WHERE guild_id=?', (json.dumps(session), 2, GUILD))
        self.assertEqual(data_cleanup.apply(self.database, proof)['deletedRequestRows'], 3)

    def test_wal_preview_reads_committed_rows_without_changing_main_or_wal_data(self):
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('UPDATE music_requests SET title=? WHERE entry_id=? AND guild_id=?', ('committed in WAL', 'old-a', GUILD))
            writer.commit()
            main = self.database.read_bytes(); wal = Path(str(self.database) + '-wal').read_bytes()
            result = self.preview()
            self.assertEqual(result['counts']['eligibleRequestRows'], 3)
            self.assertEqual(self.database.read_bytes(), main)
            self.assertEqual(Path(str(self.database) + '-wal').read_bytes(), wal)

    def test_replaced_database_bad_scope_dates_and_invalid_session_fail_closed(self):
        proof = self.preview()
        replacement = self.root / 'replacement.sqlite'; shutil.copy2(self.database, replacement); os.replace(replacement, self.database)
        with self.assertRaisesRegex(data_cleanup.CleanupError, 'stale-preview'):
            data_cleanup.apply(self.database, proof)
        for scope, guild, cutoff in [('playlists', GUILD, BEFORE), ('request-stats', 'g', BEFORE),
                                     ('request-stats', GUILD, '2026-02-30'), ('request-stats', GUILD, '2999-01-01')]:
            with self.assertRaises(data_cleanup.CleanupError):
                data_cleanup.preview(self.database, scope, guild, cutoff)
        write(self.database, 'UPDATE music_sessions SET snapshot=? WHERE guild_id=?', (json.dumps({'guildId': GUILD, 'queue': 'invalid', 'history': []}), GUILD))
        with self.assertRaisesRegex(data_cleanup.CleanupError, 'invalid-session'):
            self.preview()
        self.assertEqual(read(self.database, 'SELECT count(*) FROM music_requests'), [(10,)])

    def test_unsupported_schema_is_refused(self):
        write(self.database, 'PRAGMA user_version=4')
        with self.assertRaisesRegex(data_cleanup.CleanupError, 'unsupported-schema'):
            self.preview()

    def test_failed_commit_rolls_back_actual_deletes(self):
        observed = []
        class FailCommit(sqlite3.Connection):
            def commit(self):
                observed.append(self.execute('SELECT count(*) FROM music_requests').fetchone()[0])
                raise sqlite3.OperationalError('fixture commit refused')
        connector = lambda path, write=False: sqlite3.connect(path, isolation_level=None, factory=FailCommit)
        with self.assertRaisesRegex(data_cleanup.CleanupError, 'write-failed'):
            data_cleanup.apply(self.database, self.preview(), connector=connector)
        self.assertEqual(observed, [7], 'The failure happens after DELETE but before commit')
        self.assertEqual(read(self.database, 'SELECT count(*) FROM music_requests'), [(10,)])

    def test_database_trigger_cannot_widen_cleanup_to_saved_playlists(self):
        write(self.database, 'CREATE TRIGGER unexpected AFTER DELETE ON music_requests BEGIN DELETE FROM music_playlists; END')
        with self.assertRaisesRegex(data_cleanup.CleanupError, 'write-failed'):
            data_cleanup.apply(self.database, self.preview())
        self.assertEqual(read(self.database, 'SELECT count(*) FROM music_playlists'), [(1,)])
        self.assertEqual(read(self.database, 'SELECT count(*) FROM music_requests'), [(10,)])


class CleanupMaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = support.MaintenanceTests('test_backup_is_private_consistent_and_restarts_the_stopped_bot')
        self.fixture.setUp()
        self.engine = maintenance.Maintenance(self.fixture.layout, runner=self.fixture.run_command,
                                              owner_uid=os.geteuid(), sleep=lambda _: None)
        self.database = self.fixture.database
        seed(self.database)
        self.operations = []
        self.worker = self.engine._cleanup_worker
        self.engine._cleanup_worker = self.execute_worker

    def tearDown(self):
        self.fixture.tearDown()

    def execute_worker(self, payload):
        self.operations.append(payload['operation'])
        try:
            if payload['operation'] == 'apply':
                return data_cleanup.apply(Path(payload['database']), payload['expected'])
            selected = payload['selection']
            return data_cleanup.preview(Path(payload['database']), selected['scope'], selected['guildId'], selected['before'], expected=payload.get('expected'))
        except data_cleanup.CleanupError as error:
            raise maintenance.MaintenanceError(error.code) from None

    def preview(self):
        return self.engine.cleanup_preview('request-stats', GUILD, BEFORE)

    def test_preview_is_private_and_apply_creates_restorable_backup_before_transaction(self):
        result = self.preview()
        self.assertEqual(self.fixture.stops(), [])
        self.assertEqual(self.engine.backups()['backupIds'], [])
        record = self.fixture.layout.backups / 'cleanup-previews' / (result['previewId'] + '.json')
        self.assertEqual(record.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('private song title', json.dumps(result))
        original_worker = self.engine._cleanup_worker
        def verify_backup_first(payload):
            if payload['operation'] == 'apply':
                self.assertFalse(self.fixture.active['audiobot.service'])
                self.assertEqual(len(self.engine.backups()['backupIds']), 1)
            return original_worker(payload)
        self.engine._cleanup_worker = verify_backup_first
        applied = self.engine.cleanup_apply(result['previewId'])
        self.assertEqual(applied['deletedRequestRows'], 3)
        self.assertTrue(self.fixture.active['audiobot.service'])
        self.engine.rollback(applied['backupId'])
        self.assertEqual(read(self.database, 'SELECT count(*) FROM music_requests'), [(10,)])

    def test_changed_or_expired_preview_and_invalid_identifier_never_stop_services(self):
        result = self.preview()
        write(self.database, 'UPDATE music_requests SET title=? WHERE guild_id=? AND entry_id=?', ('changed', GUILD, 'old-a'))
        for identifier in (result['previewId'], '../outside'):
            with self.assertRaises(maintenance.MaintenanceError): self.engine.cleanup_apply(identifier)
        fresh = self.preview()
        path = self.fixture.layout.backups / 'cleanup-previews' / (fresh['previewId'] + '.json')
        record = json.loads(path.read_text()); record['expiresAt'] = int(time.time()) - 1
        self.engine._json(path, record)
        with self.assertRaisesRegex(maintenance.MaintenanceError, 'expired'):
            self.engine.cleanup_apply(fresh['previewId'])
        self.assertEqual(self.fixture.stops(), [])

    def test_backup_failure_prevents_deletion_and_restarts_the_original_bot(self):
        result = self.preview(); self.fixture.fail_copy = self.fixture.layout.state
        with self.assertRaises(maintenance.MaintenanceError): self.engine.cleanup_apply(result['previewId'])
        self.assertNotIn('apply', self.operations)
        self.assertEqual(read(self.database, 'SELECT count(*) FROM music_requests'), [(10,)])
        self.assertTrue(self.fixture.active['audiobot.service'])

    def test_second_validation_after_stop_refuses_a_newly_protected_request(self):
        result = self.preview(); original_worker = self.engine._cleanup_worker
        def change_during_stop(payload):
            if payload['operation'] == 'verify' and not self.fixture.active['audiobot.service']:
                session = json.loads(read(self.database, 'SELECT snapshot FROM music_sessions WHERE guild_id=?', (GUILD,))[0][0])
                session['queue'].append({'id': 'old-a'})
                write(self.database, 'UPDATE music_sessions SET snapshot=? WHERE guild_id=?', (json.dumps(session), GUILD))
            return original_worker(payload)
        self.engine._cleanup_worker = change_during_stop
        with self.assertRaisesRegex(maintenance.MaintenanceError, 'stale-preview'):
            self.engine.cleanup_apply(result['previewId'])
        self.assertNotIn('apply', self.operations)
        self.assertEqual(self.engine.backups()['backupIds'], [])
        self.assertTrue(self.fixture.active['audiobot.service'])

    def test_empty_selection_does_not_stop_or_back_up_and_receipt_cannot_be_reused(self):
        result = self.engine.cleanup_preview('request-stats', GUILD, '1970-01-01')
        applied = self.engine.cleanup_apply(result['previewId'])
        self.assertEqual(applied['deletedRequestRows'], 0)
        self.assertEqual(self.fixture.stops(), []); self.assertEqual(self.engine.backups()['backupIds'], [])
        with self.assertRaisesRegex(maintenance.MaintenanceError, 'already applied'):
            self.engine.cleanup_apply(result['previewId'])

    def test_worker_privilege_drop_uses_stdin_data_and_sanitized_errors(self):
        payload = {'operation': 'preview', 'database': str(self.database), 'selection': {'scope': 'request-stats', 'guildId': GUILD, 'before': BEFORE}}
        response = {'ok': True, 'result': data_cleanup.preview(self.database, 'request-stats', GUILD, BEFORE)}
        process = unittest.mock.Mock(returncode=0)
        process.communicate.return_value = (json.dumps(response), 'private-error')
        account = SimpleNamespace(pw_uid=1000, pw_gid=1000)
        with patch.object(maintenance.pwd, 'getpwnam', return_value=account), patch.object(maintenance.subprocess, 'Popen', return_value=process) as run:
            self.worker(payload)
        arguments = run.call_args.args[0]
        self.assertEqual(arguments[:4], ['/usr/bin/python3', '-I', '-B', '-c'])
        self.assertEqual(json.loads(process.communicate.call_args.kwargs['input']), payload)
        self.assertEqual(run.call_args.kwargs['env'], maintenance.SAFE_ENV)
        self.assertEqual((run.call_args.kwargs['user'], run.call_args.kwargs['group'], run.call_args.kwargs['extra_groups'], run.call_args.kwargs['umask']), (1000, 1000, [], 0o077))
        self.assertNotIn('fixture-bot-secret', repr(run.call_args))
        process.returncode = 1; process.communicate.return_value = ('{"ok":false,"code":"private-error"}', 'private-error')
        with patch.object(maintenance.pwd, 'getpwnam', return_value=account), patch.object(maintenance.subprocess, 'Popen', return_value=process):
            with self.assertRaises(maintenance.MaintenanceError) as error:
                self.worker(payload)
        self.assertNotIn('private-error', str(error.exception))

    def test_timed_out_sqlite_writer_exits_and_rolls_back_before_bot_restart(self):
        result = self.preview()
        pidfile = self.fixture.root / 'slow-worker.pid'
        committed = self.fixture.root / 'unexpected-commit'
        slow_code = ('import json,os,sqlite3,sys,time\nfrom pathlib import Path\n'
                     'payload=json.load(sys.stdin)\nc=sqlite3.connect(payload["database"],isolation_level=None)\n'
                     'c.execute("BEGIN IMMEDIATE")\nc.execute("DELETE FROM music_requests WHERE entry_id=\'old-a\'")\n'
                     'Path(' + repr(str(pidfile)) + ').write_text(str(os.getpid()))\n'
                     'time.sleep(30)\nc.commit()\nPath(' + repr(str(committed)) + ').write_text("committed")\n')
        real_popen = subprocess.Popen
        children = []
        class BoundedFixtureChild:
            def __init__(self, child): self.child = child
            def __getattr__(self, name): return getattr(self.child, name)
            def communicate(self, input=None, timeout=None):
                return self.child.communicate(input=input, timeout=1 if timeout is not None else None)
        def popen(arguments, **kwargs):
            if arguments[:4] == ['/usr/bin/python3', '-I', '-B', '-c'] and 'user' in kwargs:
                self.assertEqual(kwargs.pop('extra_groups'), [])
                kwargs.pop('user'); kwargs.pop('group')
                child = real_popen([sys.executable, '-I', '-B', '-c', slow_code], **kwargs)
                children.append(child)
                return BoundedFixtureChild(child)
            return real_popen(arguments, **kwargs)
        fake_worker = self.engine._cleanup_worker
        self.engine._cleanup_worker = lambda payload: self.worker(payload) if payload['operation'] == 'apply' else fake_worker(payload)
        original_runner = self.engine.run
        restarted_after_exit = []
        def runner(arguments, timeout=30):
            if arguments[:2] == ['/usr/bin/systemctl', 'start']:
                self.assertEqual(len(children), 1)
                self.assertIsNotNone(children[0].poll(), 'SQLite worker must exit before service restart')
                with closing(sqlite3.connect(self.database, timeout=0.2)) as connection:
                    connection.execute('BEGIN IMMEDIATE')
                    self.assertEqual(connection.execute('SELECT count(*) FROM music_requests').fetchone()[0], 10)
                    connection.rollback()
                restarted_after_exit.append(True)
            return original_runner(arguments, timeout=timeout)
        self.engine.run = runner
        with patch.object(maintenance.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1000, pw_gid=1000)), patch.object(maintenance.subprocess, 'Popen', side_effect=popen):
            with self.assertRaisesRegex(maintenance.MaintenanceError, 'no background writer'):
                self.engine.cleanup_apply(result['previewId'])
        self.assertTrue(pidfile.exists(), 'The fixture reached its uncommitted DELETE')
        self.assertEqual(restarted_after_exit, [True])
        self.assertFalse(committed.exists())
        self.assertEqual(read(self.database, 'SELECT count(*) FROM music_requests'), [(10,)])

    def test_cleanup_public_cli_requires_scope_and_review_identifier_without_building(self):
        calls = []
        runner = lambda arguments, **kwargs: (calls.append(arguments) or subprocess.CompletedProcess(arguments, 0))
        cli = SetupCLI(self.fixture.root, runner=runner, output=lambda _: None)
        cli.cleanup([]); self.assertEqual(calls, [])
        cli.cleanup(['preview', 'request-stats', GUILD, BEFORE])
        self.assertEqual(calls[-1][-5:], ['internal-maintenance', 'cleanup-preview', 'request-stats', GUILD, BEFORE])
        identifier = 'cleanup-' + 'a' * 32
        cli.cleanup(['apply', identifier])
        self.assertEqual(calls[-1][-3:], ['internal-maintenance', 'cleanup-apply', identifier])
        before = len(calls)
        for arguments in (['preview', 'playlists', GUILD, BEFORE], ['apply', '/tmp/preview'], ['apply'], ['preview', 'request-stats', 'all', BEFORE]):
            with self.assertRaises(SetupCLIError): cli.cleanup(arguments)
        self.assertEqual(len(calls), before)
        self.assertTrue(all(command[0] == 'sudo' for command in calls))


if __name__ == '__main__':
    unittest.main()
