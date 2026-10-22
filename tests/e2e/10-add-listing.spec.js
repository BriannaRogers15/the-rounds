const { test, expect, openOwnerPage, closeSession } = require('../fixtures/app-fixture');
const { resetLedger } = require('../fixtures/ledger-helpers');
const { installPlacesMock, SAMPLE_PLACES, OUT_OF_AREA_PLACES } = require('../fixtures/places-mock');
const { getDoc } = require('../fixtures/firestore-seed');
const { clearFirestore } = require('../fixtures/emulator-admin');

// Owner sessions seed the full curated dataset into the shared emulator;
// guest-only specs assert exact card counts, so don't leave it behind.
test.afterAll(async () => { await clearFirestore(); });

// Add Listing is owner-only, and its search path talks to Google Places —
// replaced here by a fake installed before page load (fixtures/places-mock.js).

async function openAddModal(browser, mockOptions = {}) {
  const page = await openOwnerPage(browser, { contextSetup: (ctx) => installPlacesMock(ctx, mockOptions) });
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
  await page.click('#addFromAreas');
  await expect(page.locator('#rName')).toBeVisible();
  return { page, dialogs };
}

async function findSaved(page, name) {
  return page.evaluate((name) => restaurants.find((r) => r.name === name) || null, name);
}

test.describe('Add Listing: Google Places search path', () => {
  test('searching shows only food/drink results; picking one auto-tags and fills details', async ({ browser }) => {
    const { page } = await openAddModal(browser);
    let saved = null;
    try {
      await page.fill('#rName', 'Mock');
      const suggestions = page.locator('#nameSuggestions li');
      await expect(suggestions).toHaveCount(1); // hardware store filtered out
      await expect(suggestions.first()).toContainText('Mock Taqueria');

      await suggestions.first().click();
      // mexican_restaurant -> "Mexican" via GOOGLE_TYPE_TAG
      await expect(page.locator('#filingUnder .tag-pill')).toHaveCount(1);
      await expect(page.locator('#filingUnder .tag-pill')).toContainText('Mexican');

      await page.click('#saveAdd');
      await expect(page.locator('#rName')).toHaveCount(0); // modal closed

      saved = await findSaved(page, 'Mock Taqueria');
      const place = SAMPLE_PLACES[0];
      expect(saved).toMatchObject({
        categories: ['Mexican'],
        address: place.formattedAddress,
        phone: place.internationalPhoneNumber,
        website: place.websiteURI,
        lat: place.lat,
        lng: place.lng,
      });
      expect(saved.mapsUrl).toContain(`place_id:${place.id}`);

      // Actually persisted to the shared ledger, not just local state.
      await expect.poll(() => getDoc(`restaurants/${saved.id}`)).toMatchObject({ name: 'Mock Taqueria' });
    } finally {
      if (saved) await resetLedger(page, { restaurantIds: [saved.id] });
      await closeSession(page);
    }
  });

  test('auto-suggested guide chips can be edited before saving', async ({ browser }) => {
    const { page } = await openAddModal(browser);
    let saved = null;
    try {
      await page.fill('#rName', 'Mock Taq');
      await page.locator('#nameSuggestions li').first().click();
      await page.locator('#filingUnder .tag-x[data-tag="Mexican"]').click();
      await expect(page.locator('#filingUnder .tag-pill')).toHaveCount(0);
      await page.fill('#addTagInput', 'Tacos');
      await page.press('#addTagInput', 'Enter');
      await expect(page.locator('#filingUnder .tag-pill')).toContainText('Tacos');

      await page.click('#saveAdd');
      saved = await findSaved(page, 'Mock Taqueria');
      expect(saved.categories).toEqual(['Tacos']);
    } finally {
      if (saved) await resetLedger(page, { restaurantIds: [saved.id] });
      await closeSession(page);
    }
  });

  test('saving with zero guide tags is blocked', async ({ browser }) => {
    // A real food result Google doesn't classify beyond "restaurant" —
    // GOOGLE_TYPE_TAG maps it to nothing, so no chip is pre-filled.
    const generic = {
      id: 'mock-place-generic', displayName: 'Mock Generic Diner',
      formattedAddress: '400 W Mock St, Chicago, IL 60607, USA', lat: 41.88, lng: -87.64,
      primaryType: 'restaurant', types: ['restaurant', 'food'],
    };
    const { page, dialogs } = await openAddModal(browser, { places: [generic] });
    try {
      await page.fill('#rName', 'Mock Generic');
      await page.locator('#nameSuggestions li').first().click();
      await expect(page.locator('#filingUnder .tag-pill')).toHaveCount(0);
      await page.click('#saveAdd');
      expect(dialogs.at(-1)).toContain('Add at least one guide');
      expect(await findSaved(page, 'Mock Generic Diner')).toBeNull();
      await expect(page.locator('#rName')).toBeVisible(); // still open
    } finally {
      await closeSession(page);
    }
  });

  test('saving without picking a search result is blocked', async ({ browser }) => {
    const { page, dialogs } = await openAddModal(browser);
    try {
      await page.fill('#rName', 'Typed But Never Picked');
      await page.click('#saveAdd');
      expect(dialogs.at(-1)).toContain('Search and select a restaurant');
      expect(await findSaved(page, 'Typed But Never Picked')).toBeNull();
    } finally {
      await closeSession(page);
    }
  });
});

