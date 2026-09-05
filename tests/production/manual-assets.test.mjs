import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const manual = join(root, 'manual');
const prepared = join(root, 'runtime', 'prepared', 'manual');
const balancedTags = new Set(['section', 'div', 'figure', 'a']);

function assertManualMarkupBalanced(html) {
  const stack = [];
  const tagPattern = /<\/?([a-z][\w:-]*)(?:\s[^<>]*?)?\/?\s*>/gi;
  for (const match of html.matchAll(tagPattern)) {
    const tag = match[1].toLowerCase();
    if (!balancedTags.has(tag)) continue;
    const token = match[0];
    if (token.startsWith('</')) {
      assert.equal(
        stack.pop(),
        tag,
        `manual closing tag </${tag}> does not match its opening tag`,
      );
    } else if (!token.endsWith('/>')) {
      stack.push(tag);
    }
  }
  assert.deepEqual(stack, [], 'manual has unclosed section/div/figure/a tags');
}

async function filesUnder(directory) {
  const result = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(relative(directory, path));
    }
  }
  await visit(directory);
  return result.sort();
}

test('manual is a self-contained static bundle and prepare-static copies it exactly', async () => {
  await run(process.execPath, ['scripts/prepare-static.mjs'], { cwd: root });
  const sourceFiles = await filesUnder(manual);
  const preparedFiles = await filesUnder(prepared);
  assert.ok(sourceFiles.includes('index.html'));
  assert.ok(sourceFiles.includes('manual.css'));
  assert.ok(sourceFiles.some((path) => path.endsWith('.png')));
  assert.ok(sourceFiles.some((path) => path.endsWith('.gif')));
  assert.ok(sourceFiles.includes('assets/02-select-threshold.gif'));
  assert.ok(sourceFiles.includes('assets/02-select-threshold.png'));
  assert.ok(sourceFiles.includes('assets/05-save-reopen.png'));
  assert.deepEqual(preparedFiles, sourceFiles);
  for (const path of sourceFiles) {
    assert.deepEqual(
      await readFile(join(prepared, path)),
      await readFile(join(manual, path)),
      `prepared manual differs from source for ${path}`,
    );
  }

  const html = await readFile(join(manual, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /(?:https?:)?\/\//i);
  assert.match(html, /スコア<\/dt>[\s\S]*数値/);
  assert.match(html, /群分け<\/dt>[\s\S]*2値、または数値の境界/);
  assert.match(html, /サンプル \/ 音声<\/dt>[\s\S]*任意/);
  assert.match(
    html,
    /参考・探索分析です[\s\S]*検査合否や運用しきい値の承認には使用しません/,
  );
  assert.match(html, /初期値の1%は操作用の仮値/);
  assert.match(html, /部分一致（含む）.*「完全一致」/);
  assert.match(html, /分析の来歴・条件と確認用JSON/);
  assert.match(html, /同じブラウザープロファイル[\s\S]*利用者別に暗号化/);
  assert.match(html, /範囲を絞る/);
  assert.match(html, /しきい値を調整/);
  assert.match(html, /02-select-threshold\.gif/);
  assert.match(html, /02-select-threshold\.png/);
  assert.match(html, /05-save-reopen\.png/);
  assert.match(html, /探索用の仮しきい値を示す縦線と上端のハンドル/);
  assert.match(html, /仮しきい値の縦線と上端のハンドル（coral色）/);
  assertManualMarkupBalanced(html);
  const css = await readFile(join(manual, 'manual.css'), 'utf8');
  assert.match(css, /\.motion-static\s*\{\s*display:\s*none;/);
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.motion-gif\s*\{\s*display:\s*none;[\s\S]*?\.motion-static\s*\{\s*display:\s*block;/,
  );
  const motionGifLinks = [
    ...html.matchAll(/<a\b[^>]*class="[^"]*\bmotion-gif\b[^"]*"[^>]*>/g),
  ];
  const motionStaticLinks = [
    ...html.matchAll(/<a\b[^>]*class="[^"]*\bmotion-static\b[^"]*"[^>]*>/g),
  ];
  assert.equal(
    motionGifLinks.length,
    4,
    'GIF visibility class belongs on each GIF link',
  );
  assert.equal(
    motionStaticLinks.length,
    4,
    'static visibility class belongs on each paired static link',
  );
  assert.doesNotMatch(html, /<img\b[^>]*class="[^"]*\bmotion-(?:gif|static)\b/);
  const imageLinks = [
    ...html.matchAll(
      /<a\s+class="[^"]*\bimage-link\b[^"]*"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<img\b[^>]*src="([^"]+)"/g,
    ),
  ];
  assert.ok(
    imageLinks.length >= 9,
    'every manual visual has an original-size link',
  );
  for (const [, href, src] of imageLinks) assert.equal(href, src);
  for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const path = reference.split(/[?#]/, 1)[0];
    if (!path) continue;
    assert.ok(
      !path.startsWith('/'),
      `manual reference must be relative: ${reference}`,
    );
    await access(join(manual, path));
  }
});

test('release inventory includes the manual when a built release is present', async () => {
  const manifestPath = join(root, 'dist', 'release-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const manifestPaths = new Set(manifest.files?.map((entry) => entry.path));
  for (const path of await filesUnder(manual))
    assert.ok(
      manifestPaths.has(`manual/${path}`),
      `release is missing manual/${path}`,
    );
});
