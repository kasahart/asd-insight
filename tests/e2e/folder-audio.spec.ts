import { expect, test } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

test('階層WAVの取り込み前照合と明示的な属性採用', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'asd-insight-folder-'));
  try {
    for (const path of ['正常/設備A', '要確認/設備B']) {
      await mkdir(join(root, path), { recursive: true });
      await writeFile(join(root, path, '001.wav'), Buffer.from('RIFF0000WAVE'));
    }
    await page.goto('/');
    const openData = page.getByRole('button', {
      name: 'データを選ぶ',
      exact: true,
    });
    try {
      await expect(openData).toBeVisible({ timeout: 15_000 });
    } catch {
      await page.getByRole('button', { name: '保存せず一時利用' }).click();
      await expect(openData).toBeVisible();
    }
    await openData.click();
    const dialog = page.getByRole('dialog', { name: 'データと保存した分析' });
    await dialog
      .locator('input[type="file"][accept=".csv,.tsv"]')
      .setInputFiles({
        name: 'folders.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(
          'sample_id,score,group,audio_file\na,0.1,A,正常/設備A/001.wav\nb,0.2,A,001.wav\nc,0.8,B,要確認/設備B/001.wav\nd,0.9,B,missing.wav\n',
        ),
      });
    await dialog.getByRole('button', { name: 'このデータを表示' }).click();
    await page.locator('#dataset-mapping-summary').click();
    await page.locator('#audio-column').selectOption('audio_file');
    await page.locator('input[webkitdirectory]').setInputFiles(root);
    const preview = page.getByRole('region', { name: '音声の取り込み前確認' });
    await expect(preview).toContainText('対応 2行、未対応 1行、曖昧 1行');
    await expect(
      page.getByRole('region', { name: 'WAVフォルダの属性候補' }),
    ).toContainText('正常');
    await expect(page.locator('#group-column')).toHaveValue('group');
    await page.getByRole('checkbox', { name: '階層1を分析条件に採用' }).check();
    await preview.getByRole('button', { name: '確認して追加' }).click();
    await expect(page.locator('.audio-import-control')).toContainText(
      '2 / 4件',
    );
    await expect(page.locator('#group-column')).toHaveValue('group');
    await expect(
      page.locator('#group-column option[value="WAVフォルダ階層1"]'),
    ).toHaveCount(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
