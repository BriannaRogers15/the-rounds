const { test, expect } = require('../fixtures/app-fixture');
const { injectRestaurants, resetLedger } = require('../fixtures/ledger-helpers');
const { probeRestaurants } = require('../fixtures/seed-data');

test.describe('Area banner', () => {
  test('"Browse all listings" shows the all-of-Chicagoland banner with no area pill', async ({ listingsPage }) => {
    await expect(listingsPage.locator('#areaBanner')).toBeVisible();
    await expect(listingsPage.locator('.area-all-note')).toHaveText('All of Chicagoland');
    await expect(listingsPage.locator('.area-pill')).toHaveCount(0);
  });

  test('"← Neighborhoods" returns to the landing page', async ({ listingsPage }) => {
    await listingsPage.click('#backToAreas');
    await expect(listingsPage.locator('#areasPage')).toBeVisible();
    await expect(listingsPage.locator('#listingsLayout')).toBeHidden();
  });

  test('clicking an area shows a pill with name + count, and its × clears back to all', async ({ guestPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(guestPage, probes);
    try {
      await guestPage.locator('.area-block').first().click();
      const pill = guestPage.locator('.area-pill');
      await expect(pill).toBeVisible();
      await expect(pill).toContainText('spot');

      await guestPage.click('#clearArea');
      await expect(guestPage.locator('.area-pill')).toHaveCount(0);
      await expect(guestPage.locator('.area-all-note')).toBeVisible();
      // Clearing the pill stays in listings view rather than bouncing back
      // to the neighborhoods page.
      await expect(guestPage.locator('#listingsLayout')).toBeVisible();
    } finally {
      await resetLedger(guestPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });
});
