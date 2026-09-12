#!/usr/bin/env python3
"""Optional source/setup regressions with fake accounts, packages and services only."""
from contextlib import ExitStack, redirect_stdout
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from self_host import integrations as subject
from self_host.maintenance import Layout, Maintenance, installation_lock


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='musicmaid-integrations-')
        self.root = Path(self.temporary.name)
        self.release, self.app, self.state = self.root / 'private-home/release', self.root / 'runtime', self.root / 'state'
        for path in (self.release / 'apps/spotify-stream', self.release / 'infra/lavalink', self.release / 'bin', self.app / 'scripts', self.state):
            path.mkdir(parents=True)
        self.release.parent.chmod(0o700)
        self.lock = self.release / 'apps/spotify-stream/Cargo.lock'
        self.lock.write_text('fixture-locked-rust-dependencies')
        (self.release / 'infra/lavalink/youtube-requirements.txt').write_text('yt-dlp==2026.8.19\n')
        (self.release / 'bin/SHA256SUMS').write_text('tracked-checksum-must-stay-unchanged')
        self.metadata = {'revision': 'a' * 40, 'sourceHash': 'b' * 64, 'dependencyHash': 'c' * 64, 'dirty': False}
        (self.release / 'release-manifest.json').write_text(json.dumps(self.metadata))
        (self.app / 'release-manifest.json').write_text(json.dumps(self.metadata))
        self.original = b'DISCORD_TOKEN="fixture-discord-private"\nSPOTIFY_CLIENT_ID="previous-client"\n'
        (self.app / '.env').write_bytes(self.original)
        (self.app / '.env').chmod(0o600)
        self.owner = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(subject, 'APP', self.app))
        self.stack.enter_context(patch.object(subject, 'STATE', self.state))
        self.stack.enter_context(patch.object(subject.pwd, 'getpwnam', return_value=self.owner))

    def tearDown(self):
        self.stack.close()
        self.temporary.cleanup()

    def artifact(self):
        with patch.object(subject, 'release_metadata', return_value=self.metadata):
            directory = subject.artifact_directory(self.release, 'spotify')
            binary = directory / 'musicmaid-spotify-stream'
            binary.write_bytes(b'\x7fELFfixture-operator-build')
            subject.write_artifact(self.release, 'spotify', [binary])
        return directory

    def test_artifacts_require_matching_owned_release_lock_and_exact_checksum(self):
        directory = self.artifact()
        with patch.object(subject, 'release_metadata', return_value=self.metadata):
            manifest, files = subject.verify_artifact(self.release, directory, 'spotify', os.getuid())
            self.assertEqual(manifest['revision'], self.metadata['revision'])
            self.assertEqual(files['musicmaid-spotify-stream'], b'\x7fELFfixture-operator-build')
            (directory / 'musicmaid-spotify-stream').write_bytes(b'\x7fELFtampered')
            with self.assertRaisesRegex(subject.IntegrationError, 'checksum'):
                subject.verify_artifact(self.release, directory, 'spotify', os.getuid())
            (directory / 'musicmaid-spotify-stream').write_bytes(b'\x7fELFfixture-operator-build')
            self.lock.write_text('changed lock')
            with self.assertRaisesRegex(subject.IntegrationError, 'lock file'):
                subject.verify_artifact(self.release, directory, 'spotify', os.getuid())
        self.assertEqual((self.release / 'bin/SHA256SUMS').read_text(), 'tracked-checksum-must-stay-unchanged')

    def test_privileged_environments_find_almalinux_administration_tools_in_sbin(self):
        from self_host.maintenance import SAFE_ENV as maintenance_environment
        prefix = self.root / 'system-paths'
        sbin = prefix / 'usr/sbin'; sbin.mkdir(parents=True)
        tool = sbin / 'fixture-admin-command'
        tool.write_text('#!/bin/sh\nprintf available\n'); tool.chmod(0o755)
        for environment in (subject.SAFE_ENV, maintenance_environment):
            with self.subTest(environment=environment):
                mapped = dict(environment, PATH=os.pathsep.join(str(prefix / part.lstrip('/')) for part in environment['PATH'].split(os.pathsep)))
                result = subprocess.run(['/bin/sh', '-c', 'fixture-admin-command'], env=mapped, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, 'AlmaLinux places tools such as runuser and ss in /usr/sbin')
                self.assertEqual(result.stdout, 'available')

    def test_regular_secret_files_and_artifacts_reject_symlinks(self):
        private = self.root / 'secret'
        private.write_text('fixture-private-value'); private.chmod(0o600)
        alias = self.root / 'linked-secret'; alias.symlink_to(private)
        with self.assertRaises(OSError):
            subject.regular(alias, os.getuid(), True)
        directory = self.artifact()
        (directory / 'artifact.json').chmod(0o644)
        with patch.object(subject, 'release_metadata', return_value=self.metadata), self.assertRaises(subject.IntegrationError):
            subject.verify_artifact(self.release, directory, 'spotify', os.getuid())

    def test_rust_build_runs_as_user_locked_and_never_rewrites_tracked_checksums(self):
        commands = []
        def runner(command, **kwargs):
            commands.append([str(value) for value in command])
            if command[0] == 'cargo':
                target = Path(command[command.index('--target-dir') + 1]) / 'release/musicmaid-spotify-stream'
                target.parent.mkdir(parents=True); target.write_bytes(b'\x7fELFfixture-build')
        with patch.object(subject.os, 'geteuid', return_value=1000), patch.object(subject, 'release_metadata', return_value=self.metadata), patch.object(subject.shutil, 'which', return_value='/usr/bin/cargo'), patch.object(subject, 'run', side_effect=runner):
            directory = subject.build_spotify(self.release)
        self.assertEqual(commands[0][0], 'cargo'); self.assertIn('--locked', commands[0])
        self.assertIn(str(self.release / '.setup/artifacts/spotify/target'), commands[0])
        self.assertTrue((directory / 'artifact.json').is_file())
        self.assertEqual((self.release / 'bin/SHA256SUMS').read_text(), 'tracked-checksum-must-stay-unchanged')
        with patch.object(subject.os, 'geteuid', return_value=0), self.assertRaisesRegex(subject.IntegrationError, 'normal setup user'):
            subject.build_spotify(self.release)

    def test_youtube_preparation_uses_pinned_wheel_only_downloads_as_user(self):
        commands = []
        def runner(command, **kwargs):
            commands.append([str(value) for value in command])
            if 'download' in command:
                directory = Path(command[command.index('--dest') + 1]); (directory / 'yt_dlp-2026.8.19-py3-none-any.whl').write_bytes(b'fixture-wheel')
        with patch.object(subject.os, 'geteuid', return_value=1000), patch.object(subject, 'release_metadata', return_value=self.metadata), patch.object(subject, 'run', side_effect=runner):
            directory = subject.build_youtube(self.release)
        self.assertIn('--only-binary=:all:', commands[1]); self.assertIn(str(self.release / 'infra/lavalink/youtube-requirements.txt'), commands[1])
        self.assertEqual(json.loads((directory / 'artifact.json').read_text())['kind'], 'youtube')
        self.assertFalse(any(command[0] in ('sudo', 'dnf') for command in commands))

    def test_failed_preflight_never_replaces_running_configuration_or_rotated_grant(self):
        grant = self.state / 'spotify-direct.json'; grant.write_text('old-fixture-grant')
        def fail(candidate):
            self.assertEqual((self.app / '.env').read_bytes(), self.original)
            self.assertEqual(candidate.stat().st_mode & 0o777, 0o600)
            self.assertIn(b'new-fixture-secret', candidate.read_bytes())
            grant.write_text('refreshed-fixture-grant')
            raise subject.IntegrationError('fixture preflight refused')
        with patch.object(subject, 'run') as command, self.assertRaises(subject.IntegrationError):
            subject.checked_environment({'SPOTIFY_CLIENT_SECRET': 'new-fixture-secret'}, fail)
        command.assert_not_called()
        self.assertEqual((self.app / '.env').read_bytes(), self.original)
        self.assertEqual(grant.read_text(), 'refreshed-fixture-grant')
        self.assertEqual(list(self.state.glob('.integration-env-*')), [])

    def test_failed_bot_restart_restores_only_settings_and_keeps_refreshed_grants(self):
        grant = self.state / 'spotify-direct.json'; grant.write_text('newly-refreshed-grant')
        with patch.object(subject, 'run', side_effect=subject.IntegrationError('fixture restart failed')), patch.object(subject.subprocess, 'run') as recovery, self.assertRaises(subject.IntegrationError):
            subject.checked_environment({'SPOTIFY_DIRECT_ENABLED': 'true'}, lambda candidate: None)
        self.assertEqual((self.app / '.env').read_bytes(), self.original)
        self.assertEqual(grant.read_text(), 'newly-refreshed-grant')
        recovery.assert_called_once_with(['systemctl', 'restart', 'audiobot'], check=False, env=subject.SAFE_ENV)

    def test_configuration_race_is_refused_before_promotion(self):
        promoted = []
        def other_configuration(candidate):
            (self.app / '.env').write_bytes(b'changed-by-another-setup\n')
        with patch.object(subject, 'run') as command, self.assertRaisesRegex(subject.IntegrationError, 'changed during'):
            subject.checked_environment({'VIEWER_ENABLED': 'true'}, other_configuration, lambda: promoted.append(True))
        self.assertEqual(promoted, []); command.assert_not_called()
        self.assertEqual((self.app / '.env').read_bytes(), b'changed-by-another-setup\n')

    def test_root_internal_actions_cannot_bypass_managed_install_ownership(self):
        with patch.object(subject.os, 'geteuid', return_value=0), patch.dict(os.environ, {'SUDO_UID': '1000'}), patch.object(subject, 'require_managed_root', side_effect=subject.SetupError('fixture legacy host')), patch.object(subject, 'run') as command:
            with self.assertRaises(subject.SetupError):
                subject.root_main(self.release, 'spotify-api')
            command.assert_not_called()

    def test_root_integration_shares_maintenance_lock_before_any_preflight_or_action(self):
        layout = Layout(self.root / 'managed-host')
        holder = Maintenance(layout, owner_uid=os.getuid())
        lock = lambda: installation_lock(layout, owner_uid=os.getuid())
        with patch.object(subject.os, 'geteuid', return_value=0), patch.dict(os.environ, {'SUDO_UID': '1000'}), \
                patch.object(subject, 'require_managed_root') as ownership, \
                patch.object(subject, 'installation_lock', side_effect=lock), \
                patch.object(subject, 'release_metadata', return_value=self.metadata) as preflight, \
                patch.object(subject, 'run') as command, patch.object(subject, 'setup_spotify_api') as action:
            with holder._lock():
                with self.assertRaisesRegex(subject.IntegrationError, 'Another self-host maintenance'):
                    subject.root_main(self.release, 'spotify-api')
            ownership.assert_called_once_with(self.release)
            preflight.assert_not_called(); command.assert_not_called(); action.assert_not_called()
            self.assertEqual((self.app / '.env').read_bytes(), self.original)
            subject.root_main(self.release, 'spotify-api')
            preflight.assert_called_once_with(self.release)
            action.assert_called_once_with(self.release)

    def test_failed_root_integration_releases_shared_maintenance_lock(self):
        layout = Layout(self.root / 'managed-host')
        lock = lambda: installation_lock(layout, owner_uid=os.getuid())
        with patch.object(subject.os, 'geteuid', return_value=0), patch.dict(os.environ, {'SUDO_UID': '1000'}), \
                patch.object(subject, 'require_managed_root'), patch.object(subject, 'installation_lock', side_effect=lock), \
                patch.object(subject, 'release_metadata', return_value=self.metadata), patch.object(subject, 'run'), \
                patch.object(subject, 'setup_spotify_api', side_effect=subject.IntegrationError('fixture activation failure')):
            with self.assertRaisesRegex(subject.IntegrationError, 'fixture activation failure'):
                subject.root_main(self.release, 'spotify-api')
        with Maintenance(layout, owner_uid=os.getuid())._lock():
            pass

    def test_bot_helpers_run_installed_paths_after_privilege_drop_even_for_private_operator_home(self):
        with patch.object(subject, 'run') as command:
            subject.as_bot(self.release, 'youtube-check.mjs', self.state / 'candidate.env')
        arguments = [str(value) for value in command.call_args.args[0]]
        self.assertEqual(arguments[:4], ['runuser', '-u', 'botsvc', '--'])
        self.assertIn(str(self.app / 'scripts/youtube-check.mjs'), arguments)
        self.assertNotIn(str(self.release), ' '.join(arguments))
        self.assertEqual(command.call_args.kwargs['cwd'], self.app)
        for name in ('connect-spotify-audio.sh', 'connect-spotify-playlists.sh'):
            script = (Path(__file__).parent / name).read_text()
            self.assertIn('exec runuser -u botsvc -- env -i', script)
            self.assertIn('/opt/botsvc/audiobot/scripts/authorize-spotify-', script)
            self.assertNotIn('"$SCRIPT_DIR/', script)

    def test_privileged_commands_strip_inherited_preload_and_account_environment(self):
        with patch.object(subject.os, 'geteuid', return_value=0), patch.dict(os.environ, {'NODE_OPTIONS': '--require=/private/fixture.js', 'DISCORD_TOKEN': 'fixture-secret'}), patch.object(subject.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as command:
            subject.run(['/usr/bin/node', '--version'])
        self.assertEqual(command.call_args.kwargs['env'], subject.SAFE_ENV)
        self.assertNotIn('fixture-secret', repr(command.call_args))

    def test_status_never_returns_account_values(self):
        content = self.original + b'SPOTIFY_CLIENT_SECRET="fixture-private-secret"\n'
        (self.app / '.env').write_bytes(content)
        result = subject.integration_status(self.release)
        self.assertTrue(result['configured']['spotify-api'])
        self.assertNotIn('fixture-private', json.dumps(result))

    def test_spotify_secret_prompt_refuses_missing_tty_without_stdin_fallback_or_mutation(self):
        with patch('builtins.open', side_effect=OSError('fixture no controlling terminal')), patch('builtins.input', side_effect=AssertionError('No echoed stdin fallback is permitted')), patch.object(subject, 'checked_environment') as activate:
            with self.assertRaisesRegex(ValueError, 'needs a terminal'):
                subject.setup_spotify_api(self.release)
        activate.assert_not_called()
        self.assertEqual((self.app / '.env').read_bytes(), self.original)

    def test_signed_package_route_does_not_enable_copr_or_disable_signature_checks(self):
        with patch.object(subject, 'run') as command:
            subject.signed_packages(['caddy'], epel=True)
        arguments = command.call_args.args[0]
        self.assertIn('--disablerepo=*', arguments); self.assertIn('--setopt=gpgcheck=1', arguments)
        self.assertIn('--enablerepo=baseos,appstream,extras,crb,epel', arguments)
        self.assertNotIn('copr', ' '.join(arguments)); self.assertNotIn('--nogpgcheck', arguments)

    def test_video_refuses_other_web_servers_before_any_install_or_service_mutation(self):
        def inspect(command, **kwargs):
            return SimpleNamespace(returncode=0, stdout='LISTEN users:(("nginx",pid=99,fd=3))\n' if command[0] == 'ss' else '0')
        with patch.object(subject.subprocess, 'run', side_effect=inspect), patch.object(subject, 'run') as mutation, patch('builtins.input', side_effect=AssertionError('No reuse question for a conflicting server')), redirect_stdout(io.StringIO()), self.assertRaisesRegex(subject.IntegrationError, 'another service'):
            subject.setup_video(self.release)
        mutation.assert_not_called()

    def test_video_reuse_requires_explicit_operator_choice(self):
        def inspect(command, **kwargs):
            return SimpleNamespace(returncode=0, stdout='LISTEN users:(("caddy",pid=42,fd=3))\n' if command[0] == 'ss' else '42')
        with patch.object(subject.subprocess, 'run', side_effect=inspect), patch.object(subject.shutil, 'which', return_value='/usr/bin/caddy'), patch.object(subject, 'run') as mutation, patch('builtins.input', return_value=''), redirect_stdout(io.StringIO()), self.assertRaisesRegex(subject.IntegrationError, 'cancelled'):
            subject.setup_video(self.release)
        mutation.assert_not_called()

    def test_video_failure_restores_prior_caddy_state_after_snapshot_and_validation(self):
        configuration = self.root / 'Caddyfile'; configuration.write_text('existing.example { respond "existing" }\n')
        inspected, mutations = [], []
        def inspect(command, **kwargs):
            inspected.append(command)
            return SimpleNamespace(returncode=1 if command[:2] in (['systemctl', 'is-active'], ['systemctl', 'is-enabled']) else 0, stdout='0' if 'MainPID' in command else '')
        def mutate(command, **kwargs):
            mutations.append(command)
            if command == [self.release / 'scripts/deploy-viewer.sh']:
                raise subject.IntegrationError('fixture viewer failed')
        real_directory = subject.private_directory
        with patch.object(subject, 'CADDY_CONFIG', configuration), patch.object(subject, 'BACKUPS', self.root / 'backups'), patch.object(subject, 'private_directory', side_effect=lambda path, owner=None: real_directory(path, os.getuid())), patch.object(subject.subprocess, 'run', side_effect=inspect), patch.object(subject.shutil, 'which', return_value='/usr/bin/caddy'), patch.object(subject, 'run', side_effect=mutate), patch('builtins.input', return_value='y'), redirect_stdout(io.StringIO()), self.assertRaises(subject.IntegrationError):
            subject.setup_video(self.release)
        snapshots = list((self.root / 'backups').glob('*/Caddyfile'))
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0].read_bytes(), configuration.read_bytes())
        self.assertEqual(mutations[0][:2], ['caddy', 'validate'])
        self.assertIn(['systemctl', 'start', 'caddy'], mutations)
        self.assertIn(['systemctl', 'stop', 'caddy'], inspected)
        self.assertIn(['systemctl', 'disable', 'caddy'], inspected)

    def test_tools_reject_linked_or_writable_ancestors_before_root_interpreter_use(self):
        parent = self.root / 'tools-parent'; parent.mkdir(mode=0o755)
        with patch.object(subject, 'TOOLS', parent / 'tools'):
            subject.secure_tools_directory(owner_uid=os.getuid())
            (parent / 'tools').chmod(0o777)
            with self.assertRaisesRegex(subject.IntegrationError, 'tools directory'):
                subject.secure_tools_directory(owner_uid=os.getuid())
        alias = self.root / 'linked-parent'; alias.symlink_to(parent, target_is_directory=True)
        with patch.object(subject, 'TOOLS', alias / 'tools'), self.assertRaisesRegex(subject.IntegrationError, 'tools ancestor'):
            subject.secure_tools_directory(owner_uid=os.getuid())


if __name__ == '__main__':
    unittest.main()
