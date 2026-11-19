// Menus come straight from MENU_LOOKUP (data/menu-lookup.js), which the
// daily menu routine keeps current. A listing's stored `menu` holds only
// dishes people added. Covers: the shown menu, the one-time cleanup of the
// copies older versions made, adding dishes, renamed dishes keeping their
// visits and ratings, and the owner's "Re-check menu" button.
const { test, expect } = require('../fixtures/app-fixture');
const { injectRestaurants, injectVisits, resetLedger, openListingDetail } = require('../fixtures/ledger-helpers');
const { getOwnerUid } = require('../fixtures/auth-helpers');
const { getDoc } = require('../fixtures/firestore-seed');
const { clearFirestore } = require('../fixtures/emulator-admin');

// Owner sessions seed the full curated dataset into the shared emulator;
// guest-only specs assert exact card counts, so don't leave it behind.
test.afterAll(async () => { await clearFirestore(); });

// A probe filed under a real, sectioned curated entry (curatedName), so it
// gets that entry's menu without touching the real listing.
const ENTRY = 'Chi Cafe';
function probe(id, extra = {}) {
  return {
    id, name: `Probe ${id}`, curatedName: ENTRY, categories: ['Chinese'],
    address: '1 Probe St, Chicago, IL 60616', createdAt: Date.now(), menu: [], ...extra,
  };
}
const curated = (page) => page.evaluate((name) => {
  const e = MENU_LOOKUP.find((x) => x.name === name);
  const dishes = Object.values(e.sections).flat();
  return { dishes, count: new Set(dishes.map((d) => d.toLowerCase())).size, asOf: e.asOf };
}, ENTRY);
const record = (page, id) => page.evaluate((id) => restaurants.find((r) => r.id === id) || null, id);

