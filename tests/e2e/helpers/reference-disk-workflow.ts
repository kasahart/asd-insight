import { expect, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

async function inspectFixture(root: string, count: number) {
  const csvPath = join(root, `synthetic-${count}.csv`);
  const csv = await readFile(csvPath);
  const lines = csv.toString().trim().split('\n');
  assert.equal(lines[0], 'id,audio_file,score,group,device');
  assert.equal(lines.length - 1, count);
  const hashes = new Set<string>();
  const paths = new Set<string>();
  let wavBytes = 0;
  const scan = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else {
        assert.ok(entry.isFile());
        assert.ok(entry.name.endsWith('.wav'));
        const bytes = await readFile(path);
        assert.equal(bytes.length, 4044, path);
        assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', path);
        assert.equal(bytes.toString('ascii', 8, 12), 'WAVE', path);
        assert.equal(bytes.readUInt32LE(24), 8000, path);
        assert.equal(bytes.readUInt16LE(22), 1, path);
        assert.equal(bytes.readUInt16LE(34), 16, path);
        assert.equal(bytes.readUInt32LE(40), 4000, path);
        hashes.add(createHash('sha256').update(bytes).digest('hex'));
        paths.add(relative(join(root, 'wav'), path));
        wavBytes += bytes.length;
      }
    }
  };
  await scan(join(root, 'wav'));
  assert.equal(paths.size, count);
  assert.equal(hashes.size, count);
  assert.equal(wavBytes, count * 4044);
  for (const line of lines.slice(1))
    assert.ok(paths.has(line.split(',')[1]), line);
  const tail = lines.at(-1)!.split(',');
  const first = lines[1].split(',');
  const tailBytes = await readFile(join(root, 'wav', tail[1]));
  return {
    csvPath,
    wavPath: join(root, 'wav'),
    count,
    wavBytes,
    csvBytes: csv.length,
    csvHash: createHash('sha256').update(csv).digest('hex'),
    tailId: tail[0],
    tailName: tail[1].split('/').at(-1)!,
    firstName: first[1].split('/').at(-1)!,
    tailHash: createHash('sha256').update(tailBytes).digest('hex'),
  };
}

async function report(page: Page) {
  const provenance = page.locator('.analysis-provenance');
  if (!(await provenance.evaluate((el: HTMLDetailsElement) => el.open)))
    await provenance.locator(':scope > summary').click();
  const details = provenance.locator('.provenance-json-details');
  if (!(await details.evaluate((el: HTMLDetailsElement) => el.open)))
    await details.locator(':scope > summary').click();
  return JSON.parse(
    await page.locator('#analysis-provenance-json').inputValue(),
  );
}

async function persisted(page: Page, id: string) {
  return await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('overlap-lab-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const get = (store: string, key: string) =>
        new Promise<any>((resolve, reject) => {
          const request = db.transaction(store).objectStore(store).get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const record = await get('sessions', id);
      const dataset = await get('datasets', record.datasetVersionId);
      const files: { name: string; bytes: number }[] = [];
      const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
        for await (const [name, handle] of (dir as any).entries()) {
          if (handle.kind === 'directory')
            await walk(handle, prefix + name + '/');
          else
            files.push({
              name: prefix + name,
              bytes: (await handle.getFile()).size,
            });
        }
      };
      await walk(await navigator.storage.getDirectory(), '');
      return {
        bundleBytes: record.bundleBytes,
        datasetHash: record.datasetHash,
        logicalDatasetHash: record.logicalDatasetHash,
        state: record.state,
        audioAssetCount: Object.keys(record.audio).length,
        sourcePresent: record.source !== undefined,
        audioReferenceCount: record.audioReferences?.length,
        referencedAudioBytes: record.audioReferences?.reduce(
          (sum: number, ref: any) => sum + ref.size,
          0,
        ),
        storedRowCount: dataset.value.rows.length,
        externalCSV: dataset.value.externalCSV,
        files,
        metadataJSONBytes: new TextEncoder().encode(
          JSON.stringify({ record, dataset }),
        ).byteLength,
      };
    } finally {
      db.close();
    }
  }, id);
}

