const { test, expect } = require('../fixtures/app-fixture');
const { injectRestaurants, resetLedger } = require('../fixtures/ledger-helpers');
const { probeRestaurants } = require('../fixtures/seed-data');

// Confetti and the PWA update-available banner are covered alongside the
// flows that actually trigger them (Add Listing / Log a Visit in Phase 4;
// the update banner needs a real service worker lifecycle, which the test
// fixtures intentionally disable — see tests/README.md). The "Elsewhere in
// Chicago" ghost-neighborhood edge case needs real neighborhood-geo
// assignment and isn't covered by lightweight probe data; low priority,
// noted as a gap rather than forced.

test.describe('View toggle persistence', () => {
  test('switching to Map view survives a filter change afterward', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('[data-view="map"]');
      await listingsPage.waitForSelector('#leafletMapEl', { timeout: 10000 });
      await listingsPage.click('#gemsToggle');
      // Still on the map, not bounced back to grid, just showing fewer markers.
      await expect(listingsPage.locator('#leafletMapEl')).toBeVisible();
      await expect(listingsPage.locator('.leaflet-interactive')).toHaveCount(1, { timeout: 10000 });
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('switching to Map view survives a guide/category change afterward', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('[data-view="map"]');
      await listingsPage.waitForSelector('#leafletMapEl', { timeout: 10000 });
      await listingsPage.click('.rail-item[data-cat="American"]');
      await expect(listingsPage.locator('#leafletMapEl')).toBeVisible();
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });
});
