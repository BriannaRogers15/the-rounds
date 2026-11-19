const { test, expect, openOwnerPage, closeSession } = require('../fixtures/app-fixture');
const { injectRestaurants, injectVisits, resetLedger, openListingDetail, waitForBootSettled } = require('../fixtures/ledger-helpers');
const { installPlacesMock } = require('../fixtures/places-mock');
const { getOwnerUid } = require('../fixtures/auth-helpers');
const { getDoc } = require('../fixtures/firestore-seed');
const { clearFirestore } = require('../fixtures/emulator-admin');

// Owner sessions seed the full curated dataset into the shared emulator;
// guest-only specs assert exact card counts, so don't leave it behind.
test.afterAll(async () => { await clearFirestore(); });

// Two locations of one chain, as Google would return them.
const BRANCHES = [
  {
    id: 'mock-chain-west-loop', displayName: 'Probe Chain West Loop',
    formattedAddress: '10 W Madison St, Chicago, IL 60602, USA', lat: 41.8819, lng: -87.6278,
    internationalPhoneNumber: '+1 312-555-0101', websiteURI: 'https://probe-chain.example.com/west-loop',
    primaryType: 'chicken_restaurant', types: ['chicken_restaurant', 'restaurant', 'food'],
  },
  {
    id: 'mock-chain-oak-lawn', displayName: 'Probe Chain Oak Lawn',
    formattedAddress: '4800 W 95th St, Oak Lawn, IL 60453, USA', lat: 41.7206, lng: -87.7432,
    internationalPhoneNumber: '+1 708-555-0102', websiteURI: 'https://probe-chain.example.com/oak-lawn',
    primaryType: 'chicken_restaurant', types: ['chicken_restaurant', 'restaurant', 'food'],
  },
];

function probe(id, extra = {}) {
  return {
    id, name: 'Probe Chain', categories: ['Chicken'], createdAt: Date.now(), menu: ['Wings'],
    address: '10 W Madison St, Chicago, IL 60602', lat: 41.8819, lng: -87.6278, town: 'Chicago', region: 'Chicago',
    phone: '+1 312-555-0101', mapsUrl: 'https://www.google.com/maps/place/?q=place_id:mock-chain-west-loop',
    yelp: 'https://www.yelp.com/biz/probe-chain-west-loop', website: 'https://probe-chain.example.com/west-loop',
    ...extra,
  };
}

async function openOwner(browser) {
  const page = await openOwnerPage(browser, { contextSetup: (ctx) => installPlacesMock(ctx, { places: BRANCHES }) });
  await waitForBootSettled(page);
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
  return { page, dialogs };
}
const record = (page, id) => page.evaluate((id) => restaurants.find((r) => r.id === id) || null, id);

