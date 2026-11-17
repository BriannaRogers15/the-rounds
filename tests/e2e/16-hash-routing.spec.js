const { test, expect } = require('../fixtures/app-fixture');
const { injectRestaurants, resetLedger, waitForAppReady } = require('../fixtures/ledger-helpers');
const { probeRestaurants } = require('../fixtures/seed-data');

test.describe('URL hash routing', () => {
  test('empty hash lands on the areas page', async ({ guestPage }) => {
    expect(guestPage.url().split('#')[1] || '').toBe('');
    await expect(guestPage.locator('#areasPage')).toBeVisible();
  });

  test('navigating to listings updates the hash to v=all', async ({ listingsPage }) => {
    await expect
      .poll(() => new URL(listingsPage.url()).hash)
      .toBe('#v=all');
  });

  test('selecting a guide category appends c= to the hash', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('.rail-item[data-cat="American"]');
      await expect
        .poll(() => new URL(listingsPage.url()).hash)
        .toBe('#v=all&c=American');
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('browser back returns from listings to the areas page', async ({ listingsPage }) => {
    await listingsPage.goBack();
    await expect(listingsPage.locator('#areasPage')).toBeVisible();
    await expect(listingsPage.locator('#listingsLayout')).toBeHidden();
  });

  test('a cold load directly on #v=all lands in listings, bypassing the areas page', async ({ appPage }) => {
    // Simulates someone opening a bookmarked/shared link straight into the
    // "all listings" view rather than navigating there through the UI —
    // a fresh navigation with the hash already in the target URL, not a
    // same-page hash mutation followed by reload.
    await appPage.goto('/index.html#v=all');
    await waitForAppReady(appPage);
    await appPage.click('#authGuestLink');
    await expect(appPage.locator('#listingsLayout')).toBeVisible();
    await expect(appPage.locator('#areasPage')).toBeHidden();
  });

  test('the city sides are Up North / Out West / Out South / Over East, and old side links still land', async ({ browser }) => {
    const { openGuestPage, closeContext } = require('../fixtures/app-fixture');
    const context = await browser.newContext();
    const page = await openGuestPage(context);
    try {
      expect(await page.evaluate(() => CHI_SIDES)).toEqual(['Downtown', 'Up North', 'Out West', 'Out South', 'Over East']);
      // A bookmark saved before the rename.
      await page.goto('/index.html#v=area&t=side&n=South+Side');
      await page.waitForFunction(() => window.__roundsAppReady === true);
      await expect(page.locator('.area-title')).toHaveText('Out South');
    } finally {
      await closeContext(context);
    }
  });
});
