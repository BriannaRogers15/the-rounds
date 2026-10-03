const { test, expect } = require('../fixtures/app-fixture');
const { injectRestaurants, resetLedger } = require('../fixtures/ledger-helpers');
const { probeRestaurants } = require('../fixtures/seed-data');

// Probe data recap: Probe Pizza Place is tagged [Pizza, Italian] (Pizza
// nests under the Italian group per PARENT_GROUPS); Probe Sushi Spot is
// [Sushi, Japanese] (Sushi nests under Japanese); Probe Hidden Gem is
// [Chicago Gems, American] (Chicago Gems is a badge tag, never shown as a
// rail guide; American has no children in this probe set, so it's a leaf).

test.describe('Guides / cuisine rail', () => {
  test('a group label with children unfolds an accordion of sub-tags on click', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('.rail-item[data-cat="Italian"]');
      const children = listingsPage.locator('.rail-children .rail-item');
      await expect(children).toHaveCount(2); // "All Italian" + "Pizza"
      await expect(children.filter({ hasText: 'Pizza' })).toBeVisible();
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('clicking a child sub-tag filters to only that sub-tag', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('.rail-item[data-cat="Italian"]');
      await listingsPage.click('.rail-children .rail-item[data-sub="Pizza"]');
      await expect(listingsPage.locator('.ticket')).toHaveCount(1);
      await expect(listingsPage.locator('.ticket')).toHaveAttribute('data-id', 'probe-pizza-1');
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('a leaf label with no children filters directly, no accordion', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('.rail-item[data-cat="American"]');
      await expect(listingsPage.locator('.ticket')).toHaveCount(1);
      await expect(listingsPage.locator('.ticket')).toHaveAttribute('data-id', 'probe-gem-3');
      await expect(listingsPage.locator('.rail-item[data-cat="American"] + .rail-children')).toHaveCount(0);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('re-clicking the active top-level category toggles back to All', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.click('.rail-item[data-cat="American"]');
      await expect(listingsPage.locator('.ticket')).toHaveCount(1);
      await listingsPage.click('.rail-item[data-cat="American"]');
      await expect(listingsPage.locator('.ticket')).toHaveCount(probes.length);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('Chicago Gems is never shown as a rail guide (it is a badge, not a category)', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await expect(listingsPage.locator('.rail-item[data-cat="Chicago Gems"]')).toHaveCount(0);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('rail item counts reflect the current active area scope', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      const allCount = await listingsPage.locator('.rail-item[data-cat="All"] .rail-cnt').textContent();
      expect(Number(allCount)).toBeGreaterThanOrEqual(probes.length);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });
});
