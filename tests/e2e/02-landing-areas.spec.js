const { test, expect, openGuestPage } = require('../fixtures/app-fixture');
const { waitForAppReady, injectRestaurants, resetLedger } = require('../fixtures/ledger-helpers');
const { probeRestaurants } = require('../fixtures/seed-data');

test.describe('Landing / neighborhoods page', () => {
  test('lands on the areas page, not the listings grid, after guest sign-in', async ({ guestPage }) => {
    await expect(guestPage.locator('#areasPage')).toBeVisible();
    await expect(guestPage.locator('#listingsLayout')).toBeHidden();
  });

  test('"Browse all listings" bypasses area selection into the grid', async ({ listingsPage }) => {
    await expect(listingsPage.locator('#listingsLayout')).toBeVisible();
    await expect(listingsPage.locator('#areasPage')).toBeHidden();
  });

  test('clicking a neighborhood/area block opens listings scoped to that area', async ({ guestPage }) => {
    await waitForAppReady(guestPage);
    const probes = probeRestaurants();
    await injectRestaurants(guestPage, probes);
    try {
      const firstBlock = guestPage.locator('.area-block').first();
      await expect(firstBlock).toBeVisible();
      await firstBlock.click();
      await expect(guestPage.locator('#listingsLayout')).toBeVisible();
      await expect(guestPage.locator('#areaBanner')).toBeVisible();
    } finally {
      await resetLedger(guestPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('ghost toggle reveals unexplored neighborhoods when present', async ({ guestPage }) => {
    const ghostToggle = guestPage.locator('#ghostToggle');
    if ((await ghostToggle.count()) === 0) {
      test.skip(true, 'No unexplored neighborhoods in the current dataset to toggle');
    }
    const beforeText = await ghostToggle.textContent();
    await ghostToggle.click();
    await expect(ghostToggle).not.toHaveText(beforeText || '');
  });

  test('shared ledger status indicator is visible on the areas page', async ({ guestPage }) => {
    await expect(guestPage.locator('#ledgerStatus')).toBeVisible();
  });
});

test.describe('Landing page: boundary data unavailable', () => {
  test('if neighborhood boundaries can\'t load, the landing page still works', async ({ browser }) => {
    const context = await browser.newContext();
    const errors = [];
    try {
      // Block both boundary sources before the page ever loads.
      await context.route(/data\.cityofchicago\.org|tigerweb\.geo\.census\.gov/, (route) => route.abort());
      const page = await openGuestPage(context);
      page.on('pageerror', (e) => errors.push(e.message));
      await expect(page.locator('#areasPage')).toBeVisible();
      await page.click('#browseAllBtn');
      await expect(page.locator('#listingsLayout')).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
