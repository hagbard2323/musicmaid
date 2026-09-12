"""Scoped SQLite request/statistics cleanup. Invoked as botsvc by maintenance.

No automatic pruning, session edits, playlist deletion or user erasure. Preview
uses a read-only main database connection; its protection table exists in memory.
"""
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import stat
import sys


class CleanupError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def selection(scope, guild_id, before):
    if scope != 'request-stats':
        raise CleanupError('invalid-scope')
    if not isinstance(guild_id, str) or not re.fullmatch(r'[0-9]{17,20}', guild_id):
        raise CleanupError('invalid-guild')
    try:
        if not isinstance(before, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', before):
            raise ValueError()
        day = date.fromisoformat(before)
        if not date(1970, 1, 1) <= day <= datetime.now(timezone.utc).date():
            raise ValueError()
    except ValueError:
        raise CleanupError('invalid-cutoff') from None
    return {'scope': scope, 'guildId': guild_id, 'before': before,
            'cutoffMs': int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp() * 1000)}


def identity(database):
    try:
        info = database.lstat()
        if not stat.S_ISREG(info.st_mode):
            raise ValueError()
    except (OSError, ValueError):
        raise CleanupError('invalid-database') from None
    return {'device': info.st_dev, 'inode': info.st_ino}


def connect(database, write=False):
    return sqlite3.connect(database.absolute().as_uri() + ('?mode=rw' if write else '?mode=ro'),
                           uri=True, timeout=5, isolation_level=None)


def protected_entries(connection, guild_id):
    protected = set()

    def entry(value):
        if not isinstance(value, dict) or not isinstance(value.get('id'), str) or not 0 < len(value['id']) <= 256:
            raise CleanupError('invalid-session')
        protected.add(value['id'])
        if value.get('requestId') is not None:
            if not isinstance(value['requestId'], str) or not 0 < len(value['requestId']) <= 256:
                raise CleanupError('invalid-session')
            protected.add(value['requestId'])

    for (raw,) in connection.execute('SELECT snapshot FROM music_sessions WHERE guild_id=?', (guild_id,)):
        try:
            if not isinstance(raw, str) or len(raw) > 8 * 1024 * 1024:
                raise ValueError()
            session = json.loads(raw)
            if (not isinstance(session, dict) or session.get('guildId') != guild_id
                    or not isinstance(session.get('queue'), list) or not isinstance(session.get('history'), list)
                    or len(session['queue']) > 500 or len(session['history']) > 100):
                raise ValueError()
            if session.get('current') is not None:
                entry(session['current'])
            for queued in session['queue']:
                entry(queued)
            for history in session['history']:
                if not isinstance(history, dict):
                    raise ValueError()
                entry(history.get('entry'))
        except (TypeError, ValueError):
            raise CleanupError('invalid-session') from None
    return protected


ELIGIBLE = '''guild_id=? AND added_at<? AND NOT EXISTS
             (SELECT 1 FROM temp.cleanup_protected p WHERE p.entry_id=music_requests.entry_id)'''


def describe(connection, selected, file_identity):
    version = connection.execute('PRAGMA user_version').fetchone()[0]
    if version != 3:
        raise CleanupError('unsupported-schema')
    protected = protected_entries(connection, selected['guildId'])
    connection.execute('CREATE TEMP TABLE cleanup_protected(entry_id TEXT PRIMARY KEY)')
    connection.executemany('INSERT INTO temp.cleanup_protected VALUES (?)', [(item,) for item in protected])
    parameters = (selected['guildId'], selected['cutoffMs'])
    total = connection.execute('SELECT count(*) FROM music_requests WHERE guild_id=?', parameters[:1]).fetchone()[0]
    old = connection.execute('SELECT count(*) FROM music_requests WHERE guild_id=? AND added_at<?', parameters).fetchone()[0]
    counts = {'eligibleRequestRows': 0, 'statsRequests': 0, 'statsPlayed': 0, 'statsFinished': 0, 'statsFailed': 0}
    digest = hashlib.sha256()
    digest.update((json.dumps({'selection': selected, 'schemaVersion': version}, sort_keys=True) + '\n').encode())
    rows = connection.execute('SELECT entry_id,requester,added_at,title,author,uri,played,finished,failed,counted '
                              'FROM music_requests WHERE ' + ELIGIBLE + ' ORDER BY entry_id', parameters)
    for row in rows:
        digest.update((json.dumps(row, ensure_ascii=True, separators=(',', ':')) + '\n').encode())
        counts['eligibleRequestRows'] += 1
        if row[9]:
            counts['statsRequests'] += row[9]
            counts['statsPlayed'] += row[6]
            counts['statsFinished'] += row[7]
            counts['statsFailed'] += row[8]
    counts.update({'protectedOldRequestRows': old - counts['eligibleRequestRows'],
                   'retainedRequestRows': total - counts['eligibleRequestRows']})
    return {'version': 1, 'selection': selected, 'schemaVersion': version,
            'databaseIdentity': file_identity, 'targetHash': digest.hexdigest(), 'counts': counts}


