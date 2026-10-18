// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  // Every test shares one local Firebase Auth (+ as of Phase 2, Firestore)
  // Emulator instance (started in globalSetup), since the app's auth gate
  // blocks on it unconditionally. Phase 1's guest-only tests tolerated 2
  // parallel workers fine, but Phase 2's real sign-in + live Firestore
  // listeners per test proved genuinely unreliable at any concurrency above
  // 1 — reproduced repeatedly: tests hang indefinitely waiting on the
  // emulator under 2 workers even after every actual logic bug was fixed,
  // and were rock-solid every time at workers:1. This is a real capacity
  // limit of one local emulator pair under concurrent browser contexts, not
  // app or test flakiness — a slower, reliable suite beats a faster, flaky
  // one.
  workers: 1,
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
    // Node-only: these specs never request `page`, so no browser launches.
    // They talk straight to the Firestore Emulator via
    // @firebase/rules-unit-testing.
    {
      name: 'rules',
      testDir: './tests/rules',
    },
  ],
});