test.describe('Change location', () => {
  test('picking another location moves the listing and keeps its visits, menu and guides', async ({ browser }) => {
    const { page, dialogs } = await openOwner(browser);
    const r = probe('loc-move');
    // Signed in as the owner, so the visit is the owner's (the rules refuse
    // saving a visit under anyone else's account).
    const v = { id: 'loc-move-v', restaurantId: r.id, authorUid: await getOwnerUid(), reviewer: 'Ana', rating: 4, wouldReturn: true, ate: ['Wings'], notes: '', date: '2026-10-01', createdAt: Date.now() };
    await injectRestaurants(page, [r]);
    await injectVisits(page, [v]);
    try {
      await openListingDetail(page, r.id);
      await expect(page.locator('.visit-item')).toHaveCount(1);
      await page.click('#changeLocBtn');
      // The search opens already filled with the spot's name.
      await expect(page.locator('#locSearch')).toHaveValue('Probe Chain');
      const picks = page.locator('#locSuggestions li');
      await expect(picks).toHaveCount(2);
      await picks.filter({ hasText: 'Oak Lawn' }).click();

      await expect(page.locator('.detail-addr')).toContainText('4800 W 95th St, Oak Lawn');
      expect(dialogs.some((m) => m.includes('Move Probe Chain to 4800 W 95th St'))).toBe(true);

      const moved = await record(page, r.id);
      expect(moved).toMatchObject({
        name: 'Probe Chain', categories: ['Chicken'], menu: ['Wings'],
        address: '4800 W 95th St, Oak Lawn, IL 60453, USA', lat: 41.7206, lng: -87.7432,
        phone: '+1 708-555-0102', website: 'https://probe-chain.example.com/oak-lawn',
        mapsUrl: 'https://www.google.com/maps/place/?q=place_id:mock-chain-oak-lawn',
        town: 'Oak Lawn', region: 'South Suburbs', yelp: null, neighborhood: null,
      });
      expect(typeof moved.locationChosenAt).toBe('number');
      // Another location can have a different menu, so it's queued for the
      // daily menu re-check (shown to the owner on the listing).
      expect(typeof moved.menuCheckRequestedAt).toBe('number');
      await expect(page.locator('#recheckNote')).toHaveText(/^Re-check requested /);
      // The visit is still on the listing.
      await expect(page.locator('.visit-item')).toHaveCount(1);
      // Saved to the shared ledger — and the old Yelp link is really gone
      // there, not just locally (saves merge into the stored record).
      await expect.poll(async () => (await getDoc(`restaurants/${r.id}`))?.address).toBe('4800 W 95th St, Oak Lawn, IL 60453, USA');
      expect((await getDoc(`restaurants/${r.id}`)).yelp).toBeNull();
    } finally {
      await resetLedger(page, { restaurantIds: [r.id], visitIds: [v.id] });
      await closeSession(page);
    }
  });

  test('a location that is already its own listing is refused', async ({ browser }) => {
    const { page, dialogs } = await openOwner(browser);
    const r = probe('loc-dupe');
    const other = probe('loc-dupe-other', {
      name: 'Probe Chain Oak Lawn', address: '4800 W 95th St, Oak Lawn, IL 60453',
      mapsUrl: 'https://www.google.com/maps/place/?q=place_id:mock-chain-oak-lawn',
    });
    await injectRestaurants(page, [r, other]);
    try {
      await openListingDetail(page, r.id);
      await page.click('#changeLocBtn');
      await page.locator('#locSuggestions li', { hasText: 'Oak Lawn' }).click();
      await expect.poll(() => dialogs.some((m) => m.includes('already its own listing: Probe Chain Oak Lawn'))).toBe(true);
      expect((await record(page, r.id)).address).toBe('10 W Madison St, Chicago, IL 60602');
    } finally {
      await resetLedger(page, { restaurantIds: [r.id, other.id] });
      await closeSession(page);
    }
  });

  test('Cancel puts the address row back unchanged', async ({ browser }) => {
    const { page } = await openOwner(browser);
    const r = probe('loc-cancel');
    await injectRestaurants(page, [r]);
    try {
      await openListingDetail(page, r.id);
      await page.click('#changeLocBtn');
      await page.click('#locCancel');
      await expect(page.locator('.detail-addr')).toContainText('10 W Madison St');
      await expect(page.locator('#changeLocBtn')).toBeVisible();
    } finally {
      await resetLedger(page, { restaurantIds: [r.id] });
      await closeSession(page);
    }
  });

  test('a chosen location survives the curated address data re-applied at owner sign-in', async ({ browser }) => {
    const { page } = await openOwner(browser);
    // A real curated listing (seeded by the owner session) with an
    // ADDRESS_LOOKUP entry.
    const curated = await page.evaluate(() => {
      const entry = ADDRESS_LOOKUP.find((e) => e.address && e.lat != null);
      const r = restaurants.find((x) => curatedKey(x) === entry.name.toLowerCase());
      return { id: r.id, address: entry.address };
    });
    const before = await record(page, curated.id);
    try {
      // Without a chosen location, the curated address wins (unchanged behavior).
      await page.evaluate(async (id) => { restaurants.find((r) => r.id === id).address = '1 Somewhere Else, Chicago, IL'; await enrichAddresses(); }, curated.id);
      expect((await record(page, curated.id)).address).toBe(curated.address);
      // With one, it stays put.
      await page.evaluate(async (id) => {
        const r = restaurants.find((x) => x.id === id);
        r.address = '4800 W 95th St, Oak Lawn, IL 60453, USA';
        r.locationChosenAt = Date.now();
        await enrichAddresses();
      }, curated.id);
      expect((await record(page, curated.id)).address).toBe('4800 W 95th St, Oak Lawn, IL 60453, USA');
    } finally {
      await page.evaluate(async (b) => {
        const i = restaurants.findIndex((x) => x.id === b.id);
        restaurants[i] = b;
        await saveRestaurants();
      }, before);
      await closeSession(page);
    }
  });
});
