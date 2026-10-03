// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  // Every test shares one local Firebase Auth Emulator instance (started in
  // globalSetup) since the app's auth gate blocks on it unconditionally.
  // Too many parallel browser contexts initializing auth simultaneously
  // starves that single process and stalls page loads (reproduced: 2/4
  // tests hang on the loading screen with the default worker count on this
  // machine, 0/4 with workers capped at 2) — this is a known constraint of
  // a single local emulator instance, not app or test flakiness.
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }]],
  globalSetup: require.resolve('./tests/global-setup.js'),
  use: {
    baseURL: 'http://localhost:8741',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'python3 -m http.server 8741 --directory .',
    url: 'http://localhost:8741',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'e2e',
      testDir: './tests/e2e',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
