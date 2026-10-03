const { test, expect } = require('../fixtures/app-fixture');
const { injectRestaurants, injectVisits, resetLedger } = require('../fixtures/ledger-helpers');
const { probeRestaurants, probeVisits } = require('../fixtures/seed-data');

test.describe('Filter toggles', () => {
  test('"Haven\'t been yet" shows only listings with zero visits', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    const visits = probeVisits(); // visits probe-pizza-1 only
    await injectRestaurants(listingsPage, probes);
    await injectVisits(listingsPage, visits);
    try {
      await listingsPage.click('#unvisitedToggle');
      await expect(listingsPage.locator('.ticket')).toHaveCount(probes.length - 1);
      await expect(listingsPage.locator('.ticket[data-id="probe-pizza-1"]')).toHaveCount(0);
    } finally {
      await resetLedger(listingsPage, {
        restaurantIds: probes.map((r) => r.id),
        visitIds: visits.map((v) => v.id),
      });
    }
  });

  test('Gems shows only Chicago Gems-tagged listings', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('#gemsToggle');
      await expect(listingsPage.locator('.ticket')).toHaveCount(1);
      await expect(listingsPage.locator('.ticket')).toHaveAttribute('data-id', 'probe-gem-3');
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('Recently Added shows only listings created in the last 30 days', async ({ listingsPage }) => {
    const probes = probeRestaurants(); // only the gem is "recent"
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('#recentToggle');
      await expect(listingsPage.locator('.ticket')).toHaveCount(1);
      await expect(listingsPage.locator('.ticket')).toHaveAttribute('data-id', 'probe-gem-3');
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('filters combine with each other and with search', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('#gemsToggle');
      await listingsPage.click('#unvisitedToggle'); // the gem is also unvisited
      await expect(listingsPage.locator('.ticket')).toHaveCount(1);
      await listingsPage.fill('#searchBox', 'zzznomatch');
      await expect(listingsPage.locator('.empty')).toBeVisible({ timeout: 2000 });
    } finally {
      await listingsPage.fill('#searchBox', '');
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('toggling a filter off restores previously hidden listings', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('#gemsToggle');
      await expect(listingsPage.locator('.ticket')).toHaveCount(1);
      await listingsPage.click('#gemsToggle');
      await expect(listingsPage.locator('.ticket')).toHaveCount(probes.length);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });
});
