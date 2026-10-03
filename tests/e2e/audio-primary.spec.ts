import { expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

function wav() {
  const bytes = Buffer.alloc(44 + 800 * 2);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(1600, 40);
  return bytes;
}
test('音源を起点に最初のCSV行だけを採用し、未対応・曖昧・重複と属性なしを通知する', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const folder = await mkdtemp(join(tmpdir(), 'insight-audio-primary-'));
  try {
    for (const key of [
      'A/a.wav',
      'B/b.wav',
      'x/same.wav',
      'y/same.wav',
      'orphan.wav',
    ]) {
      await mkdir(join(folder, key, '..'), { recursive: true });
      await writeFile(join(folder, key), wav());
    }
    await page.goto('/');
    await page
      .getByRole('button', { name: 'データを選ぶ', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'データと保存した分析' });
  await dialog.getByRole('button', { name: 'CSV・TSV', exact: true }).click();
    await dialog
      .locator('input[type=file][accept=".csv,.tsv"]')
      .setInputFiles({
        name: 'audio-first.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(
          'sample_id,score,group,audio_file\nr0,1,A,A/a.wav\nr1,999,B,A/a.wav\nr2,2,B,B/b.wav\nr3,50,A,missing.wav\nr4,51,B,same.wav\nr5,3,A,x/same.wav\n',
        ),
      });
    await dialog
      .getByLabel(
        '軽量保存：解析設定・調査状態のみ。再開時に元CSV・音声を選び直す（大容量音声向け）',
      )
      .check();
    await dialog.getByRole('button', { name: 'このデータを表示' }).click();
    const notice = page.getByRole('region', { name: '音源とCSV属性の対応' });
    await expect(notice).toContainText('解析対象は0件');
    await page.locator('#dataset-mapping-summary').click();
    await page.locator('input[webkitdirectory]').setInputFiles(folder);
    await page
      .getByRole('button', { name: '確認して追加', exact: true })
      .click();
    await expect(notice).toContainText(
      'CSV属性を採用した音源 3件、CSV属性なし 2件',
    );
    await expect(notice).toContainText(
      '音源未対応 1行、候補が曖昧 1行、重複で非採用 1行',
    );
    await expect(page.getByLabel('音源の指標対象件数')).toContainText(
      '指標対象 3音源',
    );
    const provenance = page.locator('.analysis-provenance');
    if (!(await provenance.evaluate((el: HTMLDetailsElement) => el.open))) await provenance.locator(':scope > summary').click();
    const details = provenance.locator('.provenance-json-details');
    if (!(await details.evaluate((el: HTMLDetailsElement) => el.open))) await details.locator(':scope > summary').click();
    const report = JSON.parse(await page.locator('#analysis-provenance-json').inputValue());
    expect(report.version).toBe(7);
    expect(report.source.audioPopulation.policy).toBe('first-source-row-v1');
    expect(report.source.audioPopulation.adoptedCount).toBe(3);
    expect(report.source.audioPopulation.inventoryCount).toBe(5);
    expect(report.source.audioPopulation.withoutAttributesCount).toBe(2);
    expect(report.source.audioPopulation.excludedRows.missing).toEqual([3]);
    expect(report.source.audioPopulation.excludedRows.ambiguous).toEqual([{ rowIndex: 4, candidates: expect.arrayContaining(['x/same.wav', 'y/same.wav']) }]);
    expect(report.source.audioPopulation.excludedRows.duplicate).toEqual([{ rowIndex: 1, adoptedRowIndex: 0, audioKey: 'A/a.wav' }]);
    expect(report.source.audioPopulation.inventory.find((item: { audioKey: string }) => item.audioKey === 'A/a.wav')).toMatchObject({ rowIndex: 0, bytes: wav().length });
    expect(report.source.audioPopulation.signature).toMatch(/^3:/);
    expect(report.summary.excluded.audio).toBe(3);
    await notice.getByText('対象外の元CSV行（3行）', { exact: true }).click();
    await expect(notice).toContainText('元CSV 2行目：重複・非採用');
    await expect(notice).toContainText('元CSV 1行目を採用');
    await notice.getByText('音源一覧（5件）', { exact: true }).click();
    await expect(notice).toContainText('orphan.wav — CSV属性なし');
    await notice
      .getByRole('button', { name: 'orphan.wav', exact: true })
      .click();
    const player = notice.getByLabel('orphan.wav の再生');
    await expect(player).toBeVisible();
    await expect
      .poll(() => player.evaluate((el) => (el as HTMLAudioElement).duration))
      .toBeCloseTo(0.1, 2);
    await page.locator('#audio-column').selectOption('sample_id');
    await expect(notice).toContainText('解析対象は0件');
    await expect(page.getByLabel('音源の指標対象件数')).not.toContainText(
      '指標対象 3音源',
    );
    await expect(page.locator('main.main-panel')).toHaveAttribute('aria-busy', 'false');
    await page.locator('#audio-column').selectOption('audio_file');
    await expect(page.getByLabel('音源の指標対象件数')).toContainText(
      '指標対象 3音源',
    );
    await writeFile(join(folder, 'missing.wav'), wav());
    await page.locator('input[webkitdirectory]').setInputFiles(folder);
    await page.getByRole('button', { name: '確認して追加', exact: true }).click();
    await expect(page.getByLabel('音源の指標対象件数')).toContainText('指標対象 4音源');
    await expect(page.locator('main.main-panel')).toHaveAttribute('aria-busy', 'false');
    if (!(await provenance.evaluate((el: HTMLDetailsElement) => el.open))) await provenance.locator(':scope > summary').click();
    if (!(await details.evaluate((el: HTMLDetailsElement) => el.open))) await details.locator(':scope > summary').click();
    const supplementedReport = JSON.parse(await page.locator('#analysis-provenance-json').inputValue());
    expect(supplementedReport.source.logicalDatasetHash).toBe(report.source.logicalDatasetHash);
    expect(supplementedReport.source.audioPopulation.adoptedCount).toBe(4);
    expect(supplementedReport.source.audioPopulation.signature).not.toBe(report.source.audioPopulation.signature);
    expect(supplementedReport.summary.excluded.audio).toBe(2);
    await page.screenshot({ path: info.outputPath('audio-primary.png') });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
