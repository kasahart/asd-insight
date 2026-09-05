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

async function expectContained(page: Page, selectors: string[]) {
  const geometry = await page.evaluate((elementSelectors) => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const boxes = elementSelectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector))
        .filter(visible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            selector,
            left: rect.left,
            right: rect.right,
            width: rect.width,
            height: rect.height,
          };
        }),
    );
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      boxes,
    };
  }, selectors);

  expect(
    geometry.documentWidth,
    'document should not create horizontal viewport overflow',
  ).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.boxes.length).toBeGreaterThan(0);
  for (const box of geometry.boxes) {
    expect(
      box.width,
      `${box.selector} should have layout width`,
    ).toBeGreaterThan(0);
    expect(
      box.height,
      `${box.selector} should have layout height`,
    ).toBeGreaterThan(0);
    expect(
      box.left,
      `${box.selector} starts outside the viewport`,
    ).toBeGreaterThanOrEqual(-1);
    expect(
      box.right,
      `${box.selector} ends outside the viewport`,
    ).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  }
}

async function waitForThresholdSlider(page: Page) {
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );
  const slider = page.getByRole('slider', {
    name: '分布上の仮しきい値',
    exact: true,
  });
  await expect(slider).toBeVisible({ timeout: 30_000 });
  return slider;
}

async function readThresholdDisplay(
  page: Page,
  slider: ReturnType<Page['getByRole']>,
) {
  const value = await slider.getAttribute('aria-valuenow');
  const valueText = await slider.getAttribute('aria-valuetext');
  const rule = await page.locator('.threshold-rule code').innerText();
  const marker = await page
    .locator('.distribution-threshold-marker text')
    .textContent();
  return {
    value: Number(value),
    valueText,
    rule,
    marker: marker?.trim() ?? '',
  };
}

test('responsive boundaries keep the startup dialog and main workbench inside the viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 650, height: 900 });
  await page.goto('/');
  await waitForStartup(page);
  await page.getByRole('button', { name: 'データを選ぶ', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: 'データと保存した分析',
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: '合成デモ', exact: true }),
  ).toBeEnabled();
  await expectContained(page, ['.data-source-dialog']);

  await dialog.getByRole('button', { name: '合成デモ', exact: true }).click();
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

  const workbench = page.locator('.context-workbench');
  await expect(workbench).toHaveAttribute('data-layout', 'stacked');
  await expectContained(page, [
    '.workspace',
    '.control-panel',
    '.main-panel',
    '.context-workbench',
    '.analysis-stage',
    '.context-inspector',
  ]);

  await page.setViewportSize({ width: 1241, height: 900 });
  await expect(workbench).toHaveAttribute('data-layout', 'columns');
  await expectContained(page, [
    '.workspace',
    '.main-panel',
    '.context-workbench',
    '.analysis-stage',
    '.context-inspector',
  ]);

  await page.setViewportSize({ width: 1240, height: 900 });
  await expect(workbench).toHaveAttribute('data-layout', 'stacked');
  await expectContained(page, [
    '.workspace',
    '.main-panel',
    '.context-workbench',
    '.analysis-stage',
    '.context-inspector',
  ]);

  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(workbench).toHaveAttribute('data-layout', 'columns');

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
  await expect(inspector.getByLabel('選択中のサンプル名')).toContainText(
    sampleId!,
  );

  const separator = page.getByRole('separator', {
    name: '詳細パネルの幅',
    exact: true,
  });
  await expect(separator).toHaveAttribute('aria-disabled', 'false');
  await expect(separator).toHaveAttribute('tabindex', '0');
  const min = Number(await separator.getAttribute('aria-valuemin'));
  const max = Number(await separator.getAttribute('aria-valuemax'));
  expect(max).toBeGreaterThan(min);

  await separator.focus();
  await separator.press('Home');
  await expect(separator).toHaveAttribute('aria-valuenow', String(min));
  await expect(inspector.getByLabel('選択中のサンプル名')).toContainText(
    sampleId!,
  );

  await separator.press('End');
  await expect(separator).toHaveAttribute('aria-valuenow', String(max));
  await separator.press('ArrowRight');
  const narrowed = Number(await separator.getAttribute('aria-valuenow'));
  expect(narrowed).toBeLessThan(max);
  await separator.press('ArrowLeft');
  await expect(separator).toHaveAttribute('aria-valuenow', String(max));
  await expect(inspector.getByLabel('選択中のサンプル名')).toContainText(
    sampleId!,
  );
});

