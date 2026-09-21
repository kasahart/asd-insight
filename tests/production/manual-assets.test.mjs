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
const requiredWorkflowFiles = [
  'assets/local-workflow-clean.mp4',
  'assets/local-workflow-poster.png',
  'assets/local-workflow-clean.ja.vtt',
  'sample/inspection.csv',
  'sample/tone.wav',
];

function vttTimestampMs(value) {
  const parts = value.split(':');
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  assert.equal(parts.length, 0, `invalid WebVTT timestamp: ${value}`);
  assert.ok(
    Number.isInteger(hours) && Number.isInteger(minutes) && Number.isFinite(seconds),
    `invalid WebVTT timestamp: ${value}`,
  );
  assert.ok(minutes >= 0 && minutes < 60, `invalid WebVTT minutes: ${value}`);
  assert.ok(seconds >= 0 && seconds < 60, `invalid WebVTT seconds: ${value}`);
  return (hours * 60 * 60 + minutes * 60 + seconds) * 1000;
}

function htmlTextContent(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

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
  for (const path of requiredWorkflowFiles)
    assert.ok(sourceFiles.includes(path), `manual is missing ${path}`);
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

  assert.match(html, /id="video"/);
  assert.match(html, /href="#video"/);
  assert.match(html, /inspection\.csv/);
  assert.match(html, /tone\.wav/);
  const manualText = htmlTextContent(html);
  for (const phrase of [
    'データを選ぶ',
    'CSV・TSV',
    'このデータを表示',
    '評価する異常度の列',
    '群分けに使う列',
    'サンプル名に使う列',
    '音声のファイル名・パス列',
    '判定群',
    '検査名',
    '音声名',
    '仮しきい値を設定',
    '試聴用の音声を追加',
    'スペクトログラム',
    '調査メモ',
    'スコア0.7の区間をクリック',
    '計算対象全体 6件 / 一覧表示 1件',
    '範囲を解除',
    '端末に保存済み',
    '再読込',
    '保存した分析',
    'WAV音声から異常スコアを生成しません',
    '音声なし',
    '操作間の待ち時間を省いています',
    '保存一覧は対象の分析だけを切り出し',
  ])
    assert.ok(manualText.includes(phrase), `manual text is missing: ${phrase}`);

  const videoMatch = html.match(/<video\b([^>]*)>([\s\S]*?)<\/video>/i);
  assert.ok(videoMatch, 'manual must include the workflow video');
  const [, videoAttributes, videoBody] = videoMatch;
  assert.match(videoAttributes, /\baria-label="ASD Insightの操作動画"/i);
  assert.match(videoAttributes, /\bcontrols(?:\s|$)/i);
  assert.match(videoAttributes, /\bpreload="none"/i);
  assert.match(videoAttributes, /\bplaysinline(?:\s|$)/i);
  assert.match(
    videoAttributes,
    /\bposter="\.\/assets\/local-workflow-poster\.png"/i,
  );
  assert.doesNotMatch(videoAttributes, /\b(?:autoplay|loop)(?:\s|=|$)/i);
  assert.match(
    videoBody,
    /<source\b[^>]*src="\.\/assets\/local-workflow-clean\.mp4"[^>]*>/i,
  );
  const trackMatch = videoBody.match(/<track\b([^>]*)>/i);
  assert.ok(trackMatch, 'workflow video must include a subtitle track');
  const [, trackAttributes] = trackMatch;
  assert.match(trackAttributes, /\bkind="subtitles"/i);
  assert.match(
    trackAttributes,
    /\bsrc="\.\/assets\/local-workflow-clean\.ja\.vtt"/i,
  );
  assert.match(trackAttributes, /\bsrclang="ja"/i);
  assert.match(trackAttributes, /\blabel="日本語字幕"/i);
  assert.match(trackAttributes, /\bdefault(?:\s|$)/i);
  assert.match(html, /href="\.\/assets\/local-workflow-clean\.mp4"/i);
  assert.match(
    html,
    /<a\b[^>]*href="\.\/assets\/local-workflow-clean\.ja\.vtt"[^>]*\bdownload(?:\s|=|>)/i,
  );
  for (const path of ['./sample/inspection.csv', './sample/tone.wav']) {
    const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      html,
      new RegExp(
        `<a\\b[^>]*href="${escapedPath}"[^>]*\\bdownload(?:\\s|=|>)`,
        'i',
      ),
      `${path} must be offered as a download`,
    );
  }

  const subtitles = await readFile(
    join(manual, 'assets/local-workflow-clean.ja.vtt'),
    'utf8',
  );
  assert.match(subtitles, /^\uFEFF?WEBVTT(?:[ \t].*)?(?:\r?\n|$)/);
  const cues = [
    ...subtitles.matchAll(
      /^(\d{2,}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2,}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})(?:\s+[^\r\n]*)?$/gm,
    ),
  ];
  assert.ok(cues.length > 0, 'Japanese WebVTT must contain at least one cue');
  for (const [, start, end] of cues)
    assert.ok(
      vttTimestampMs(start) < vttTimestampMs(end),
      `WebVTT cue must end after it starts: ${start} --> ${end}`,
    );
  assert.match(
    subtitles,
    /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
    'subtitle file must contain Japanese text',
  );

  const csv = (await readFile(join(manual, 'sample/inspection.csv'), 'utf8'))
    .replace(/^\uFEFF/, '')
    .trim();
  const csvRows = csv.split(/\r?\n/).map((line) => line.split(','));
  assert.deepEqual(csvRows[0], ['検査名', '異常スコア', '判定群', '音声名']);
  const records = csvRows.slice(1);
  assert.equal(records.length, 6, 'inspection fixture must contain six data rows');
  assert.ok(records.every((row) => row.length === 4));
  assert.equal(
    records.filter((row) => row[2] === '正常').length,
    3,
    'inspection fixture must contain three 正常 rows',
  );
  assert.equal(
    records.filter((row) => row[2] === '要確認').length,
    3,
    'inspection fixture must contain three 要確認 rows',
  );
  assert.equal(
    records.filter((row) => row[3] === 'tone.wav').length,
    1,
    'inspection fixture must reference tone.wav once',
  );
  assert.ok(
    records.every((row) => row[1] !== '' && Number.isFinite(Number(row[1]))),
    'inspection fixture scores must be precomputed numbers',
  );
  assertManualMarkupBalanced(html);
  const css = await readFile(join(manual, 'manual.css'), 'utf8');
  assert.match(css, /\.workflow-video\s*\{/);
  assert.match(css, /\.workflow-video-player\s*\{/);
  assert.match(css, /aspect-ratio:\s*1280\s*\/\s*840/);
  assert.match(css, /\.workflow-video-player::cue\s*\{/);
  assert.match(css, /\.workflow-video a:focus-visible/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*700px\)[\s\S]*?\.workflow-video\s*\{[\s\S]*?grid-template-columns:\s*1fr/,
  );
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
  for (const [, reference] of html.matchAll(/poster="([^"]+)"/g)) {
    const path = reference.split(/[?#]/, 1)[0];
    assert.ok(path && !path.startsWith('/'), `poster must be relative: ${reference}`);
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
