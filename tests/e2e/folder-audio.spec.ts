import { expect, test } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

test('階層WAVの自動属性化と一覧での対応状況', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'asd-insight-folder-'));
  let persistent = true;
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
      persistent = false;
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
      page.getByRole('region', { name: 'WAVフォルダ階層' }),
    ).toContainText('正常');
    await expect(page.locator('#id-column')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '試聴用の音声を追加' }),
    ).toHaveCount(0);
    await expect(page.locator('#group-column')).toHaveValue('group');
    await expect(
      page.getByRole('checkbox', { name: /階層1を分析条件に採用/ }),
    ).toHaveCount(0);
    await preview.getByRole('button', { name: '確認して追加' }).click();
    await expect(page.locator('.audio-import-control')).toContainText(
      '2 / 4件',
    );
    await expect(page.locator('#group-column')).toHaveValue('group');
    await expect(
      page.locator('#group-column option[value="WAVフォルダ階層1"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('#group-column option[value="WAVフォルダ階層2"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('#filter-column option[value="WAVフォルダ階層1"]'),
    ).toHaveCount(1);
    const table = page.getByRole('region', {
      name: 'サンプル一覧の横スクロール領域',
    });
    await expect(
      table.getByRole('columnheader', { name: /ファイル名/ }),
    ).toBeVisible();
    await expect(
      table.getByRole('columnheader', { name: /相対パス/ }),
    ).toBeVisible();
    await expect(
      table.getByRole('columnheader', { name: /sample_id/ }),
    ).toBeVisible();
    await expect(
      table.getByRole('columnheader', { name: /audio_file/ }),
    ).toHaveCount(0);
    await expect(
      table.getByRole('columnheader', { name: /WAVフォルダ階層1/ }),
    ).toBeVisible();
    await expect(
      table.getByText('正常/設備A/001.wav', { exact: true }).first(),
    ).toBeVisible();
    await expect(
      table.getByText('001.wav', { exact: true }).first(),
    ).toBeVisible();
    const ambiguousIcon = table.locator(
      '.sample-audio-status[title*="曖昧: 同名WAVが複数あります"]',
    );
    await expect(ambiguousIcon).toHaveCount(1);
    await ambiguousIcon.hover();
    const ambiguityReason = await ambiguousIcon.getAttribute('title');
    expect(ambiguityReason).toBeTruthy();
    expect(ambiguityReason ?? '').toContain('正常/設備A/001.wav');
    expect(ambiguityReason ?? '').toContain('要確認/設備B/001.wav');
    await expect(ambiguousIcon).toHaveAttribute('role', 'img');
    await expect(ambiguousIcon).toHaveAttribute(
      'aria-label',
      /音声未対応: 曖昧: 同名WAVが複数あります/,
    );
    const missingIcon = table.locator(
      '.sample-audio-status[title*="CSVの音声値「missing.wav」"]',
    );
    await expect(missingIcon).toHaveCount(1);
    await missingIcon.hover();
    await expect(missingIcon.locator('.sample-audio-icon')).toHaveAttribute(
      'opacity',
      '0.25',
    );
    await expect(table.getByText(/CSVの音声値「missing\.wav」/)).toHaveCount(0);
    await table.getByRole('button', { name: /相対パス：.*昇順にする/ }).click();
    await expect(
      table.getByRole('columnheader', { name: /相対パス/ }),
    ).toHaveAttribute('aria-sort', 'ascending');
    const search = page.getByLabel('ファイル名・相対パスで検索');
    await search.fill('正常/設備A/001.wav');
    await expect(
      page.getByRole('heading', { name: /^サンプル一覧/ }),
    ).toContainText('1件');
    await search.fill('missing.wav');
    await expect(
      page.getByRole('heading', { name: /^サンプル一覧/ }),
    ).toContainText('1件');
    await search.fill('');
    if (persistent) {
      await expect(
        page.getByRole('button', { name: /保存状態と分析を管理/ }),
      ).toContainText('端末に保存済み', { timeout: 20_000 });
      await page.reload();
      await page
        .getByRole('button', { name: 'データを選ぶ', exact: true })
        .click();
      const saved = page
        .getByRole('dialog', { name: 'データと保存した分析' })
        .getByRole('region', { name: '保存した分析' })
        .getByRole('listitem')
        .filter({ hasText: 'folders.csv' });
      await saved.getByRole('button', { name: '開く', exact: true }).click();
      await expect(
        page.locator('#group-column option[value="WAVフォルダ階層2"]'),
      ).toHaveCount(1);
      await expect(
        page.getByRole('columnheader', { name: /相対パス/ }),
      ).toHaveAttribute('aria-sort', 'ascending');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('音声対応数が保存上限を超えたフォルダは確認画面へ進めない', async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'asd-insight-audio-limit-'));
  try {
    for (let index = 0; index < 2001; index++) {
      const name = `sample-${String(index).padStart(4, '0')}.wav`;
      await writeFile(join(root, name), Buffer.from('RIFF0000WAVE'));
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
        name: 'audio-limit.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(
          'sample_id,score,group,audio_file\n001,0.1,A,sample-0000.wav\n002,0.9,B,sample-0001.wav\n',
        ),
      });
    await dialog.getByRole('button', { name: 'このデータを表示' }).click();
    await page.locator('#dataset-mapping-summary').click();
    await page.locator('#group-column').selectOption('group');
    await page.locator('#group-a').selectOption('A');
    await page.locator('#group-b').selectOption('B');
    await page.locator('#audio-column').selectOption('audio_file');
    await page.locator('input[webkitdirectory]').setInputFiles(root);
    await expect(page.locator('.import-error')).toContainText(
      'WAVは2,000件まで追加できます',
    );
    await expect(
      page.getByRole('region', { name: '音声の取り込み前確認' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '確認して追加' }),
    ).toHaveCount(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