test('320px keeps search, table scrolling, sorting, and score cells usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await openDemo(page);

  const query = page.getByLabel('サンプル名で検索', { exact: true });
  const queryLabel = page.locator('.sample-query-control > label').first();
  const labelBox = await queryLabel.boundingBox();
  const helperBox = await queryLabel.locator('span').boundingBox();
  const inputBox = await query.boundingBox();
  expect(labelBox).not.toBeNull();
  expect(helperBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  expect(inputBox!.y).toBeGreaterThan(helperBox!.y + helperBox!.height - 1);
  expect(inputBox!.width).toBeGreaterThanOrEqual(labelBox!.width - 8);

  await page.getByLabel('検索一致方法', { exact: true }).selectOption('exact');
  await query.fill('DEMO-0001');
  await expect(page.getByRole('heading', { name: /^サンプル一覧/ })).toContainText(
    '1件',
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    )
    .toBe(true);

  await query.fill('');
  await page.getByLabel('検索一致方法', { exact: true }).selectOption('partial');
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );
  const region = page.getByRole('region', {
    name: 'サンプル一覧の横スクロール領域',
  });
  await expect(region).toBeVisible();
  const beforeScroll = await region.evaluate((element) => ({
    scrollLeft: element.scrollLeft,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(beforeScroll.scrollWidth).toBeGreaterThan(beforeScroll.clientWidth);
  await region.focus();
  await expect(region).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() => region.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(beforeScroll.scrollLeft);
  await expect(region).toBeFocused();

  const scoreHeader = page.getByRole('button', { name: /^score_a：/ }).first();
  const scoreColumn = scoreHeader.locator('..');
  const firstScoreCell = page
    .locator('tbody[aria-label="一覧の表示ページ"] tr')
    .first()
    .locator('.number-cell');
  await firstScoreCell.scrollIntoViewIfNeeded();
  await expect(scoreHeader).toBeVisible();
  await scoreHeader.focus();
  await expect(scoreHeader).toBeFocused();
  const ascendingFirst = Number(
    await firstScoreCell.innerText(),
  );
  await page.keyboard.press('Enter');
  await expect(scoreColumn).toHaveAttribute('aria-sort', 'descending');
  await firstScoreCell.scrollIntoViewIfNeeded();
  const descendingFirst = Number(
    await firstScoreCell.innerText(),
  );
  expect(descendingFirst).toBeGreaterThan(ascendingFirst);

  const unobscured = await page.evaluate(() => {
    const scoreCell = document.querySelector(
      'tbody[aria-label="一覧の表示ページ"] .number-cell',
    )?.closest('td');
    const region = document.querySelector<HTMLElement>(
      '[aria-label="サンプル一覧の横スクロール領域"]',
    );
    if (!scoreCell || !region) return null;
    const scoreRect = scoreCell.getBoundingClientRect();
    const regionRect = region.getBoundingClientRect();
    const left = Math.max(
      scoreRect.left,
      regionRect.left + region.clientLeft,
      0,
    );
    const right = Math.min(
      scoreRect.right,
      regionRect.left + region.clientLeft + region.clientWidth,
      window.innerWidth,
    );
    const top = Math.max(scoreRect.top, regionRect.top + region.clientTop, 0);
    const bottom = Math.min(
      scoreRect.bottom,
      regionRect.top + region.clientTop + region.clientHeight,
      window.innerHeight,
    );
    if (right <= left || bottom <= top) return null;
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    const hit = document.elementFromPoint(x, y)?.closest('td');
    return {
      scoreVisible: true,
      hitScore: hit === scoreCell,
    };
  });
  expect(unobscured).not.toBeNull();
  expect(unobscured!.scoreVisible).toBe(true);
  expect(unobscured!.hitScore).toBe(true);
});

test('threshold slider keyboard controls update its value and visible readout', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDemo(page);

  const target = page.getByLabel('OK群のNG候補率上限（%）', { exact: true });
  await expect(target).toBeVisible();
  await target.fill('10');
  await page
    .getByRole('button', { name: '仮しきい値を設定', exact: true })
    .click();
  let slider = await waitForThresholdSlider(page);
  const min = Number(await slider.getAttribute('aria-valuemin'));
  const max = Number(await slider.getAttribute('aria-valuemax'));
  expect(max).toBeGreaterThan(min);

  async function assertReadout(expected: number) {
    slider = await waitForThresholdSlider(page);
    await expect(slider).toHaveAttribute('aria-valuenow', String(expected));
    const display = await readThresholdDisplay(page, slider);
    expect(display.value).toBe(expected);
    expect(display.valueText).toContain('スコア');
    expect(display.rule).toContain('NG候補');
    const markerValue = Number(display.marker.replaceAll(',', ''));
    expect(Math.abs(markerValue - expected)).toBeLessThan(
      Math.max(0.001, Math.abs(expected) * 0.0001),
    );
  }

  await slider.focus();
  await slider.press('Home');
  await assertReadout(min);

  await slider.focus();
  await slider.press('End');
  await assertReadout(max);

  await slider.focus();
  await slider.press('ArrowLeft');
  const afterArrow = Number(await slider.getAttribute('aria-valuenow'));
  expect(afterArrow).toBeLessThan(max);
  await assertReadout(afterArrow);

  await slider.focus();
  await slider.press('Escape');
  await assertReadout(afterArrow);

  await slider.focus();
  await slider.press('ArrowRight');
  const restored = Number(await slider.getAttribute('aria-valuenow'));
  expect(restored).toBeGreaterThan(afterArrow);
  await assertReadout(restored);
});

test('threshold slider keeps focus across a recalculation and accepts the next key', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDemo(page);

  const target = page.getByLabel('OK群のNG候補率上限（%）', { exact: true });
  await target.fill('10');
  await page
    .getByRole('button', { name: '仮しきい値を設定', exact: true })
    .click();
  const slider = await waitForThresholdSlider(page);
  const before = Number(await slider.getAttribute('aria-valuenow'));

  // Focus once, then use the page keyboard so a remounted locator cannot
  // accidentally focus the replacement element between key presses.
  await slider.focus();
  await expect(slider).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toBeFocused();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );
  const afterFirst = Number(await slider.getAttribute('aria-valuenow'));
  expect(afterFirst).toBeLessThan(before);

  await page.keyboard.press('ArrowLeft');
  await expect(slider).toBeFocused();
  await expect(page.locator('main.main-panel')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 },
  );
  const afterSecond = Number(await slider.getAttribute('aria-valuenow'));
  expect(afterSecond).toBeLessThan(afterFirst);
});

