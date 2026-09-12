import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../../../scripts/release-manifest.mjs', import.meta.url));
const { buildManifest, validateManifest, sourceHash, sourceInputs } = await import(new URL('../../../scripts/release-manifest.mjs', import.meta.url).href);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const gitEnvironment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env: gitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'musicmaid-manifest-')), root = join(directory, 'checkout'); mkdirSync(root);
  const files: Record<string, string> = {
    'package.json': '{"name":"fixture","private":true}', 'package-lock.json': '{"name":"fixture","lockfileVersion":3}',
    'apps/bot/src/index.ts': 'export const release = "fixture";\n', 'scripts/example.sh': '#!/bin/bash\ntrue\n',
    'infra/lavalink/application.yml': 'server:\n  port: 2333\n', 'bin/SHA256SUMS': 'fixture-helper-checksum\n'
  };
  for (const [name, value] of Object.entries(files)) { const path = join(root, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, value); }
  git(root, 'init', '-q'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Fixture release');
  return { directory, root, close: () => rmSync(directory, { recursive: true, force: true }) };
}
function archiveOf(directory: string, root: string, manifest: unknown) {
  const archive = join(directory, 'archive');
  cpSync(root, archive, { recursive: true, filter: source => source !== join(root, '.git') });
  writeFileSync(join(archive, 'release-manifest.json'), JSON.stringify(manifest));
  return archive;
}
function check(root: string) { return spawnSync(process.execPath, [script, '--check', root], { env: gitEnvironment, encoding: 'utf8' }); }

test('clean committed release records exact revision, source inputs and dependency lock and passes CLI check', () => {
  const f = fixture();
  try {
    const manifest = buildManifest(f.root);
    assert.match(manifest.revision, /^[a-f0-9]{40}$/); assert.equal(manifest.revision, git(f.root, 'rev-parse', 'HEAD'));
    assert.equal(manifest.dirty, false); assert.ok(Number.isFinite(Date.parse(manifest.builtAt)));
    assert.equal(manifest.sourceHash, sourceHash(f.root));
    assert.equal(manifest.dependencyHash, digest(readFileSync(join(f.root, 'package-lock.json'), 'utf8')));
    writeFileSync(join(f.root, 'release-manifest.json'), JSON.stringify(manifest));
    assert.equal(check(f.root).status, 0);
  } finally { f.close(); }
});

test('archive rebuild preserves provenance instead of inventing a checkout revision or build timestamp', () => {
  const f = fixture();
  try {
    const manifest = buildManifest(f.root), archive = archiveOf(f.directory, f.root, manifest);
    assert.deepEqual(buildManifest(archive), manifest);
    const result = spawnSync(process.execPath, [script, '--build', archive], { env: gitEnvironment, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(archive, 'dist/release.json'), 'utf8')), manifest);
    assert.deepEqual(JSON.parse(readFileSync(join(archive, 'release-manifest.json'), 'utf8')), manifest);
  } finally { f.close(); }
});

test('altered archived source, audio deployment configuration, helper checksum and dependency lock fail validation', () => {
  for (const input of ['apps/bot/src/index.ts', 'infra/lavalink/application.yml', 'bin/SHA256SUMS', 'package-lock.json']) {
    const f = fixture();
    try {
      const manifest = buildManifest(f.root), archive = archiveOf(f.directory, f.root, manifest);
      writeFileSync(join(archive, input), 'changed fixture input\n');
      assert.throws(() => validateManifest(archive, manifest, true), /changed|does not match/, input);
      assert.notEqual(check(archive).status, 0, input);
    } finally { f.close(); }
  }
});

test('compiled-only bundle preserves declared source provenance while still validating its lock', () => {
  const f = fixture();
  try {
    const manifest = buildManifest(f.root), archive = archiveOf(f.directory, f.root, manifest);
    rmSync(join(archive, 'apps'), { recursive: true });
    mkdirSync(join(archive, 'dist/apps/bot/src'), { recursive: true });
    writeFileSync(join(archive, 'dist/apps/bot/src/index.js'), '// compiled fixture\n');
    assert.deepEqual(validateManifest(archive, manifest, true), manifest);
    assert.equal(check(archive).status, 0);
    writeFileSync(join(archive, 'package-lock.json'), '{}');
    assert.throws(() => validateManifest(archive, manifest, true), /dependency lock/);
  } finally { f.close(); }
});

test('unknown provenance and both tracked/untracked dirty source builds are refused by --check', () => {
  const f = fixture();
  try {
    for (const change of ['tracked', 'untracked']) {
      if (change === 'untracked') {
        git(f.root, 'checkout', '--', 'apps/bot/src/index.ts');
        assert.equal(git(f.root, 'status', '--porcelain', '--untracked-files=no'), '', 'Untracked-source coverage must not rely on a previous tracked change.');
      }
      const path = join(f.root, change === 'tracked' ? 'apps/bot/src/index.ts' : 'apps/bot/src/new.ts');
      writeFileSync(path, 'export const pendingChange = true;\n');
      const manifest = buildManifest(f.root); assert.equal(manifest.dirty, true);
      writeFileSync(join(f.root, 'release-manifest.json'), JSON.stringify(manifest));
      assert.notEqual(check(f.root).status, 0);
    }
    const unknown = join(f.directory, 'unknown'); mkdirSync(unknown);
    writeFileSync(join(unknown, 'package-lock.json'), '{}');
    const manifest = buildManifest(unknown); assert.equal(manifest.revision, 'unknown'); assert.equal(manifest.dirty, true);
    writeFileSync(join(unknown, 'release-manifest.json'), JSON.stringify(manifest));
    assert.notEqual(check(unknown).status, 0);
  } finally { f.close(); }
});

test('release hashing is deterministic and rejects symbolic links in source inputs', () => {
  const f = fixture();
  try {
    const names = sourceInputs(f.root); assert.deepEqual(names, [...names].sort());
    const before = sourceHash(f.root);
    mkdirSync(join(f.root, 'scripts/__pycache__')); writeFileSync(join(f.root, 'scripts/__pycache__/cache.pyc'), 'ignored cache');
    mkdirSync(join(f.root, 'dist')); writeFileSync(join(f.root, 'dist/index.js'), 'generated output');
    assert.equal(sourceHash(f.root), before);
    symlinkSync(join(f.root, 'package.json'), join(f.root, 'apps/bot/src/symlink.ts'));
    assert.throws(() => sourceInputs(f.root), /symbolic links/);
    rmSync(join(f.root, 'apps/bot/src/symlink.ts'));
    symlinkSync(join(f.root, 'missing-target'), join(f.root, 'scripts/missing.sh'));
    assert.throws(() => sourceInputs(f.root), /symbolic links/, 'Dangling links must not disappear from the verified input set.');
  } finally { f.close(); }
});
