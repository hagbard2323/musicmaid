"""Normal-user setup orchestration, with small explicit privileged entry points."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys

from .config import SettingsError, TerminalPrompt, configure, load_settings, record_step, settings_path

COMMANDS = ('check', 'configure', 'install', 'sources', 'video', 'doctor', 'backup', 'update', 'rollback', 'cleanup')
BACKUP_ID = re.compile(r'self-host-\d{8}T\d{6}Z-[a-f0-9]{8}')
USAGE = 'Usage: ./scripts/setup.sh [check|configure|install|sources|video|doctor|backup|update [release-directory]|rollback [backup-ID]|cleanup]'
CLEANUP_USAGE = 'Preview: ./scripts/setup.sh cleanup preview request-stats GUILD_ID YYYY-MM-DD\nApply reviewed preview: ./scripts/setup.sh cleanup apply cleanup-<32-hex-ID>'


class SetupCLIError(ValueError):
    """A safe operator instruction, never a raw subprocess or credential error."""


def public_report(report):
    """Keep the internal handoff protocol free of configuration/credential data."""
    allowed = ('supported', 'existing', 'managed', 'rootVerificationPending', 'installed', 'configured', 'ready', 'audioReady', 'status', 'issues', 'dependencies', 'nodeVersion', 'conflicts', 'remainingChecks', 'backup')
    return {key: report[key] for key in allowed if key in report}


def build_environment():
    environment = os.environ.copy()
    for key in tuple(environment):
        if key.startswith(('DISCORD_', 'SPOTIFY_', 'YOUTUBE_', 'LAVALINK_', 'VIEWER_', 'MUSIC_')):
            environment.pop(key, None)
    environment.update({'DISCORD_TOKEN': 'test', 'DISCORD_CLIENT_ID': 'test'})
    return environment


class SetupCLI:
    def __init__(self, release, runner=subprocess.run, prompt_factory=TerminalPrompt, backend=None, output=print):
        self.release = Path(release).resolve()
        self.runner, self.prompt_factory, self.output = runner, prompt_factory, output
        self._backend = backend

    @property
    def backend(self):
        if self._backend is None:
            from . import install
            self._backend = install
        return self._backend

    def command(self, argv, *, release=None, capture=False, environment=None, failure='The setup step failed. Run doctor before retrying.'):
        try:
            result = self.runner(argv, cwd=str(release or self.release), env=environment, check=False,
                                 **({'capture_output': True, 'text': True} if capture else {}))
        except (OSError, subprocess.SubprocessError):
            raise SetupCLIError(failure) from None
        if result.returncode:
            raise SetupCLIError(failure)
        return result

    def privileged(self, action, *operands, capture=False):
        result = self.command(['sudo', '/usr/bin/python3', '-I', '-B', str(self.release / 'scripts/self-host-setup.py'), action, *map(str, operands)],
                              capture=capture, failure='The privileged setup step did not finish. Run doctor and follow the reported recovery step.')
        if capture:
            try:
                report = json.loads(result.stdout.strip().splitlines()[-1])
                if not isinstance(report, dict):
                    raise ValueError()
                return report
            except (ValueError, IndexError, AttributeError):
                raise SetupCLIError('The protected status check did not return a valid result. Run doctor before making changes.') from None
        return None

    def check(self, display=True):
        report = self.backend.check_host(self.release)
        if display:
            self.output(json.dumps(public_report(report), sort_keys=True))
            if report.get('supported') and not report.get('existing'):
                self.output('Core installation will request sudo for supported system dependencies, then build and test as your normal account.')
            if report.get('existing'):
                self.output('An installation already exists. Use doctor or the managed update path; install never overwrites it.')
        return report

    def configure(self):
        with self.prompt_factory() as prompt:
            path = configure(self.release, prompt)
            self.output('Private setup settings saved in .setup/settings.json. Credentials were not printed.')
            status = self.check(display=False)
            if not status.get('existing'):
                return
            protected = self.privileged('internal-status', capture=True)
            if not protected.get('managed'):
                self.output('This existing installation is outside the guided installer. The saved draft was not applied; use its existing operator workflow.')
                return
            answer = prompt.read('Apply these Discord settings to the managed installation and restart the bot? [y/N]: ').strip().lower()
            if answer not in ('y', 'yes'):
                self.output('Draft retained. Installed settings and services were not changed.')
                return
            self.privileged('internal-configure', path)
            self.output('Configuration repair finished. Run ./scripts/setup.sh doctor to verify the bot login and voice permissions.')

    def build(self, release=None):
        release = Path(release or self.release).resolve()
        if os.geteuid() == 0:
            raise SetupCLIError('Builds and package lifecycle scripts must run as the normal account, never root.')
        if not all((release / name).is_file() for name in ('package.json', 'package-lock.json', 'scripts/check-bot-release.py')):
            raise SetupCLIError('Choose a complete MusicMaid release checkout with its lockfile and reviewed preflight helper.')
        environment = build_environment()
        for arguments, description in ((['ci'], 'Install locked Node dependencies'), (['run', 'check'], 'Check application types'), (['test'], 'Run isolated application tests'), (['run', 'build'], 'Build the bot and viewer artifacts')):
            self.output(description + ' as the normal account.')
            self.command(['/usr/bin/npm', *arguments], release=release, environment=environment,
                         failure='The normal-user build or tests failed. Installed services were not changed; fix the checkout and run this command again.')
        self.command(['/usr/bin/python3', '-I', '-B', str(release / 'scripts/check-bot-release.py'), str(release)],
                     release=release, failure='The clean-release preflight failed. Commit reviewed changes or choose a clean tested release; installed services were not changed.')

    def install(self):
        report = self.check()
        if not report.get('supported'):
            raise SetupCLIError('This installer currently supports AlmaLinux 10 on x86_64. No installation changes were made.')
        if report.get('existing'):
            raise SetupCLIError('An installation already exists. Run doctor, configure for managed credential repair, or update; install does not overwrite existing state.')
        if report.get('conflicts'):
            raise SetupCLIError('Host conflicts must be resolved before installation. Review the check result; no installation changes were made.')
        path = settings_path(self.release)
        if not path.exists():
            with self.prompt_factory() as prompt:
                configure(self.release, prompt)
        load_settings(path)
        self.output('Installing supported OS dependencies through sudo.')
        self.privileged('internal-bootstrap')
        self.build()
        self.output('Build and clean-release preflight passed. Installing the verified artifacts through sudo.')
        self.privileged('internal-install', path)
        record_step(self.release, 'coreInstalledAt')
        self.output('Core install step finished. Run doctor, then verify audible playback. Sources and video remain optional next steps.')

    def sources(self, video=False):
        from .integrations import run_integrations
        run_integrations(self.release, 'video' if video else None)

    def maintenance(self, command, operand=None):
        if command == 'update':
            candidate = Path(operand).expanduser().resolve() if operand else self.release
            self.build(candidate)
            self.privileged('internal-maintenance', 'update', candidate)
            if settings_path(self.release).exists():
                record_step(self.release, 'lastUpdateAt')
            return
        if command == 'rollback':
            if not operand:
                self.privileged('internal-maintenance', 'backups')
                self.output('Choose one listed ID, then run ./scripts/setup.sh rollback <backup-ID>. Nothing was rolled back.')
                return
            if not BACKUP_ID.fullmatch(operand):
                raise SetupCLIError('Use an exact guided-installer backup ID from ./scripts/setup.sh rollback, not a path or a legacy updater snapshot.')
            self.privileged('internal-maintenance', 'rollback', operand)
            return
        self.privileged('internal-maintenance', command)

    def cleanup(self, operands):
        if not operands:
            self.output(CLEANUP_USAGE)
            self.output('Manual request/statistics retention only. Preview changes no database data; apply creates a private backup. Playlists and active/recent playback history are preserved.')
            return
        if (len(operands) == 4 and operands[:2] == ['preview', 'request-stats']
                and re.fullmatch(r'[0-9]{17,20}', operands[2]) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', operands[3])):
            self.privileged('internal-maintenance', 'cleanup-preview', *operands[1:])
        elif len(operands) == 2 and operands[0] == 'apply' and re.fullmatch(r'cleanup-[a-f0-9]{32}', operands[1]):
            self.privileged('internal-maintenance', 'cleanup-apply', operands[1])
        else:
            raise SetupCLIError(CLEANUP_USAGE)

    def dispatch(self, command, operand=None):
        if command == 'check':
            report = self.check()
            return 0 if report.get('supported') and not report.get('conflicts') else 1
        if command == 'configure': self.configure()
        elif command == 'install': self.install()
        elif command in ('sources', 'video'): self.sources(command == 'video')
        elif command == 'cleanup': self.cleanup([])
        else: self.maintenance(command, operand)
        return 0

    def guided(self):
        self.output('MusicMaid guided setup · AlmaLinux 10 x86_64 · one Discord server per host')
        report = self.check()
        with self.prompt_factory() as prompt:
            while True:
                default = 'doctor' if report.get('existing') else 'install'
                prompt.write('Actions: check, configure, install, sources, video, doctor, backup, update, rollback, cleanup, exit')
                command = prompt.read('Next action [' + default + ']: ').strip().lower() or default
                if command in ('exit', 'quit', 'done', '0'):
                    return 0
                if command not in COMMANDS:
                    prompt.write('Choose one of the listed actions.')
                    continue
                self.dispatch(command)
                report = self.check(display=False)


def internal(argv, release):
    if os.geteuid() != 0:
        raise SetupCLIError('Internal installation actions require the normal-user wrapper and sudo.')
    from . import install
    action, operands = argv[0], argv[1:]
    if action == 'internal-status' and not operands:
        print(json.dumps(public_report(install.check_host(release)), sort_keys=True))
    elif action == 'internal-bootstrap' and not operands:
        print(json.dumps(public_report(install.bootstrap(release)), sort_keys=True))
    elif action in ('internal-install', 'internal-configure') and len(operands) == 1:
        operation = install.install if action == 'internal-install' else install.configure_core
        print(json.dumps(public_report(operation(release, Path(operands[0]))), sort_keys=True))
    elif action == 'internal-maintenance' and operands and operands[0] in ('doctor', 'backup', 'backups', 'update', 'rollback', 'cleanup-preview', 'cleanup-apply'):
        from .maintenance import main as maintain
        return maintain(operands)
    else:
        raise SetupCLIError('Unsupported internal setup action.')
    return 0


def main(argv=None, release=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    release = Path(release or Path(__file__).resolve().parents[2])
    previous_term = None
    try:
        if argv and argv[0].startswith('internal-'):
            if os.geteuid() == 0 and argv[0] in ('internal-install', 'internal-configure', 'internal-maintenance'):
                def cancelled(_number, _frame):
                    raise KeyboardInterrupt()
                previous_term = signal.signal(signal.SIGTERM, cancelled)
            return internal(argv, release)
        if argv in (['--help'], ['-h']):
            print(USAGE)
            return 0
        if os.geteuid() == 0:
            raise SetupCLIError('Run setup.sh as your normal account. It requests sudo only for protected installation and maintenance.')
        if argv and argv[0] == 'cleanup':
            SetupCLI(release).cleanup(argv[1:])
            return 0
        if len(argv) > 2 or (argv and argv[0] not in COMMANDS) or (len(argv) == 2 and argv[0] not in ('update', 'rollback')):
            raise SetupCLIError(USAGE)
        cli = SetupCLI(release)
        return cli.dispatch(argv[0], argv[1] if len(argv) == 2 else None) if argv else cli.guided()
    except (KeyboardInterrupt, EOFError):
        print('Setup cancelled. Run the same action to resume; no credentials were printed.', file=sys.stderr)
        return 130
    except (SetupCLIError, SettingsError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception as error:
        for module_name, class_name in (('self_host.install', 'SetupError'), ('self_host.integrations', 'IntegrationError'), ('self_host.maintenance', 'MaintenanceError')):
            domain = sys.modules.get(module_name)
            safe_error = getattr(domain, class_name, None)
            if isinstance(safe_error, type) and isinstance(error, safe_error):
                print(str(error), file=sys.stderr)
                return 1
        # Backend/integration helpers expose safe operator errors, but never dump
        # an unknown exception, its subprocess arguments or protected file data.
        print('Setup could not finish. Run ./scripts/setup.sh doctor and review the last completed step; credentials and raw errors were withheld.', file=sys.stderr)
        return 1
    finally:
        if previous_term is not None:
            signal.signal(signal.SIGTERM, previous_term)