test.describe('Menus come from the curated list', () => {
  test('a listing shows its full curated menu plus the dishes people added', async ({ listingsPage }) => {
    const { count } = await curated(listingsPage);
    const r = probe('menu-merge', { menu: ['Probe Secret Noodles'] });
    await injectRestaurants(listingsPage, [r]);
    try {
      await openListingDetail(listingsPage, r.id);
      await expect(listingsPage.locator('.menu-head .section-sub')).toContainText(`${count + 1} dishes`);
      // A dish the curated menu doesn't list sits under "More".
      await listingsPage.fill('#menuSearch', 'Probe Secret');
      const more = listingsPage.locator('#menuChips .menu-group[data-section="More"]');
      await expect(more.locator('.menu-row', { hasText: 'Probe Secret Noodles' })).toBeVisible();
      // Guests can't ask for a re-check.
      await expect(listingsPage.locator('#recheckMenuBtn')).toHaveCount(0);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: [r.id] });
    }
  });

  test('the one-time cleanup drops copied dishes, keeps dishes people added, and runs once', async ({ ownerPage }) => {
    const { dishes, count } = await curated(ownerPage);
    // How older versions stored it: every curated dish copied in, a dish a
    // later correction retired, and one a person added.
    const r = probe('menu-strip', { menuSeeded: 2, menu: [...dishes, 'Probe Retired Special', 'Probe Secret Noodles'] });
    await injectRestaurants(ownerPage, [r]);
    try {
      await ownerPage.evaluate(() => { MENU_LOOKUP.find((e) => e.name === 'Chi Cafe').retire = ['Probe Retired Special']; });
      await ownerPage.evaluate(() => stripCopiedMenus());
      const after = await record(ownerPage, r.id);
      expect(after.menu).toEqual(['Probe Secret Noodles']);
      expect(after.menuSeeded).toBeNull();
      expect(await ownerPage.evaluate((id) => menuOf(restaurants.find((x) => x.id === id)).length, r.id)).toBe(count + 1);
      await expect.poll(async () => (await getDoc(`restaurants/${r.id}`))?.menu).toEqual(['Probe Secret Noodles']);
      expect((await getDoc(`restaurants/${r.id}`)).menuSeeded).toBeNull();
      // Running it again changes nothing.
      await ownerPage.evaluate(() => stripCopiedMenus());
      expect((await record(ownerPage, r.id)).menu).toEqual(['Probe Secret Noodles']);
    } finally {
      await ownerPage.evaluate(() => { delete MENU_LOOKUP.find((e) => e.name === 'Chi Cafe').retire; });
      await resetLedger(ownerPage, { restaurantIds: [r.id] });
    }
  });

  test('a dish already on the curated menu is not stored again; a new one is', async ({ ownerPage }) => {
    const { dishes } = await curated(ownerPage);
    const r = probe('menu-add');
    await injectRestaurants(ownerPage, [r]);
    try {
      const result = await ownerPage.evaluate(({ id, dish }) => [
        addDishToMenu(id, dish.toUpperCase()),
        addDishToMenu(id, 'Probe Brand New Dish'),
        restaurants.find((x) => x.id === id).menu,
      ], { id: r.id, dish: dishes[0] });
      expect(result).toEqual([false, true, ['Probe Brand New Dish']]);
    } finally {
      await resetLedger(ownerPage, { restaurantIds: [r.id] });
    }
  });

  test('a renamed dish keeps its visits and stars, and editing the visit shows the new name checked', async ({ ownerPage }) => {
    const { dishes } = await curated(ownerPage);
    const target = dishes[0];
    const r = probe('menu-rename');
    const v = {
      id: 'menu-rename-v', restaurantId: r.id, authorUid: await getOwnerUid(), reviewer: 'Tester', rating: 4, wouldReturn: true,
      ate: ['Probe Old Name'], dishDetails: [{ dish: 'Probe Old Name', rating: 5 }], notes: '', date: '2026-10-01', createdAt: Date.now(),
    };
    await ownerPage.evaluate((t) => { MENU_LOOKUP.find((e) => e.name === 'Chi Cafe').renamed = { 'Probe Old Name': t }; }, target);
    await injectRestaurants(ownerPage, [r]);
    await injectVisits(ownerPage, [v]);
    try {
      await openListingDetail(ownerPage, r.id);
      await ownerPage.fill('#menuSearch', target);
      const row = ownerPage.locator('#menuChips .menu-row').filter({ has: ownerPage.locator('.dish-name', { hasText: new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first();
      await expect(row.locator('.ordered-badge')).toHaveText('ordered 1×');
      await expect(row.locator('.dish-avg')).toHaveText('5.0★');
      // The old name isn't added to the menu as a separate dish.
      expect(await ownerPage.evaluate((id) => menuOf(restaurants.find((x) => x.id === id)).includes('Probe Old Name'), r.id)).toBe(false);

      await ownerPage.locator(`.visit-edit[data-vid="${v.id}"]`).click();
      const box = ownerPage.locator(`#dishArea input[type="checkbox"][data-dish="${target}"]`).first();
      await expect(box).toBeChecked();
    } finally {
      await ownerPage.evaluate(() => { delete MENU_LOOKUP.find((e) => e.name === 'Chi Cafe').renamed; });
      await resetLedger(ownerPage, { restaurantIds: [r.id], visitIds: [v.id] });
    }
  });

  test('"Re-check menu" queues the spot for the daily menu routine', async ({ ownerPage }) => {
    const { asOf } = await curated(ownerPage);
    const r = probe('menu-recheck');
    await injectRestaurants(ownerPage, [r]);
    try {
      await openListingDetail(ownerPage, r.id);
      await ownerPage.click('#recheckMenuBtn');
      const today = await ownerPage.evaluate(() => fmtDate(localDateStr()));
      await expect(ownerPage.locator('#recheckNote')).toHaveText(`Re-check requested ${today}`);
      await expect(ownerPage.locator('#recheckMenuBtn')).toHaveCount(0);
      await expect.poll(async () => typeof (await getDoc(`restaurants/${r.id}`))?.menuCheckRequestedAt).toBe('number');
      // Once the menu has been checked on a later day, the request is done.
      const done = await ownerPage.evaluate(({ id, asOf }) => {
        const x = restaurants.find((y) => y.id === id);
        x.menuCheckRequestedAt = new Date(`${asOf}T00:00:00`).getTime() - 86400000;
        return menuRecheckPending(x);
      }, { id: r.id, asOf });
      expect(done).toBeNull();
    } finally {
      await resetLedger(ownerPage, { restaurantIds: [r.id] });
    }
  });
});
