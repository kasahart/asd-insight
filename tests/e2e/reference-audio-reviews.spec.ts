import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

const csvFile = {
  name: 'partial.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from(
    'id,score,group,audio_file\na,0.1,A,A/sample.wav\nb,0.9,B,B/sample.wav\n',
  ),
};
function wav(samples: number, sampleValue: number) {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 44; i < bytes.length; i += 2) bytes.writeInt16LE(sampleValue, i);
  return bytes;
}
async function folder(root: string, group: string, content: Buffer) {
  await mkdir(join(root, group), { recursive: true });
  await writeFile(join(root, group, 'sample.wav'), content);
  return root;
}
const saved = (page: Page) =>
  expect(
    page.getByRole('button', { name: /保存状態と分析を管理/ }),
  ).toContainText('端末に保存済み');
async function createReference(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'データと保存した分析' });
  await dialog.getByRole('button', { name: 'CSV・TSV', exact: true }).click();
  await dialog.getByRole('radio', { name: /軽量保存：/ }).check();
  await dialog.locator('input[accept=".csv,.tsv"]').setInputFiles(csvFile);
  await dialog
    .getByRole('button', { name: 'このデータを表示', exact: true })
    .click();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await page.locator('#dataset-mapping-summary').click();
  await saved(page);
}
async function resume(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'データと保存した分析' });
  await dialog.getByRole('button', { name: '開く', exact: true }).click();
  await expect(
    dialog.getByRole('region', { name: '軽量保存の再開' }),
  ).toBeVisible();
  await dialog.locator('input[accept=".csv,.tsv"]').setInputFiles(csvFile);
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  const summary = page.locator('#dataset-mapping-summary');
  if (
    !(await summary.evaluate(
      (el) => (el.parentElement as HTMLDetailsElement).open,
    ))
  )
    await summary.click();
}
async function attach(page: Page, directory: string) {
  await page.bringToFront();
  await page.locator('input[webkitdirectory]').setInputFiles(directory);
  await page.getByRole('button', { name: '確認して追加', exact: true }).click();
}
async function selectA(page: Page) {
  await page
    .getByLabel('ファイル名・相対パスで検索', { exact: true })
    .fill('A/sample.wav');
  await page
    .getByRole('rowgroup', { name: '一覧の表示ページ' })
    .getByRole('button', { name: 'sample.wav を選択', exact: true })
    .first()
    .click();
}

test('部分フォルダを再開後に追加しても同名WAVの別パスを区別する', async ({
  page,
}, testInfo) => {
  const first = await folder(testInfo.outputPath('first'), 'A', wav(2000, 1));
  const second = await folder(testInfo.outputPath('second'), 'B', wav(2400, 2));
  await createReference(page);
  await attach(page, first);
  await expect(page.locator('.audio-import-control')).toContainText('1 / 2件');
  await selectA(page);
  await page
    .getByLabel('調査メモ', { exact: true })
    .fill('Aの音声は別パスのBで置き換えない');
  await saved(page);
  await page.reload();
  await resume(page);
  await attach(page, second);
  await expect(page.locator('.audio-import-control')).toContainText('1 / 2件');
  await expect(page.locator('.save-notification')).toContainText(
    '音声1件は未選択',
  );
  await saved(page);
  const notice = page.getByRole('region', { name: '音源とCSV属性の対応' });
  await notice.getByText('対象外の元CSV行（1行）', { exact: true }).click();
  await expect(notice).toContainText('元CSV 1行目：音源未対応');
  await expect(notice).toContainText('Aの音声は別パスのBで置き換えない');
  await expect(page.getByLabel('調査メモ', { exact: true })).toHaveCount(0);
  // Explicit A remains unavailable, rather than playing B's same-named file.
  await expect(page.locator('#sample-inspector-content audio')).toHaveCount(0);
  await page
    .getByLabel('ファイル名・相対パスで検索', { exact: true })
    .fill('B/sample.wav');
  await page
    .getByRole('rowgroup', { name: '一覧の表示ページ' })
    .getByRole('button', { name: 'sample.wav を選択', exact: true })
    .first()
    .click();
  await expect(page.locator('#sample-inspector-content')).toContainText(
    '対応WAV: B/sample.wav',
  );
  await expect(page.locator('#sample-inspector-content audio')).toHaveCount(1);
  await attach(page, first);
  await expect(page.locator('.audio-import-control')).toContainText('2 / 2件');
  await selectA(page);
  await expect(page.getByLabel('調査メモ', { exact: true })).toHaveValue('Aの音声は別パスのBで置き換えない');
  await expect(page.locator('#sample-inspector-content')).toContainText('対応WAV: A/sample.wav');
  await saved(page);
});

test('別タブの保存と競合したWAVを編集破棄後の再生に残さない', async ({
  page,
}, testInfo) => {
  const firstFolder = await folder(
    testInfo.outputPath('saved'),
    'A',
    wav(2000, 1),
  );
  const draftFolder = await folder(
    testInfo.outputPath('draft'),
    'A',
    wav(2400, 2),
  );
  await createReference(page);
  const other = await page.context().newPage();
  await resume(other); // same saved revision, before either tab binds A/sample.wav
  await attach(page, firstFolder);
  await selectA(page);
  await page
    .getByLabel('調査メモ', { exact: true })
    .fill('先のタブで保存したメモ');
  await saved(page);
  await attach(other, draftFolder);
  await selectA(other);
  await expect(
    other.locator('.save-notification[role="alert"]'),
  ).toContainText('別の画面');
  await expect(other.locator('#sample-inspector-content audio')).toHaveCount(1);
  await other.getByRole('button', { name: /保存状態と分析を管理/ }).click();
  const dialog = other.getByRole('dialog', { name: 'データと保存した分析' });
  await dialog
    .getByRole('button', { name: '保存済みを開き直す', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: '未保存の編集を破棄', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: 'データ選択を閉じる', exact: true })
    .click();
  await saved(other);
  const notice = other.getByRole('region', { name: '音源とCSV属性の対応' });
  await notice.getByText('対象外の元CSV行（2行）', { exact: true }).click();
  await expect(notice).toContainText('先のタブで保存したメモ');
  await expect(other.getByLabel('調査メモ', { exact: true })).toHaveCount(0);
  await expect(other.locator('.audio-import-control')).toContainText('0 / 2件');
  await expect(other.locator('#sample-inspector-content audio')).toHaveCount(0);
  await expect(other.locator('output.save-notification')).toContainText(
    '音声1件は未選択',
  );
  await attach(other, firstFolder);
  await selectA(other);
  await expect(other.getByLabel('調査メモ', { exact: true })).toHaveValue('先のタブで保存したメモ');
  await expect(other.locator('#sample-inspector-content')).toContainText('対応WAV: A/sample.wav');
  await other.close();
});
