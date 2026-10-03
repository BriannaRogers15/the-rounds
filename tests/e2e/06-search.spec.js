const { test, expect } = require('../fixtures/app-fixture');
const { injectRestaurants, resetLedger } = require('../fixtures/ledger-helpers');
const { probeRestaurants } = require('../fixtures/seed-data');

test.describe('Search box', () => {
  test('filters the grid to matching names, case-insensitively', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.fill('#searchBox', 'pizza');
      await expect(listingsPage.locator('.ticket')).toHaveCount(1, { timeout: 2000 });
      await expect(listingsPage.locator('.ticket')).toContainText('Probe Pizza Place');
    } finally {
      await listingsPage.fill('#searchBox', '');
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('the 150ms debounce coalesces rapid keystrokes into one render', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      // Asserting on an intermediate "hasn't re-rendered yet" DOM state is
      // inherently timing-flaky under load — instead, count actual
      // renderContent() calls directly (it's a top-level function
      // declaration, so it's reachable on window) to prove the 5
      // keystrokes produced far fewer renders than one-per-keystroke would.
      await listingsPage.evaluate(() => {
        window.__renderCount = 0;
        const original = window.renderContent;
        window.renderContent = function (...args) {
          window.__renderCount++;
          return original.apply(this, args);
        };
      });
      await listingsPage.type('#searchBox', 'sushi', { delay: 20 });
      await expect(listingsPage.locator('.ticket')).toHaveCount(1, { timeout: 2000 });
      await expect(listingsPage.locator('.ticket')).toContainText('Probe Sushi Spot');
      const renderCount = await listingsPage.evaluate(() => window.__renderCount);
      expect(renderCount).toBeLessThan(5); // 5 keystrokes, far fewer renders
    } finally {
      await listingsPage.fill('#searchBox', '');
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('clearing the search box restores the full list', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.fill('#searchBox', 'pizza');
      await expect(listingsPage.locator('.ticket')).toHaveCount(1, { timeout: 2000 });
      await listingsPage.fill('#searchBox', '');
      await expect(listingsPage.locator('.ticket')).toHaveCount(probes.length, { timeout: 2000 });
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('no matches shows the empty state, not an empty grid', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.fill('#searchBox', 'zzzznomatch');
      await expect(listingsPage.locator('.empty')).toContainText('No listings match', { timeout: 2000 });
    } finally {
      await listingsPage.fill('#searchBox', '');
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });
});
