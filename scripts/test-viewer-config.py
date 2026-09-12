#!/usr/bin/env python3
"""Exercise the real terminal prompts with captured shell output and fake files."""
import errno
import json
import os
from pathlib import Path
import pty
import select
import shlex
import shutil
import signal
import subprocess
import tempfile
import termios
import time
import unittest
from unittest.mock import patch

HELPER = Path(__file__).with_name('configure-viewer.py').resolve()
FIXTURE_HOST = 'music.fixture.example'
FIXTURE_NODE = shutil.which('node')
if not FIXTURE_NODE:
    raise RuntimeError('Viewer configuration fixtures require Node.js 22.13+ on PATH.')
FAKE_SECRET = 'fixture-secret-never-a-real-credential'


class ViewerConfigurationTests(unittest.TestCase):
    def run_prompt(self, directory, hostname=FIXTURE_HOST, secret=FAKE_SECRET, node_executable=FIXTURE_NODE, runtime_extra=''):
        directory = Path(directory)
        runtime, output, captured = [directory / name for name in ('bot.env', 'viewer.env', 'stdout.txt')]
        runtime.write_text('DISCORD_CLIENT_ID=123456789012345678\n' + runtime_extra)
        runner = directory / 'run-config.py'
        runner.write_text(
            'import importlib.util, os\nfrom pathlib import Path\n'
            f'spec=importlib.util.spec_from_file_location("viewer_config", {str(HELPER)!r})\n'
            'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)\n'
            'os.environ.pop("DISCORD_CLIENT_ID", None)\n'
            f'module.configure(Path({str(runtime)!r}), Path({str(output)!r}), node_executable={node_executable!r})\n'
        )
        # Match deploy-viewer.sh: stdout is a pipe while /dev/tty remains the
        # controlling terminal. No root paths or actual secrets are involved.
        command = 'VIEWER_HOST="$('+shlex.join(['python3', str(runner)])+')"; result=$?; printf "%s\\n" "$VIEWER_HOST" > '+shlex.quote(str(captured))+'; exit "$result"'
        pid, fd = pty.fork()
        if pid == 0:
            os.execv('/bin/bash', ['bash', '--noprofile', '--norc', '-c', command])
        transcript = b''
        sent_host = sent_secret = hidden = False
        exited = False
        try:
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                if not select.select([fd], [], [], 0.25)[0]:
                    continue
                try:
                    chunk = os.read(fd, 4096)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                transcript += chunk
                if not sent_host and b'Viewer hostname ' in transcript:
                    os.write(fd, hostname.encode() + b'\n')
                    sent_host = True
                if not sent_secret and b'CLIENT SECRET (' in transcript:
                    hidden = not bool(termios.tcgetattr(fd)[3] & termios.ECHO)
                    os.write(fd, secret.encode() + b'\n')
                    sent_secret = True
            else:
                self.fail('Terminal prompt timed out')
            _, status = os.waitpid(pid, 0)
            exited = True
            self.assertNotIn(FAKE_SECRET.encode(), transcript, 'Secret appeared on the terminal')
            self.assertNotIn(b'Traceback', transcript)
            if sent_secret:
                self.assertTrue(hidden, 'Secret input must have echo disabled')
            return os.waitstatus_to_exitcode(status), captured.read_text(), output
        finally:
            os.close(fd)
            if not exited:
                os.killpg(pid, signal.SIGKILL)
                os.waitpid(pid, 0)

    def test_explicit_hostname_and_hidden_secret_with_captured_stdout(self):
        with tempfile.TemporaryDirectory(prefix='musicmaid-config-test-') as directory:
            code, stdout, output = self.run_prompt(directory)
            self.assertEqual(code, 0)
            self.assertEqual(stdout, FIXTURE_HOST + '\n')
            settings = dict(line.split('=', 1) for line in output.read_text().splitlines())
            self.assertEqual(json.loads(settings['DISCORD_CLIENT_ID']), '123456789012345678')
            self.assertEqual(json.loads(settings['DISCORD_CLIENT_SECRET']), FAKE_SECRET)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_existing_hostname_and_secret_are_retained_or_explicitly_changed(self):
        with tempfile.TemporaryDirectory(prefix='musicmaid-config-test-') as directory:
            self.run_prompt(directory)
            before = (Path(directory) / 'viewer.env').read_bytes()
            code, stdout, output = self.run_prompt(directory, '', '')
            self.assertEqual(code, 0)
            self.assertEqual(stdout, FIXTURE_HOST + '\n')
            self.assertEqual(output.read_bytes(), before)
            code, stdout, output = self.run_prompt(directory, 'musicmaidvideo.example.com', '')
            self.assertEqual(code, 0)
            self.assertEqual(stdout, 'musicmaidvideo.example.com\n')
            settings = dict(line.split('=', 1) for line in output.read_text().splitlines())
            self.assertEqual(json.loads(settings['DISCORD_CLIENT_SECRET']), FAKE_SECRET)
            self.assertEqual(json.loads(settings['VIEWER_PUBLIC_ORIGIN']), 'https://musicmaidvideo.example.com')

    def test_first_setup_without_a_hostname_stops_before_writing_configuration(self):
        with tempfile.TemporaryDirectory(prefix='musicmaid-config-test-') as directory:
            code, stdout, output = self.run_prompt(directory, '', FAKE_SECRET)
            self.assertNotEqual(code, 0)
            self.assertEqual(stdout, '\n')
            self.assertFalse(output.exists())

    def test_fixture_explicitly_uses_its_selected_node_outside_the_production_path(self):
        with tempfile.TemporaryDirectory(prefix='musicmaid-config-test-') as directory:
            root = Path(directory)
            node, used = root / 'fixture-node', root / 'fixture-node-used'
            node.write_text('#!/bin/sh\nprintf "invoked\\n" > ' + shlex.quote(str(used))
                            + '\nexec ' + shlex.quote(FIXTURE_NODE) + ' "$@"\n')
            node.chmod(0o700)
            code, stdout, _ = self.run_prompt(directory, node_executable=str(node))
            self.assertEqual(code, 0)
            self.assertEqual(stdout, FIXTURE_HOST + '\n')
            self.assertEqual(used.read_text(), 'invoked\n')

    def test_bot_environment_and_inherited_node_options_cannot_preload_code(self):
        with tempfile.TemporaryDirectory(prefix='musicmaid-config-preload-') as directory:
            root = Path(directory)
            marker, preload = root / 'preload-executed', root / 'preload.mjs'
            preload.write_text('import {writeFileSync} from "node:fs"; writeFileSync('
                               + json.dumps(str(marker)) + ', "must never execute");\n')
            options = '--import=' + preload.as_uri()
            with patch.dict(os.environ, {'NODE_OPTIONS': options}):
                code, stdout, output = self.run_prompt(directory, runtime_extra='NODE_OPTIONS=' + options + '\n')
            self.assertEqual(code, 0)
            self.assertEqual(stdout, FIXTURE_HOST + '\n')
            self.assertFalse(marker.exists(), 'The environment must be parsed as data without Node preloads.')
            settings = dict(line.split('=', 1) for line in output.read_text().splitlines())
            self.assertEqual(json.loads(settings['DISCORD_CLIENT_ID']), '123456789012345678')

    def test_invalid_hostname_preserves_existing_configuration(self):
        with tempfile.TemporaryDirectory(prefix='musicmaid-config-test-') as directory:
            self.run_prompt(directory)
            before = (Path(directory) / 'viewer.env').read_bytes()
            code, stdout, output = self.run_prompt(directory, 'https://invalid.example.com/path')
            self.assertNotEqual(code, 0)
            self.assertEqual(stdout, '\n')
            self.assertEqual(output.read_bytes(), before)

    def test_preinstall_rollback_does_not_touch_services(self):
        installer = HELPER.with_name('deploy-viewer.sh').read_text()
        start = installer.index('rollback() {')
        rollback = installer[start:installer.index('\ntrap rollback ERR INT TERM', start)]
        for existing in (False, True):
            with self.subTest(existing_configuration=existing), tempfile.TemporaryDirectory(prefix='musicmaid-rollback-test-') as directory:
                root = Path(directory)
                backup = root / 'backup'
                backup.mkdir()
                output = root / 'viewer.env'
                output.write_text('temporary configuration')
                if existing:
                    (backup / 'audiobot-viewer.env').write_text('prior configuration')
                log = root / 'service-calls'
                script = '\n'.join([
                    'set -euo pipefail',
                    'INSTALL_STARTED=false',
                    'BACKUP_DIR=' + shlex.quote(str(backup)),
                    'SERVICE_LOG=' + shlex.quote(str(log)),
                    'systemctl() { printf "unexpected service call\\n" >> "$SERVICE_LOG"; }',
                    'caddy() { printf "unexpected Caddy call\\n" >> "$SERVICE_LOG"; }',
                    rollback.replace('/etc/audiobot-viewer.env', str(output)),
                    'rollback',
                ])
                result = subprocess.run(['/bin/bash', '-c', script], capture_output=True, text=True)
                self.assertEqual(result.returncode, 1)
                self.assertIn('stopped before installation', result.stderr)
                self.assertFalse(log.exists(), 'Prompt failure must not touch running services')
                if existing:
                    self.assertEqual(output.read_text(), 'prior configuration')
                else:
                    self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
