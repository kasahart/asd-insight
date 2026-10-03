import { expect, test } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

test('フォルダ読み取りAPIで相対パスを保持してWAVを取り込む', async ({ page }) => {
  await page.addInitScript(() => {
    let pickerCalls = 0;
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async (options: { mode: string }) => {
        if (++pickerCalls === 2) throw new DOMException('Canceled', 'AbortError');
        document.documentElement.dataset.pickerMode = options.mode;
        const wav = {
          kind: 'file',
          async getFile() {
            return new File(['RIFF0000WAVE'], '001.wav', {
              type: 'audio/wav',
            });
          },
        };
        const equipment = {
          kind: 'directory',
          async *entries() {
            yield ['001.wav', wav];
          },
        };
        const normal = {
          kind: 'directory',
          async *entries() {
            yield ['設備A', equipment];
          },
        };
        return {
          kind: 'directory',
          name: 'audio',
          async *entries() {
            yield ['正常', normal];
          },
        };
      },
    });
  });
  await page.goto('/');
  const start = page.getByRole('button', { name: 'データを選ぶ', exact: true });
  try {
    await expect(start).toBeVisible({ timeout: 15_000 });
  } catch {
    await page.getByRole('button', { name: '保存せず一時利用' }).click();
  }
  await start.click();
  const dialog = page.getByRole('dialog', { name: 'データと保存した分析' });
  await dialog.getByRole('button', { name: 'CSV・TSV', exact: true }).click();
  await dialog.locator('input[type="file"][accept=".csv,.tsv"]').setInputFiles({
    name: 'picker.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'sample_id,score,group,audio_file\na,0.1,A,正常/設備A/001.wav\nb,0.9,B,missing.wav\n',
    ),
  });
  await dialog.getByRole('button', { name: 'このデータを表示' }).click();
  await page.locator('#dataset-mapping-summary').click();
  await page.locator('#audio-column').selectOption('audio_file');
  await page.getByRole('button', { name: 'WAVフォルダを選択' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-picker-mode', 'read');
  const preview = page.getByRole('region', { name: '音声の取り込み前確認' });
  await expect(preview).toContainText('対応 1行、未対応 1行');
  await expect(page.getByRole('region', { name: 'WAVフォルダ階層' })).toContainText(
    '正常',
  );
  await page.getByRole('button', { name: 'WAVフォルダを選択' }).click();
  await expect(preview).toContainText('対応 1行、未対応 1行');
});

test('ドロップしたWAVフォルダを読み取り、取り込み前に対応を確認できる', async ({ page }) => {
  await page.goto('/');
  const start = page.getByRole('button', { name: 'データを選ぶ', exact: true });
  try {
    await expect(start).toBeVisible({ timeout: 15_000 });
  } catch {
    await page.getByRole('button', { name: '保存せず一時利用' }).click();
  }
  await start.click();
  const dialog = page.getByRole('dialog', { name: 'データと保存した分析' });
  await dialog.getByRole('button', { name: 'CSV・TSV', exact: true }).click();
  await dialog.locator('input[type="file"][accept=".csv,.tsv"]').setInputFiles({
    name: 'dropped.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('sample_id,score,group,audio_file\na,0.1,A,正常/設備A/001.wav\n'),
  });
  await dialog.getByRole('button', { name: 'このデータを表示' }).click();
  await page.locator('#dataset-mapping-summary').click();
  await page.locator('#audio-column').selectOption('audio_file');
  await page.getByRole('button', { name: 'WAVフォルダのドロップ領域' }).evaluate((zone) => {
    let duringDrop = true;
    let releaseOld: (handle: unknown) => void = () => {};
    const oldHandle = new Promise<unknown>((resolve) => { releaseOld = resolve; });
    window.addEventListener('release-old-drop', () => {
      releaseOld({
        kind: 'directory',
        name: 'old',
        async *entries() {
          yield ['old.wav', {
            kind: 'file',
            async getFile() { return new File(['RIFF0000WAVE'], 'old.wav'); },
          }];
        },
      });
    }, { once: true });
    const directory = {
      kind: 'directory',
      name: 'audio',
      async *entries() {
        yield ['正常', {
          kind: 'directory',
          async *entries() {
            yield ['設備A', {
              kind: 'directory',
              async *entries() {
                yield ['001.wav', {
                  kind: 'file',
                  async getFile() { return new File(['RIFF0000WAVE'], '001.wav'); },
                }];
              },
            }];
          },
        }];
      },
    };
    for (const handle of [oldHandle, Promise.resolve(directory)]) {
      const drop = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(drop, 'dataTransfer', {
        value: {
          items: [{
            kind: 'file',
            getAsFileSystemHandle() {
              if (!duringDrop) throw new Error('読み取りハンドルの取得が遅すぎます');
              return handle;
            },
          }],
        },
      });
      zone.dispatchEvent(drop);
    }
    duringDrop = false;
  });
  await expect(page.getByRole('region', { name: '音声の取り込み前確認' })).toContainText(
    '対応 1行、未対応 0行',
  );
  await page.evaluate(() => new Promise<void>((resolve) => {
    window.dispatchEvent(new Event('release-old-drop'));
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(page.getByRole('region', { name: '音声の取り込み前確認' })).toContainText(
    '対応 1行、未対応 0行',
  );
  await page.getByRole('button', { name: '確認して追加' }).click();
  await expect(page.locator('.audio-import-control')).toContainText('1 / 1件');
});

test('階層WAVの自動属性化と一覧での対応状況', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'asd-insight-folder-'));
  const noAudioRoot = await mkdtemp(join(tmpdir(), 'asd-insight-no-audio-'));
  let persistent = true;
  try {
    for (const path of ['正常/設備A', '要確認/設備B']) {
      await mkdir(join(root, path), { recursive: true });
      await writeFile(join(root, path, '001.wav'), Buffer.from('RIFF0000WAVE'));
    }
    await writeFile(join(noAudioRoot, 'readme.txt'), 'no audio files');
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
  await dialog.getByRole('button', { name: 'CSV・TSV', exact: true }).click();
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
    await page.locator('input[webkitdirectory]').setInputFiles(noAudioRoot);
    await expect(page.locator('.import-error')).toContainText(
      '選択したフォルダにWAVがありません',
    );
    await expect(preview).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '確認して追加' }),
    ).toHaveCount(0);
    await page.locator('input[webkitdirectory]').setInputFiles(root);
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
    // Audio-primary populations keep unjoined CSV rows in diagnostics, not metrics/listing.
    const notice = page.getByRole('region', { name: '音源とCSV属性の対応' });
    await expect(notice).toContainText('音源未対応 1行、候補が曖昧 1行');
    await notice.getByText('対象外の元CSV行（2行）', { exact: true }).click();
    await expect(notice).toContainText('元CSV 2行目：音源候補が曖昧');
    await expect(notice).toContainText('正常/設備A/001.wav');
    await expect(notice).toContainText('要確認/設備B/001.wav');
    await expect(notice).toContainText('元CSV 4行目：音源未対応');
    await expect(table.locator('.sample-audio-status[title*="曖昧: 同名WAV"]')).toHaveCount(0);
    await expect(table.locator('.sample-audio-status[title*="missing.wav"]')).toHaveCount(0);
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
    ).toContainText('0件');
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
    await rm(noAudioRoot, { recursive: true, force: true });
  }
});

