import { expect, test } from '@playwright/test';
import { Buffer } from 'node:buffer';

// Synthetic FileSystem handles isolate application scaling from disk latency.
// One-sample valid WAVs exercise metadata/binding/storage, not bulk decoding.
test('100,001 WAVs: import, folder grouping, search, save and reopen without a count cap', async ({
  page,
}) => {
  test.skip(
    process.env.OVERLAP_E2E_SCALE !== '1',
    'Set OVERLAP_E2E_SCALE=1 for expensive scale tests',
  );
  test.setTimeout(180_000);
  const count = 100_001;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ count }) => {
      const bytes = new Uint8Array(48);
      const view = new DataView(bytes.buffer);
      for (const [offset, text] of [
        [0, 'RIFF'],
        [8, 'WAVE'],
        [12, 'fmt '],
        [36, 'data'],
      ] as const)
        bytes.set(new TextEncoder().encode(text), offset);
      view.setUint32(4, 40, true);
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, 8000, true);
      view.setUint32(28, 32000, true);
      view.setUint16(32, 4, true);
      view.setUint16(34, 32, true);
      view.setUint32(40, 4, true);
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        value: async () => ({
          name: 'scale',
          kind: 'directory',
          async *entries() {
            for (const group of ['a', 'b'])
              yield [
                group,
                {
                  kind: 'directory',
                  async *entries() {
                    yield [
                      'device',
                      {
                        kind: 'directory',
                        async *entries() {
                          for (
                            let i = group === 'a' ? 0 : 1;
                            i < count;
                            i += 2
                          ) {
                            const name = `${i}.wav`;
                            yield [
                              name,
                              {
                                kind: 'file',
                                async getFile() {
                                  return new File([bytes], name, {
                                    type: 'audio/wav',
                                    lastModified: 0,
                                  });
                                },
                              },
                            ];
                          }
                        },
                      },
                    ];
                  },
                },
              ];
          },
        }),
      });
    },
    { count },
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'データと保存した分析' });
  await dialog.getByRole('button', { name: 'CSV・TSV', exact: true }).click();
  const csv =
    'audio_file,score,group\n' +
    Array.from(
      { length: count },
      (_, i) =>
        `${i % 2 ? 'b' : 'a'}/device/${i}.wav,${i / count},${i % 2 ? 'b' : 'a'}`,
    ).join('\n');
  await dialog
    .locator('input[type="file"][accept=".csv,.tsv"]')
    .setInputFiles({
      name: 'scale.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
  await dialog.getByRole('button', { name: 'このデータを表示' }).click();
  await page.locator('#dataset-mapping-summary').click();
  await page.locator('#audio-column').selectOption('audio_file');
  const start = Date.now();
  await page.getByRole('button', { name: 'WAVフォルダを選択' }).click();
  await expect(
    page.getByRole('region', { name: '音声の取り込み前確認' }),
  ).toContainText(`対応 ${count}行、未対応 0行`, { timeout: 60_000 });
  await page.getByRole('button', { name: '確認して追加' }).click();
  await expect(page.getByText('原音対応 100,001 / 100,001件')).toBeVisible({
    timeout: 60_000,
  });
  await page.locator('#group-column').selectOption('WAVフォルダ階層1');
  await page.locator('#group-a').selectOption('a');
  await page.locator('#group-b').selectOption('b');
  const search = page.getByLabel('ファイル名・相対パスで検索');
  await search.fill('a/device/100000.wav');
  await expect(
    page.getByRole('heading', { name: /^サンプル一覧/ }),
  ).toContainText('1件', { timeout: 30_000 });
  await expect(
    page.getByRole('button', { name: /保存状態と分析を管理/ }),
  ).toContainText('端末に保存済み', { timeout: 60_000 });
  console.log(
    JSON.stringify({ count, importGroupSearchSaveMs: Date.now() - start }),
  );
  await page.reload();
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  const saved = page
    .getByRole('dialog', { name: 'データと保存した分析' })
    .getByRole('region', { name: '保存した分析' })
    .getByRole('listitem')
    .filter({ hasText: 'scale.csv' });
  await saved.getByRole('button', { name: '開く', exact: true }).click();
  await expect(page.getByText('原音対応 100,001 / 100,001件')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator('#group-column')).toHaveValue('WAVフォルダ階層1');
  await expect(search).toHaveValue('a/device/100000.wav');
  await expect(
    page.getByRole('heading', { name: /^サンプル一覧/ }),
  ).toContainText('1件', { timeout: 30_000 });
  expect(errors).toEqual([]);
});