/** Uses real disk Files through Playwright's supported webkitdirectory input.
 * Native OS picker UI is substituted, but CSV/WAV contents and browser storage/audio are real.
 */
export async function referenceDiskWorkflow(
  page: Page,
  testInfo: TestInfo,
  root: string,
  count: number,
  folderGrouping = false,
  audioFirst = false,
  verifyFullReselection = false,
) {
  if (count > 100) page.setDefaultTimeout(120_000);
  const started = Date.now();
  const fixture = await inspectFixture(root, count);
  const fixtureValidatedMs = Date.now() - started;
  console.log(
    JSON.stringify({
      phase: 'fixture-validated',
      count,
      elapsedMs: fixtureValidatedMs,
    }),
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Observe the actual playback Blob without fetching blob: URLs (connect-src forbids that).
  // This does not replace file contents, bypass CSP, or alter native media playback.
  await page.addInitScript(() => {
    const original = URL.createObjectURL.bind(URL);
    const hashes: Record<string, Promise<string>> = {};
    (window as any).__playbackBlobHashes = hashes;
    URL.createObjectURL = (blob) => {
      const url = original(blob);
      if (blob instanceof Blob && blob.size === 4044)
        hashes[url] = blob
          .arrayBuffer()
          .then(async (bytes) =>
            [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(''),
          );
      return url;
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'データと保存した分析' });
  if (audioFirst) await dialog.getByLabel('新規解析のWAVフォルダ', { exact: true }).setInputFiles(fixture.wavPath, { timeout: 180000 });
  else await dialog.getByRole('button', { name: 'CSV・TSV', exact: true }).click();
  await dialog.getByRole('radio', { name: /軽量保存：/ }).check();
  await dialog
    .locator('input[accept=".csv,.tsv"]')
    .setInputFiles(fixture.csvPath);
  if (audioFirst) await dialog.getByRole('button', { name: '対応を確認', exact: true }).click();
  await dialog
    .getByRole('button', { name: audioFirst ? '対応を確認して解析を開始' : 'このデータを表示', exact: true })
    .click();
  const ready = () =>
    expect(page.locator('main.main-panel')).toHaveAttribute(
      'aria-busy',
      'false',
      { timeout: 120_000 },
    );
  const saved = () =>
    expect(
      page.getByRole('button', { name: /保存状態と分析を管理/ }),
    ).toContainText('端末に保存済み', { timeout: 120_000 });
  await ready();
  await page.locator('#dataset-mapping-summary').click();
  const attach = async () => {
    // No synthetic handles or File byte payloads: Chromium reads the original disk files.
    await page
      .locator('input[webkitdirectory]')
      .setInputFiles(fixture.wavPath, { timeout: 180_000 });
    await expect(
      page.getByRole('region', { name: '音声の取り込み前確認' }),
    ).toContainText(`対応 ${count}行、未対応 0行`, { timeout: 180_000 });
    await page.getByRole('button', { name: '確認して追加' }).click();
    await expect(page.locator('.audio-import-control')).toContainText(
      `${count.toLocaleString('en-US')} / ${count.toLocaleString('en-US')}件`,
      { timeout: 180_000 },
    );
  };
  if (!audioFirst) await attach();
  const firstAttachedMs = Date.now() - started;
  console.log(
    JSON.stringify({
      phase: 'first-wav-attachment',
      count,
      elapsedMs: firstAttachedMs,
    }),
  );
  let fullReselectionMs: number | undefined;
  if (verifyFullReselection) {
    const reselectionStarted = Date.now();
    await page.locator('input[webkitdirectory]').setInputFiles(fixture.wavPath, { timeout: 180000 });
    const check = page.getByRole('region', { name: '音声の取り込み前確認' });
    await expect(check).toContainText(`新規0件・内容一致で保持${count}件・競合0件`, { timeout: 300000 });
    await check.getByRole('button', { name: '確認して追加', exact: true }).click();
    fullReselectionMs = Date.now() - reselectionStarted;
    console.log(JSON.stringify({ phase: 'full-folder-byte-verified', count, elapsedMs: fullReselectionMs }));
  }
  if (folderGrouping) {
    await page.locator('#group-column').selectOption('WAVフォルダ階層1');
    await page.locator('#group-a').selectOption('group_a');
    await page.locator('#group-b').selectOption('group_b');
  }
  await ready();
  const search = page.getByLabel('ファイル名・相対パスで検索', { exact: true });
  await search.fill(fixture.firstName);
  await page
    .getByRole('button', { name: `${fixture.firstName} を選択`, exact: true })
    .first()
    .click();
  const inspector = page.getByRole('complementary', {
    name: '選択サンプルの詳細',
  });
  await inspector
    .locator('summary')
    .filter({ hasText: '集計から除外' })
    .click();
  await page
    .getByLabel('除外理由', { exact: true })
    .fill('ディスク入力の回帰試験');
  await page
    .getByRole('button', { name: 'このサンプルを集計から除外', exact: true })
    .click();
  await ready();
  await search.fill(fixture.tailName);
  await page
    .getByRole('button', { name: `${fixture.tailName} を選択`, exact: true })
    .first()
    .click();
  await page
    .getByLabel('調査メモ', { exact: true })
    .fill('末尾ファイルの軽量保存・再開');
  // Audio analysis adds durable metadata asynchronously; settle it before measuring a revision.
  await expect(
    inspector.getByRole('img', { name: /スペクトログラム/ }),
  ).toBeVisible({ timeout: 90_000 });
  await saved();
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
  await ready();
  await saved();
  await page.getByRole('button', { name: /^反対群のOK候補/ }).click();
  await ready();
  await saved();
  const before = await report(page);
  expect(before.inspection.decisionFilter).toBe('false-negative');
  expect(before.threshold).not.toBeNull();
  expect(before.manualReview.excluded).toHaveLength(1);
  expect(before.notes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: '末尾ファイルの軽量保存・再開' }),
    ]),
  );
  const stored = await persisted(page, before.analysis.id);
  expect(stored.audioAssetCount).toBe(0);
  expect(stored.sourcePresent).toBe(false);
  expect(stored.audioReferenceCount).toBe(count);
  expect(stored.referencedAudioBytes).toBe(fixture.wavBytes);
  expect(stored.storedRowCount).toBe(0);
  expect(stored.externalCSV.hash).toBe(fixture.csvHash);
  expect(stored.files).toEqual([]);
  const downloadEvent = page.waitForEvent('download', {
    timeout: count > 100 ? 120_000 : 10_000,
  });
  await page.getByRole('button', { name: 'バックアップ', exact: true }).click();
  const download = await downloadEvent;
  const backupPath = testInfo.outputPath('lightweight.ovlab');
  await download.saveAs(backupPath);
  const backupBytes = (await stat(backupPath)).size;
  const exportedRecord = await persisted(page, before.analysis.id);
  expect(backupBytes).toBe(exportedRecord.bundleBytes);
  expect(backupBytes).toBeLessThan(
    count > 100 ? fixture.wavBytes / 4 : 64 * 1024,
  );
  const backup = await readFile(backupPath);
  const headerLength = backup.readUInt32BE(8);
  const header = JSON.parse(backup.subarray(12, 12 + headerLength).toString());
  expect(header.version).toBe(2);
  expect(header.dataset.rows).toEqual([]);
  expect(header.audioReferences).toHaveLength(count);
  // Every byte belongs to the manifest: no input asset frames follow it.
  expect(backupBytes).toBe(12 + headerLength);
  const initiallySavedMs = Date.now() - started;
  console.log(
    JSON.stringify({
      phase: 'lightweight-saved',
      count,
      backupBytes,
      elapsedMs: initiallySavedMs,
    }),
  );
  await page.reload();
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  await dialog.getByRole('button', { name: '開く', exact: true }).click();
  await expect(
    dialog.getByRole('region', { name: '軽量保存の再開' }),
  ).toBeVisible();
  await dialog
    .locator('input[accept=".csv,.tsv"]')
    .setInputFiles(fixture.csvPath);
  await expect(dialog).not.toBeVisible();
  await ready();
  // Audio availability is recomputed after reselection; CSV alone must not expose old metrics.
  await expect(page.getByRole('region', { name: '音源とCSV属性の対応' })).toContainText('解析対象は0件');
  const resumedStored = await persisted(page, before.analysis.id);
  for (const key of ['notes', 'reviewRecords', 'thresholdSetting'])
    expect(resumedStored.state[key]).toEqual(stored.state[key]);
  expect(await page.locator('audio[src]').count()).toBe(0);
  const csvResumedMs = Date.now() - started;
  console.log(
    JSON.stringify({ phase: 'csv-resumed', count, elapsedMs: csvResumedMs }),
  );
  if (
    !(await page
      .locator('#dataset-mapping-summary')
      .evaluate((el) => (el.parentElement as HTMLDetailsElement).open))
  )
    await page.locator('#dataset-mapping-summary').click();
  await attach();
  await ready();
  await saved();
  const reattached = await report(page);
  for (const key of [
    'settings',
    'threshold',
    'manualReview',
    'notes',
    'inspection',
  ])
    expect(reattached[key]).toEqual(before[key]);
  expect(await page.getByLabel('調査メモ', { exact: true }).inputValue()).toBe(
    '末尾ファイルの軽量保存・再開',
  );
  const finalStored = await persisted(page, before.analysis.id);
  expect(finalStored.files).toEqual([]);
  expect(finalStored.state.thresholdSetting).toEqual(
    stored.state.thresholdSetting,
  );
  expect(finalStored.state.reviewRecords).toEqual(stored.state.reviewRecords);
  await page.getByRole('button', { name: 'サンプル詳細', exact: true }).click();
  const audio = inspector.locator('audio');
  await expect(audio).toHaveCount(1, { timeout: 60_000 });
  await expect
    .poll(() => audio.evaluate((el) => el.readyState), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(1);
  expect(await audio.evaluate((el) => el.duration)).toBeCloseTo(0.25, 3);
  const playedHash = await audio.evaluate(
    async (el) => await (window as any).__playbackBlobHashes[el.src],
  );
  expect(playedHash).toBe(fixture.tailHash);
  await audio.evaluate((el) => {
    el.dataset.testPlayed = '';
    el.dataset.testEnded = '';
    el.addEventListener(
      'playing',
      () => {
        el.dataset.testPlayed = 'yes';
      },
      { once: true },
    );
    el.addEventListener(
      'ended',
      () => {
        el.dataset.testEnded = 'yes';
      },
      { once: true },
    );
  });
  await audio.click({ position: { x: 25, y: 20 } });
  await expect(audio).toHaveAttribute('data-test-played', 'yes');
  await expect(audio).toHaveAttribute('data-test-ended', 'yes');
  expect(await audio.evaluate((el) => el.currentTime)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  const result = {
    count,
    wavBytes: fixture.wavBytes,
    csvBytes: fixture.csvBytes,
    distinctWavCount: count,
    bundleBytes: finalStored.bundleBytes,
    initialBundleBytes: backupBytes,
    metadataJSONBytes: finalStored.metadataJSONBytes,
    opfsFileCount: finalStored.files.length,
    tailHash: playedHash,
    tailPlaybackSeconds: await audio.evaluate((el) => el.currentTime),
    fixtureValidatedMs,
    audioFirst,
    fullReselectionMs,
    firstAttachedMs,
    initiallySavedMs,
    csvResumedMs,
    totalMs: Date.now() - started,
    boundary:
      'Playwright directory file input; real disk bytes; native OS picker UI not exercised',
    pageErrors: errors,
  };
  const resultPath = testInfo.outputPath('disk-reference-result.json');
  await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
  await testInfo.attach('disk-reference-result', {
    path: resultPath,
    contentType: 'application/json',
  });
  console.log(JSON.stringify(result));
}
