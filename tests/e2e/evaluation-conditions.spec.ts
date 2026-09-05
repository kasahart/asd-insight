import { expect, test, type Locator, type Page } from '@playwright/test';

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
    // Navigation cancellation is expected when a page is replaced.
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
  await dialog
    .getByRole('button', { name: '合成デモを表示', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'demo_inspection.csv' }),
  ).toBeVisible();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );
}

type ResultSnapshot = {
  auc: number;
  groupA: number;
  groupB: number;
  listed: number;
  metricText: string;
};

async function waitForRecalculation(page: Page, action: () => Promise<void>) {
  const main = page.locator('main.main-panel');
  await action();
  await expect(main).toHaveAttribute('aria-busy', 'false', {
    timeout: 30_000,
  });
}

async function readFiniteAuc(locator: Locator) {
  const text = (await locator.textContent())?.trim() ?? '';
  expect(
    text,
    `expected a numeric PR-AUC in the metric strong, received: ${text}`,
  ).toMatch(/^(?:\d+(?:\.\d+)?|\.\d+)$/);
  const value = Number(text);
  expect(Number.isFinite(value), `PR-AUC is not finite: ${text}`).toBe(true);
  return value;
}

async function resultSnapshot(page: Page): Promise<ResultSnapshot> {
  const metrics = page.locator('section[aria-label="比較群全体の記述統計"]');
  const values = metrics.locator('strong');
  const listHeading = page.getByRole('heading', {
    level: 2,
    name: /^サンプル一覧/,
  });
  const listText = await listHeading.innerText();
  const listMatch = listText.match(/([\d,]+)件/);
  expect(
    listMatch,
    `could not read the list count from: ${listText}`,
  ).toBeTruthy();
  const readCount = async (index: number) => {
    const text = await values.nth(index).innerText();
    const match = text.match(/[\d,]+/);
    expect(match, `could not read group count from: ${text}`).toBeTruthy();
    return Number(match![0].replaceAll(',', ''));
  };
  return {
    auc: await readFiniteAuc(values.nth(0)),
    groupA: await readCount(1),
    groupB: await readCount(2),
    listed: Number(listMatch![1].replaceAll(',', '')),
    metricText: await metrics.innerText(),
  };
}

async function waitForSnapshot(
  page: Page,
  expected: Partial<Pick<ResultSnapshot, 'groupA' | 'groupB' | 'listed'>>,
) {
  await expect
    .poll(() => resultSnapshot(page), { timeout: 30_000 })
    .toMatchObject(expected);
}

async function waitForAucChange(page: Page, previous: number) {
  await expect
    .poll(async () => (await resultSnapshot(page)).auc, {
      timeout: 30_000,
    })
    .not.toBe(previous);
}

async function expectEvaluationHealthy(page: Page) {
  const main = page.locator('main.main-panel');
  await expect(main.getByRole('alert')).toHaveCount(0);
  await expect(main.locator('strong.null-value')).toHaveCount(0);
}

test('evaluation condition changes are recomputed by the worker and update the displayed result', async ({
  page,
}) => {
  await openDemo(page);

  const score = page.getByLabel('評価する異常度の列', { exact: true });
  const groupColumn = page.getByLabel('群分けに使う列', { exact: true });
  const groupA = page.getByLabel('群A', { exact: true });
  const groupB = page.getByLabel('群B', { exact: true });
  const okGroup = page.getByLabel('OKとして扱う基準群', { exact: true });
  const direction = page.getByLabel('NG候補とする方向', { exact: true });
  const filterColumn = page.getByLabel('評価対象の条件', { exact: true });

  await expect(score).toHaveValue('score_a');
  await expect(groupColumn).toHaveValue('cohort');
  await expect(groupA).toHaveValue('参照群');
  await expect(groupB).toHaveValue('比較群');
  await expect(okGroup).toHaveValue('A');
  await expect(direction).toHaveValue('high');
  await expect(filterColumn).toHaveValue('');
  const initial = await resultSnapshot(page);
  expect(initial).toMatchObject({ groupA: 260, groupB: 160, listed: 420 });
  expect(initial.metricText).toContain('群A');
  expect(initial.metricText).toContain('群B');
  await expectEvaluationHealthy(page);

  await waitForRecalculation(page, () => score.selectOption('score_b'));
  await expect(score).toHaveValue('score_b');
  await expect(
    page.getByRole('heading', { name: /スコア分布/ }).locator('code'),
  ).toHaveText('score_b');
  await expect(
    page.getByRole('columnheader').filter({ hasText: 'score_b' }).first(),
  ).toBeVisible();
  await waitForSnapshot(page, { groupA: 260, groupB: 160, listed: 420 });
  await waitForAucChange(page, initial.auc);
  const scoreB = await resultSnapshot(page);
  expect(scoreB.auc).not.toBe(initial.auc);
  await expectEvaluationHealthy(page);

  await waitForRecalculation(page, () => groupColumn.selectOption('batch'));
  await expect(groupColumn).toHaveValue('batch');
  await expect(groupA).toHaveValue('Lot-A');
  await expect(groupB).toHaveValue('Lot-B');
  await waitForSnapshot(page, { groupA: 140, groupB: 140, listed: 280 });
  const batchDefault = await resultSnapshot(page);
  await expectEvaluationHealthy(page);
  await expect(
    page.getByRole('columnheader').filter({ hasText: 'batch' }).first(),
  ).toBeVisible();

  // Use the third batch value as a temporary distinct value so neither edit
  // creates the invalid state where 群A and 群B are equal.
  await waitForRecalculation(page, () => groupB.selectOption('Lot-C'));
  await expect(groupB).toHaveValue('Lot-C');
  await waitForAucChange(page, batchDefault.auc);
  const lotC = await resultSnapshot(page);
  await expectEvaluationHealthy(page);
  await waitForRecalculation(page, () => groupA.selectOption('Lot-B'));
  await expect(groupA).toHaveValue('Lot-B');
  await waitForAucChange(page, lotC.auc);
  await waitForSnapshot(page, { groupA: 140, groupB: 140, listed: 280 });
  await expectEvaluationHealthy(page);

  const beforeOrientation = await resultSnapshot(page);
  await waitForRecalculation(page, () => okGroup.selectOption('B'));
  await waitForAucChange(page, beforeOrientation.auc);
  const okBResult = await resultSnapshot(page);
  await expectEvaluationHealthy(page);
  await waitForRecalculation(page, () => direction.selectOption('low'));
  await waitForAucChange(page, okBResult.auc);
  await expectEvaluationHealthy(page);
  await expect(okGroup).toHaveValue('B');
  await expect(direction).toHaveValue('low');
  await expect(page.locator('.pr-metric-context')).toContainText('陽性：群A');
  await expect(page.locator('.pr-metric-context')).toContainText('低スコア側');

  await waitForRecalculation(page, () =>
    filterColumn.selectOption('condition'),
  );
  const filterValue = page.getByLabel('集計する属性値', { exact: true });
  await expect(filterValue).toBeVisible();
  await expectEvaluationHealthy(page);
  await waitForRecalculation(page, () => filterValue.selectOption('標準'));
  await expect(filterColumn).toHaveValue('condition');
  await expect(filterValue).toHaveValue('標準');
  await expect(page.locator('.active-population')).toContainText(
    '集計条件：condition = 標準',
  );

  await waitForSnapshot(page, { groupA: 96, groupB: 97, listed: 193 });
  await expectEvaluationHealthy(page);
  await expect(
    page.getByRole('columnheader').filter({ hasText: 'score_b' }).first(),
  ).toBeVisible();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
  );
});
