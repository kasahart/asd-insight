import { expect, test, type Page, type Locator } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

const csv = 'sample_id,score,group,audio_file\na,1,A,A/a.wav\nb,2,B,B/b.wav\n';
function wav(size = 1600, value = 0) {
  const b = Buffer.alloc(44 + size, value); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(size, 40); return b;
}
async function folder(keys: string[], changed = false, large = 0) {
  const root = await mkdtemp(join(tmpdir(), 'insight-flow-repair-'));
  for (const key of keys) {
    await mkdir(join(root, key, '..'), { recursive: true });
    await writeFile(join(root, key), key.endsWith('.wav') ? wav(key === 'A/a.wav' && large ? large : 1600, changed && key === 'A/a.wav' ? 1 : 0) : 'not wav');
    await utimes(join(root, key), new Date('2026-01-01'), new Date('2026-01-01'));
  }
  return root;
}
async function start(page: Page) {
  await page.goto('/'); await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  return page.getByRole('dialog', { name: 'データと保存した分析' });
}
async function csvInput(dialog: Locator, text = csv, name = 'qa.csv') {
  await dialog.locator('input[accept=".csv,.tsv"]').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
}
async function createAudio(page: Page, root: string) {
  const dialog = await start(page);
  await dialog.getByLabel('新規解析のWAVフォルダ', { exact: true }).setInputFiles(root);
  await csvInput(dialog); await dialog.getByRole('radio', { name: /軽量保存：/ }).check();
  await dialog.getByRole('button', { name: '対応を確認', exact: true }).click();
  const go = dialog.getByRole('button', { name: '対応を確認して解析を開始', exact: true });
  await expect(go).toBeEnabled(); await go.click(); await expect(dialog).not.toBeVisible();
  await expect(page.locator('main.main-panel')).toHaveAttribute('aria-busy', 'false');
}
const targets = (page: Page) => page.getByLabel('音源の指標対象件数');
const preview = (page: Page) => page.getByRole('region', { name: '音声の取り込み前確認' });
const saved = (page: Page) => expect(page.getByRole('button', { name: /保存状態と分析を管理/ })).toContainText('端末に保存済み');
async function selectFolder(page: Page, root: string) {
  await expect(page.getByRole('button', { name: 'WAVフォルダを選択', exact: true })).toBeVisible();
  await page.locator('input[webkitdirectory]').setInputFiles(root);
  await expect(preview(page)).toBeVisible();
}
async function observation(info, data: object) { await writeFile(info.outputPath('observations.json'), JSON.stringify(data, null, 2)); console.log(JSON.stringify(data)); }

