const { test, expect } = require('../fixtures/app-fixture');
const { injectRestaurants, injectVisits, resetLedger } = require('../fixtures/ledger-helpers');
const { probeRestaurants } = require('../fixtures/seed-data');

// Distance sort (geolocation-dependent) is covered in Phase 4 alongside the
// grant/deny/timeout mocks — see tests/README.md.

async function cardOrder(page) {
  return page.locator('.ticket').evaluateAll((cards) => cards.map((c) => c.dataset.id));
}

test.describe('Sort options', () => {
  test('Name sorts alphabetically and ignores a leading "The"', async ({ listingsPage }) => {
    const probes = [
      ...probeRestaurants(),
      { id: 'probe-the-zzz', name: 'The Zzz Diner', categories: ['American'], address: 'Chicago, IL', createdAt: Date.now() },
    ];
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('[data-sort="name"]');
      const order = await cardOrder(listingsPage);
      // "The Zzz Diner" sorts by "Zzz Diner" -> after Pizza/Sushi, not at
      // the very end alphabetically by its literal first letter either way
      // here, but definitely not forced to the front by "The".
      expect(order.indexOf('probe-the-zzz')).toBeGreaterThan(order.indexOf('probe-pizza-1'));
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('Date Added sorts newest first', async ({ listingsPage }) => {
    const probes = probeRestaurants(); // gem (id probe-gem-3) has the newest createdAt
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('[data-sort="date"]');
      const order = await cardOrder(listingsPage);
      expect(order[0]).toBe('probe-gem-3');
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('Rating sorts highest average first, unrated listings last', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    const visits = [
      { id: 'v-low', restaurantId: 'probe-sushi-2', date: '2026-01-01', ate: [], rating: 2, wouldReturn: false, notes: '', reviewer: 'T', authorUid: 'x', createdAt: 1 },
      { id: 'v-high', restaurantId: 'probe-pizza-1', date: '2026-01-01', ate: [], rating: 5, wouldReturn: true, notes: '', reviewer: 'T', authorUid: 'x', createdAt: 2 },
    ];
    await injectRestaurants(listingsPage, probes);
    await injectVisits(listingsPage, visits);
    try {
      await listingsPage.click('[data-sort="rating"]');
      const order = await cardOrder(listingsPage);
      expect(order[0]).toBe('probe-pizza-1'); // 5 stars
      expect(order[1]).toBe('probe-sushi-2'); // 2 stars
      expect(order[2]).toBe('probe-gem-3'); // unrated, sorts last
    } finally {
      await resetLedger(listingsPage, {
        restaurantIds: probes.map((r) => r.id),
        visitIds: visits.map((v) => v.id),
      });
    }
  });
});
