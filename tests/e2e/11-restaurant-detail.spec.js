const { test, expect, openOwnerPage, openSignedInPage, closeSession } = require('../fixtures/app-fixture');
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

test.describe('Detail modal: visits (any viewer)', () => {
  test('visits come before the menu, with a count, the average, and each visit in full', async ({ listingsPage }) => {
    const r = probe('visits-1', { menu: ['Jerk Chicken'] });
    const v1 = visit('visits-1a', r.id, 'someone', { reviewer: 'Ana', rating: 5, date: '2026-10-02', ate: ['Jerk Chicken'], notes: 'Ask for extra sauce.' });
    const v2 = visit('visits-1b', r.id, 'someone-else', { reviewer: 'Ben', rating: 4, date: '2026-09-01', wouldReturn: false });
    await injectRestaurants(listingsPage, [r]);
    await injectVisits(listingsPage, [v1, v2]);
    try {
      await listingsPage.evaluate((id) => openDetail(id), r.id);
      const order = await listingsPage.evaluate(() => {
        const visitsEl = document.querySelector('.listing-modal .visit-list');
        const menuEl = document.querySelector('.listing-modal .menu-section');
        return !!(visitsEl.compareDocumentPosition(menuEl) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      expect(order).toBe(true);
      await expect(listingsPage.locator('.visit-list .section-sub')).toHaveText('2 visits · 4.5 average');
      const first = listingsPage.locator('.visit-item').first();
      await expect(first.locator('.visit-who')).toHaveText('Ana'); // newest first
      await expect(first.locator('.return-pill')).toHaveText('Would go back');
      await expect(first).toContainText('Ate Jerk Chicken');
      await expect(first).toContainText('Review Ask for extra sauce.');
      await expect(listingsPage.locator('.visit-item').nth(1).locator('.return-pill')).toHaveText("Wouldn't go back");
      await expect(listingsPage.locator('.menu-row', { hasText: 'Jerk Chicken' }).locator('.ordered-badge')).toHaveText('ordered 1×');
    } finally {
      await resetLedger(listingsPage, { restaurantIds: [r.id], visitIds: [v1.id, v2.id] });
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

  test('"+ Add a guide" suggests Personal Gems and Tourist Spots even before any listing has them', async ({ ownerPage }) => {
    const r = probe('tag-suggest');
    await injectRestaurants(ownerPage, [r]);
    try {
      await openListing(ownerPage, r.id);
      const options = await ownerPage.locator('#tagList option').evaluateAll((els) => els.map((e) => e.value));
      expect(options).toEqual(expect.arrayContaining(['Personal Gems', 'Tourist Spots']));
      expect(options).not.toContain('Chicago Gems');
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

  // Regression: the delete cascade used to include friends' visits, which
  // the rules wouldn't let the owner delete — the whole save was rejected,
  // and every later save retried the same deletes, so nothing synced again
  // until a reload.
  test("deleting a listing also removes friends' visits, and later saves still sync", async ({ ownerPage }) => {
    const r = probe('delete-friends');
    const later = probe('delete-friends-later');
    const friendVisit = visit('delete-friends-v', r.id, 'a-friend', { reviewer: 'A Friend' });
    await injectRestaurants(ownerPage, [r]);
    await seedDoc(`visits/${friendVisit.id}`, friendVisit);
    await expect.poll(() => ownerPage.evaluate((vid) => visits.some((x) => x.id === vid), friendVisit.id)).toBe(true);
    try {
      await openListing(ownerPage, r.id);
      ownerPage.once('dialog', (d) => d.accept());
      await ownerPage.click('#deleteRestBtn');
      await expect.poll(() => getDoc(`restaurants/${r.id}`)).toBeNull();
      await expect.poll(() => getDoc(`visits/${friendVisit.id}`)).toBeNull();
      expect(await ownerPage.evaluate(() => document.querySelector('#ledgerStatus')?.textContent ?? 'Shared')).not.toBe('Sync issue');

      await injectRestaurants(ownerPage, [later]);
      await expect.poll(() => getDoc(`restaurants/${later.id}`)).not.toBeNull();
    } finally {
      await resetLedger(ownerPage, { restaurantIds: [r.id, later.id] });
    }
  });
});

test.describe('Curated listings: your edits stick', () => {
  // Owner sessions load the full curated dataset; these use real curated
  // listings and re-run the owner startup steps in the page to prove a
  // restart doesn't undo anything.
  // The owner startup's steps, in init()'s order (app.js).
  const restart = (page) => page.evaluate(async () => {
    await migrateCategories(); await seedIfNeeded(); await redateCuratedListings(); await enrichAddresses();
    await removeClosedPlaces(); await renameCuisineTags(); await stripParentDessertTag(); await removeStrayTags();
    await removeRemovedListings(); await seedMenusFromVisits(); await seedCuratedMenus();
  });

  test('a Personal Gem you remove stays removed after the owner startup runs again', async ({ ownerPage }) => {
    const id = await ownerPage.evaluate(() => restaurants.find((r) => r.name === 'Beggars Pizza').id);
    expect(await ownerPage.evaluate((id) => restaurants.find((r) => r.id === id).categories, id)).toContain('Personal Gems');
    await openListing(ownerPage, id);
    await ownerPage.locator('#tagRow .tag-x[data-tag="Personal Gems"]').click();
    await expect(ownerPage.locator('#tagRow .tag-pill', { hasText: 'Personal Gems' })).toHaveCount(0);
    await restart(ownerPage);
    expect(await ownerPage.evaluate((id) => restaurants.find((r) => r.id === id).categories, id)).not.toContain('Personal Gems');
    await expect.poll(async () => (await getDoc(`restaurants/${id}`))?.categories).not.toContain('Personal Gems');
  });

  test('renaming a listing keeps its visits, menu and checked date, and never seeds a duplicate', async ({ ownerPage }) => {
    const before = await ownerPage.evaluate(() => {
      const r = restaurants.find((x) => x.name === 'Chi Cafe');
      return { id: r.id, menu: r.menu.length, count: restaurants.length };
    });
    const v = visit('rename-v', before.id, getOwnerUid(), { ate: ['Orange Chicken'] });
    await injectVisits(ownerPage, [v]);
    try {
      await openListing(ownerPage, before.id);
      await ownerPage.click('#renameBtn');
      await ownerPage.fill('#renameInput', 'Chi Cafe Chinatown');
      await ownerPage.click('#renameForm button[type="submit"]');
      await expect(ownerPage.locator('.modal .detail-name')).toHaveText('Chi Cafe Chinatown');
      await expect(ownerPage.locator(`.visit-item[data-vid="${v.id}"]`)).toBeVisible();
      await expect(ownerPage.locator('.menu-head .section-sub')).toContainText(`${before.menu} dishes · checked`);
      await restart(ownerPage);
      const after = await ownerPage.evaluate((id) => ({
        count: restaurants.length,
        dupes: restaurants.filter((x) => x.name === 'Chi Cafe').length,
        r: restaurants.find((x) => x.id === id),
      }), before.id);
      expect(after.count).toBe(before.count);
      expect(after.dupes).toBe(0);
      expect(after.r).toMatchObject({ name: 'Chi Cafe Chinatown', curatedName: 'Chi Cafe' });
      expect(after.r.menu.length).toBe(before.menu);
      await expect.poll(async () => (await getDoc(`restaurants/${before.id}`))?.name).toBe('Chi Cafe Chinatown');
    } finally {
      await resetLedger(ownerPage, { visitIds: [v.id] });
    }
  });

  test('a rename to a name another listing already has is refused', async ({ ownerPage }) => {
    const id = await ownerPage.evaluate(() => restaurants.find((r) => r.name === 'Akiro').id);
    const dialogs = [];
    ownerPage.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
    await openListing(ownerPage, id);
    await ownerPage.click('#renameBtn');
    await ownerPage.fill('#renameInput', 'beggars pizza');
    await ownerPage.click('#renameForm button[type="submit"]');
    expect(dialogs.at(-1)).toContain('already a listing called');
    expect(await ownerPage.evaluate((id) => restaurants.find((r) => r.id === id).name, id)).toBe('Akiro');
  });

  test('guests and friends get no rename button', async ({ listingsPage }) => {
    const r = probe('rename-guest');
    await injectRestaurants(listingsPage, [r]);
    try {
      await listingsPage.evaluate((id) => openDetail(id), r.id);
      await expect(listingsPage.locator('#renameBtn')).toHaveCount(0);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: [r.id] });
    }
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

  test("a signed-in friend gets no remove button on someone else's visit", async ({ browser, ownerPage }) => {
    const r = probe('visit-foreign');
    const v = visit('visit-foreign-v', r.id, 'someone-else', { reviewer: 'Someone Else' });
    await injectRestaurants(ownerPage, [r]);
    // Arranged server-side: no page may write a visit attributed to
    // someone else (see tests/rules/visits.rules.spec.js).
    await seedDoc(`visits/${v.id}`, v);
    const friendPage = await openSignedInPage(browser);
    try {
      await openListing(friendPage, r.id);
      const item = friendPage.locator(`.visit-item[data-vid="${v.id}"]`);
      await expect(item).toBeVisible();
      await expect(item.locator('.trash')).toHaveCount(0);
      await expect(item.locator('.visit-edit')).toHaveCount(0); // only the author can edit
    } finally {
      await closeSession(friendPage);
      await deleteDoc(`visits/${v.id}`);
      await expect.poll(() => ownerPage.evaluate((vid) => visits.some((x) => x.id === vid), v.id)).toBe(false);
      await resetLedger(ownerPage, { restaurantIds: [r.id] });
    }
  });

  test("the owner can remove someone else's visit (spam / moderation), after confirming", async ({ ownerPage }) => {
    const r = probe('visit-moderate');
    const v = visit('visit-moderate-v', r.id, 'a-spammer', { reviewer: 'Spammer' });
    await injectRestaurants(ownerPage, [r]);
    await seedDoc(`visits/${v.id}`, v);
    try {
      await openListing(ownerPage, r.id);
      const item = ownerPage.locator(`.visit-item[data-vid="${v.id}"]`);
      await expect(item).toBeVisible();
      ownerPage.once('dialog', (d) => d.accept());
      await item.locator('.trash').click();
      await expect(ownerPage.locator(`.visit-item[data-vid="${v.id}"]`)).toHaveCount(0);
      await expect.poll(() => getDoc(`visits/${v.id}`)).toBeNull();
    } finally {
      await resetLedger(ownerPage, { restaurantIds: [r.id] });
    }
  });
});