test('2,000件を超えるWAVフォルダを取り込める', async ({
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
  await dialog.getByRole('button', { name: 'CSV・TSV', exact: true }).click();
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
    await expect(
      page.getByRole('region', { name: '音声の取り込み前確認' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '確認して追加' }).click();
    await expect(page.getByText('原音対応 2 / 2件')).toBeVisible();

  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('高カーディナリティの数値風フォルダ名は全てカテゴリ値として選べる', async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'asd-insight-folder-values-'));
  const values = 202;
  try {
    const rows = ['sample_id,score,group,audio_file'];
    for (let index = 0; index < values; index++) {
      const folder = String(index).padStart(3, '0');
      const filename = `sample-${String(index).padStart(3, '0')}.wav`;
      await mkdir(join(root, folder), { recursive: true });
      await writeFile(
        join(root, folder, filename),
        Buffer.from('RIFF0000WAVE'),
      );
      rows.push(
        `id-${folder},${index % 2 ? '0.9' : '0.1'},${index % 2 ? 'B' : 'A'},${folder}/${filename}`,
      );
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
  await dialog.getByRole('button', { name: 'CSV・TSV', exact: true }).click();
    await dialog
      .locator('input[type="file"][accept=".csv,.tsv"]')
      .setInputFiles({
        name: 'folder-values.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(rows.join('\n')),
      });
    await dialog.getByRole('button', { name: 'このデータを表示' }).click();
    await page.locator('#dataset-mapping-summary').click();
    await page.locator('#group-column').selectOption('group');
    await page.locator('#audio-column').selectOption('audio_file');
    await page.locator('input[webkitdirectory]').setInputFiles(root);
    const preview = page.getByRole('region', { name: '音声の取り込み前確認' });
    await expect(preview).toContainText('未対応 0行');
    await preview.getByRole('button', { name: '確認して追加' }).click();

    const groupColumn = page.locator('#group-column');
    const derivedColumn = 'WAVフォルダ階層1';
    await expect(
      groupColumn.locator(`option[value="${derivedColumn}"]`),
    ).toHaveCount(1);
    await groupColumn.selectOption(derivedColumn);
    await expect(page.getByLabel('群分けの方法')).toHaveCount(0);
    const groupA = page.locator('#group-a');
    const groupB = page.locator('#group-b');
    await expect(groupA.locator('option')).toHaveCount(values);
    await expect(groupB.locator('option')).toHaveCount(values);
    await groupA.selectOption('201');
    await groupB.selectOption('200');
    await expect(groupA).toHaveValue('201');
    await expect(groupB).toHaveValue('200');

    const filterColumn = page.locator('#filter-column');
    await expect(
      filterColumn.locator(`option[value="${derivedColumn}"]`),
    ).toHaveCount(1);
    await filterColumn.selectOption(derivedColumn);
    const filterValue = page.getByLabel('集計する属性値');
    await expect(filterValue.locator('option')).toHaveCount(values + 1);
    await expect(filterValue.locator('option[value="201"]')).toHaveCount(1);
    await filterValue.selectOption('201');
    await expect(filterValue).toHaveValue('201');

    const provenance = page.locator('.analysis-provenance');
    await provenance.locator(':scope > summary').click();
    await expect(
      provenance.locator('.analysis-provenance-content'),
    ).toBeVisible();
    await provenance.locator('.provenance-json-details > summary').click();
    const reportField = page.getByRole('textbox', { name: '確認用JSON' });
    await expect(reportField).toBeVisible();
    const report = JSON.parse(await reportField.inputValue());
    expect(report.settings.folderMembership).toMatchObject({
      algorithm: 'fnv1a32-pair-utf16-v1',
      columns: [derivedColumn],
      levels: [1],
      rowCount: values,
    });
    expect(report.settings.folderMembership.signature).toMatch(
      /^fm1-[0-9a-f]{16}$/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
