const { test, expect } = require('../fixtures/app-fixture');
const { injectRestaurants, resetLedger } = require('../fixtures/ledger-helpers');
const { probeRestaurants } = require('../fixtures/seed-data');

// Real Leaflet + OpenStreetMap CDN tiles are allowed to load for real here
// (free, already cached after the first test) — see tests/README.md for
// why only the tilesOk-timeout fallback (Phase 4) needs network mocking.
test.describe('Map view', () => {
  test('switching to Map plots a marker per listing with coordinates', async ({ listingsPage }) => {
    const probes = probeRestaurants(); // all three probes carry lat/lng
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('[data-view="map"]');
      await listingsPage.waitForSelector('#leafletMapEl', { timeout: 10000 });
      await expect(listingsPage.locator('.leaflet-interactive')).toHaveCount(probes.length, { timeout: 10000 });
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('a listing without coordinates is excluded from the map and noted', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    const noCoords = { ...probes[0], id: 'probe-no-coords', lat: undefined, lng: undefined };
    delete noCoords.lat;
    delete noCoords.lng;
    await injectRestaurants(listingsPage, [...probes, noCoords]);
    try {
      await listingsPage.click('[data-view="map"]');
      await listingsPage.waitForSelector('#leafletMapEl', { timeout: 10000 });
      await expect(listingsPage.locator('.leaflet-interactive')).toHaveCount(probes.length, { timeout: 10000 });
      await expect(listingsPage.locator('.map-note')).toContainText('have a location yet');
    } finally {
      await resetLedger(listingsPage, { restaurantIds: [...probes.map((r) => r.id), noCoords.id] });
    }
  });

  test('marker popup links to Maps/Website/Yelp and a "View details" action', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('[data-view="map"]');
      await listingsPage.waitForSelector('#leafletMapEl', { timeout: 10000 });
      const marker = listingsPage.locator('.leaflet-interactive').first();
      await marker.dispatchEvent('mouseover');
      const popup = listingsPage.locator('.leaflet-popup-content');
      await expect(popup).toBeVisible();
      await expect(popup.locator('.map-popup-link', { hasText: 'View details' })).toBeVisible();
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('switching back to Grid restores the card view', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('[data-view="map"]');
      await listingsPage.waitForSelector('#leafletMapEl', { timeout: 10000 });
      await listingsPage.click('[data-view="grid"]');
      await expect(listingsPage.locator('.ticket').first()).toBeVisible();
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });
});

test.describe('Map view: offline fallback', () => {
  // The app swaps to its pin map only when no tile has finished loading
  // after 2.5s — i.e. tile requests that hang. (Tiles that *error* fast
  // count as "finished" to Leaflet, so that case keeps the Leaflet map with
  // blank tiles; see tests/README.md.) A route that never responds models
  // the hanging case.
  test('if street-map tiles hang, it falls back to a relative-position pin map', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.route(/tile\.openstreetmap\.org/, () => {});
      await listingsPage.click('[data-view="map"]');
      // The app waits 2.5s for any tile to load before swapping.
      await expect(listingsPage.locator('#customMap .map-pin')).toHaveCount(probes.length, { timeout: 10000 });
      await expect(listingsPage.locator('.map-note', { hasText: "Live map tiles aren't reachable" })).toBeVisible();
      await expect(listingsPage.locator('#leafletMapEl')).toHaveCount(0);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });
});
