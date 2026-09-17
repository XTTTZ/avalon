import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60000,
  expect: { timeout: 12000 },
  use: {
    baseURL: 'http://127.0.0.1:5173',
    ...devices['iPhone 13'],
    defaultBrowserType: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'npm run dev:api',
      url: 'http://127.0.0.1:8787/health',
      reuseExistingServer: !process.env.CI,
      env: { DATA_FILE: '.data/e2e.json', ALLOW_GUEST: 'true' },
      timeout: 30000,
    },
    {
      command: 'npm run dev:web',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      env: { VITE_AUTH_MODE: 'guest' },
      timeout: 30000,
    },
  ],
});