test('音源→CSV→対応確認→解析：次操作・0件保護・戻る・誤入力・連打', async ({ page }, info) => {
  const half = await folder(['A/a.wav']), full = await folder(['A/a.wav', 'B/b.wav']), bad = await folder(['readme.txt']);
  try {
    const dialog = await start(page); const next = dialog.getByRole('button', { name: '対応を確認', exact: true }); const go = dialog.getByRole('button', { name: '対応を確認して解析を開始', exact: true });
    await expect(dialog.getByRole('button', { name: '音源から開始', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('button', { name: 'WAVフォルダを選ぶ', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'CSV・TSVを選ぶ', exact: true })).toBeDisabled(); await expect(next).toBeDisabled();
    await page.screenshot({ path: info.outputPath('01-audio-first-entry.png') });
    await dialog.getByLabel('新規解析のWAVフォルダ', { exact: true }).setInputFiles(bad); await expect(dialog).toContainText('WAVがありません');
    await dialog.getByLabel('新規解析のWAVフォルダ', { exact: true }).setInputFiles(half);
    await expect(dialog.getByRole('button', { name: 'CSV・TSVを選ぶ', exact: true })).toBeEnabled(); await expect(next).toBeDisabled();
    await csvInput(dialog, csv.replaceAll('A/a.wav', 'none.wav').replaceAll('B/b.wav', 'other.wav'));
    await next.click(); await expect(dialog.getByRole('region', { name: '解析前の対応確認' })).toContainText('解析対象は0件'); await expect(go).toBeDisabled();
    await dialog.getByRole('button', { name: '入力選択に戻る', exact: true }).click(); await csvInput(dialog); await next.click(); await expect(dialog.getByRole('region', { name: '解析前の対応確認' })).toContainText('CSV属性を採用した音源 1件'); await expect(go).toBeEnabled();
    await expect(page.locator('main.main-panel')).toHaveCount(0); // No workspace/analysis until confirmation.
    await dialog.getByRole('button', { name: '入力選択に戻る', exact: true }).click(); await dialog.getByRole('button', { name: '音源選択に戻る', exact: true }).click(); await expect(next).toBeDisabled();
    await dialog.getByLabel('新規解析のWAVフォルダ', { exact: true }).setInputFiles(full);
    await dialog.locator('input[accept=".csv,.tsv"]').setInputFiles({ name: 'wrong.wav', mimeType: 'audio/wav', buffer: wav() });
    await expect(dialog).toContainText('CSVまたはTSV形式'); await expect(next).toBeDisabled(); await csvInput(dialog); await expect(next).toBeEnabled();
    await dialog.getByRole('radio', { name: /軽量保存：/ }).check();
    await next.click(); await expect(go).toBeEnabled(); await page.screenshot({ path: info.outputPath('02-confirm-before-analysis.png') });
    await go.dblclick(); await expect(dialog).not.toBeVisible(); await expect(targets(page)).toContainText('指標対象 2音源'); await saved(page);
    await observation(info, { case: 'audio-first', wavFirst: true, csvGated: true, zeroBlocked: true, backKeptCSV: true, wrongFileRejected: true, doubleConfirmTargets: 2 });
  } finally { await Promise.all([half, full, bad].map(root => rm(root, { recursive: true, force: true }))); }
});

test('一部→完全フォルダの不足補完：一致保持・異内容拒否・メモ/除外/設定の保存再開', async ({ page }, info) => {
  test.setTimeout(180000);
  const half = await folder(['A/a.wav']), full = await folder(['A/a.wav', 'B/b.wav']), conflict = await folder(['A/a.wav', 'B/b.wav', 'C/new.wav'], true);
  try {
    await createAudio(page, half); await expect(targets(page)).toContainText('指標対象 1音源');
    await page.locator('tbody[aria-label="一覧の表示ページ"] button.sample-link').first().click();
    await page.getByLabel('調査メモ', { exact: true }).fill('不足補完前のメモ');
    const inspector = page.getByRole('complementary', { name: '選択サンプルの詳細' });
    await inspector.locator('summary').filter({ hasText: '集計から除外' }).click();
    await page.getByLabel('除外理由', { exact: true }).fill('不足補完前の除外');
    await page.getByRole('button', { name: 'このサンプルを集計から除外', exact: true }).click();
    await page.locator('#bins').selectOption('48'); await saved(page);
    await selectFolder(page, conflict); await expect(preview(page)).toContainText('競合1件');
    await preview(page).getByText('追加できない音源（1）', { exact: true }).click(); await expect(preview(page)).toContainText('既存音源と内容が異なります');
    await expect(preview(page).getByRole('button', { name: '確認して追加', exact: true })).toBeDisabled();
    await preview(page).getByRole('button', { name: '取り消す', exact: true }).click();
    await expect(page.getByRole('region', { name: '音源とCSV属性の対応' })).toContainText('音源 1件');
    await selectFolder(page, full); await expect(preview(page)).toContainText('新規1件・内容一致で保持1件・競合0件');
    await expect(preview(page).getByRole('button', { name: '確認して追加', exact: true })).toBeEnabled();
    await preview(page).screenshot({ path: info.outputPath('03-full-folder-supplement.png') });
    await preview(page).getByRole('button', { name: '確認して追加', exact: true }).dblclick();
    await expect(page.getByRole('region', { name: '音源とCSV属性の対応' })).toContainText('音源 2件');
    await expect(targets(page)).toContainText('指標対象 1音源'); // One retained manual exclusion.
    await expect(page.getByLabel('調査メモ', { exact: true })).toHaveValue('不足補完前のメモ');
    await expect(page.locator('#bins')).toHaveValue('48'); await expect(page.getByText(/理由：不足補完前の除外/).first()).toBeVisible(); await saved(page);
    await selectFolder(page, full); await expect(preview(page)).toContainText('新規0件・内容一致で保持2件・競合0件');
    await preview(page).getByRole('button', { name: '確認して追加', exact: true }).click(); await saved(page);
    await page.reload(); await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'データと保存した分析' });
    await dialog.getByRole('button', { name: '開く', exact: true }).click();
    const resume = dialog.getByRole('region', { name: '軽量保存の再開' }); await resume.getByRole('button', { name: '再開を取り消す', exact: true }).click(); await expect(resume).not.toBeVisible();
    await dialog.getByRole('button', { name: '開く', exact: true }).click(); await expect(resume).toBeVisible(); await csvInput(dialog, csv.replace(',1,A,', ',999,A,')); await expect(dialog).toContainText('保存時と異なります');
    await csvInput(dialog); await expect(dialog).not.toBeVisible(); await expect(page.getByRole('region', { name: '音源とCSV属性の対応' })).toContainText('解析対象は0件');
    await expect(page.getByRole('button', { name: 'WAVフォルダを選択', exact: true })).toBeVisible();
    await selectFolder(page, full); await preview(page).getByRole('button', { name: '確認して追加', exact: true }).click(); await expect(targets(page)).toContainText('指標対象 1音源');
    await expect(page.locator('#bins')).toHaveValue('48'); await expect(page.getByLabel('調査メモ', { exact: true })).toHaveValue('不足補完前のメモ'); await expect(page.getByText(/理由：不足補完前の除外/).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath('04-restored-preserved.png') });
    await observation(info, { case: 'supplement', samePathCompared: true, differentSameSizeMtimeRejected: true, extraConflictBatchNotPartiallyApplied: true, fullSelectionAddsOne: true, noOpReselection: true, notePreserved: true, exclusionPreserved: true, bins: 48, resumeCancel: true, wrongCSVRejected: true, CSVOnlyZero: true, restoredEligible: 1 });
  } finally { await Promise.all([half, full, conflict].map(root => rm(root, { recursive: true, force: true }))); }
});

