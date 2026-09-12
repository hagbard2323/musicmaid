#!/usr/bin/env python3
"""Check the GitHub wrapper with fake clone/build/sudo commands in temporary trees."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('deploy-from-github.sh')


class GitHubDeploymentWrapperTests(unittest.TestCase):
    def setUp(self):
        if os.geteuid() == 0:
            self.skipTest('Run wrapper fixtures unprivileged, matching its production contract.')
        self.temporary = tempfile.TemporaryDirectory(prefix='musicmaid-github-wrapper-')
        self.root = Path(self.temporary.name)
        self.runtime = self.root / 'runtime'
        self.repository = self.root / 'fake-remote'
        self.bin = self.root / 'bin'
        self.temporary_builds = self.root / 'builds'
        self.checkout = self.root / 'existing checkout'
        for path in (self.runtime, self.repository / 'scripts', self.bin, self.temporary_builds, self.checkout / '.git'):
            path.mkdir(parents=True)
        (self.checkout / '.git/HEAD').write_text('fixture branch: unchanged')
        (self.checkout / 'tracked.ts').write_text('uncommitted user changes')
        (self.checkout / 'untracked.txt').write_text('user data')
        self.runtime_env = self.runtime / '.env'
        self.runtime_env.write_text('VIEWER_ENABLED=false\nDISCORD_TOKEN=fixture-private\n')
        self.runtime_env.chmod(0o600)
        (self.repository / 'package.json').write_text('{}')
        (self.repository / 'package-lock.json').write_text('{}')
        (self.repository / 'scripts/restore-bot-database.py').write_text('# fixture helper\n')
        self.log = self.root / 'commands.jsonl'
        for name in ('deploy-bot-update.sh', 'deploy-viewer.sh'):
            (self.repository / 'scripts' / name).write_text('''#!/bin/bash
set -euo pipefail
python3 - "$0" <<'PY'
import json,os,sys
with open(os.environ['COMMAND_LOG'],'a') as output:
    output.write(json.dumps({'command':'installer','args':sys.argv[1:],'uid':os.geteuid()})+'\\n')
PY
exit "${FIXTURE_INSTALL_EXIT:-0}"
''')
        prefix = '''#!/usr/bin/python3
import json,os,sys
from pathlib import Path
with open(os.environ['COMMAND_LOG'],'a') as output:
    output.write(json.dumps({'command':Path(sys.argv[0]).name,'args':sys.argv[1:],'uid':os.geteuid()})+'\\n')
'''
        self.command('git', prefix + '''import shutil
if sys.argv[1]=='clone':
    shutil.copytree(os.environ['FIXTURE_REMOTE'],sys.argv[-1],dirs_exist_ok=True)
elif sys.argv[1:]==['rev-parse','--verify','HEAD']:
    print('0123456789abcdef0123456789abcdef01234567')
else:
    raise SystemExit('Unsafe or unexpected git mutation: '+str(sys.argv[1:]))
''')
        self.command('npm', prefix + '''if ' '.join(sys.argv[1:])==os.environ.get('FIXTURE_FAIL_BUILD'):
    raise SystemExit(19)
if sys.argv[1:]==['run','build']:
    paths=['dist/apps/bot/src/index.js']
    if os.environ.get('FIXTURE_BUILD_VIEWER','true')=='true':
        paths+=['dist/viewer/app.js','dist/apps/viewer-server/src/index.js']
    for name in paths:
        path=Path(name); path.parent.mkdir(parents=True,exist_ok=True); path.write_text('// fixture build')
''')
        self.command('sudo', prefix + '''# Never elevate in a fixture. Execute only the wrapper's fixed Node handoff.
if sys.argv[1:4]!=['/usr/bin/node','--input-type=module','-']:
    raise SystemExit('Unexpected privilege command')
import shutil
node=shutil.which('node')
if not node:
    raise SystemExit('The fixture requires Node on PATH')
os.execv(node,[node,*sys.argv[2:]])
''')
        self.wrapper = self.root / 'deploy-from-github.sh'
        self.wrapper.write_text(SCRIPT.read_text().replace('/opt/botsvc/audiobot', str(self.runtime)))
        self.wrapper.chmod(0o700)
        self.environment = {**os.environ, 'PATH': str(self.bin) + ':' + os.environ['PATH'],
                            'TMPDIR': str(self.temporary_builds), 'COMMAND_LOG': str(self.log),
                            'FIXTURE_REMOTE': str(self.repository), 'AUDIOBOT_REPO_URL': 'fixture:remote',
                            'AUDIOBOT_BRANCH': 'reviewed-release', 'AUDIOBOT_SRC_DIR': str(self.checkout)}
        for key in ('AUDIOBOT_APP_DIR', 'AUDIOBOT_APP_USER', 'AUDIOBOT_APP_GROUP'):
            self.environment.pop(key, None)

    def tearDown(self):
        self.temporary.cleanup()

    def command(self, name, body):
        path = self.bin / name
        path.write_text(body)
        path.chmod(0o700)

    def run_wrapper(self):
        return subprocess.run([str(self.wrapper)], env=self.environment, text=True, capture_output=True, timeout=10)

    def commands(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_bot_update_is_isolated_checked_unprivileged_then_delegated_once(self):
        before = {str(path.relative_to(self.checkout)): path.read_bytes() for path in self.checkout.rglob('*') if path.is_file()}
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.commands()
        self.assertEqual([row['command'] for row in commands], ['git', 'git', 'npm', 'npm', 'npm', 'npm', 'sudo', 'installer'])
        self.assertEqual([row['args'] for row in commands if row['command'] == 'npm'], [['ci'], ['run', 'check'], ['test'], ['run', 'build']])
        self.assertTrue(all(row['uid'] != 0 for row in commands), 'Fixture repository code must never execute as root')
        self.assertEqual(Path(commands[-1]['args'][0]).name, 'deploy-bot-update.sh')
        self.assertNotEqual(commands[0]['args'][-1], str(self.checkout))
        self.assertEqual(before, {str(path.relative_to(self.checkout)): path.read_bytes() for path in self.checkout.rglob('*') if path.is_file()})
        self.assertEqual(list(self.temporary_builds.iterdir()), [])
        self.assertNotIn('fixture-private', result.stdout + result.stderr)

    def test_enabled_viewer_uses_combined_transaction_without_executing_env_contents(self):
        injected = self.root / 'must-not-exist'
        self.runtime_env.write_text('VIEWER_ENABLED="true"\nUNTRUSTED=$(touch ' + str(injected) + ')\n')
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(Path(self.commands()[-1]['args'][0]).name, 'deploy-viewer.sh')
        self.assertFalse(injected.exists())

    def test_build_failure_never_reaches_sudo_or_an_installer(self):
        self.environment['FIXTURE_FAIL_BUILD'] = 'test'
        before = self.runtime_env.read_bytes()
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 19)
        self.assertNotIn('sudo', [row['command'] for row in self.commands()])
        self.assertNotIn('installer', [row['command'] for row in self.commands()])
        self.assertEqual(before, self.runtime_env.read_bytes())
        self.assertEqual(list(self.temporary_builds.iterdir()), [])

    def test_incompatible_runtime_and_account_overrides_fail_before_clone(self):
        for key, value in [('AUDIOBOT_APP_DIR', str(self.root / 'unsupported')), ('AUDIOBOT_APP_USER', 'root'), ('AUDIOBOT_APP_GROUP', 'wheel')]:
            with self.subTest(key=key):
                self.environment[key] = value
                result = self.run_wrapper()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('not supported', result.stderr)
                self.assertEqual(self.commands(), [])
                del self.environment[key]

    def test_missing_runtime_env_cannot_be_used_as_a_fresh_installer(self):
        self.runtime_env.unlink()
        result = self.run_wrapper()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('installer', [row['command'] for row in self.commands()])
        self.assertFalse(self.runtime_env.exists())

    def test_enabled_viewer_refuses_incomplete_release_instead_of_bot_only_update(self):
        self.runtime_env.write_text('VIEWER_ENABLED=true\n')
        self.environment['FIXTURE_BUILD_VIEWER'] = 'false'
        result = self.run_wrapper()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('installer', [row['command'] for row in self.commands()])

    def test_legacy_branch_without_transactional_helpers_is_rejected_before_sudo(self):
        (self.repository / 'scripts/restore-bot-database.py').unlink()
        result = self.run_wrapper()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Publish the tested release first', result.stderr)
        self.assertNotIn('sudo', [row['command'] for row in self.commands()])

    def test_installer_failure_propagates_and_cleans_only_its_isolated_build(self):
        self.environment['FIXTURE_INSTALL_EXIT'] = '23'
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 23)
        self.assertEqual((self.checkout / 'tracked.ts').read_text(), 'uncommitted user changes')
        self.assertEqual(list(self.temporary_builds.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