def _compare(actual, expected):
    if not isinstance(expected, dict) or any(actual.get(key) != expected.get(key)
            for key in ('version', 'selection', 'schemaVersion', 'databaseIdentity', 'targetHash', 'counts')):
        raise CleanupError('stale-preview')


def preview(database, scope, guild_id, before, *, expected=None, connector=connect):
    database = Path(database)
    selected = selection(scope, guild_id, before)
    file_identity = identity(database)
    connection = connector(database)
    try:
        connection.execute('PRAGMA temp_store=MEMORY')
        connection.execute('BEGIN')
        proof = describe(connection, selected, file_identity)
        if identity(database) != file_identity:
            raise CleanupError('stale-preview')
        if expected is not None:
            _compare(proof, expected)
        return proof
    except CleanupError:
        raise
    except (sqlite3.Error, TypeError, ValueError):
        raise CleanupError('invalid-database') from None
    finally:
        if connection.in_transaction:
            connection.rollback()
        connection.close()


def authorizer(action, table, _column, database, trigger):
    # Database triggers must not widen an operator's selected cleanup scope.
    if action in (sqlite3.SQLITE_DELETE, sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE):
        return sqlite3.SQLITE_OK if (action == sqlite3.SQLITE_DELETE and table == 'music_requests'
                                    and database == 'main' and trigger is None) else sqlite3.SQLITE_DENY
    if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH, sqlite3.SQLITE_ALTER_TABLE,
                  sqlite3.SQLITE_DROP_TABLE, sqlite3.SQLITE_DROP_INDEX, sqlite3.SQLITE_DROP_TRIGGER,
                  sqlite3.SQLITE_CREATE_TABLE, sqlite3.SQLITE_CREATE_INDEX, sqlite3.SQLITE_CREATE_TRIGGER,
                  sqlite3.SQLITE_PRAGMA):
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_FUNCTION and _column == 'load_extension':
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def apply(database, expected, *, connector=connect):
    database = Path(database)
    if not isinstance(expected, dict) or not isinstance(expected.get('selection'), dict):
        raise CleanupError('stale-preview')
    selected = expected['selection']
    selected = selection(selected.get('scope'), selected.get('guildId'), selected.get('before'))
    file_identity = identity(database)
    connection = connector(database, write=True)
    try:
        connection.execute('PRAGMA temp_store=MEMORY')
        connection.execute('BEGIN IMMEDIATE')
        actual = describe(connection, selected, file_identity)
        _compare(actual, expected)
        if identity(database) != file_identity:
            raise CleanupError('stale-preview')
        connection.set_authorizer(authorizer)
        cursor = connection.execute('DELETE FROM music_requests WHERE ' + ELIGIBLE,
                                    (selected['guildId'], selected['cutoffMs']))
        if cursor.rowcount != actual['counts']['eligibleRequestRows']:
            raise CleanupError('stale-preview')
        connection.commit()
        return {'deletedRequestRows': cursor.rowcount, 'counts': actual['counts']}
    except CleanupError:
        if connection.in_transaction:
            connection.rollback()
        raise
    except (sqlite3.Error, TypeError, ValueError):
        if connection.in_transaction:
            connection.rollback()
        raise CleanupError('write-failed') from None
    finally:
        connection.close()


def worker_main():
    try:
        raw = sys.stdin.read(131073)
        if len(raw) > 131072:
            raise CleanupError('invalid-input')
        payload = json.loads(raw)
        database = Path(payload['database'])
        if payload.get('operation') in ('preview', 'verify'):
            selected = payload['selection']
            result = preview(database, selected.get('scope'), selected.get('guildId'), selected.get('before'), expected=payload.get('expected'))
        elif payload.get('operation') == 'apply':
            result = apply(database, payload['expected'])
        else:
            raise CleanupError('invalid-input')
        print(json.dumps({'ok': True, 'result': result}, sort_keys=True))
        return 0
    except CleanupError as error:
        print(json.dumps({'ok': False, 'code': error.code}))
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error):
        print(json.dumps({'ok': False, 'code': 'invalid-database'}))
    return 1


if __name__ == '__main__':
    raise SystemExit(worker_main())
