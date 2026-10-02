import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

const csv = Buffer.from(
  'id,score,group,audio_file\na1,0.1,A,A/a1.wav\na2,0.2,A,A/a2.wav\nb1,0.8,B,B/b1.wav\nb2,0.9,B,B/b2.wav\n',
);
const csvFile = { name: 'reference.csv', mimeType: 'text/csv', buffer: csv };

function wav() {
  const bytes = Buffer.alloc(4044);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(4036, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(4000, 40);
  return bytes;
}

test('タブ切替時のCSV軽量保存選択を保ち、合成デモには適用しない', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'データと保存した分析' });
  await dialog.getByRole('radio', { name: /軽量保存：/ }).check();
  await dialog.getByRole('button', { name: '合成デモ', exact: true }).click();
  await dialog.getByRole('button', { name: 'CSV・TSV', exact: true }).click();
  await expect(dialog.getByRole('radio', { name: /軽量保存：/ })).toBeChecked();
  await dialog.getByRole('button', { name: '合成デモ', exact: true }).click();
  await dialog
    .getByRole('button', { name: '合成デモを表示', exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'demo_inspection.csv', exact: true }),
  ).toBeVisible();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(
    page.getByRole('button', { name: /保存状態と分析を管理/ }),
  ).toContainText('端末に保存済み');

  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  await dialog.getByRole('button', { name: 'CSV・TSV', exact: true }).click();
  await dialog.getByRole('radio', { name: /軽量保存：/ }).check();
  await dialog.locator('input[accept=".csv,.tsv"]').setInputFiles(csvFile);
  await dialog
    .getByRole('button', { name: 'このデータを表示', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'reference.csv', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.save-notification')).toContainText(
    '軽量保存：CSV・音声本体は含まれません',
  );
  await expect(
    page.getByRole('button', { name: /保存状態と分析を管理/ }),
  ).toContainText('端末に保存済み');

  await page.reload();
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  const saved = dialog.getByRole('region', { name: '保存した分析' });
  await saved
    .getByRole('listitem')
    .filter({ hasText: 'demo_inspection.csv' })
    .getByRole('button', { name: '開く', exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'demo_inspection.csv', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  await saved
    .getByRole('listitem')
    .filter({ hasText: 'reference.csv' })
    .getByRole('button', { name: '開く', exact: true })
    .click();
  await expect(
    dialog.getByRole('region', { name: '軽量保存の再開' }),
  ).toBeVisible();
  await dialog.locator('input[accept=".csv,.tsv"]').setInputFiles(csvFile);
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'reference.csv', exact: true }),
  ).toBeVisible();
});

test('軽量保存は元CSVを照合し、欠けた音声があっても階層条件・メモ・除外履歴を復元する', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'データと保存した分析' });
  const csvInput = dialog.locator('input[accept=".csv,.tsv"]');
  await csvInput.setInputFiles(csvFile);
  await dialog.getByRole('radio', { name: /軽量保存：/ }).check();
  await dialog.getByRole('button', { name: 'このデータを表示' }).click();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  const folder = testInfo.outputPath('audio');
  for (const group of ['A', 'B']) {
    await mkdir(join(folder, group), { recursive: true });
    for (const i of [1, 2])
      await writeFile(
        join(folder, group, `${group.toLowerCase()}${i}.wav`),
        wav(),
      );
  }
  await page.locator('#dataset-mapping-summary').click();
  await page.locator('input[webkitdirectory]').setInputFiles(folder);
  await expect(
    page.getByRole('region', { name: '音声の取り込み前確認' }),
  ).toContainText('音声本体');
  await page.getByRole('button', { name: '確認して追加' }).click();
  await expect(page.locator('.audio-import-control')).toContainText('4 / 4件');
  await page.locator('#group-column').selectOption('WAVフォルダ階層1');
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await page
    .getByRole('button', { name: 'a1.wav を選択', exact: true })
    .first()
    .click();
  await page
    .getByLabel('調査メモ', { exact: true })
    .fill('音声を複製せず調査を保存');
  const inspector = page.getByRole('complementary', {
    name: '選択サンプルの詳細',
  });
  await inspector
    .locator('summary')
    .filter({ hasText: '集計から除外' })
    .click();
  await page
    .getByLabel('除外理由', { exact: true })
    .fill('軽量保存で保持する除外');
  await page
    .getByRole('button', { name: 'このサンプルを集計から除外', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /保存状態と分析を管理/ }),
  ).toContainText('端末に保存済み');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'バックアップ', exact: true }).click();
  const backup = await downloadEvent;
  const backupPath = testInfo.outputPath('reference.ovlab');
  await backup.saveAs(backupPath);
  await page.reload();
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  await dialog.getByRole('button', { name: '開く', exact: true }).click();
  await expect(
    dialog.getByRole('region', { name: '軽量保存の再開' }),
  ).toBeVisible();
  await csvInput.setInputFiles({
    ...csvFile,
    buffer: Buffer.from(csv.toString().replace('0.1', '0.3')),
  });
  await expect(dialog).toContainText('選択したCSVの内容が保存時と異なります');
  await expect(
    dialog.getByRole('region', { name: '軽量保存の再開' }),
  ).toBeVisible();
  await csvInput.setInputFiles({ ...csvFile, name: 'renamed.csv' });
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#group-column')).toHaveValue('WAVフォルダ階層1');
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.getByLabel('調査メモ', { exact: true })).toHaveValue(
    '音声を複製せず調査を保存',
  );
  await expect(inspector).toContainText('集計から除外中');
  await expect(page.locator('.save-notification')).toContainText(
    '音声4件は未選択',
  );
  // Changed bytes/metadata are rejected without replacing the saved review state.
  const changed = testInfo.outputPath('changed');
  await mkdir(join(changed, 'A'), { recursive: true });
  await writeFile(join(changed, 'A', 'a1.wav'), Buffer.from('changed audio'));
  await page.locator('input[webkitdirectory]').setInputFiles(changed);
  await page.getByRole('button', { name: '確認して追加' }).click();
  await expect(page.locator('.import-error')).toContainText(
    '容量または更新日時が保存時と異なります',
  );
  await expect(page.locator('.audio-import-control')).toContainText('0 / 4件');
  // Reattach only A using the unchanged original files; B is temporarily absent.
  const { rename } = await import('node:fs/promises');
  await rename(join(folder, 'B'), testInfo.outputPath('missing-B'));
  await page.locator('input[webkitdirectory]').setInputFiles(folder);
  await page.getByRole('button', { name: '確認して追加' }).click();
  await expect(page.locator('.audio-import-control')).toContainText('2 / 4件');
  await expect(page.locator('#group-column')).toHaveValue('WAVフォルダ階層1');
  await expect(page.locator('.save-notification')).toContainText(
    '音声2件は未選択',
  );
  await expect(page.getByLabel('調査メモ', { exact: true })).toHaveValue(
    '音声を複製せず調査を保存',
  );
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  await dialog.locator('input[accept=".ovlab"]').setInputFiles(backupPath);
  await expect(
    dialog.getByRole('region', { name: '軽量保存の再開' }),
  ).toBeVisible();
  await csvInput.setInputFiles(csvFile);
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel('調査メモ', { exact: true })).toHaveValue(
    '音声を複製せず調査を保存',
  );
  await expect(inspector).toContainText('集計から除外中');
});

