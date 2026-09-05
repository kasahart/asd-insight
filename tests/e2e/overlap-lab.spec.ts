import { expect, test, type Page } from '@playwright/test';

type BrowserDiagnostics = {
  pageErrors: string[];
  consoleErrors: string[];
  requestFailures: string[];
};

const diagnosticsByPage = new WeakMap<Page, BrowserDiagnostics>();
type StorageMode = 'persistent' | 'memory';

test.beforeEach(async ({ page }) => {
  const diagnostics: BrowserDiagnostics = {
    pageErrors: [],
    consoleErrors: [],
    requestFailures: [],
  };
  diagnosticsByPage.set(page, diagnostics);
  page.on('pageerror', (error) => {
    diagnostics.pageErrors.push(error.stack ?? error.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const location = message.location().url;
      diagnostics.consoleErrors.push(
        location ? `${message.text()} (${location})` : message.text(),
      );
    }
  });
  page.on('requestfailed', (request) => {
    const errorText = request.failure()?.errorText ?? 'unknown request failure';
    // Page reloads and navigation can cancel a request by design.
    if (/ERR_ABORTED|NS_BINDING_ABORTED/i.test(errorText)) return;
    diagnostics.requestFailures.push(
      `${request.method()} ${request.url()} (${errorText})`,
    );
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const diagnostics = diagnosticsByPage.get(page);
  try {
    if (testInfo.status !== 'passed' || !diagnostics) return;
    // Let late worker and console events settle before declaring the page clean.
    await page.waitForTimeout(0);
    expect(diagnostics.pageErrors, 'unexpected pageerror').toEqual([]);
    expect(diagnostics.consoleErrors, 'unexpected console.error').toEqual([]);
    expect(diagnostics.requestFailures, 'unexpected failed request').toEqual(
      [],
    );
  } finally {
    diagnosticsByPage.delete(page);
  }
});

async function waitForStartup(page: Page): Promise<StorageMode> {
  const openData = page.getByRole('button', {
    name: 'データを選ぶ',
    exact: true,
  });
  try {
    await expect(openData).toBeVisible({ timeout: 15_000 });
    return 'persistent';
  } catch {
    // Persistent storage can be disabled by a browser policy. The app only
    // offers memory mode after that failure, so make the fallback explicit.
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

async function openStartup(page: Page): Promise<StorageMode> {
  await page.goto('/');
  return waitForStartup(page);
}

async function openDemo(page: Page): Promise<StorageMode> {
  const storageMode = await openStartup(page);
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();

  const dialog = page.getByRole('dialog', {
    name: 'データと保存した分析',
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '合成デモ', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '合成デモ' })).toBeVisible();

  const showDemo = dialog.getByRole('button', {
    name: '合成デモを表示',
    exact: true,
  });
  await expect(showDemo).toBeEnabled();
  await showDemo.click();

  await expect(
    page.getByRole('heading', { name: 'demo_inspection.csv' }),
  ).toBeVisible();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );
  return storageMode;
}

async function listedCount(page: Page) {
  const heading = page.getByRole('heading', {
    level: 2,
    name: /^サンプル一覧/,
  });
  const text = await heading.innerText();
  const match = text.match(/([\d,]+)件/);
  expect(match, `could not read the sample count from: ${text}`).toBeTruthy();
  return Number(match![1].replaceAll(',', ''));
}

async function visiblePageScores(page: Page) {
  return page
    .locator('tbody[aria-label="一覧の表示ページ"] tr')
    .evaluateAll((rows) =>
      rows.map((row) => Number(row.cells[2]?.textContent?.trim() ?? NaN)),
    );
}

test('初期ページのpreviewレスポンスが配信セキュリティヘッダーを返す', async ({
  page,
}) => {
  const response = await page.goto('/');
  expect(response).not.toBeNull();
  expect(response!.status()).toBe(200);
  const headers = response!.headers();
  expect(headers['content-security-policy']).toContain("default-src 'none'");
  expect(headers['content-security-policy']).toContain(
    "script-src 'self' 'wasm-unsafe-eval'",
  );
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['permissions-policy']).toContain('microphone=()');
  await waitForStartup(page);
});

test('初期画面から合成デモを開くと評価画面が表示される', async ({ page }) => {
  await openDemo(page);

  await expect(
    page.getByRole('heading', { name: '評価条件', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: '全体のスコア分布' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: /^サンプル一覧/ }),
  ).toContainText('420件');
});

test('数値で指定した分布範囲が一覧の候補に連動する', async ({ page }) => {
  await openDemo(page);
  const allCount = await listedCount(page);
  expect(allCount).toBe(420);

  await page.getByText('数値で指定', { exact: true }).click();
  await page.getByLabel('確認範囲の下限', { exact: true }).fill('0.2');
  await page.getByLabel('確認範囲の上限', { exact: true }).fill('0.4');
  await page.getByRole('button', { name: '範囲を適用', exact: true }).click();

  await expect(page.locator('output.selection-status')).toContainText(
    '一覧範囲：0.2 ≤ スコア ≤ 0.4',
  );
  await expect
    .poll(() => listedCount(page), { timeout: 10_000 })
    .toBeLessThan(allCount);
  const rangeCount = await listedCount(page);
  expect(rangeCount).toBeGreaterThan(0);

  const visibleScores = await page
    .locator('tbody[aria-label="一覧の表示ページ"] tr')
    .evaluateAll((rows) =>
      rows.map((row) => Number(row.cells[2]?.textContent?.trim() ?? NaN)),
    );
  expect(visibleScores.length).toBeGreaterThan(0);
  expect(visibleScores.every((score) => score >= 0.2 && score <= 0.4)).toBe(
    true,
  );
});

test('分布上を相対位置でドラッグすると一覧の候補が絞り込まれる', async ({
  page,
}) => {
  await openDemo(page);
  const allCount = await listedCount(page);
  const rangeTarget = page.locator('rect.distribution-range-target');
  const box = await rangeTarget.boundingBox();
  expect(box).not.toBeNull();

  // Use proportions of the rendered target so this remains independent of
  // viewport pixels and chart margins.
  const start = { x: box!.x + box!.width * 0.2, y: box!.y + box!.height * 0.5 };
  const end = { x: box!.x + box!.width * 0.55, y: start.y };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator('output.selection-status')).toContainText(
    '一覧範囲：',
  );
  const rangeText = await page.locator('output.selection-status').innerText();
  const number = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
  const rangeMatch = rangeText.match(
    new RegExp(
      `一覧範囲：\\s*(${number})\\s*≤\\s*スコア\\s*(≤|<)\\s*(${number})`,
    ),
  );
  expect(
    rangeMatch,
    `could not parse the selected range: ${rangeText}`,
  ).not.toBeNull();
  const lower = Number(rangeMatch![1]);
  const upper = Number(rangeMatch![3]);
  expect(lower).toBeLessThan(upper);
  await expect
    .poll(() => listedCount(page), { timeout: 10_000 })
    .toBeLessThan(allCount);
  expect(await listedCount(page)).toBeGreaterThan(0);
  const visibleScores = await visiblePageScores(page);
  expect(visibleScores.length).toBeGreaterThan(0);
  expect(
    visibleScores.every((score) =>
      rangeMatch![2] === '≤'
        ? score >= lower && score <= upper
        : score >= lower && score < upper,
    ),
  ).toBe(true);
});