test.describe('Add Listing: Chicagoland only', () => {
  test('suggestions outside Illinois never show', async ({ browser }) => {
    const { page } = await openAddModal(browser, { places: [...SAMPLE_PLACES, ...OUT_OF_AREA_PLACES] });
    try {
      await page.fill('#rName', 'Mock Hoosier');
      await page.waitForFunction(() => window.__placesMockCalls.some((c) => c.input === 'Mock Hoosier'));
      await expect(page.locator('#nameSuggestions li')).toHaveCount(0);
    } finally {
      await closeSession(page);
    }
  });

  test('picking an Illinois spot outside the seven metro counties is refused', async ({ browser }) => {
    const { page, dialogs } = await openAddModal(browser, { places: [...SAMPLE_PLACES, ...OUT_OF_AREA_PLACES] });
    try {
      await page.fill('#rName', 'Mock Rockford');
      await page.locator('#nameSuggestions li').first().click();
      await expect.poll(() => dialogs.at(-1)).toContain('outside Chicagoland');
      await expect(page.locator('#rName')).toHaveValue('');
      await page.click('#saveAdd');
      expect(dialogs.at(-1)).toContain('Search and select a restaurant');
      expect(await findSaved(page, 'Mock Rockford Diner')).toBeNull();
    } finally {
      await closeSession(page);
    }
  });

  test('a manual address picked outside Chicagoland is refused', async ({ browser }) => {
    const { page, dialogs } = await openAddModal(browser, {
      addresses: [{ id: 'mock-addr-rockford', formattedAddress: '9 Mock Ln, Rockford, IL 61101, USA', lat: 42.27, lng: -89.09, state: 'IL', county: 'Winnebago', types: ['street_address'] }],
    });
    try {
      await page.click('#manualToggle');
      await page.fill('#rAddr', '9 Mock');
      await page.locator('#addrSuggestions li').first().click();
      await expect.poll(() => dialogs.at(-1)).toContain('outside Chicagoland');
      await expect(page.locator('#rAddr')).toHaveValue('');
    } finally {
      await closeSession(page);
    }
  });

  test('a hand-typed address must name a known Chicagoland town', async ({ browser }) => {
    const { page, dialogs } = await openAddModal(browser);
    try {
      await page.click('#manualToggle');
      await page.fill('#rName', 'Downstate Probe');
      await page.fill('#rAddr', '1 Main St, Springfield, IL 62701');
      await page.fill('#addTagInput', 'American');
      await page.press('#addTagInput', 'Enter');
      await page.click('#saveAdd');
      expect(dialogs.at(-1)).toContain('only covers Chicago and its suburbs');
      expect(await findSaved(page, 'Downstate Probe')).toBeNull();
    } finally {
      await closeSession(page);
    }
  });
});

