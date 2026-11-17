const { test, expect } = require('../fixtures/app-fixture');
const { injectRestaurants, injectVisits, resetLedger } = require('../fixtures/ledger-helpers');
const { probeRestaurants, probeVisits } = require('../fixtures/seed-data');

test.describe('Listings grid view', () => {
  test('renders one card per listing with its name and "Not visited yet"', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      for (const r of probes) {
        const card = listingsPage.locator(`.ticket[data-id="${r.id}"]`);
        await expect(card).toBeVisible();
        await expect(card.locator('.ticket-name')).toHaveText(r.name);
        await expect(card.locator('.ticket-meta .not-visited')).toHaveText('Not visited yet');
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

  test('a visited listing shows "Visited" with its stars; an unvisited one says "Not visited yet"', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    const visits = probeVisits();
    await injectRestaurants(listingsPage, probes);
    await injectVisits(listingsPage, visits);
    try {
      const visitedCard = listingsPage.locator(`.ticket[data-id="${visits[0].restaurantId}"]`);
      await expect(visitedCard.locator('.visited-label')).toHaveText('Visited');
      // The probe visit is rated 5.
      await expect(visitedCard.locator('.stars .st-full')).toHaveCount(5);
      await expect(visitedCard.locator('.stars')).toHaveAttribute('aria-label', '5 out of 5 stars');
      await expect(visitedCard.locator('.not-visited')).toHaveCount(0);

      const unvisitedId = probes.find((r) => r.id !== visits[0].restaurantId).id;
      const unvisitedCard = listingsPage.locator(`.ticket[data-id="${unvisitedId}"]`);
      await expect(unvisitedCard.locator('.visited-label')).toHaveCount(0);
      await expect(unvisitedCard.locator('.not-visited')).toHaveText('Not visited yet');
    } finally {
      await resetLedger(listingsPage, {
        restaurantIds: probes.map((r) => r.id),
        visitIds: visits.map((v) => v.id),
      });
    }
  });

  test('a listing tagged Personal Gems shows the gem badge', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      const gem = probes.find((r) => r.categories.includes('Personal Gems'));
      await expect(listingsPage.locator(`.ticket[data-id="${gem.id}"] .gem-badge`)).toHaveText('Personal Gem');
      const nonGem = probes.find((r) => !r.categories.includes('Personal Gems'));
      await expect(listingsPage.locator(`.ticket[data-id="${nonGem.id}"] .gem-badge`)).toHaveCount(0);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test("cards list the spot's own guides on one line (no umbrella groups, no emoji) and its area, not its street", async ({ listingsPage }) => {
    const probes = probeRestaurants();
    const tagged = {
      id: 'probe-guides-4', name: 'Probe Guide Line', categories: ['Brunch', 'Jamaican', 'Personal Gems'],
      address: '5 Probe Way, Oak Park, IL 60302', menu: [], createdAt: Date.now(),
    };
    const hood = { ...tagged, id: 'probe-hood-5', name: 'Probe Hood Spot', categories: ['Pizza'], address: '1 Probe St, Chicago, IL 60615', neighborhood: 'Hyde Park' };
    await injectRestaurants(listingsPage, [...probes, tagged, hood]);
    try {
      const card = listingsPage.locator(`.ticket[data-id="${tagged.id}"]`);
      // Cuisine first, then occasion; the Gems badge is not a guide; Pizza's
      // umbrella group (Italian) is not added.
      await expect(card.locator('.ticket-guides')).toHaveText('Jamaican · Brunch');
      await expect(listingsPage.locator(`.ticket[data-id="${hood.id}"] .ticket-guides`)).toHaveText('Pizza');
      // Suburb: its town. City: its neighborhood. Never the street address.
      await expect(card.locator('.ticket-area')).toHaveText('Oak Park');
      await expect(listingsPage.locator(`.ticket[data-id="${hood.id}"] .ticket-area`)).toHaveText('Hyde Park');
      await expect(card).not.toContainText('5 Probe Way');
      const text = await listingsPage.locator('#content').innerText();
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: [...probes.map((r) => r.id), tagged.id, hood.id] });
    }
  });

  test('inside one neighborhood the cards drop the area (the page title says it); "all" keeps it', async ({ listingsPage }) => {
    const probe = { id: 'probe-hood-only', name: 'Probe Hood Only', categories: ['Pizza'], address: '1 Probe St, Chicago, IL 60615', neighborhood: 'Hyde Park', region: 'Chicago', town: 'Chicago', menu: [], createdAt: Date.now() };
    await injectRestaurants(listingsPage, [probe]);
    try {
      const card = () => listingsPage.locator(`.ticket[data-id="${probe.id}"]`);
      await expect(card().locator('.ticket-area')).toHaveText('Hyde Park');
      await listingsPage.evaluate(() => openArea({ type: 'neighborhood', name: 'Hyde Park' }));
      await expect(listingsPage.locator('.area-title')).toHaveText('Hyde Park');
      await expect(card().locator('.ticket-area')).toHaveCount(0);
      // A whole side of the city mixes neighborhoods, so the area shows.
      await listingsPage.evaluate(() => openArea({ type: 'side', name: 'Out South' }));
      await expect(card().locator('.ticket-area')).toHaveText('Hyde Park');
    } finally {
      await resetLedger(listingsPage, { restaurantIds: [probe.id] });
    }
  });

  test('a visited card shows when it was last visited', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    const base = { restaurantId: 'probe-pizza-1', rating: 4, wouldReturn: true, ate: [], notes: '', reviewer: 'P', authorUid: 'p', createdAt: Date.now() };
    const vs = [{ ...base, id: 'probe-last-1', date: '2025-03-02' }, { ...base, id: 'probe-last-2', date: '2025-06-09' }];
    await injectRestaurants(listingsPage, probes);
    await injectVisits(listingsPage, vs);
    try {
      await expect(listingsPage.locator('.ticket[data-id="probe-pizza-1"] .last-visit')).toHaveText('Jun 9, 2025');
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id), visitIds: vs.map((v) => v.id) });
    }
  });

  test('searching finds spots by a dish on their menu, and says which dish', async ({ listingsPage }) => {
    const probes = probeRestaurants(); // Probe Sushi Spot serves "Spicy Tuna Roll"
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.fill('#searchBox', 'tuna');
      const card = listingsPage.locator('.ticket[data-id="probe-sushi-2"]');
      await expect(card).toBeVisible();
      await expect(card.locator('.ticket-match')).toHaveText('On the menu: Spicy Tuna Roll');
      await expect(listingsPage.locator('.ticket[data-id="probe-pizza-1"]')).toHaveCount(0);
      // A name match needs no dish line.
      await listingsPage.fill('#searchBox', 'Probe Sushi');
      await expect(card.locator('.ticket-match')).toHaveCount(0);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });
});