test('一覧からサンプルを選ぶと詳細パネルと参照行が切り替わる', async ({
  page,
}) => {
  await openDemo(page);

  const sampleLink = page
    .locator('tbody[aria-label="一覧の表示ページ"] button.sample-link')
    .first();
  const sampleId = await sampleLink.getAttribute('title');
  expect(sampleId).toMatch(/^DEMO-\d{4}$/);
  await sampleLink.click();

  const inspector = page.getByRole('complementary', {
    name: '選択サンプルの詳細',
  });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole('heading', { name: '音声' })).toBeVisible();
  await expect(inspector.getByLabel('選択中のサンプル名')).toContainText(
    sampleId!,
  );
  await expect(inspector).toContainText(
    'デモ合成音・実際の機械音ではありません',
  );

  const referenceBody = page.locator(
    'tbody[aria-label="選択中のサンプル（参照）"]',
  );
  await expect(referenceBody).toBeVisible();
  await expect(
    referenceBody.getByRole('button', { name: `${sampleId} を選択` }),
  ).toBeVisible();
  await expect(referenceBody.locator('tr[aria-selected="true"]')).toHaveCount(
    1,
  );
});

test('合成デモの選択とメモが保存され、reload後に分析として復元できる', async ({
  page,
}) => {
  const storageMode = await openDemo(page);
  expect(
    storageMode,
    '保存復元E2Eには永続ストレージが必要です。一時利用へフォールバックしたためテストを成功扱いにしません。',
  ).toBe('persistent');

  const sampleLink = page
    .locator('tbody[aria-label="一覧の表示ページ"] button.sample-link')
    .first();
  const sampleId = await sampleLink.getAttribute('title');
  expect(sampleId).toMatch(/^DEMO-\d{4}$/);
  await sampleLink.click();
  await expect(
    page.getByRole('complementary', { name: '選択サンプルの詳細' }),
  ).toBeVisible();

  const note = 'E2Eで保存したメモ';
  await page.getByLabel('調査メモ', { exact: true }).fill(note);
  await expect(
    page.getByRole('button', { name: '保存状態と分析を管理' }),
  ).toContainText('端末に保存済み', { timeout: 20_000 });

  await page.reload();
  await expect(
    page.getByRole('heading', { name: '分析するデータを選ぶ' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: 'データと保存した分析',
  });
  const saved = dialog.getByRole('region', { name: '保存した分析' });
  await expect(saved).toBeVisible();
  const savedDemo = saved
    .getByRole('listitem')
    .filter({ hasText: 'demo_inspection.csv' });
  await expect(savedDemo).toBeVisible();
  await savedDemo.getByRole('button', { name: '開く', exact: true }).click();

  await expect(
    page.getByRole('heading', { name: 'demo_inspection.csv' }),
  ).toBeVisible();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );
  await expect(
    page.getByRole('complementary', { name: '選択サンプルの詳細' }),
  ).toBeVisible();
  await expect(page.getByLabel('選択中のサンプル名')).toContainText(sampleId!);
  await expect(page.getByLabel('調査メモ', { exact: true })).toHaveValue(note);
  await expect(
    page.getByRole('button', { name: '保存状態と分析を管理' }),
  ).toContainText('端末に保存済み');
});

