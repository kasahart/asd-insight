import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);

function csp(source, name) {
  const match = source.match(new RegExp(`const ${name} =\\s*"([^"]+)";`));
  assert.ok(match, `Vite ${name} is missing`);
  return match[1];
}

test('preview CSP policies preserve the application and audio-worker boundary', async () => {
  const vite = await readFile(new URL('vite.config.ts', root), 'utf8');
  const page = csp(vite, 'pageCsp');
  const audio = csp(vite, 'audioCsp');
  assert.doesNotMatch(page, /'unsafe-eval'/);
  assert.match(page, /'wasm-unsafe-eval'/);
  assert.match(audio, /'wasm-unsafe-eval'/);
  assert.match(audio, /'unsafe-eval'/);
});

test('dev and build lifecycle gates verify the prepared audio runtime', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.match(
    packageJson.scripts.predev,
    /npm run runtime:check/,
    'predev must reject a stale runtime before starting a preview',
  );
  assert.match(
    packageJson.scripts.prebuild,
    /npm run runtime:check/,
    'prebuild must reject a stale runtime before Vite embeds it',
  );
});
