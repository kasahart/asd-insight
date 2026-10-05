import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const syncScript = fileURLToPath(
  new URL('../../scripts/sync-gui-core.mjs', import.meta.url),
);
test('sync validates canonical provenance and reads committed blobs across filtered checkouts', () => {
  const root = mkdtempSync(join(tmpdir(), 'gui-core-sync-'));
  try {
    const repo = join(root, 'Analyzer checkout_日本');
    const source = join(repo, 'src/shared/gui-core');
    const consumer = join(root, 'Insight checkout_日本');
    const script = join(consumer, 'scripts/sync-gui-core.mjs');
    mkdirSync(source, { recursive: true });
    mkdirSync(join(consumer, 'scripts'), { recursive: true });
    copyFileSync(syncScript, script);
    const git = (...args) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.name', 'GUI core test');
    git('config', 'user.email', 'gui-core-test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'true');
    git(
      'remote',
      'add',
      'origin',
      'https://github.com/kasahart/audio-wandas-analyzer.git',
    );
    const bytes = 'export const value = 1;\n';
    writeFileSync(join(source, 'index.ts'), bytes.replaceAll('\n', '\r\n'));
    writeFileSync(join(source, 'package.json'), '{"private":true}\r\n');
    git('add', '.');
    git('commit', '-qm', 'Canonical fixture');
    const run = (...args) =>
      spawnSync(process.execPath, [script, ...args], {
        cwd: consumer,
        encoding: 'utf8',
      });
    const result = run('--from', source);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(consumer, 'packages/wandas-gui-core/index.ts'), 'utf8'),
      bytes,
    );
    assert.equal(run('--check').status, 0);
    writeFileSync(join(source, 'index.ts'), bytes + '// dirty\n');
    const dirty = run('--from', source);
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /Commit the canonical package/);
    git('restore', 'src/shared/gui-core/index.ts');
    const wrongPath = run('--from', repo);
    assert.notEqual(wrongPath.status, 0);
    assert.match(wrongPath.stderr, /canonical src\/shared\/gui-core directory/);
    git(
      'remote',
      'set-url',
      'origin',
      'https://github.com/other/audio-wandas-analyzer.git',
    );
    const wrongRepo = run('--from', source);
    assert.notEqual(wrongRepo.status, 0);
    assert.match(wrongRepo.stderr, /Source origin must be/);
    writeFileSync(
      join(consumer, 'packages/wandas-gui-core/index.ts'),
      '// edited snapshot\n',
    );
    const changed = run('--check');
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /GUI core snapshot changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