test('使い方ページの画像とGIF参照が実ブラウザで読み込める', async ({
  page,
}) => {
  await page.goto('/manual/');

  await expect(page).toHaveTitle('ASD Insight | 使い方');
  await expect(
    page.getByRole('heading', {
      name: '分布を見て、気になるサンプルを確認する',
    }),
  ).toBeVisible();

  const images = page.locator('img');
  await expect(images).toHaveCount(10);
  await expect
    .poll(
      () =>
        images.evaluateAll((nodes) =>
          nodes.every(
            (node) =>
              (node as HTMLImageElement).naturalWidth > 0 &&
              (node as HTMLImageElement).naturalHeight > 0,
          ),
        ),
      { timeout: 10_000 },
    )
    .toBe(true);

  const references = await page.locator('a.image-link').evaluateAll((nodes) =>
    nodes.map((node) => ({
      href: node.getAttribute('href'),
      target: node.getAttribute('target'),
      source: node.querySelector('img')?.getAttribute('src'),
    })),
  );
  expect(references.length).toBe(10);
  expect(references.every(({ href, source }) => href && source)).toBe(true);
  expect(
    references.filter(({ href }) => href?.toLowerCase().endsWith('.gif'))
      .length,
  ).toBeGreaterThanOrEqual(3);
  expect(
    references.every(({ href, source }) => {
      const hrefUrl = new URL(href!, page.url());
      const sourceUrl = new URL(source!, page.url());
      const pageOrigin = new URL(page.url()).origin;
      return (
        hrefUrl.origin === pageOrigin && sourceUrl.origin === hrefUrl.origin
      );
    }),
  ).toBe(true);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(page.locator('a.motion-gif').first()).toBeHidden();
  await expect(page.locator('a.motion-static').first()).toBeVisible();
  expect(
    await page
      .locator('a.motion-gif')
      .evaluateAll((nodes) =>
        nodes.every((node) => getComputedStyle(node).display === 'none'),
      ),
  ).toBe(true);
  expect(
    await page
      .locator('a.motion-static')
      .evaluateAll((nodes) =>
        nodes.every((node) => getComputedStyle(node).display !== 'none'),
      ),
  ).toBe(true);
});

test('初期画面と評価画面の使い方リンクがマニュアルへ遷移する', async ({
  page,
}) => {
  await openStartup(page);
  await page.getByRole('link', { name: '使い方', exact: true }).click();
  await expect(page).toHaveURL(/\/manual\/$/);
  await expect(
    page.getByRole('heading', {
      name: '分布を見て、気になるサンプルを確認する',
    }),
  ).toBeVisible();

  await page.goto('/');
  await openDemo(page);
  await page.getByRole('link', { name: '使い方', exact: true }).click();
  await expect(page).toHaveURL(/\/manual\/$/);
  await expect(page).toHaveTitle('ASD Insight | 使い方');
});
