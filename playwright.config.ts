import { defineConfig, devices, chromium } from '@playwright/test';
import { accessSync, constants } from 'node:fs';

function isExecutable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const portText = process.env.OVERLAP_E2E_PORT ?? '4174';
const port = Number(portText);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error(
    `OVERLAP_E2E_PORT must be an integer between 1024 and 65535 (received ${portText}).`,
  );
}

const requestedBrowser = process.env.OVERLAP_E2E_BROWSER_PATH?.trim();
if (requestedBrowser && !isExecutable(requestedBrowser)) {
  throw new Error(
    `OVERLAP_E2E_BROWSER_PATH does not point to an executable: ${requestedBrowser}`,
  );
}
const browserExecutable =
  requestedBrowser ||
  [
    chromium.executablePath(),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].find((candidate) => isExecutable(candidate));
if (!browserExecutable) {
  throw new Error(
    'No E2E browser is available. Install a browser outside the repository with `npx playwright install chromium`, or set OVERLAP_E2E_BROWSER_PATH to an installed Chrome executable.',
  );
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: './test-results',
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'ja-JP',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: { executablePath: browserExecutable },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npm run e2e:server -- --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    timeout: 120_000,
    reuseExistingServer: process.env.OVERLAP_E2E_REUSE_SERVER === '1',
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
