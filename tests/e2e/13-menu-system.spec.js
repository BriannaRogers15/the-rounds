const { test, expect } = require('../fixtures/app-fixture');
const { injectRestaurants, resetLedger } = require('../fixtures/ledger-helpers');
const { probeRestaurants } = require('../fixtures/seed-data');

// Interactive dish-checklist behavior (log-a-visit) requires a signed-in
// write session and is covered in Phase 4 — this file covers the read-only
// detail-modal menu display, which any guest can see.

test.describe('Menu system (read-only display)', () => {
  test('a listing with dishes but no curated sections renders one unnamed group', async ({ listingsPage }) => {
    const probes = probeRestaurants(); // Probe Pizza Place has no MENU_LOOKUP entry
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.locator('.ticket[data-id="probe-pizza-1"]').click();
      const menuChips = listingsPage.locator('#menuChips');
      await expect(menuChips.locator('.menu-group')).toHaveCount(1);
      await expect(menuChips.locator('.menu-group-title')).toHaveCount(0); // unnamed group
      await expect(menuChips.locator('.menu-row')).toHaveCount(2); // Cheese Slice, Pepperoni Pie
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('a listing with no dishes shows the "no dishes on file" message, not an empty section', async ({ listingsPage }) => {
    const probes = probeRestaurants(); // gem has menu: []
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.locator('.ticket[data-id="probe-gem-3"]').click();
      await expect(listingsPage.locator('#menuChips .no-menu')).toContainText('No dishes on file yet');
      await expect(listingsPage.locator('#menuChips .menu-group')).toHaveCount(0);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('menu uses 3 columns once a listing has more than 40 dishes', async ({ listingsPage }) => {
    const bigMenu = Array.from({ length: 41 }, (_, i) => `Dish ${i + 1}`);
    const probe = { id: 'probe-big-menu', name: 'Probe Big Menu Place', categories: ['American'], address: 'Chicago, IL', menu: bigMenu, createdAt: Date.now() };
    await injectRestaurants(listingsPage, [probe]);
    try {
      await listingsPage.locator('.ticket[data-id="probe-big-menu"]').click();
      await expect(listingsPage.locator('#menuChips')).toHaveClass(/cols3/);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: [probe.id] });
    }
  });
});