test('manual step anchors and same-origin image/link resources are usable', async ({
  page,
  request,
}) => {
  await page.goto('/manual/');
  await expect(page).toHaveTitle('ASD Insight | 使い方');

  const stepIds = ['start', 'conditions', 'distribution', 'samples', 'save'];
  const stepLinks = page
    .getByRole('navigation', { name: '手順' })
    .getByRole('link');
  await expect(stepLinks).toHaveCount(stepIds.length);
  for (const [index, id] of stepIds.entries()) {
    const link = stepLinks.nth(index);
    await expect(link).toHaveAttribute('href', `#${id}`);
    await link.click();
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toBe(`#${id}`);
    await expect(page.locator(`#${id}`)).toBeInViewport();
  }

  const resourceUrls = await page.evaluate(() => {
    const urls = new Set<string>();
    const add = (value: string | null) => {
      if (!value) return;
      const url = new URL(value, window.location.href);
      if (url.origin === window.location.origin) {
        url.hash = '';
        urls.add(url.href);
      }
    };
    document
      .querySelectorAll('img[src], link[href], a.image-link[href]')
      .forEach((element) =>
        add(element.getAttribute('src') ?? element.getAttribute('href')),
      );
    return [...urls];
  });
  expect(resourceUrls.length).toBeGreaterThan(1);

  const statuses = await Promise.all(
    resourceUrls.map(async (url) => ({
      url,
      status: (await request.get(url)).status(),
    })),
  );
  expect(
    statuses,
    'every favicon/image/link resource should return HTTP 200',
  ).toEqual(resourceUrls.map((url) => ({ url, status: 200 })));
});