test('既存のbasename対応を曖昧にする追加は拒否し、取消後も元の対象を保持', async ({ page }, info) => {
  const half = await folder(['A/a.wav']), other = await folder(['B/a.wav']);
  try {
    const dialog = await start(page); await dialog.getByLabel('新規解析のWAVフォルダ', { exact: true }).setInputFiles(half);
    await csvInput(dialog, csv.replace('A/a.wav', 'a.wav')); await dialog.getByRole('radio', { name: /軽量保存：/ }).check();
    await dialog.getByRole('button', { name: '対応を確認', exact: true }).click();
    await dialog.getByRole('button', { name: '対応を確認して解析を開始', exact: true }).click(); await expect(dialog).not.toBeVisible(); await expect(targets(page)).toContainText('指標対象 1音源');
    await selectFolder(page, other); await expect(preview(page)).toContainText('曖昧 1行'); await expect(preview(page).getByRole('button', { name: '確認して追加', exact: true })).toBeDisabled();
    await preview(page).getByRole('button', { name: '取り消す', exact: true }).click(); await expect(targets(page)).toContainText('指標対象 1音源');
    await observation(info, { case: 'ambiguity', changedBindingRejected: true, cancelKeptTargets: 1 });
  } finally { await Promise.all([half, other].map(root => rm(root, { recursive: true, force: true }))); }
});

