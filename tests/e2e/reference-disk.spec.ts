import { test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { referenceDiskWorkflow } from './helpers/reference-disk-workflow';

test('実ディスクの異内容WAVで軽量保存・再開・末尾再生を検証する', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const root = testInfo.outputPath('disk-fixture');
  await promisify(execFile)('python3', [
    'scripts/generate-reference-wav-fixture.py',
    '--output',
    root,
    '--count',
    '8',
  ]);
  await referenceDiskWorkflow(page, testInfo, root, 8);
});

// Regression for object-key reordering during browser storage.
test('WAV階層で群分けした軽量保存もしきい値を保持する', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const root = testInfo.outputPath('disk-fixture');
  await promisify(execFile)('python3', [
    'scripts/generate-reference-wav-fixture.py',
    '--output',
    root,
    '--count',
    '8',
  ]);
  await referenceDiskWorkflow(page, testInfo, root, 8, true);
});
