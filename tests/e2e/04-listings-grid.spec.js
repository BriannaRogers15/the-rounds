const { test, expect } = require('../fixtures/app-fixture');
const { injectRestaurants, injectVisits, resetLedger } = require('../fixtures/ledger-helpers');
const { probeRestaurants, probeVisits } = require('../fixtures/seed-data');

test.describe('Listings grid view', () => {
  test('renders one card per listing with name, address, and visit count', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      for (const r of probes) {
        const card = listingsPage.locator(`.ticket[data-id="${r.id}"]`);
        await expect(card).toBeVisible();
        await expect(card).toContainText(r.name);
        await expect(card.locator('.ticket-meta')).toContainText('0 visits');
      }
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('clicking a card opens its detail modal', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.locator(`.ticket[data-id="${probes[0].id}"]`).click();
      await expect(listingsPage.locator('.modal .detail-name')).toContainText(probes[0].name);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('a visited listing shows the VISITED stamp and visit count; an unvisited one does not', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    const visits = probeVisits();
    await injectRestaurants(listingsPage, probes);
    await injectVisits(listingsPage, visits);
    try {
      const visitedCard = listingsPage.locator(`.ticket[data-id="${visits[0].restaurantId}"]`);
      await expect(visitedCard.locator('.stamp')).toBeVisible();
      await expect(visitedCard.locator('.ticket-meta')).toContainText('1 visit');

      const unvisitedId = probes.find((r) => r.id !== visits[0].restaurantId).id;
      const unvisitedCard = listingsPage.locator(`.ticket[data-id="${unvisitedId}"]`);
      await expect(unvisitedCard.locator('.stamp')).toHaveCount(0);
    } finally {
      await resetLedger(listingsPage, {
        restaurantIds: probes.map((r) => r.id),
        visitIds: visits.map((v) => v.id),
      });
    }
  });

  test('a listing tagged Chicago Gems shows the gem badge', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      const gem = probes.find((r) => r.categories.includes('Chicago Gems'));
      await expect(listingsPage.locator(`.ticket[data-id="${gem.id}"] .gem-badge`)).toBeVisible();
      const nonGem = probes.find((r) => !r.categories.includes('Chicago Gems'));
      await expect(listingsPage.locator(`.ticket[data-id="${nonGem.id}"] .gem-badge`)).toHaveCount(0);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('address link opens externally and does not trigger the detail modal', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      const card = listingsPage.locator(`.ticket[data-id="${probes[0].id}"]`);
      const addrLink = card.locator('.addr-link');
      await expect(addrLink).toHaveAttribute('target', '_blank');
      // Clicking it must not open the detail overlay (stopPropagation).
      const [popup] = await Promise.all([
        listingsPage.waitForEvent('popup'),
        addrLink.click(),
      ]);
      await popup.close();
      await expect(listingsPage.locator('#ov')).toHaveCount(0);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });
});
