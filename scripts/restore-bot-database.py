#!/usr/bin/env python3
"""Restore a stopped bot's database without rolling back refreshed account grants."""
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile


def restore(snapshot: Path, database=Path('/var/lib/audiobot/music.sqlite')):
    source = snapshot / 'music.sqlite'
    suffixes = ('', '-wal', '-shm')
    if not source.exists() and not source.is_symlink():
        # A first installation may have no database yet. Never delete a newly
        # created database or guess which surviving sidecars belong to it.
        if any(Path(str(database) + suffix).exists() or Path(str(source) + suffix).exists()
               for suffix in suffixes):
            raise ValueError('No pre-update music database was saved. Existing database files were preserved; keep the bot stopped for recovery.')
        return

    saved = {}
    for suffix in suffixes:
        path = Path(str(source) + suffix)
        if path.exists() or path.is_symlink():
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('Music database snapshot must contain regular files only.')
            saved[suffix] = (path, info)

    if not database.parent.exists():
        database.parent.mkdir(mode=0o700)
        info = snapshot.stat()
        os.chown(database.parent, info.st_uid, info.st_gid)
    staged = {}
    try:
        # Prepare complete replacement files before touching the live database.
        for suffix, (path, info) in saved.items():
            fd, temporary = tempfile.mkstemp(dir=database.parent, prefix='.music-rollback-')
            staged[suffix] = Path(temporary)
            with os.fdopen(fd, 'wb') as output, path.open('rb') as input_file:
                shutil.copyfileobj(input_file, output)
                os.fchmod(output.fileno(), stat.S_IMODE(info.st_mode))
                os.fchown(output.fileno(), info.st_uid, info.st_gid)
                output.flush()
                os.fsync(output.fileno())
        # Old sidecars must not be applied to the restored database. Both callers
        # stop MusicMaid first; restore only sidecars from this same snapshot.
        for suffix in ('-wal', '-shm'):
            Path(str(database) + suffix).unlink(missing_ok=True)
        for suffix in suffixes:
            if suffix in staged:
                os.replace(staged[suffix], Path(str(database) + suffix))
    finally:
        for path in staged.values():
            path.unlink(missing_ok=True)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: restore-bot-database.py <stopped-state-snapshot>')
    try:
        restore(Path(sys.argv[1]))
    except (OSError, ValueError) as error:
        raise SystemExit('Music database rollback stopped: ' + str(error)) from None
