const base = require('@playwright/test');

const test = base.test.extend({
  // A fresh page with the app loaded, service worker disabled (removes
  // cache-staleness as a source of flakiness entirely, rather than relying
  // on bumping CACHE_NAME or Playwright's fresh-context default), and the
  // rounds-app-ready flag-setting listener registered before any page
  // script runs.
  appPage: async ({ page }, use) => {
    await page.addInitScript(() => {
      // Picked up by firebase-init.js before it evaluates (addInitScript
      // runs before any page script, including the type="module" one) —
      // points the app at the local emulators instead of the real project.
      window.__ROUNDS_TEST__ = { useEmulators: true };
      // Classic no-op: avoids ever registering a real service worker in
      // test runs, so there's nothing to go stale between test files.
      if ('serviceWorker' in navigator) {
        Object.defineProperty(navigator.serviceWorker, 'register', {
          value: () => Promise.reject(new Error('disabled in tests')),
        });
      }
      window.addEventListener('rounds-app-ready', () => {
        window.__roundsAppReady = true;
      });
    });
    await page.goto('/index.html');
    await use(page);
  },

  // appPage, already past the auth gate via guest mode.
  guestPage: async ({ appPage }, use) => {
    await appPage.click('#authGuestLink');
    await appPage.waitForSelector('.wrap:not([style*="display: none"])');
    await use(appPage);
  },

  // guestPage, already navigated past the neighborhoods landing page into
  // the searchable grid/map view — the single most important documented
  // gotcha for this app (it does NOT land on the list view by default).
  listingsPage: async ({ guestPage }, use) => {
    await guestPage.click('#browseAllBtn');
    await guestPage.waitForSelector('#content:not(.loading)');
    await use(guestPage);
  },
});

module.exports = { test, expect: base.expect };
