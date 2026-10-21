const { test, expect, openOwnerPage } = require('../fixtures/app-fixture');
const { injectRestaurants, injectVisits, resetLedger, openListingDetail } = require('../fixtures/ledger-helpers');
const { getOwnerUid } = require('../fixtures/auth-helpers');
const { seedDoc, deleteDoc, getDoc } = require('../fixtures/firestore-seed');
const { clearFirestore } = require('../fixtures/emulator-admin');

test.beforeAll(async () => { await clearFirestore(); });
// Owner sessions seed the full curated dataset into the shared emulator;
// guest-only specs assert exact card counts, so don't leave it behind.
test.afterAll(async () => { await clearFirestore(); });

function probe(id, extra = {}) {
  return { id, name: `Probe ${id}`, categories: ['American'], address: '1 Probe St, Chicago, IL 60607', createdAt: Date.now(), menu: [], ...extra };
}
function visit(id, restaurantId, authorUid, extra = {}) {
  return { id, restaurantId, authorUid, reviewer: 'Tester', rating: 4, wouldReturn: true, ate: [], notes: '', date: '2026-10-01', createdAt: Date.now(), ...extra };
}

async function openListing(page, id) {
  await openListingDetail(page, id);
}

test.describe('Detail modal: links (any viewer)', () => {
  test('shows Maps, Yelp and phone pills, and links the name to the website', async ({ listingsPage }) => {
    const r = probe('links-1', {
      website: 'https://links-probe.example.com/',
      yelp: 'https://www.yelp.com/biz/links-probe',
      phone: '+1 (312) 555-0123',
      mapsUrl: 'https://www.google.com/maps/place/?q=place_id:links-probe',
    });
    await injectRestaurants(listingsPage, [r]);
    try {
      await listingsPage.locator(`.ticket[data-id="${r.id}"]`).click();
      const links = listingsPage.locator('.detail-links');
      await expect(links.locator('a', { hasText: 'Google Maps' })).toHaveAttribute('href', r.mapsUrl);
      await expect(links.locator('a', { hasText: 'Yelp' })).toHaveAttribute('href', r.yelp);
      await expect(links.locator('a[href^="tel:"]')).toHaveAttribute('href', 'tel:+13125550123');
      await expect(listingsPage.locator('.detail-name a')).toHaveAttribute('href', r.website);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: [r.id] });
    }
  });

  test('omits the Yelp and phone pills when a listing has neither', async ({ listingsPage }) => {
    const r = probe('links-2');
    await injectRestaurants(listingsPage, [r]);
    try {
      await listingsPage.locator(`.ticket[data-id="${r.id}"]`).click();
      await expect(listingsPage.locator('.detail-links a', { hasText: 'Yelp' })).toHaveCount(0);
      await expect(listingsPage.locator('.detail-links a[href^="tel:"]')).toHaveCount(0);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: [r.id] });
    }
  });
});

