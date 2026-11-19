// Menu choices: a dish's sizes, counts, flavors, sauces and sides come from
// its MENU_LOOKUP entry (`options`). Log a Visit shows them under a checked
// dish (one pick per group, stars and "Any changes?" stay); the visit
// stores them; the listing's menu keeps one rating per dish plus a
// breakdown by choice. Visits from before choices keep working.
const { test, expect } = require('../fixtures/app-fixture');
const { injectRestaurants, injectVisits, resetLedger, openListingDetail } = require('../fixtures/ledger-helpers');
const { getOwnerUid } = require('../fixtures/auth-helpers');
const { getDoc } = require('../fixtures/firestore-seed');
const { clearFirestore } = require('../fixtures/emulator-admin');
const { pickStars } = require('../fixtures/stars');

test.afterAll(async () => { await clearFirestore(); });

const ENTRY = 'Chi Cafe';
const OPTIONS = { Size: ['6 pc', '12 pc', '24 pc'], Sauce: ['Mild', 'Hot'] };
function probe(id) {
  return { id, name: `Probe ${id}`, curatedName: ENTRY, categories: ['Chinese'], address: '1 Probe St, Chicago, IL 60616', createdAt: Date.now(), menu: [] };
}
// A dish from the section that starts open, given choices for this page.
async function giveChoices(page) {
  return page.evaluate(({ name, options }) => {
    const e = MENU_LOOKUP.find((x) => x.name === name);
    const dish = e.sections['Most Popular'][0];
    e.options = { [dish]: options };
    return dish;
  }, { name: ENTRY, options: OPTIONS });
}
const dropChoices = (page) => page.evaluate((name) => { delete MENU_LOOKUP.find((x) => x.name === name).options; }, ENTRY);

test.describe('Menu choices', () => {
  test('pick choices under a dish, save them on the visit, and see them on the visit and the menu', async ({ ownerPage }) => {
    const dish = await giveChoices(ownerPage);
    const r = probe('choice-log');
    await injectRestaurants(ownerPage, [r]);
    try {
      await openListingDetail(ownerPage, r.id);
      await ownerPage.click('#logVisitBtn');
      const pick = ownerPage.locator(`.dish-pick[data-dish="${dish}"]`).first();
      // No choices until the dish is checked.
      await expect(pick.locator('.choice-group')).toHaveCount(0);
      await pick.locator('input[type="checkbox"]').check();
      await expect(pick.locator('.choice-group')).toHaveCount(2);
      // Stars and "Any changes?" are still there.
      await expect(pick.locator('.star-slider')).toBeVisible();
      await expect(pick.locator('.dish-mod')).toBeVisible();

      const chip = (group, choice) => pick.locator(`.choice-group[data-group="${group}"] .choice-chip[data-choice="${choice}"]`);
      await chip('Size', '12 pc').click();
      await chip('Sauce', 'Hot').click();
      await chip('Sauce', 'Hot').click(); // tapping it again clears it
      await expect(chip('Sauce', 'Hot')).toHaveAttribute('aria-pressed', 'false');
      await chip('Sauce', 'Mild').click();
      await chip('Size', '24 pc').click(); // one pick per group
      await chip('Size', '12 pc').click();
      await expect(chip('Size', '12 pc')).toHaveAttribute('aria-pressed', 'true');
      await expect(chip('Size', '24 pc')).toHaveAttribute('aria-pressed', 'false');
      await pickStars(pick.locator('.star-slider'), 5);

      await pickStars(ownerPage.locator('#starPick'), 4);
      await ownerPage.click('#wrYes');
      await ownerPage.click('#saveLog');
      await expect(ownerPage.locator('.visit-item')).toHaveCount(1);

      const saved = await ownerPage.evaluate((id) => visits.find((v) => v.restaurantId === id), r.id);
      expect(saved.dishDetails).toEqual([{ dish, rating: 5, choices: { Size: '12 pc', Sauce: 'Mild' } }]);
      await expect.poll(async () => (await getDoc(`visits/${saved.id}`))?.dishDetails).toEqual(saved.dishDetails);

      // The visit card lists what was chosen.
      await expect(ownerPage.locator('.visit-item .ate-choices')).toHaveText('12 pc · Mild');
      // The menu: one rating for the dish, and the breakdown by choice.
      await ownerPage.fill('#menuSearch', dish);
      const row = ownerPage.locator('#menuChips .menu-row').filter({ has: ownerPage.locator('.dish-name', { hasText: dish }) }).first();
      await expect(row.locator('.dish-badges .dish-avg')).toHaveText('5.0★');
      // Grouped and labeled, in the menu's own group order.
      await expect(row.locator('.choice-stat-group')).toHaveText(['Size', 'Sauce']);
      await expect(row.locator('.choice-stat')).toHaveText(['12 pc 5.0★ 1×', 'Mild 5.0★ 1×']);

      // Editing the visit shows the choices picked.
      await ownerPage.locator(`.visit-edit[data-vid="${saved.id}"]`).click();
      await expect(chip('Size', '12 pc')).toHaveAttribute('aria-pressed', 'true');
      await expect(chip('Sauce', 'Mild')).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await dropChoices(ownerPage);
      const ids = await ownerPage.evaluate((id) => visits.filter((v) => v.restaurantId === id).map((v) => v.id), r.id);
      await resetLedger(ownerPage, { restaurantIds: [r.id], visitIds: ids });
    }
  });

  test('ratings from before choices still count toward the dish, and its breakdown shows only choices people picked', async ({ ownerPage }) => {
    const dish = await giveChoices(ownerPage);
    const r = probe('choice-old');
    const base = { restaurantId: r.id, authorUid: await getOwnerUid(), reviewer: 'Tester', rating: 4, wouldReturn: true, notes: '', date: '2026-10-01', createdAt: Date.now() };
    const visitsIn = [
      { ...base, id: 'choice-old-1', ate: [dish], dishDetails: [{ dish, rating: 3 }] },
      { ...base, id: 'choice-old-2', ate: [dish], dishDetails: [{ dish, rating: 5, choices: { Size: '6 pc' } }] },
    ];
    await injectRestaurants(ownerPage, [r]);
    await injectVisits(ownerPage, visitsIn);
    try {
      await openListingDetail(ownerPage, r.id);
      await ownerPage.fill('#menuSearch', dish);
      const row = ownerPage.locator('#menuChips .menu-row').filter({ has: ownerPage.locator('.dish-name', { hasText: dish }) }).first();
      await expect(row.locator('.dish-badges .dish-avg')).toHaveText('4.0★');
      await expect(row.locator('.ordered-badge')).toHaveText('ordered 2×');
      await expect(row.locator('.choice-stat')).toHaveText(['6 pc 5.0★ 1×']);
      // The older visit's card has no choices line.
      await expect(ownerPage.locator('.visit-item[data-vid="choice-old-1"] .ate-choices')).toHaveCount(0);
      await expect(ownerPage.locator('.visit-item[data-vid="choice-old-2"] .ate-choices')).toHaveText('6 pc');
    } finally {
      await dropChoices(ownerPage);
      await resetLedger(ownerPage, { restaurantIds: [r.id], visitIds: visitsIn.map((v) => v.id) });
    }
  });
});
