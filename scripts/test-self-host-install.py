#!/usr/bin/env python3
"""Exercise fresh-host installation against a temporary filesystem and fake commands."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from self_host import install as backend
from self_host.maintenance import Layout, Maintenance

REPO = Path(__file__).resolve().parent.parent


class FakeHost(backend.Host):
    def __init__(self, root):
        super().__init__(root, self.execute)
        self.calls, self.owners = [], {}
        self.user = 0
        self.available = set(('node', 'npm', 'podman', 'rsync', 'git', 'curl', 'python3', 'pip3', 'openssl', 'ss', 'systemd-notify', 'systemctl'))
        self.node_version = 'v22.23.2\n'
        self.account = False
        self.active, self.containers = set(), set()
        self.occupied = set()
        self.fail_commands = set()
        self.bot_ok = self.audio_ok = True
        self.reject_new_token = False
        for name in ('/etc', '/opt', '/run/systemd/system', '/etc/polkit-1/rules.d'):
            self.path(name).mkdir(parents=True, exist_ok=True)
        self.path('/usr/bin').mkdir(parents=True)
        self.path('/usr/bin/ss').write_text('fixture executable'); self.path('/usr/bin/ss').chmod(0o755)
        self.path('/etc/os-release').write_text('ID="almalinux"\nVERSION_ID="10.2"\n')

    def uid(self): return self.user
    def caller_uid(self): return os.geteuid()
    def architecture(self): return 'x86_64'
    def executable(self, name): return name in self.available
    def command_path(self, name): return super().command_path(name) if name == 'ss' else '/usr/bin/' + name if name in self.available else None
    def sleep(self, seconds): pass
    def audio_ready(self, password): return self.audio_ok

    def info(self, path):
        info = Path(path).lstat()
        uid, gid = self.owners.get(str(path), (0, 0))
        return SimpleNamespace(st_mode=info.st_mode, st_uid=uid, st_gid=gid, st_size=info.st_size)

    def chown(self, path, uid, gid):
        self.owners[str(path)] = (uid, gid)

    def execute(self, args, **_kwargs):
        self.calls.append(args)
        command = (Path(args[0]).name, *args[1:])
        code, output = 0, ''
        if command in self.fail_commands:
            return subprocess.CompletedProcess(args, 1, '', 'fixture failure')
        if command[:2] == ('node', '--version'):
            output = self.node_version
        elif command[0] == 'getent':
            if not self.account:
                code = 2
            else:
                output = 'botsvc:x:991:991::/opt/botsvc:/sbin/nologin\n' if command[1] == 'passwd' else 'botsvc:x:991:\n'
        elif command[0] == 'useradd':
            self.account = True
        elif command[0] == 'userdel':
            self.account = False
        elif command[:3] == ('podman', 'container', 'exists'):
            code = 0 if command[3] in self.containers else 1
        elif command[0] == 'ss':
            if int(args[-1].rsplit(':', 1)[1]) in self.occupied:
                output = 'LISTEN 0 100 127.0.0.1:' + args[-1].rsplit(':', 1)[1]
        elif command[0] == 'dnf':
            self.available.update(('node', 'npm', 'podman', 'rsync', 'git', 'curl', 'python3', 'pip3', 'openssl', 'ss', 'systemd-notify'))
            self.node_version = 'v22.23.2\n'
            self.path('/etc/polkit-1/rules.d').mkdir(parents=True, exist_ok=True)
        elif command[:2] == ('systemctl', 'show'):
            output = 'not-found\n' if args[-2] == 'LoadState' else 'a' * 32 + '\n'
        elif command[:2] == ('systemctl', 'start'):
            self.active.add(command[2])
        elif command[:2] == ('systemctl', 'stop'):
            self.active.discard(command[2])
        elif command[:2] == ('systemctl', 'is-active'):
            code = 0 if args[-1] in self.active else 3
        elif command[0] == 'journalctl':
            invalid = self.reject_new_token and 'bad-fixture-token' in self.path(backend.APP + '/.env').read_text()
            if self.bot_ok and not invalid:
                output = 'Registered MusicMaid guild commands.\nMusicMaid ready.\n'
        return subprocess.CompletedProcess(args, code, output, '')


class SelfHostInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='musicmaid-fresh-install-')
        self.directory = Path(self.temp.name)
        self.host = FakeHost(self.directory / 'host')
        self.release = self.directory / 'release'
        for name, contents in {
            'package.json': '{"type":"module"}', 'package-lock.json': '{}', 'apps/bot/src/index.ts': '// source',
            'dist/apps/bot/src/index.js': '// compiled fixture', 'dist/apps/bot/src/runtime/watchdog.js': '// watchdog',
            'dist/apps/bot/src/runtime/release-info.js': '// release info',
        }.items():
            path = self.release / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(contents)
        for name in ('deploy/audiobot.service', 'deploy/50-audiobot-restart.rules', 'infra/lavalink/application.yml'):
            path = self.release / name; path.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(REPO / name, path)
        for module in ('discord.js', 'shoukaku', 'dotenv'):
            path = self.release / 'node_modules' / module; path.mkdir(parents=True); (path / 'package.json').write_text('{}')
        (self.release / '.setup').mkdir(mode=0o700)
        self.config = self.release / '.setup/settings.json'
        self.settings = {'version': 1, 'discord': {'token': 'fixture-token-' + 'x' * 40, 'clientId': '123456789012345678',
                         'guildId': '123456789012345679', 'musicTextChannelId': '123456789012345680', 'adminRoleIds': []},
                         'lavalink': {'password': 'fixtureRandomSecret_' + 'y' * 40}, 'sources': {}, 'viewer': {'enabled': False}, 'steps': {}}
        self.save_settings()
        (self.release / 'private-research.md').write_text('must not copy unrelated operator material')
        (self.release / '.env').write_text('must not copy this environment')
        self.manifest()

    def tearDown(self): self.temp.cleanup()

    def save_settings(self):
        self.config.write_text(json.dumps(self.settings)); self.config.chmod(0o600)

    def manifest(self):
        names = ['package.json', 'package-lock.json', 'apps/bot/src/index.ts', 'deploy/audiobot.service',
                 'deploy/50-audiobot-restart.rules', 'infra/lavalink/application.yml']
        digest = ''.join(name + '\0' + hashlib.sha256((self.release / name).read_bytes()).hexdigest() + '\n' for name in sorted(names))
        manifest = {'version': 1, 'revision': 'b' * 40, 'dirty': False, 'builtAt': '2026-09-12T00:00:00Z',
                    'dependencyHash': hashlib.sha256((self.release / 'package-lock.json').read_bytes()).hexdigest(),
                    'sourceHash': hashlib.sha256(digest.encode()).hexdigest()}
        data = json.dumps(manifest)
        (self.release / 'release-manifest.json').write_text(data); (self.release / 'dist/release.json').write_text(data)

    def install(self): return backend.install(self.release, self.config, host=self.host)

    def test_read_only_check_and_bootstrap_install_only_fixed_missing_prerequisites(self):
        self.host.available.difference_update(('node', 'npm', 'podman', 'pip3', 'openssl'))
        report = backend.check_host(self.release, host=self.host)
        self.assertTrue(report['supported']); self.assertFalse(report['existing']); self.assertFalse(report['dependencies']['node'])
        self.assertFalse(any(Path(call[0]).name in ('dnf', 'useradd') for call in self.host.calls))
        report = backend.bootstrap(self.release, host=self.host)
        self.assertTrue(all(report['dependencies'].values()))
        calls = [call for call in self.host.calls if Path(call[0]).name == 'dnf']
        self.assertEqual(calls, [['/usr/bin/dnf', 'install', '-y', 'nodejs', 'nodejs-npm', 'openssl', 'podman', 'python3-pip']])
        self.assertFalse(self.host.path(backend.APP).exists())

    def test_nonroot_protected_paths_remain_unknown_until_privileged_preflight(self):
        self.host.user = os.geteuid() or 1000
        target = self.host.path('/etc/polkit-1/rules.d/50-audiobot-restart.rules')
        real_exists = Path.exists
        def protected_exists(path):
            if path == target: raise PermissionError('fixture protected parent')
            return real_exists(path)
        with patch.object(Path, 'exists', protected_exists):
            report = backend.check_host(self.release, host=self.host)
            self.assertTrue(report['supported']); self.assertFalse(report['existing']); self.assertTrue(report['rootVerificationPending']); self.assertEqual(report['conflicts'], [])
            self.host.user = 0
            report = backend.check_host(self.release, host=self.host)
            self.assertTrue(report['conflicts']); self.assertFalse(report['rootVerificationPending'])

    def test_almalinux_sbin_ss_is_used_without_changing_node_or_npm_paths(self):
        self.host.path('/usr/bin/ss').unlink(); self.host.path('/usr/sbin').mkdir(parents=True)
        self.host.path('/usr/sbin/ss').write_text('fixture executable'); self.host.path('/usr/sbin/ss').chmod(0o755)
        self.assertEqual(backend.Host.command_path(self.host, 'ss'), '/usr/sbin/ss')
        report = backend.check_host(self.release, host=self.host)
        self.assertTrue(report['dependencies']['ss']); self.assertFalse(report['conflicts'])
        self.assertTrue(any(call[0] == '/usr/sbin/ss' for call in self.host.calls))
        self.assertTrue(any(call[0] == '/usr/bin/node' for call in self.host.calls))

    def test_conflicts_and_unsupported_platform_fail_before_mutating_host(self):
        self.host.occupied.add(2333)
        with self.assertRaisesRegex(backend.SetupError, '2333'): self.install()
        self.assertFalse(any(Path(call[0]).name in ('useradd', 'dnf') or call[1:2] == ['pull'] for call in self.host.calls))
        self.host.occupied.clear(); self.host.path('/etc/os-release').write_text('ID=fedora\nVERSION_ID=44\n')
        with self.assertRaisesRegex(backend.SetupError, 'AlmaLinux'): backend.bootstrap(self.release, host=self.host)

    def test_existing_runtime_and_untrusted_tools_ancestor_are_never_reused(self):
        parent = self.host.path('/opt/botsvc'); parent.mkdir()
        self.host.owners[str(parent)] = (991, 991)
        with self.assertRaisesRegex(backend.SetupError, 'root-owned'): self.install()
        self.assertEqual(self.host.owners[str(parent)], (991, 991))
        self.host.owners[str(parent)] = (0, 0)
        runtime = self.host.path(backend.APP); runtime.mkdir(); sentinel = runtime / 'existing'; sentinel.write_text('keep')
        with self.assertRaisesRegex(backend.SetupError, 'already exist'): self.install()
        self.assertEqual(sentinel.read_text(), 'keep')

    def test_private_settings_require_expected_owner_exact_mode_and_no_symlinks(self):
        self.config.chmod(0o644)
        with self.assertRaisesRegex(backend.SetupError, '0600'): self.install()
        self.config.chmod(0o600)
        with patch.object(self.host, 'caller_uid', return_value=os.geteuid() + 1):
            with self.assertRaisesRegex(backend.SetupError, 'invoking account'): self.install()
        linked = self.release / '.setup/linked.json'; linked.symlink_to(self.config)
        with self.assertRaisesRegex(backend.SetupError, 'Linked'): backend.install(self.release, linked, host=self.host)
        self.assertEqual(self.host.calls, [])

    def test_manifest_tamper_or_escaping_dependency_links_are_rejected_without_commands(self):
        (self.release / 'apps/bot/src/index.ts').write_text('// modified after build')
        with self.assertRaisesRegex(backend.SetupError, 'clean, complete'): self.install()
        self.manifest()
        (self.release / 'node_modules/escape').symlink_to(self.directory)
        with self.assertRaisesRegex(backend.SetupError, 'clean, complete'): self.install()
        self.assertEqual(self.host.calls, [])

    def test_fresh_install_writes_private_secrets_root_tools_and_owned_fixed_services(self):
        result = self.install(); self.assertTrue(result['ready']); self.assertTrue(result['audioReady'])
        env = self.host.path(backend.APP + '/.env'); lava_env = self.host.path(backend.LAVA_ENV)
        self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600); self.assertEqual(stat.S_IMODE(lava_env.stat().st_mode), 0o600)
        self.assertEqual(self.host.owners[str(env)], (991, 991)); self.assertEqual(self.host.owners[str(lava_env)], (0, 0))
        for name in ('/opt/botsvc', backend.TOOLS):
            self.assertEqual(self.host.owners[str(self.host.path(name))], (0, 0)); self.assertEqual(stat.S_IMODE(self.host.path(name).stat().st_mode), 0o755)
        secret = self.settings['lavalink']['password']; self.assertIn(secret, env.read_text()); self.assertIn(secret, lava_env.read_text())
        units = '\n'.join(self.host.path(path).read_text() for path in backend.FILES if path.endswith(('.service', '.container', '.rules')))
        self.assertNotIn(secret, units); self.assertNotIn(self.settings['discord']['token'], units); self.assertNotIn('audiobot-ipv6', units)
        self.assertIn('EnvironmentFile=/etc/audiobot-lavalink.env', units); self.assertIn('WatchdogSec=60', units)
        self.assertNotIn('youshallnotpass', self.host.path(backend.LAVA + '/application.yml').read_text())
        self.assertFalse(self.host.path(backend.APP + '/.setup').exists()); self.assertFalse(self.host.path(backend.APP + '/private-research.md').exists())
        marker = backend.require_managed_root(host=self.host); self.assertEqual(marker['managedBy'], 'musicmaid-self-host')
        self.assertEqual(set(marker['units']), set(backend.UNITS)); self.assertNotIn(secret, json.dumps(result) + json.dumps(marker) + repr(self.host.calls))
        self.assertFalse(any(Path(call[0]).name in ('npm', 'cargo') for call in self.host.calls))

    def test_optional_offline_and_failed_bot_start_leave_a_managed_recoverable_install(self):
        self.host.bot_ok = self.host.audio_ok = False
        self.host.fail_commands.add(('systemctl', 'start', 'audiobot.service'))
        result = self.install(); self.assertEqual(result['status'], 'installed_needs_attention'); self.assertFalse(result['ready'])
        self.assertTrue(self.host.path(backend.APP + '/.env').exists()); self.assertTrue(self.host.account)
        self.assertEqual(backend.require_managed_root(host=self.host)['appDir'], backend.APP)
        self.assertFalse(any(call[1:2] == ['stop'] for call in self.host.calls))

    def test_initial_bad_login_can_be_repaired_through_managed_configuration(self):
        self.settings['discord']['token'] = 'bad-fixture-token-' + 'b' * 40; self.save_settings(); self.host.reject_new_token = True
        result = self.install(); self.assertFalse(result['ready']); self.assertTrue(result['managed'])
        self.settings['discord']['token'] = 'good-fixture-token-' + 'g' * 40; self.save_settings()
        result = backend.configure_core(self.release, self.config, host=self.host)
        self.assertTrue(result['ready']); self.assertIn('good-fixture-token-', self.host.path(backend.APP + '/.env').read_text())

    def test_mutating_module_apis_refuse_a_nonroot_caller(self):
        self.host.user = os.geteuid() or 1000
        for operation in (lambda: backend.bootstrap(self.release, host=self.host), self.install,
                          lambda: backend.configure_core(self.release, self.config, host=self.host)):
            with self.assertRaisesRegex(backend.SetupError, 'sudo'): operation()
        self.assertEqual(self.host.calls, [])

    def test_marker_validation_refuses_foreign_ownership_and_arbitrary_service_names(self):
        self.install(); path = self.host.path(backend.MARKER)
        self.host.owners[str(path)] = (991, 991)
        with self.assertRaisesRegex(backend.SetupError, 'ownership marker'): backend.require_managed_root(host=self.host)
        self.host.owners[str(path)] = (0, 0)
        marker = json.loads(path.read_text()); marker['units'].append('unrelated.service'); path.write_text(json.dumps(marker))
        with self.assertRaisesRegex(backend.SetupError, 'ownership marker'): backend.require_managed_root(host=self.host)

    def test_hard_install_failure_rolls_back_only_new_owned_files_and_account(self):
        sentinel = self.host.path('/opt/other-service'); sentinel.write_text('unrelated')
        self.host.fail_commands.add(('systemctl', 'enable', 'audiobot.service'))
        with self.assertRaises(backend.SetupError): self.install()
        for path in (backend.APP, backend.STATE, backend.LAVA, backend.TOOLS, *backend.FILES): self.assertFalse(self.host.path(path).exists(), path)
        self.assertFalse(self.host.account); self.assertEqual(sentinel.read_text(), 'unrelated'); self.assertTrue(self.config.exists())
        self.assertFalse(any('other-service' in ' '.join(call) for call in self.host.calls))

    def test_rollback_stop_failure_preserves_all_new_files_and_account(self):
        original = backend._new_file
        def fail_marker(path, *args, **kwargs):
            if path == self.host.path(backend.MARKER): raise backend.SetupError('fixture final write failure')
            return original(path, *args, **kwargs)
        self.host.fail_commands.add(('systemctl', 'stop', 'lavalink.service'))
        with patch.object(backend, '_new_file', fail_marker):
            with self.assertRaisesRegex(backend.SetupError, 'retained'): self.install()
        self.assertTrue(self.host.path(backend.APP + '/.env').exists()); self.assertTrue(self.host.account)
        stops = [call[-1] for call in self.host.calls if call[1:2] == ['stop']]
        self.assertEqual(set(stops), set(backend.UNITS)); self.assertFalse(self.host.path(backend.MARKER).exists())

    def test_managed_discord_reconfiguration_preserves_sources_viewer_and_audio_password(self):
        self.install(); env = self.host.path(backend.APP + '/.env')
        env.write_text(env.read_text() + 'SPOTIFY_CLIENT_SECRET="keep-source-secret"\nVIEWER_ENABLED=true\n')
        grant = self.host.path(backend.STATE + '/spotify-direct.json'); grant.write_text('preserve-grant')
        lava = self.host.path(backend.LAVA_ENV).read_bytes()
        self.settings['discord']['token'] = 'new-fixture-token-' + 'n' * 40; self.save_settings(); self.host.calls.clear()
        result = backend.configure_core(self.release, self.config, host=self.host)
        self.assertTrue(result['ready']); self.assertIn(self.settings['discord']['token'], env.read_text())
        self.assertIn('keep-source-secret', env.read_text()); self.assertIn('VIEWER_ENABLED=true', env.read_text())
        self.assertEqual(grant.read_text(), 'preserve-grant'); self.assertEqual(lava, self.host.path(backend.LAVA_ENV).read_bytes())
        changed = [call for call in self.host.calls if call[1:2] in (['start'], ['stop'])]
        self.assertTrue(all(call[-1] == 'audiobot.service' for call in changed))

    def test_core_configuration_shares_maintenance_lock_before_settings_or_service_changes(self):
        self.install(); self.host.calls.clear()
        env = self.host.path(backend.APP + '/.env'); before = env.read_bytes()
        holder = Maintenance(Layout(self.host.root), owner_uid=os.geteuid())
        with holder._lock(), patch.object(backend, '_settings', side_effect=AssertionError('Do not read the draft before acquiring the shared lock')):
            with self.assertRaisesRegex(backend.SetupError, 'Another self-host maintenance'):
                backend.configure_core(self.release, self.config, host=self.host)
        self.assertEqual(self.host.calls, [])
        self.assertEqual(env.read_bytes(), before)
        self.assertEqual(list(self.host.path('/var/backups/audiobot').glob('core-config-*')), [])
        result = backend.configure_core(self.release, self.config, host=self.host)
        self.assertTrue(result['configured'], 'The same operation succeeds after the competing transaction releases its lock')

    def test_failed_core_configuration_releases_shared_maintenance_lock(self):
        self.install()
        self.settings['discord']['token'] = 'bad-fixture-token-' + 'b' * 40
        self.save_settings(); self.host.reject_new_token = True
        with self.assertRaisesRegex(backend.SetupError, 'previous .env was restored'):
            backend.configure_core(self.release, self.config, host=self.host)
        with Maintenance(Layout(self.host.root), owner_uid=os.geteuid())._lock():
            pass

    def test_failed_new_discord_login_restores_old_env_and_same_guild_guard_prevents_repointing(self):
        self.install(); env = self.host.path(backend.APP + '/.env'); before = env.read_bytes()
        self.settings['discord']['token'] = 'bad-fixture-token-' + 'b' * 40; self.save_settings(); self.host.reject_new_token = True
        with self.assertRaisesRegex(backend.SetupError, 'previous .env was restored'):
            backend.configure_core(self.release, self.config, host=self.host)
        self.assertEqual(env.read_bytes(), before); self.assertIn('audiobot.service', self.host.active)
        self.settings['discord']['guildId'] = '987654321098765432'; self.save_settings(); self.host.calls.clear()
        with self.assertRaisesRegex(backend.SetupError, 'same Discord server'):
            backend.configure_core(self.release, self.config, host=self.host)
        self.assertEqual(self.host.calls, []); self.assertEqual(env.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