test.describe('Add Listing: billing', () => {
  test('one search is one billed session: its keystrokes share a token, and a pick starts a new one', async ({ browser }) => {
    const { page } = await openAddModal(browser);
    try {
      await page.locator('#rName').pressSequentially('Mock Ta', { delay: 400 }); // pauses long enough to fire several requests
      await expect(page.locator('#nameSuggestions li')).toHaveCount(1);
      const first = await page.evaluate(() => window.__placesMockCalls.map((c) => c.token));
      expect(first.length).toBeGreaterThan(1);
      expect(new Set(first).size).toBe(1);
      expect(first[0]).not.toBeNull();

      await page.locator('#nameSuggestions li').first().click();
      await expect(page.locator('#filingUnder .tag-pill')).toHaveCount(1);
      await page.fill('#rName', 'Mock Taq');
      await expect.poll(() => page.evaluate(() => window.__placesMockCalls.length)).toBeGreaterThan(first.length);
      const next = await page.evaluate(() => window.__placesMockCalls.at(-1).token);
      expect(next).not.toBe(first[0]);
    } finally {
      await closeSession(page);
    }
  });

  test('opening New Listing makes no search request by itself', async ({ browser }) => {
    const { page } = await openAddModal(browser);
    try {
      await page.waitForTimeout(1000);
      expect(await page.evaluate(() => window.__placesMockCalls.length)).toBe(0);
    } finally {
      await closeSession(page);
    }
  });
});

test.describe('Add Listing: manual entry path', () => {
  test('a blocked Places API shows the warning and opens manual entry on the first search', async ({ browser }) => {
    const { page } = await openAddModal(browser, { mode: 'blocked' });
    try {
      await page.fill('#rName', 'Anything');
      await expect(page.locator('#placesNotice')).toBeVisible();
      await expect(page.locator('#manualAddrField')).toBeVisible();
      await expect(page.locator('#manualToggle')).toBeHidden();
    } finally {
      await closeSession(page);
    }
  });

  test('"Add it manually" requires an address, then saves with address autocomplete coordinates', async ({ browser }) => {
    const { page, dialogs } = await openAddModal(browser);
    let saved = null;
    try {
      await page.click('#manualToggle');
      await expect(page.locator('#manualAddrField')).toBeVisible();

      await page.fill('#rName', 'Manual Probe Spot');
      await page.fill('#addTagInput', 'American');
      await page.press('#addTagInput', 'Enter');
      await page.click('#saveAdd');
      expect(dialogs.at(-1)).toContain('Name and address are required');

      await page.fill('#rAddr', '300 N Mock');
      await page.locator('#addrSuggestions li').first().click();
      await expect(page.locator('#rAddr')).toHaveValue('300 N Mock Ave, Chicago, IL 60614, USA');

      await page.click('#saveAdd');
      saved = await findSaved(page, 'Manual Probe Spot');
      expect(saved).toMatchObject({
        categories: ['American'],
        address: '300 N Mock Ave, Chicago, IL 60614, USA',
        lat: 41.92,
        lng: -87.65,
      });
      expect(saved.website).toBeUndefined();
    } finally {
      if (saved) await resetLedger(page, { restaurantIds: [saved.id] });
      await closeSession(page);
    }
  });

  test('a free-typed address in a known Chicagoland town saves without coordinates', async ({ browser }) => {
    const { page } = await openAddModal(browser, { mode: 'blocked' });
    let saved = null;
    try {
      // The failed first search switches to manual mode asynchronously and
      // clears the chips when it does — wait for it, or a tag added first
      // gets wiped.
      await page.fill('#rName', 'Typed Address Spot');
      await expect(page.locator('#manualAddrField')).toBeVisible();
      await page.fill('#rAddr', '1 Nowhere Rd, Chicago, IL');
      await page.fill('#addTagInput', 'American');
      await page.press('#addTagInput', 'Enter');
      await page.click('#saveAdd');
      saved = await findSaved(page, 'Typed Address Spot');
      expect(saved.address).toBe('1 Nowhere Rd, Chicago, IL');
      expect(saved.lat).toBeUndefined();
    } finally {
      if (saved) await resetLedger(page, { restaurantIds: [saved.id] });
      await closeSession(page);
    }
  });
});
