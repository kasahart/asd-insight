import { expect, test, type Page } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';

async function waitForStartup(page: Page) {
  const openData = page.getByRole('button', {
    name: 'データを選ぶ',
    exact: true,
  });
  try {
    await expect(openData).toBeVisible({ timeout: 15_000 });
    return 'persistent';
  } catch {
    const memoryMode = page.getByRole('button', {
      name: '保存せず一時利用',
      exact: true,
    });
    await expect(memoryMode).toBeVisible();
    await memoryMode.click();
    await expect(openData).toBeVisible();
    return 'memory';
  }
}

function wavFile(name: string, frequency: number) {
  const sampleRate = 8_000;
  const frames = 800;
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * 2, true);
  for (let index = 0; index < frames; index++) {
    const sample = Math.round(
      Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 8_000,
    );
    view.setInt16(44 + index * 2, sample, true);
  }
  return { name, mimeType: 'audio/wav', buffer: Buffer.from(bytes) };
}

async function openImportedCSV(page: Page) {
  await page.goto('/');
  const mode = await waitForStartup(page);
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: 'データと保存した分析',
  });
  await expect(dialog).toBeVisible();
  return { mode, dialog };
}

test('分析の来歴とJSON/CSV/.ovlabの実ファイルを照合し、再取込で識別できる', async ({
  page,
}, testInfo) => {
  const { mode, dialog } = await openImportedCSV(page);
  expect(
    mode,
    '保存と再取込の回帰には永続ストレージが必要です。',
  ).toBe('persistent');

  const csv = [
    'sample_id,score,group,audio_file,condition',
    'sample-001,0.10,reference,sample-001.wav,base',
    'sample-002,0.20,reference,sample-002.wav,base',
    'sample-003,0.90,comparison,sample-003.wav,stress',
    'sample-004,0.80,comparison,sample-004.wav,stress',
    '',
  ].join('\n');
  await dialog
    .locator('input[type="file"][accept=".csv,.tsv"]')
    .setInputFiles({
      name: 'r4-roundtrip.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
  await expect(dialog.getByRole('heading', { name: 'r4-roundtrip.csv' })).toBeVisible();
  await dialog
    .getByRole('button', { name: 'このデータを表示', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'r4-roundtrip.csv' }),
  ).toBeVisible();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );

  const audioFiles = [1, 2, 3, 4].map((index) =>
    wavFile(`sample-00${index}.wav`, 220 + index * 30),
  );
  await page
    .locator('input[type="file"][accept="audio/wav,.wav"]')
    .setInputFiles(audioFiles);
  await expect(page.locator('.audio-import-control')).toContainText('4 / 4件');

  const firstSample = page.getByRole('button', {
    name: 'sample-001 を選択',
    exact: true,
  });
  await firstSample.click();
  await expect(
    page.getByRole('complementary', { name: '選択サンプルの詳細' }),
  ).toBeVisible();
  const note = 'R4/R6 roundtrip note';
  await page.getByLabel('調査メモ', { exact: true }).fill(note);
  await page
    .getByRole('complementary', { name: '選択サンプルの詳細' })
    .locator('summary')
    .filter({ hasText: '集計から除外' })
    .click();
  await page.getByLabel('除外理由', { exact: true }).fill('roundtrip review');
  await page
    .getByRole('button', {
      name: 'このサンプルを集計から除外',
      exact: true,
    })
    .click();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );

  await page
    .getByRole('button', { name: /^分布のしきい値設定を開く/ })
    .click();
  const threshold = page.getByRole('complementary', {
    name: '分布のしきい値設定',
  });
  await threshold
    .getByLabel('OK群のNG候補率上限（%）', { exact: true })
    .fill('1');
  await threshold
    .getByRole('button', { name: '仮しきい値を設定', exact: true })
    .click();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );

  await page.getByLabel('検索一致方法', { exact: true }).selectOption('exact');
  await page.getByLabel('サンプル名で検索', { exact: true }).fill('sample-004');
  await expect(page.getByRole('heading', { name: /^サンプル一覧/ })).toContainText(
    '1件',
  );

  const identity = page.locator('.analysis-identity code');
  const originalAnalysisId = await identity.innerText();
  const provenance = page.locator('.analysis-provenance');
  await expect(provenance).toHaveJSProperty('open', false);
  await provenance.locator(':scope > summary').click();
  await expect(provenance).toContainText('評価条件');
  await expect(provenance).toContainText('探索用しきい値');
  await expect(provenance).toContainText('一覧表示条件');
  await expect(provenance).toContainText('台形積分');
  const identifiers = provenance.locator('.provenance-identifiers');
  const jsonDetails = provenance.locator('.provenance-json-details');
  await expect(identifiers).toHaveJSProperty('open', false);
  await expect(jsonDetails).toHaveJSProperty('open', false);
  await expect(page.locator('#analysis-provenance-json')).toHaveCount(0);
  await expect(identifiers.locator('code').first()).toBeHidden();
  await identifiers.locator(':scope > summary').click();
  await expect(identifiers).toContainText('datasetVersionId');
  await expect(identifiers).toContainText('論理datasetHash');
  await jsonDetails.locator(':scope > summary').click();
  let provenanceJSON = JSON.parse(
    await page.locator('#analysis-provenance-json').inputValue(),
  ) as {
    analysis: { id: string };
    source: unknown;
    settings: unknown;
    threshold: unknown;
    inspection: { query: string; queryMode: string };
    manualReview: { history: unknown[]; excluded: unknown[] };
    notes: Array<{ text: string }>;
  };
  expect(provenanceJSON.analysis.id).toBe(originalAnalysisId);
  expect(provenanceJSON.inspection).toMatchObject({
    query: 'sample-004',
    queryMode: 'exact',
  });
  expect(provenanceJSON.notes.map((entry) => entry.text)).toContain(note);
  expect(provenanceJSON.manualReview.history).not.toHaveLength(0);

  const sourceBeforeHistory = provenanceJSON.source;
  const settingsBeforeHistory = provenanceJSON.settings;
  const query = page.getByLabel('サンプル名で検索', { exact: true });
  await query.fill('sample-003');
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );
  await expect(provenance).toContainText('名前「sample-003」');
  await expect(page.locator('#analysis-provenance-json')).toBeVisible();
  const queryUpdatedJSON = JSON.parse(
    await page.locator('#analysis-provenance-json').inputValue(),
  ) as typeof provenanceJSON;
  expect(queryUpdatedJSON.inspection.query).toBe('sample-003');
  expect(queryUpdatedJSON.source).toEqual(sourceBeforeHistory);
  expect(queryUpdatedJSON.settings).toEqual(settingsBeforeHistory);

  await query.fill('');
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );
  const excludedOnly = page.getByRole('button', { name: /^除外のみ/ }).first();
  await excludedOnly.click();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );
  await page
    .getByRole('button', {
      name: 'sample-001 を一覧から集計に戻す',
      exact: true,
    })
    .click();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );
  await expect(page.locator('#analysis-provenance-json')).toBeVisible();
  const restoredJSON = JSON.parse(
    await page.locator('#analysis-provenance-json').inputValue(),
  ) as typeof provenanceJSON;
  expect(restoredJSON.source).toEqual(sourceBeforeHistory);
  expect(restoredJSON.settings).toEqual(settingsBeforeHistory);
  expect(restoredJSON.threshold).toBeNull();
  expect(restoredJSON.manualReview.excluded).toHaveLength(0);
  const restoredEvent = restoredJSON.manualReview.history.at(-1) as {
    action: string;
    reason: string;
    at: string;
  };
  expect(restoredEvent).toMatchObject({
    action: 'restore',
    reason: 'roundtrip review',
  });
  expect(restoredEvent.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  await expect(provenance).toContainText('復元');
  await expect(provenance).toContainText('roundtrip review');

  await page.getByRole('button', { name: /^すべて/ }).first().click();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );
  await page
    .getByRole('button', { name: 'sample-001 を選択', exact: true })
    .first()
    .click();
  const inspector = page.getByRole('complementary', {
    name: '選択サンプルの詳細',
  });
  const reasonInput = page.getByLabel('除外理由', { exact: true });
  if (!(await reasonInput.isVisible())) {
    await inspector
      .locator('summary')
      .filter({ hasText: '集計から除外' })
      .click();
  }
  await reasonInput.fill('roundtrip review');
  await page
    .getByRole('button', {
      name: 'このサンプルを集計から除外',
      exact: true,
    })
    .click();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );
  await page
    .getByRole('button', { name: /^分布のしきい値設定を開く/ })
    .click();
  const thresholdAgain = page.getByRole('complementary', {
    name: '分布のしきい値設定',
  });
  await thresholdAgain
    .getByLabel('OK群のNG候補率上限（%）', { exact: true })
    .fill('1');
  await thresholdAgain
    .getByRole('button', { name: '仮しきい値を設定', exact: true })
    .click();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );
  await query.fill('sample-004');
  await expect(page.getByRole('heading', { name: /^サンプル一覧/ })).toContainText(
    '1件',
  );
  await expect(page.locator('#analysis-provenance-json')).toBeVisible();
  provenanceJSON = JSON.parse(
    await page.locator('#analysis-provenance-json').inputValue(),
  ) as typeof provenanceJSON;
  expect(provenanceJSON.inspection).toMatchObject({
    query: 'sample-004',
    queryMode: 'exact',
  });
  expect(provenanceJSON.threshold).not.toBeNull();
  expect(provenanceJSON.manualReview.excluded).toHaveLength(1);

  const csvPath = testInfo.outputPath('roundtrip-selection.csv');
  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  await (await csvDownload).saveAs(csvPath);
  const csvOutput = await readFile(csvPath, 'utf8');
  expect(csvOutput).toContain('analyst_note');
  expect(csvOutput).toContain('sample-004');

  const jsonPath = testInfo.outputPath('roundtrip-analysis.json');
  const jsonDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '結果JSON', exact: true }).click();
  await (await jsonDownload).saveAs(jsonPath);
  const report = JSON.parse(await readFile(jsonPath, 'utf8')) as {
    analysis: { id: string };
    source: {
      name: string;
      datasetVersionId: string;
      datasetHash: string;
      logicalDatasetHash: string;
      originalFileHash?: string;
    };
    settings: { scoreColumn: string };
    threshold: unknown;
    inspection: { query: string; queryMode: string };
    notes: Array<{ text: string }>;
    manualReview: { history: unknown[] };
  };
  expect(report.analysis.id).toBe(originalAnalysisId);
  expect(report.source.name).toBe('r4-roundtrip.csv');
  expect(report.source.datasetVersionId).toBeTruthy();
  expect(report.source.datasetHash).toMatch(/^[a-f0-9]{64}$/);
  expect(report.source.logicalDatasetHash).toBe(report.source.datasetHash);
  expect(report.settings.scoreColumn).toBe('score');
  expect(report.inspection).toMatchObject({ query: 'sample-004', queryMode: 'exact' });
  expect(report.source).toEqual(provenanceJSON.source);
  expect(report.settings).toEqual(provenanceJSON.settings);
  expect(report.threshold).toEqual(provenanceJSON.threshold);
  expect(report.inspection).toEqual(provenanceJSON.inspection);
  expect(report.manualReview).toEqual(provenanceJSON.manualReview);
  expect(report.notes).toEqual(provenanceJSON.notes);
  expect(report.notes.map((entry) => entry.text)).toContain(note);
  expect(report.manualReview.history).not.toHaveLength(0);

  await expect(
    page.getByRole('button', { name: /保存状態と分析を管理/ }),
  ).toContainText('端末に保存済み', { timeout: 20_000 });
  const bundlePath = testInfo.outputPath('roundtrip-analysis.ovlab');
  const bundleDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'バックアップ', exact: true }).click();
  await (await bundleDownload).saveAs(bundlePath);
  const bundleBytes = await readFile(bundlePath);
  expect(bundleBytes.byteLength).toBeGreaterThan(100);

  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'データと保存した分析' });
  await manager
    .locator('input[type="file"][accept=".ovlab"]')
    .setInputFiles(bundlePath);
  await expect(
    page.getByRole('heading', { name: 'r4-roundtrip.csv' }),
  ).toBeVisible();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );
  await expect(identity).not.toHaveText(originalAnalysisId);
  await expect(page.getByLabel('検索一致方法', { exact: true })).toHaveValue(
    'exact',
  );
  await expect(page.getByLabel('サンプル名で検索', { exact: true })).toHaveValue(
    'sample-004',
  );

  const importedProvenance = page.locator('.analysis-provenance');
  await expect(importedProvenance).toHaveJSProperty('open', false);
  await importedProvenance.locator(':scope > summary').click();
  await expect(importedProvenance).toContainText('評価条件');
  const importedJsonDetails = importedProvenance.locator(
    '.provenance-json-details',
  );
  await importedJsonDetails.locator(':scope > summary').click();
  const importedReport = JSON.parse(
    await page.locator('#analysis-provenance-json').inputValue(),
  ) as {
    source: {
      datasetHash: string;
      logicalDatasetHash: string;
      originalFileHash?: string;
    };
    settings: unknown;
    threshold: unknown;
  };
  expect(importedReport.source.datasetHash).toBe(report.source.datasetHash);
  expect(importedReport.source.logicalDatasetHash).toBe(
    report.source.logicalDatasetHash,
  );
  if (report.source.originalFileHash !== undefined) {
    expect(importedReport.source.originalFileHash).toBe(
      report.source.originalFileHash,
    );
  }
  expect(importedReport.settings).toEqual(report.settings);
  expect(importedReport.threshold).toEqual(report.threshold);

  await page.getByLabel('サンプル名で検索', { exact: true }).fill('');
  await page.getByRole('button', { name: /^すべて/ }).click();
  await page
    .getByRole('button', { name: 'sample-001 を選択', exact: true })
    .first()
    .click();
  await expect(page.getByLabel('調査メモ', { exact: true })).toHaveValue(note);
  await expect(
    page.getByRole('complementary', { name: '選択サンプルの詳細' }),
  ).toContainText('集計から除外中');

  await page.getByLabel('サンプル名で検索', { exact: true }).fill('sample-004');
  await page
    .getByRole('button', { name: 'sample-004 を選択', exact: true })
    .click();
  await expect(
    page.getByRole('complementary', { name: '選択サンプルの詳細' }).locator('audio'),
  ).toBeVisible();
});
