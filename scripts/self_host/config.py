"""Private, atomic setup settings. No credential is accepted through CLI arguments."""
from contextlib import nullcontext
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile
import termios


class SettingsError(ValueError):
    """An operator-facing configuration error containing no submitted values."""


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def settings_path(release):
    return Path(release) / '.setup' / 'settings.json'


class TerminalPrompt:
    """Use separate terminal handles and disable echo without a stdin fallback."""
    def __enter__(self):
        try:
            self.reader = open('/dev/tty', 'r', encoding='utf-8')
            self.writer = open('/dev/tty', 'w', encoding='utf-8')
            if not os.isatty(self.reader.fileno()):
                raise OSError()
        except OSError:
            for stream in (getattr(self, 'reader', None), getattr(self, 'writer', None)):
                if stream:
                    stream.close()
            raise SettingsError('Interactive setup needs a terminal. Run the command directly in your SSH terminal; do not pipe credentials into it.') from None
        return self

    def __exit__(self, *_):
        self.reader.close()
        self.writer.close()

    def write(self, message):
        self.writer.write(message + '\n')
        self.writer.flush()

    def read(self, label, secret=False):
        previous = None
        if secret:
            try:
                previous = termios.tcgetattr(self.reader.fileno())
                hidden = previous[:]
                hidden[3] &= ~termios.ECHO
                termios.tcsetattr(self.reader.fileno(), termios.TCSANOW, hidden)
            except termios.error:
                raise SettingsError('The terminal could not hide input. No secret was read; use a regular SSH terminal.') from None
        try:
            self.writer.write(label)
            self.writer.flush()
            line = self.reader.readline()
            if not line:
                raise SettingsError('Setup cancelled before settings were saved.')
            return line.rstrip('\r\n')
        finally:
            if previous is not None:
                termios.tcsetattr(self.reader.fileno(), termios.TCSADRAIN, previous)
                self.writer.write('\n')
                self.writer.flush()


def valid_id(value):
    return isinstance(value, str) and re.fullmatch(r'\d{5,22}', value) is not None


def valid_token(value):
    return (isinstance(value, str) and 20 <= len(value) <= 512
            and value.isascii() and all(32 < ord(char) < 127 for char in value))


def validate_settings(value):
    if not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1:
        raise SettingsError('Setup settings have an unsupported format version.')
    discord, lavalink = value.get('discord'), value.get('lavalink')
    if not isinstance(discord, dict) or not valid_token(discord.get('token')):
        raise SettingsError('A bot token is required. Use the Bot page token, not the application client secret.')
    for field in ('clientId', 'guildId', 'musicTextChannelId'):
        if not valid_id(discord.get(field)):
            raise SettingsError('Application, server and music text-channel IDs must contain only digits.')
    roles = discord.get('adminRoleIds', [])
    if not isinstance(roles, list) or len(roles) > 25 or any(not valid_id(role) for role in roles) or len(set(roles)) != len(roles):
        raise SettingsError('Moderator role IDs must be a list of distinct numeric IDs, with at most 25 roles.')
    if not isinstance(lavalink, dict) or not isinstance(lavalink.get('password'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,200}', lavalink['password']):
        raise SettingsError('The generated audio-service password is missing or invalid. Restore the private setup settings rather than substituting a shared default.')
    if not isinstance(value.get('sources', {}), dict) or not isinstance(value.get('steps', {}), dict):
        raise SettingsError('Optional setup settings have an invalid format.')
    viewer = value.get('viewer', {'enabled': False})
    if not isinstance(viewer, dict) or type(viewer.get('enabled')) is not bool:
        raise SettingsError('Viewer setup settings have an invalid format.')
    return deepcopy(value)


def load_settings(path, expected_uid=None):
    path = Path(path)
    expected_uid = os.geteuid() if expected_uid is None else expected_uid
    try:
        parent = path.parent.lstat()
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != expected_uid or parent.st_mode & 0o077:
            raise SettingsError('The setup settings directory must be private and owned by your normal account.')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'r', encoding='utf-8') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != expected_uid or info.st_mode & 0o077 or not 0 < info.st_size <= 65536:
                raise SettingsError('The setup settings must be a private regular file owned by your normal account.')
            value = json.load(stream)
        return validate_settings(value)
    except SettingsError:
        raise
    except (OSError, ValueError, UnicodeError):
        raise SettingsError('The private setup settings could not be read. Restore a valid settings file or run configure in a new checkout.') from None


def save_settings(path, value):
    value = validate_settings(value)
    path = Path(path)
    try:
        path.parent.mkdir(mode=0o700, parents=False, exist_ok=True)
        info = path.parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise SettingsError('The setup settings directory must be private and owned by your normal account.')
        if path.exists() or path.is_symlink():
            load_settings(path)
        data = json.dumps(value, indent=2) + '\n'
        if len(data.encode('utf-8')) > 65536:
            raise SettingsError('The setup settings exceed the supported size.')
        fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.settings-')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as output:
                os.fchmod(output.fileno(), 0o600)
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            Path(temporary).unlink(missing_ok=True)
    except SettingsError:
        raise
    except OSError:
        raise SettingsError('Setup could not confirm its private settings were saved. Check directory permissions and storage before retrying.') from None


def collect_settings(previous, prompt):
    settings = deepcopy(previous) if previous else {
        'version': 1, 'discord': {}, 'lavalink': {'password': secrets.token_urlsafe(32)},
        'sources': {}, 'viewer': {'enabled': False}, 'steps': {},
    }
    discord = settings['discord']
    prompt.write('Enter credentials only here in this terminal. Stored values are never displayed; Enter retains a configured value.')
    for field, label, predicate, secret in (
        ('token', 'Discord BOT TOKEN (hidden; not the client secret)', valid_token, True),
        ('clientId', 'Discord application ID', valid_id, False),
        ('guildId', 'Discord server ID (one server per host)', valid_id, False),
        ('musicTextChannelId', 'Music text-channel ID', valid_id, False),
    ):
        while True:
            suffix = ' [configured; Enter keeps]' if discord.get(field) else ''
            answer = prompt.read(label + suffix + ': ', secret=secret).strip()
            candidate = answer or discord.get(field)
            if predicate(candidate):
                discord[field] = candidate
                break
            prompt.write('Paste the bot token only, with no spaces.' if secret else 'Enter the numeric ID copied from Discord Developer Mode.')
    while True:
        answer = prompt.read('Moderator role IDs, comma separated (optional; Enter keeps; - clears): ').strip()
        roles = [] if answer == '-' else [part for part in re.split(r'[\s,]+', answer) if part] if answer else discord.get('adminRoleIds', [])
        roles = list(dict.fromkeys(roles))
        if len(roles) <= 25 and all(valid_id(role) for role in roles):
            discord['adminRoleIds'] = roles
            break
        prompt.write('Use at most 25 numeric role IDs separated by commas, or - to clear the list.')
    settings.setdefault('steps', {})['configuredAt'] = timestamp()
    return validate_settings(settings)


def configure(release, prompt=None):
    path = settings_path(release)
    existing = load_settings(path) if path.exists() or path.is_symlink() else None
    with nullcontext(prompt) if prompt is not None else TerminalPrompt() as terminal:
        settings = collect_settings(existing, terminal)
    save_settings(path, settings)
    return path


def record_step(release, name):
    if name not in ('coreInstalledAt', 'lastUpdateAt'):
        raise SettingsError('Unknown setup step.')
    path = settings_path(release)
    settings = load_settings(path)
    settings.setdefault('steps', {})[name] = timestamp()
    save_settings(path, settings)
