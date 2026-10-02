import { test } from '@playwright/test';
import { referenceDiskWorkflow } from './helpers/reference-disk-workflow';

test('opt-in: 実ディスク100,001 WAV / 404MBの軽量保存・再開・末尾再生', async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.OVERLAP_E2E_SCALE !== '1',
    'Set OVERLAP_E2E_SCALE=1 for expensive scale tests',
  );
  test.setTimeout(900_000);
  const root = process.env.OVERLAP_E2E_DISK_FIXTURE;
  if (!root)
    throw new Error(
      'Set OVERLAP_E2E_DISK_FIXTURE to a generated 100001-file fixture directory',
    );
  await referenceDiskWorkflow(page, testInfo, root, 100001, true);
});
