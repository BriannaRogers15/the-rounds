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

  test('Personal Gems shows only gem-tagged listings', async ({ listingsPage }) => {
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

  test('on a phone the filters fold into one "Filters" button that shows how many are on', async ({ browser }) => {
    const { openGuestPage, closeContext } = require('../fixtures/app-fixture');
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await openGuestPage(context);
    try {
      await page.click('#browseAllBtn');
      await expect(page.locator('#gemsToggle')).toBeHidden();
      await expect(page.locator('#filtersCount')).toBeHidden();
      await page.click('#filtersToggle');
      await expect(page.locator('#filtersToggle')).toHaveAttribute('aria-expanded', 'true');
      await page.click('#gemsToggle');
      await page.click('#unvisitedToggle');
      await expect(page.locator('#filtersCount')).toHaveText('2');
      await expect(page.locator('#gemsToggle')).toHaveAttribute('aria-pressed', 'true');
      await page.click('#filtersToggle');
      await expect(page.locator('#gemsToggle')).toBeHidden();
      await expect(page.locator('#filtersCount')).toHaveText('2'); // still on while folded
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    } finally {
      await closeContext(context);
    }
  });

  test('"Tourist spots" shows only listings tagged Tourist Spots, and is a badge, not a guide', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    const tourist = { ...probes[1], id: 'probe-tourist', name: 'Probe Tourist Spot', categories: ['Pizza', 'Tourist Spots'] };
    await injectRestaurants(listingsPage, [...probes, tourist]);
    try {
      await expect(listingsPage.locator('.ticket[data-id="probe-tourist"] .tourist-badge')).toHaveText('Tourist Spot');
      await expect(listingsPage.locator('.ticket[data-id="probe-tourist"] .ticket-guides')).toHaveText('Pizza');
      await expect(listingsPage.locator('.rail-item[data-cat="Tourist Spots"]')).toHaveCount(0);
      await listingsPage.click('#touristToggle');
      await expect(listingsPage.locator('.ticket')).toHaveCount(1);
      await expect(listingsPage.locator('.ticket[data-id="probe-tourist"]')).toBeVisible();
      await listingsPage.click('#touristToggle');
      await expect(listingsPage.locator('.ticket')).toHaveCount(4);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: [...probes.map((r) => r.id), 'probe-tourist'] });
    }
  });

  test('a listing still carrying the old "Chicago Gems" tag counts as a Personal Gem until it migrates', async ({ listingsPage }) => {
    const legacy = { id: 'probe-legacy-gem', name: 'Probe Legacy Gem', categories: ['American', 'Chicago Gems'], address: '1 Probe St, Chicago, IL 60607', menu: [], createdAt: Date.now() };
    await injectRestaurants(listingsPage, [legacy]);
    try {
      await expect(listingsPage.locator('.ticket[data-id="probe-legacy-gem"] .gem-badge')).toHaveText('Personal Gem');
      await expect(listingsPage.locator('.rail-item[data-cat="Chicago Gems"]')).toHaveCount(0);
      await listingsPage.click('#gemsToggle');
      await expect(listingsPage.locator('.ticket[data-id="probe-legacy-gem"]')).toBeVisible();
      // The owner's startup migration renames the stored tag.
      const after = await listingsPage.evaluate(async () => { await renameCuisineTags(); return restaurants.find((r) => r.id === 'probe-legacy-gem').categories; });
      expect(after).toEqual(['American', 'Personal Gems']);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: [legacy.id] });
    }
  });
});
