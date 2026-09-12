#!/usr/bin/env python3
"""Snapshot/restore the bot unit alongside its stopped runtime and database."""
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile

UNIT = Path('/etc/systemd/system/audiobot.service')


def regular(path):
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError('The bot unit and snapshot files must be regular files, not links.')


def snapshot(backup, unit=UNIT):
    saved, state = backup / 'audiobot.service', backup / 'bot-unit-state'
    if saved.exists() or saved.is_symlink() or state.exists() or state.is_symlink():
        raise ValueError('The bot unit snapshot already exists; refusing to replace it.')
    present = unit.exists() or unit.is_symlink()
    if present:
        regular(unit)
        shutil.copy2(unit, saved)
        info = unit.stat()
        os.chown(saved, info.st_uid, info.st_gid)
    with state.open('x') as output:
        os.fchmod(output.fileno(), 0o600)
        output.write('present\n' if present else 'absent\n')
        output.flush()
        os.fsync(output.fileno())


def validate(backup):
    state, saved = backup / 'bot-unit-state', backup / 'audiobot.service'
    regular(state)
    if state.stat().st_size > 16:
        raise ValueError('The bot unit snapshot has an invalid state marker.')
    marker = state.read_text()
    if marker == 'present\n':
        regular(saved)
        return saved
    if marker == 'absent\n' and not saved.exists() and not saved.is_symlink():
        return None
    raise ValueError('The bot unit snapshot is incomplete or inconsistent.')


def restore(backup, unit=UNIT):
    saved = validate(backup)
    if unit.exists() or unit.is_symlink():
        regular(unit)
    if saved is None:
        unit.unlink(missing_ok=True)
        return
    info = saved.stat()
    fd, temporary = tempfile.mkstemp(dir=unit.parent, prefix='.audiobot-unit-rollback-')
    try:
        with os.fdopen(fd, 'wb') as output, saved.open('rb') as input_file:
            shutil.copyfileobj(input_file, output)
            os.fchmod(output.fileno(), stat.S_IMODE(info.st_mode))
            os.fchown(output.fileno(), info.st_uid, info.st_gid)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, unit)
    finally:
        Path(temporary).unlink(missing_ok=True)


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('snapshot', 'validate', 'restore'):
        raise SystemExit('Usage: bot-service-unit.py <snapshot|validate|restore> <stopped-backup-directory>')
    try:
        {'snapshot': snapshot, 'validate': validate, 'restore': restore}[sys.argv[1]](Path(sys.argv[2]))
    except (OSError, ValueError) as error:
        raise SystemExit('Bot unit transaction stopped: ' + str(error)) from None
