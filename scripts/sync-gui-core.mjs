import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const destination = fileURLToPath(
  new URL('../packages/wandas-gui-core/', import.meta.url),
);
const files = ['index.ts', 'package.json'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (process.argv.includes('--check')) {
  const provenance = JSON.parse(
    readFileSync(destination + 'upstream.json', 'utf8'),
  );
  if (
    provenance.repository !== 'kasahart/audio-wandas-analyzer' ||
    provenance.path !== 'src/shared/gui-core' ||
    !/^[a-f0-9]{40}$/.test(provenance.commit)
  )
    throw new Error('Invalid GUI core provenance');
  for (const file of files)
    if (hash(readFileSync(destination + file)) !== provenance.sha256[file])
      throw new Error(
        `GUI core snapshot changed: ${file}. Update from the canonical Analyzer package.`,
      );
  console.log('GUI core snapshot matches its pinned hashes');
} else {
  const flag = process.argv.indexOf('--from');
  if (flag < 0 || !process.argv[flag + 1])
    throw new Error(
      'Use --check or --from <Analyzer checkout>/src/shared/gui-core',
    );
  const source = resolve(process.argv[flag + 1]);
  const git = (...args) => execFileSync('git', ['-C', source, ...args]);
  if (
    git('rev-parse', '--show-prefix').toString().trim() !==
    'src/shared/gui-core/'
  )
    throw new Error(
      'Source must be the canonical src/shared/gui-core directory',
    );
  const origin = git('remote', 'get-url', 'origin').toString().trim();
  if (
    !/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)kasahart\/audio-wandas-analyzer(?:\.git)?\/?$/.test(
      origin,
    )
  )
    throw new Error('Source origin must be kasahart/audio-wandas-analyzer');
  const commit = git('rev-parse', 'HEAD').toString().trim();
  if (
    execFileSync(
      'git',
      ['-C', source, 'status', '--porcelain', '--', ...files],
      { encoding: 'utf8' },
    ).trim()
  )
    throw new Error('Commit the canonical package before syncing');
  const sha256 = {};
  mkdirSync(destination, { recursive: true });
  for (const file of files) {
    const bytes = git('show', `${commit}:src/shared/gui-core/${file}`);
    writeFileSync(destination + file, bytes);
    sha256[file] = hash(bytes);
  }
  writeFileSync(
    destination + 'upstream.json',
    JSON.stringify(
      {
        repository: 'kasahart/audio-wandas-analyzer',
        commit,
        path: 'src/shared/gui-core',
        sha256,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`GUI core synchronized from Analyzer ${commit}`);
}