test('全量から軽量保存へのコピー・再開後もしきい値と判断絞り込みを保持する', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'データと保存した分析' });
  await dialog.locator('input[accept=".csv,.tsv"]').setInputFiles(csvFile);
  await dialog
    .getByRole('button', { name: 'このデータを表示', exact: true })
    .click();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await page.getByRole('button', { name: /^分布のしきい値設定を開く/ }).click();
  const threshold = page.getByRole('complementary', {
    name: '分布のしきい値設定',
  });
  await threshold
    .getByLabel('OK群のNG候補率上限（%）', { exact: true })
    .fill('13');
  await threshold
    .getByRole('button', { name: '仮しきい値を設定', exact: true })
    .click();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await page.getByRole('button', { name: /^OK基準群のNG候補/ }).click();
  const report = async () => {
    const provenance = page.locator('.analysis-provenance');
    if (!(await provenance.evaluate((el: HTMLDetailsElement) => el.open)))
      await provenance.locator(':scope > summary').click();
    const details = provenance.locator('.provenance-json-details');
    if (!(await details.evaluate((el: HTMLDetailsElement) => el.open)))
      await details.locator(':scope > summary').click();
    return JSON.parse(
      await page.locator('#analysis-provenance-json').inputValue(),
    );
  };
  const before = await report();
  expect(before.threshold).not.toBeNull();
  expect(before.inspection.decisionFilter).toBe('false-positive');
  await expect(
    page.getByRole('button', { name: /保存状態と分析を管理/ }),
  ).toContainText('端末に保存済み');
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  await dialog
    .getByRole('button', { name: '保存した分析', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: '現在の調査を軽量保存にコピー', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  const copied = await report();
  expect(copied.analysis.id).not.toBe(before.analysis.id);
  expect(copied.source.logicalDatasetHash).toBe(
    before.source.logicalDatasetHash,
  );
  expect(copied.source.storageDatasetHash).not.toBe(before.source.datasetHash);
  expect(copied.threshold).toEqual(before.threshold);
  expect(copied.inspection.decisionFilter).toBe('false-positive');
  await expect(
    page.getByRole('button', { name: /保存状態と分析を管理/ }),
  ).toContainText('端末に保存済み');
  await page.reload();
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  await dialog
    .getByRole('region', { name: '保存した分析' })
    .getByRole('listitem')
    .filter({ hasText: '（軽量保存）' })
    .getByRole('button', { name: '開く', exact: true })
    .click();
  await expect(
    dialog.getByRole('region', { name: '軽量保存の再開' }),
  ).toBeVisible();
  await dialog.locator('input[accept=".csv,.tsv"]').setInputFiles(csvFile);
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  const resumed = await report();
  expect(resumed.source.logicalDatasetHash).toBe(
    before.source.logicalDatasetHash,
  );
  expect(resumed.threshold).toEqual(before.threshold);
  expect(resumed.inspection.decisionFilter).toBe('false-positive');
});
