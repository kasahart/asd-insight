import { expect, test, type Page } from '@playwright/test';

type BrowserDiagnostics = {
  pageErrors: string[];
  consoleErrors: string[];
  requestFailures: string[];
};

const diagnosticsByPage = new WeakMap<Page, BrowserDiagnostics>();

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
    if (message.type() !== 'error') return;
    const location = message.location().url;
    diagnostics.consoleErrors.push(
      location ? `${message.text()} (${location})` : message.text(),
    );
  });
  page.on('requestfailed', (request) => {
    const errorText = request.failure()?.errorText ?? 'unknown request failure';
    // A navigation can cancel a request by design.
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
    // Give worker and console events one turn to settle before declaring the
    // browser runtime clean.
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

async function waitForStartup(page: Page) {
  const openData = page.getByRole('button', {
    name: 'データを選ぶ',
    exact: true,
  });
  try {
    await expect(openData).toBeVisible({ timeout: 15_000 });
  } catch {
    // If persistent storage is unavailable, the app explicitly offers a
    // temporary mode. The workflow tests do not depend on save/restore.
    const memoryMode = page.getByRole('button', {
      name: '保存せず一時利用',
      exact: true,
    });
    await expect(memoryMode).toBeVisible();
    await memoryMode.click();
    await expect(openData).toBeVisible();
  }
}

async function openDemo(page: Page) {
  await page.goto('/');
  await waitForStartup(page);
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
}

function countFromText(text: string): number {
  const match = text.match(/([\d,]+)件/);
  expect(match, `could not read a count from: ${text}`).toBeTruthy();
  return Number(match![1].replaceAll(',', ''));
}

async function listedCount(page: Page): Promise<number> {
  const heading = page.getByRole('heading', {
    level: 2,
    name: /^サンプル一覧/,
  });
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(heading).toContainText(/[\d,]+件/);
  return countFromText(await heading.innerText());
}

async function buttonCount(button: ReturnType<Page['getByRole']>) {
  return countFromText(await button.innerText());
}

async function pageScores(page: Page): Promise<number[]> {
  return page
    .locator('tbody[aria-label="一覧の表示ページ"] td .number-cell')
    .evaluateAll((cells) =>
      cells.map((cell) => Number(cell.textContent?.trim() ?? NaN)),
    );
}

function isAscending(values: number[]): boolean {
  return values.every(
    (value, index) => index === 0 || values[index - 1] <= value,
  );
}

function isDescending(values: number[]): boolean {
  return values.every(
    (value, index) => index === 0 || values[index - 1] >= value,
  );
}

test('仮しきい値からOK基準群のNG候補・反対群のOK候補と一覧が連動する', async ({ page }) => {
  await openDemo(page);

  await expect(
    page.getByRole('button', { name: /^OK基準群のNG候補/ }),
  ).toContainText('未設定時は1%で仮設定');
  await page
    .getByRole('button', {
      name: /^分布のしきい値設定を開く/,
    })
    .click();
  const thresholdPanel = page.getByRole('complementary', {
    name: '分布のしきい値設定',
  });
  await expect(thresholdPanel).toBeVisible();
  await thresholdPanel
    .getByLabel('OK群のNG候補率上限（%）', { exact: true })
    .fill('1');
  await thresholdPanel
    .getByRole('button', { name: '仮しきい値を設定', exact: true })
    .click();
  await expect(
    thresholdPanel.getByRole('heading', { name: '仮しきい値による候補分類' }),
  ).toBeVisible();
  await expect(page.locator('.listing-scope-summary')).toContainText(
    '計算対象全体',
  );

  const falsePositive = page.getByRole('button', {
    name: /^OK基準群のNG候補/,
  });
  const falseNegative = page.getByRole('button', {
    name: /^反対群のOK候補/,
  });
  await expect(falsePositive).toContainText(/\d+件/);
  await expect(falseNegative).toContainText(/\d+件/);
  const falsePositiveCount = await buttonCount(falsePositive);
  const falseNegativeCount = await buttonCount(falseNegative);
  expect(falsePositiveCount).toBeGreaterThan(0);
  expect(falseNegativeCount).toBeGreaterThan(0);

  await falsePositive.click();
  await expect(falsePositive).toHaveAttribute('aria-pressed', 'true');
  await expect(falseNegative).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.candidate-scope')).toContainText('候補全体');
  await expect.poll(() => listedCount(page)).toBe(falsePositiveCount);

  await falseNegative.click();
  await expect(falsePositive).toHaveAttribute('aria-pressed', 'false');
  await expect(falseNegative).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => listedCount(page)).toBe(falseNegativeCount);
});

test('一覧ヘッダーのセル全体で昇順・降順を切り替え、aria-sortと値順が一致する', async ({
  page,
}) => {
  await openDemo(page);

  const scoreHeader = page
    .getByRole('columnheader')
    .filter({ hasText: 'score_a' })
    .first();
  await expect(scoreHeader).toHaveAttribute('aria-sort', 'ascending');

  // The click targets the semantic header cell. The production CSS expands
  // the contained button to the entire cell, so this also guards the hit area.
  await scoreHeader.click();
  await expect(scoreHeader).toHaveAttribute('aria-sort', 'descending');
  let scores = await pageScores(page);
  expect(scores.length).toBeGreaterThan(1);
  expect(scores.every(Number.isFinite)).toBe(true);
  expect(isDescending(scores)).toBe(true);

  await scoreHeader.click();
  await expect(scoreHeader).toHaveAttribute('aria-sort', 'ascending');
  scores = await pageScores(page);
  expect(isAscending(scores)).toBe(true);

  // Sorting has only two states; a third activation returns to descending,
  // never to an unset state.
  await scoreHeader.click();
  await expect(scoreHeader).toHaveAttribute('aria-sort', 'descending');
  expect(isDescending(await pageScores(page))).toBe(true);
});

test('サンプルを除外し、除外のみから同じサンプルを復活できる', async ({
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
  const detailButton = page.getByRole('button', {
    name: '選択サンプルの詳細へ',
    exact: true,
  });
  await expect(detailButton).toBeEnabled();
  await detailButton.click();
  await expect(page.locator('#sample-audio')).toBeFocused();
  await inspector
    .locator('summary')
    .filter({ hasText: '集計から除外' })
    .click();
  await page.locator('#ignore-reason').fill('E2E確認用の除外');
  await page
    .getByRole('button', {
      name: 'このサンプルを集計から除外',
      exact: true,
    })
    .click();
  await expect(inspector).toContainText('集計から除外中');

  const ignoredOnly = page.getByRole('button', { name: /^除外のみ/ });
  await expect(ignoredOnly).toContainText('1件');
  await ignoredOnly.click();
  await expect(ignoredOnly).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => listedCount(page)).toBe(1);
  const restore = page.getByRole('button', {
    name: `${sampleId} を一覧から集計に戻す`,
    exact: true,
  });
  await expect(restore).toBeVisible();
  await restore.click();

  await expect.poll(() => listedCount(page)).toBe(0);
  await expect(ignoredOnly).toContainText('0件');
  await expect(
    page.getByRole('button', {
      name: `${sampleId} を一覧から集計に戻す`,
      exact: true,
    }),
  ).toHaveCount(0);

  const all = page.getByRole('button', { name: /^すべて/ });
  await all.click();
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => listedCount(page)).toBe(420);
  await expect(
    page
      .getByRole('button', { name: `${sampleId} を選択`, exact: true })
      .first(),
  ).toBeVisible();
  await expect(page.locator('tr[data-excluded="true"]')).toHaveCount(0);
});

test('サンプル名検索とページ送りが一覧件数に反映される', async ({ page }) => {
  await openDemo(page);

  const firstDisplayed = page
    .locator('tbody[aria-label="一覧の表示ページ"] button.sample-link')
    .first();
  const sampleId = await firstDisplayed.getAttribute('title');
  expect(sampleId).toMatch(/^DEMO-\d{4}$/);

  const query = page.getByLabel('サンプル名で検索', { exact: true });
  await query.fill(sampleId!);
  await expect.poll(() => listedCount(page)).toBe(1);
  await expect(
    page.getByRole('button', { name: `${sampleId} を選択`, exact: true }),
  ).toBeVisible();

  await query.fill('');
  await expect.poll(() => listedCount(page)).toBe(420);
  const nextPage = page.getByRole('button', {
    name: '次のページ',
    exact: true,
  });
  await expect(nextPage).toBeEnabled();
  await nextPage.click();
  await expect(page.getByText(/9–16件/)).toBeVisible();
  await expect(nextPage).toBeEnabled();
});