test('CSVから準備する既存動線でも、0件からの音源選択・preview取消が直接見える', async ({ page }, info) => {
  const full = await folder(['A/a.wav', 'B/b.wav']);
  try {
    const dialog = await start(page); await dialog.getByRole('button', { name: 'CSV・TSV', exact: true }).click(); await csvInput(dialog);
    await dialog.getByRole('button', { name: 'このデータを表示', exact: true }).click(); await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('region', { name: '解析入力の準備' })).toContainText('次の操作：WAVフォルダを選択');
    await expect(page.getByRole('button', { name: 'WAVフォルダを選択', exact: true })).toBeVisible();
    await selectFolder(page, full); await preview(page).getByRole('button', { name: '取り消す', exact: true }).click(); await expect(preview(page)).not.toBeVisible();
    await expect(page.getByRole('region', { name: '音源とCSV属性の対応' })).toContainText('解析対象は0件');
    await selectFolder(page, full); await preview(page).getByRole('button', { name: '確認して追加', exact: true }).click(); await expect(targets(page)).toContainText('指標対象 2音源');
    await observation(info, { case: 'legacy-next-action', nextActionVisible: true, previewVisibleWithoutOpeningDetails: true, cancelKeptZero: true, retryTargets: 2 });
  } finally { await rm(full, { recursive: true, force: true }); }
});

test('新規準備を閉じる/Escapeで既存のメモを保持し、再度開くと準備中のファイルを破棄', async ({ page }, info) => {
  const full = await folder(['A/a.wav', 'B/b.wav']);
  try {
    await createAudio(page, full); await page.locator('tbody[aria-label="一覧の表示ページ"] button.sample-link').first().click();
    await page.getByLabel('調査メモ', { exact: true }).fill('既存メモ'); const title = await page.locator('h1').innerText();
    await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'データと保存した分析' });
    await dialog.getByRole('button', { name: '音源から開始', exact: true }).click(); await dialog.getByLabel('新規解析のWAVフォルダ', { exact: true }).setInputFiles(full); await csvInput(dialog, csv, 'unapplied.csv');
    await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(page.locator('h1')).toHaveText(title); await expect(page.getByLabel('調査メモ', { exact: true })).toHaveValue('既存メモ');
    await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click(); await expect(dialog.getByRole('button', { name: '対応を確認', exact: true })).toBeDisabled(); await expect(dialog).toContainText('次の操作：解析するWAVフォルダ');
    await dialog.getByRole('button', { name: 'データ選択を閉じる', exact: true }).click(); await expect(page.locator('h1')).toHaveText(title);
    await observation(info, { case: 'unapplied-close', escapeKeptOriginal: true, discardedStagedFiles: true, closeKeptNote: true });
  } finally { await rm(full, { recursive: true, force: true }); }
});

test('重複音源の内容確認を途中取消して、不足分だけの再試行を妨げない', async ({ page }, info) => {
  test.setTimeout(120000);
  const half = await folder(['A/a.wav'], false, 64 * 1024 * 1024), full = await folder(['A/a.wav', 'B/b.wav'], false, 64 * 1024 * 1024), missing = await folder(['B/b.wav']);
  try {
    await createAudio(page, half); await expect(targets(page)).toContainText('指標対象 1音源');
    await page.locator('input[webkitdirectory]').setInputFiles(full);
    const cancel = page.getByRole('button', { name: '音源の確認を取り消す', exact: true }); await expect(cancel).toBeVisible(); await cancel.click(); await expect(cancel).not.toBeVisible(); await expect(preview(page)).not.toBeVisible();
    await expect(page.getByRole('region', { name: '音源とCSV属性の対応' })).toContainText('音源 1件');
    await selectFolder(page, missing); await preview(page).getByRole('button', { name: '確認して追加', exact: true }).click(); await expect(targets(page)).toContainText('指標対象 2音源');
    await expect(preview(page)).not.toBeVisible(); await observation(info, { case: 'content-check-cancel', bytes: 64 * 1024 * 1024, realReadCancelled: true, oldAnalysisKept: true, retryTargets: 2 });
  } finally { await Promise.all([half, full, missing].map(root => rm(root, { recursive: true, force: true }))); }
});
