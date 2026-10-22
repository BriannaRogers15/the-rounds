const { test, expect, openGuestPage, closeContext } = require('../fixtures/app-fixture');
const { injectRestaurants, resetLedger, waitForBootSettled } = require('../fixtures/ledger-helpers');
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

// Line-only outline watermark behind the listings (renderListingsBackdrop).
test.describe('Listings backdrop outline', () => {
  const backdropPath = (page) => page.locator('#listingsBackdrop svg path');
  // Each polygon is one "M…Z" subpath.
  const subpathCount = (page) => backdropPath(page).evaluate((p) => (p.getAttribute('d').match(/M/g) || []).length);

  test('Browse all outlines every Chicago neighborhood; picking an area outlines just that area', async ({ guestPage }) => {
    const probes = probeRestaurants().map((r) => ({ ...r, region: 'Chicago', town: 'Chicago', neighborhood: 'Gold Coast' }));
    await injectRestaurants(guestPage, probes);
    try {
      await waitForBootSettled(guestPage); // boundary file loaded
      await guestPage.click('#browseAllBtn');
      await expect(guestPage.locator('#listingsBackdrop')).toBeVisible();
      await expect(guestPage.locator('#listingsBackdrop')).toHaveClass(/all-areas/);
      const allCount = await subpathCount(guestPage);
      expect(allCount).toBeGreaterThanOrEqual(90); // ~98 neighborhoods

      await guestPage.click('#backToAreas');
      await guestPage.locator('.area-block[data-name="Gold Coast"]').click();
      await expect(guestPage.locator('#listingsBackdrop')).toBeVisible();
      await expect(guestPage.locator('#listingsBackdrop')).not.toHaveClass(/all-areas/);
      const areaCount = await subpathCount(guestPage);
      expect(areaCount).toBeGreaterThan(0);
      expect(areaCount).toBeLessThan(allCount);
      // Outline only — no fill, so it blends into the background.
      await expect(backdropPath(guestPage)).toHaveCSS('fill', 'none');
      // Never intercepts clicks meant for the cards.
      await expect(guestPage.locator('#listingsBackdrop')).toHaveCSS('pointer-events', 'none');
    } finally {
      await resetLedger(guestPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('is hidden in Map view and returns in Grid view', async ({ listingsPage }) => {
    await waitForBootSettled(listingsPage);
    await expect(listingsPage.locator('#listingsBackdrop')).toBeVisible();
    await listingsPage.click('#viewOpts button[data-view="map"]');
    await expect(listingsPage.locator('#listingsBackdrop')).toBeHidden();
    await listingsPage.click('#viewOpts button[data-view="grid"]');
    await expect(listingsPage.locator('#listingsBackdrop')).toBeVisible();
  });

  test('stays hidden when the boundary data is unavailable', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      await context.route(/data\.cityofchicago\.org|tigerweb\.geo\.census\.gov/, (route) => route.abort());
      const page = await openGuestPage(context);
      await waitForBootSettled(page);
      await page.click('#browseAllBtn');
      await expect(page.locator('#listingsLayout')).toBeVisible();
      await expect(page.locator('#listingsBackdrop')).toBeHidden();
    } finally {
      await closeContext(context);
    }
  });
});
