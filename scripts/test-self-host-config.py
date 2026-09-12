#!/usr/bin/env python3
"""Private configuration, real terminal secrecy and unprivileged orchestration tests."""
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import pty
import select
import signal
import stat
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from self_host.config import SettingsError, collect_settings, configure, load_settings, save_settings, settings_path
from self_host.cli import SetupCLI, SetupCLIError, build_environment, main, public_report

SECRET = 'fixture-bot-token-never-echo-0123456789'
SCRIPT = Path(__file__).resolve().parent / 'self-host-setup.py'


class Prompt:
    def __init__(self, answers):
        self.answers, self.messages, self.questions = iter(answers), [], []

    def __enter__(self): return self
    def __exit__(self, *_): return None
    def write(self, message): self.messages.append(message)

    def read(self, label, secret=False):
        self.questions.append((label, secret))
        try: return next(self.answers)
        except StopIteration: raise EOFError() from None


def settings():
    return {'version': 1, 'discord': {'token': SECRET, 'clientId': '123456789', 'guildId': '234567890', 'musicTextChannelId': '345678901', 'adminRoleIds': ['456789012']},
            'lavalink': {'password': 'a' * 43}, 'sources': {}, 'viewer': {'enabled': False}, 'steps': {}}


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.release = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def test_first_setup_is_private_and_does_not_emit_values(self):
        prompt = Prompt([SECRET, '123456789', '234567890', '345678901', '456789012,456789012'])
        path = configure(self.release, prompt)
        value = load_settings(path)
        self.assertEqual(value['discord']['token'], SECRET)
        self.assertEqual(value['discord']['adminRoleIds'], ['456789012'])
        self.assertFalse(value['viewer']['enabled'])
        self.assertGreaterEqual(len(value['lavalink']['password']), 43)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        self.assertTrue(prompt.questions[0][1])
        output = repr(prompt.messages) + repr(prompt.questions)
        for private in (SECRET, value['lavalink']['password'], '123456789', '234567890'):
            self.assertNotIn(private, output)

    def test_resume_preserves_credentials_optional_configuration_and_steps(self):
        previous = settings()
        previous['sources'] = {'youtube': {'cookieFile': '/private/fixture-cookies.txt'}, 'spotify': {'market': 'DE'}}
        previous['viewer'] = {'enabled': True, 'hostname': 'fixture.example'}
        previous['steps'] = {'coreInstalledAt': '2026-09-12T00:00:00Z'}
        path = settings_path(self.release)
        save_settings(path, previous)
        configure(self.release, Prompt(['', '', '', '', '']))
        current = load_settings(path)
        for key in ('discord', 'lavalink', 'sources', 'viewer'):
            self.assertEqual(current[key], previous[key])
        self.assertEqual(current['steps']['coreInstalledAt'], previous['steps']['coreInstalledAt'])
        self.assertIn('configuredAt', current['steps'])

    def test_invalid_fields_retry_without_printing_submitted_values(self):
        prompt = Prompt(['bad token value', SECRET, 'not-an-id', '123456789', '234567890', '345678901', 'bad-role', '-'])
        value = collect_settings(None, prompt)
        self.assertEqual(value['discord']['adminRoleIds'], [])
        self.assertEqual(value['discord']['clientId'], '123456789')
        self.assertNotIn('bad token value', repr(prompt.messages))
        self.assertNotIn('bad-role', repr(prompt.messages))

    def test_cancel_and_atomic_replace_failure_preserve_existing_file(self):
        path = settings_path(self.release)
        save_settings(path, settings())
        before = path.read_bytes()
        with self.assertRaises(EOFError): configure(self.release, Prompt(['different-token-01234567890123456789']))
        self.assertEqual(path.read_bytes(), before)
        with patch('self_host.config.os.replace', side_effect=OSError('injected write failure')):
            with self.assertRaises(SettingsError): save_settings(path, settings())
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(list(path.parent.glob('.settings-*')), [])

    def test_linked_and_readable_by_others_settings_are_rejected(self):
        path = settings_path(self.release)
        save_settings(path, settings())
        path.chmod(0o644)
        with self.assertRaises(SettingsError): load_settings(path)
        path.chmod(0o600)
        outside = self.release / 'other.json'
        path.rename(outside)
        path.symlink_to(outside)
        with self.assertRaises(SettingsError): load_settings(path)
        with self.assertRaises(SettingsError): save_settings(path, settings())
        self.assertEqual(json.loads(outside.read_text())['discord']['token'], SECRET)

    def test_malformed_json_error_does_not_repeat_credentials(self):
        path = settings_path(self.release)
        path.parent.mkdir(mode=0o700)
        path.write_text('invalid ' + SECRET)
        path.chmod(0o600)
        with self.assertRaises(SettingsError) as caught: load_settings(path)
        self.assertNotIn(SECRET, str(caught.exception))

    def test_hidden_secret_input_uses_a_real_controlling_terminal(self):
        pid, fd = pty.fork()
        if pid == 0:
            program = "from pathlib import Path; from self_host.config import configure; configure(Path(__import__('sys').argv[1])); print('CONFIGURED')"
            os.execv(sys.executable, [sys.executable, '-B', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); ' + program.replace("argv[1]", "argv[2]"), str(SCRIPT.parent), str(self.release)])
        transcript = bytearray()
        try:
            responses = [(b'Discord BOT TOKEN', SECRET), (b'Discord application ID', '123456789'), (b'Discord server ID', '234567890'), (b'Music text-channel ID', '345678901'), (b'Moderator role IDs', '-')]
            next_answer = 0
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if select.select([fd], [], [], 0.1)[0]:
                    try: chunk = os.read(fd, 65536)
                    except OSError: break
                    if not chunk: break
                    transcript.extend(chunk)
                    if next_answer < len(responses) and responses[next_answer][0] in transcript:
                        os.write(fd, responses[next_answer][1].encode() + b'\n')
                        next_answer += 1
                if b'CONFIGURED' in transcript: break
            self.assertIn(b'CONFIGURED', transcript)
            self.assertNotIn(SECRET.encode(), transcript)
            self.assertEqual(load_settings(settings_path(self.release))['discord']['token'], SECRET)
        finally:
            os.close(fd)
            done, _ = os.waitpid(pid, os.WNOHANG)
            if not done:
                os.kill(pid, 15)
                os.waitpid(pid, 0)


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.release = Path(self.temporary.name)
        (self.release / 'scripts').mkdir()
        for name in ('package.json', 'package-lock.json', 'scripts/check-bot-release.py'):
            (self.release / name).write_text('fixture')
        save_settings(settings_path(self.release), settings())
        self.addCleanup(self.temporary.cleanup)
        self.calls, self.output = [], []
        self.report = {'supported': True, 'existing': False, 'managed': False, 'issues': [], 'dependencies': {}, 'conflicts': []}

    def run_command(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        return SimpleNamespace(returncode=0, stdout=json.dumps(self.report))

    def cli(self, prompt=None):
        return SetupCLI(self.release, runner=self.run_command, prompt_factory=lambda: prompt or Prompt([]), backend=SimpleNamespace(check_host=lambda _release: self.report), output=self.output.append)

    @contextmanager
    def normal_build(self):
        with patch('self_host.cli.os.geteuid', return_value=1000), patch('self_host.cli.load_settings', return_value=settings()), patch('self_host.cli.record_step'):
            yield

    def test_install_runs_bootstrap_then_normal_build_then_verified_root_install(self):
        self.report.update(rootVerificationPending=True, issues=['Protected host checks require sudo.', 'Host prerequisites need bootstrap.'], dependencies={'podman': False})
        with self.normal_build(): self.cli().install()
        commands = [call[0] for call in self.calls]
        self.assertEqual(commands[0][-1], 'internal-bootstrap')
        self.assertEqual([command[1:] for command in commands if command[0] == '/usr/bin/npm'], [['ci'], ['run', 'check'], ['test'], ['run', 'build']])
        self.assertEqual(commands[-1][-2:], ['internal-install', str(settings_path(self.release))])
        self.assertEqual(commands[-2][0], '/usr/bin/python3')
        self.assertTrue(all('/usr/bin/npm' not in command for command in commands if command[0] == 'sudo'))
        self.assertNotIn(SECRET, repr(self.calls) + repr(self.output))
        for command, options in self.calls:
            if command[0] == '/usr/bin/npm':
                self.assertEqual(options['env']['DISCORD_TOKEN'], 'test')

    def test_existing_or_unsupported_host_never_bootstraps_or_builds(self):
        for change in ({'existing': True}, {'supported': False}, {'conflicts': ['fixture conflict']}):
            before = self.report.copy()
            self.report.update(change)
            with self.assertRaises(SetupCLIError): self.cli().install()
            self.assertEqual(self.calls, [])
            self.report = before

    def test_build_failure_prevents_install(self):
        def fail_tests(argv, **kwargs):
            result = self.run_command(argv, **kwargs)
            if argv == ['/usr/bin/npm', 'test']: result.returncode = 1
            return result
        cli = self.cli(); cli.runner = fail_tests
        with self.normal_build(), self.assertRaises(SetupCLIError): cli.install()
        self.assertFalse(any('internal-install' in command for command, _ in self.calls))

    def test_managed_configure_requires_explicit_apply_and_never_builds(self):
        self.report.update(existing=True, managed=True)
        for answer, should_apply in (('', False), ('yes', True)):
            self.calls.clear()
            self.cli(Prompt(['', '', '', '', '', answer])).configure()
            commands = [command for command, _ in self.calls]
            self.assertEqual(any('internal-configure' in command for command in commands), should_apply)
            self.assertFalse(any(command[0] == '/usr/bin/npm' for command in commands))

    def test_update_builds_before_maintenance_and_rollback_without_id_only_lists(self):
        with self.normal_build(): self.cli().maintenance('update')
        self.assertEqual(self.calls[-1][0][-3:], ['internal-maintenance', 'update', str(self.release)])
        self.calls.clear()
        self.cli().maintenance('rollback')
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][0][-2:], ['internal-maintenance', 'backups'])
        with self.assertRaises(SetupCLIError): self.cli().maintenance('rollback', '/tmp/unknown-backup')

    def test_root_cannot_enter_public_install_or_build(self):
        with patch('self_host.cli.os.geteuid', return_value=0), redirect_stderr(io.StringIO()):
            self.assertEqual(main(['install'], self.release), 1)
            with self.assertRaises(SetupCLIError): self.cli().build()
        self.assertEqual(self.calls, [])

    def test_unknown_errors_and_status_protocol_do_not_expose_settings(self):
        report = public_report({'supported': True, 'discord': settings()['discord'], 'lavalink': settings()['lavalink']})
        self.assertEqual(report, {'supported': True})
        with patch.dict(os.environ, {'DISCORD_TOKEN': SECRET, 'SPOTIFY_CLIENT_SECRET': SECRET, 'LAVALINK_AUTH': SECRET}):
            environment = build_environment()
        self.assertEqual(environment['DISCORD_TOKEN'], 'test')
        self.assertNotIn('SPOTIFY_CLIENT_SECRET', environment)
        error_output = io.StringIO()
        with patch('self_host.cli.os.geteuid', return_value=1000), patch('self_host.cli.SetupCLI.dispatch', side_effect=RuntimeError(SECRET)), redirect_stderr(error_output):
            self.assertEqual(main(['check'], self.release), 1)
        self.assertNotIn(SECRET, error_output.getvalue())

    def test_known_provider_and_maintenance_errors_keep_their_safe_recovery_instruction(self):
        for module, name, message in (
            ('self_host.integrations', 'IntegrationError', 'Complete the Spotify API metadata step first.'),
            ('self_host.maintenance', 'MaintenanceError', 'Choose an existing guided-installer backup ID.'),
        ):
            error_type = type(name, (Exception,), {})
            error_output = io.StringIO()
            with patch.dict(sys.modules, {module: SimpleNamespace(**{name: error_type})}), patch('self_host.cli.os.geteuid', return_value=1000), patch('self_host.cli.SetupCLI.dispatch', side_effect=error_type(message)), redirect_stderr(error_output):
                self.assertEqual(main(['sources'], self.release), 1)
            self.assertIn(message, error_output.getvalue())

    def test_termination_becomes_a_catchable_transaction_interruption(self):
        original = signal.getsignal(signal.SIGTERM)
        def interrupt(_argv, _release):
            signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
        with patch('self_host.cli.os.geteuid', return_value=0), patch('self_host.cli.internal', side_effect=interrupt), redirect_stderr(io.StringIO()):
            self.assertEqual(main(['internal-install', str(settings_path(self.release))], self.release), 130)
        self.assertIs(signal.getsignal(signal.SIGTERM), original)


if __name__ == '__main__':
    unittest.main()
