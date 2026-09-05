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
    // Navigation and worker cancellation can abort an in-flight request by
    // design; all other failed requests are actionable in this runtime test.
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
    // Allow the final worker response and canvas draw to emit any late errors.
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

test.setTimeout(90_000);

test('合成デモの音声を実Wandas/Pyodideで解析し、音声表示とゲイン操作を確認する', async ({
  page,
}) => {
  type CapturedResponse = {
    url: string;
    status: number;
    headers: Record<string, string>;
  };
  const runtimeResponses: CapturedResponse[] = [];
  page.context().on('response', (response) => {
    const pathname = new URL(response.url()).pathname;
    if (
      pathname.includes('/runtime/audio/') ||
      /\/assets\/audio\.worker-[A-Za-z0-9_-]+\.js$/.test(pathname)
    ) {
      runtimeResponses.push({
        url: response.url(),
        status: response.status(),
        headers: response.headers(),
      });
    }
  });

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
  const audio = inspector.locator('audio');
  await expect(audio).toHaveCount(1, { timeout: 15_000 });
  await expect(audio).toHaveAttribute('src', /^blob:/);
  await expect
    .poll(() => audio.evaluate((element) => element.readyState), {
      timeout: 15_000,
      message: 'native audio metadata was not loaded',
    })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => audio.evaluate((element) => element.duration), {
      timeout: 15_000,
      message: 'native audio duration was not available',
    })
    .toBeGreaterThan(0);

  const spectrogram = page.getByRole('img', {
    name: `${sampleId} のスペクトログラム`,
    exact: true,
  });
  await expect(spectrogram).toBeVisible({ timeout: 60_000 });
  await expect(
    inspector.getByText('音声エンジンを準備中…', { exact: true }),
  ).toHaveCount(0);
  await expect(
    inspector.getByText('波形・スペクトログラムを計算中…', { exact: true }),
  ).toHaveCount(0);

  // The final UI result includes Wandas' fixed analysis metadata.
  await expect(inspector).toContainText('16,000 Hz（原音）/ 1 ch', {
    timeout: 10_000,
  });

  const pageOrigin = new URL(page.url()).origin;
  const responseFor = async (pattern: RegExp, description: string) => {
    await expect
      .poll(
        () =>
          runtimeResponses.find((candidate) =>
            pattern.test(new URL(candidate.url).pathname),
          ) ?? null,
        {
          timeout: 60_000,
          message: `${description} response was not captured`,
        },
      )
      .not.toBeNull();
    const response = runtimeResponses.find((candidate) =>
      pattern.test(new URL(candidate.url).pathname),
    );
    expect(response, `${description} response was not captured`).toBeDefined();
    expect(new URL(response!.url).origin, `${description} origin`).toBe(
      pageOrigin,
    );
    expect(response!.status, `${description} HTTP status`).toBe(200);
    return response!;
  };

  // URL strings alone do not prove that the pinned runtime was delivered.
  // Check the actual successful responses used by the worker.
  await responseFor(/\/runtime\/audio\/pyodide\.mjs$/, 'Pyodide mjs');
  await responseFor(/\/runtime\/audio\/pyodide\.asm\.wasm$/, 'Pyodide WASM');
  await responseFor(
    /\/runtime\/audio\/wandas-0\.7\.2-[^/]+\.whl$/,
    'Wandas wheel',
  );
  const workerResponse = await responseFor(
    /\/assets\/audio\.worker-[A-Za-z0-9_-]+\.js$/,
    'audio worker script',
  );
  const workerCsp = workerResponse.headers['content-security-policy'];
  expect(workerCsp, 'audio worker CSP header').toBeTruthy();
  expect(workerCsp).toContain("default-src 'none'");
  expect(workerCsp).toContain(
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
  );
  expect(workerCsp).toContain("worker-src 'none'");
  expect(workerCsp).toContain("connect-src 'self'");

  await expect
    .poll(
      () =>
        runtimeResponses
          .filter((candidate) =>
            new URL(candidate.url).pathname.includes('/runtime/audio/'),
          )
          .every((candidate) => new URL(candidate.url).origin === pageOrigin),
      { timeout: 60_000, message: 'audio runtime response origin changed' },
    )
    .toBe(true);

  const waveformDetails = inspector.locator('details.sample-audio-details');
  await expect(waveformDetails).toBeVisible();
  await waveformDetails
    .locator('summary')
    .filter({ hasText: '波形・音声情報' })
    .click();
  await expect(
    waveformDetails.getByLabel('原音のch1波形、振幅はマイナス1から1', {
      exact: true,
    }),
  ).toBeVisible();

  const gain = inspector.locator('#sample-playback-gain');
  const gainOutput = inspector
    .locator('output')
    .filter({ hasText: /^\+?\d+ dB$/ });
  await expect(gain).toHaveValue('0');
  await expect(gainOutput).toHaveText('0 dB');
  await gain.fill('6');
  await expect(gain).toHaveValue('6');
  await expect(gain).toHaveAttribute('aria-valuetext', '+6 dB');
  await expect(gainOutput).toHaveText('+6 dB');
  const resetGain = inspector.getByRole('button', {
    name: '0 dBに戻す',
    exact: true,
  });
  await expect(resetGain).toBeEnabled();
  await resetGain.click();
  await expect(gain).toHaveValue('0');
  await expect(gain).toHaveAttribute('aria-valuetext', '0 dB');
  await expect(gainOutput).toHaveText('0 dB');
  await expect(resetGain).toBeDisabled();
});