test.describe('Detail modal: owner edits', () => {
  test('the owner can add a guide tag, and it persists', async ({ ownerPage }) => {
    const r = probe('tag-add');
    await injectRestaurants(ownerPage, [r]);
    try {
      await openListing(ownerPage, r.id);
      await ownerPage.fill('#newTag', 'Brunch');
      await ownerPage.press('#newTag', 'Enter');
      await expect(ownerPage.locator('#tagRow .tag-pill', { hasText: 'Brunch' })).toBeVisible();
      await expect.poll(async () => (await getDoc(`restaurants/${r.id}`))?.categories).toEqual(['American', 'Brunch']);
    } finally {
      await resetLedger(ownerPage, { restaurantIds: [r.id] });
    }
  });

  test('adding a tag the listing already has (any case) is a no-op', async ({ ownerPage }) => {
    const r = probe('tag-dup');
    await injectRestaurants(ownerPage, [r]);
    try {
      await openListing(ownerPage, r.id);
      await ownerPage.fill('#newTag', 'american');
      await ownerPage.press('#newTag', 'Enter');
      await expect(ownerPage.locator('#tagRow .tag-pill')).toHaveCount(1);
    } finally {
      await resetLedger(ownerPage, { restaurantIds: [r.id] });
    }
  });

  test('the owner can remove a guide tag, and it persists', async ({ ownerPage }) => {
    const r = probe('tag-remove', { categories: ['American', 'Brunch'] });
    await injectRestaurants(ownerPage, [r]);
    try {
      await openListing(ownerPage, r.id);
      await ownerPage.locator('#tagRow .tag-x[data-tag="Brunch"]').click();
      await expect(ownerPage.locator('#tagRow .tag-pill', { hasText: 'Brunch' })).toHaveCount(0);
      await expect.poll(async () => (await getDoc(`restaurants/${r.id}`))?.categories).toEqual(['American']);
    } finally {
      await resetLedger(ownerPage, { restaurantIds: [r.id] });
    }
  });

  test('cancelling the delete confirmation keeps the listing', async ({ ownerPage }) => {
    const r = probe('delete-cancel');
    await injectRestaurants(ownerPage, [r]);
    try {
      await openListing(ownerPage, r.id);
      ownerPage.once('dialog', (d) => d.dismiss());
      await ownerPage.click('#deleteRestBtn');
      await expect(ownerPage.locator('.modal .detail-name')).toBeVisible();
      expect(await getDoc(`restaurants/${r.id}`)).not.toBeNull();
    } finally {
      await resetLedger(ownerPage, { restaurantIds: [r.id] });
    }
  });

  test('confirming delete removes the listing and its own visits, locally and in Firestore', async ({ ownerPage }) => {
    const r = probe('delete-ok');
    const v = visit('delete-ok-v', r.id, getOwnerUid());
    await injectRestaurants(ownerPage, [r]);
    await injectVisits(ownerPage, [v]);
    await openListing(ownerPage, r.id);
    ownerPage.once('dialog', (d) => d.accept());
    await ownerPage.click('#deleteRestBtn');
    await expect(ownerPage.locator(`.ticket[data-id="${r.id}"]`)).toHaveCount(0);
    expect(await ownerPage.evaluate((vid) => visits.some((x) => x.id === vid), v.id)).toBe(false);
    await expect.poll(() => getDoc(`restaurants/${r.id}`)).toBeNull();
    await expect.poll(() => getDoc(`visits/${v.id}`)).toBeNull();
  });
});

test.describe('Detail modal: removing visits', () => {
  test('a visit\'s author sees "remove" on it and can delete it', async ({ ownerPage }) => {
    const r = probe('visit-own');
    const v = visit('visit-own-v', r.id, getOwnerUid());
    await injectRestaurants(ownerPage, [r]);
    await injectVisits(ownerPage, [v]);
    try {
      await openListing(ownerPage, r.id);
      const item = ownerPage.locator(`.visit-item[data-vid="${v.id}"]`);
      await item.locator('.trash').click();
      await expect(item).toHaveCount(0);
      await expect.poll(() => getDoc(`visits/${v.id}`)).toBeNull();
    } finally {
      await resetLedger(ownerPage, { restaurantIds: [r.id] });
    }
  });

  test("nobody — not even the owner — gets a remove button on someone else's visit", async ({ ownerPage }) => {
    const r = probe('visit-foreign');
    const v = visit('visit-foreign-v', r.id, 'someone-else', { reviewer: 'Someone Else' });
    await injectRestaurants(ownerPage, [r]);
    // Arranged server-side: the owner's page isn't allowed to write a visit
    // attributed to someone else (see tests/rules/visits.rules.spec.js).
    await seedDoc(`visits/${v.id}`, v);
    try {
      await openListing(ownerPage, r.id);
      const item = ownerPage.locator(`.visit-item[data-vid="${v.id}"]`);
      await expect(item).toBeVisible();
      await expect(item.locator('.trash')).toHaveCount(0);
    } finally {
      // Remove the foreign visit server-side first; the owner's page can't
      // delete it, and resetLedger would otherwise try to.
      await deleteDoc(`visits/${v.id}`);
      await expect.poll(() => ownerPage.evaluate((vid) => visits.some((x) => x.id === vid), v.id)).toBe(false);
      await resetLedger(ownerPage, { restaurantIds: [r.id] });
    }
  });
});
