const { test, expect, openOwnerPage, openSignedInPage, closeSession } = require('../fixtures/app-fixture');
const { injectRestaurants, openListingDetail } = require('../fixtures/ledger-helpers');
const { getDoc } = require('../fixtures/firestore-seed');
const { clearFirestore } = require('../fixtures/emulator-admin');

// Logged by a signed-in non-owner against a listing the owner created —
// the realistic shape (only the owner can create listings; anyone signed
// in can log visits, and add a dish that's missing from the menu).
test.beforeAll(async () => { await clearFirestore(); });
test.afterAll(async () => { await clearFirestore(); });

async function arrangeListing(browser, id, extra = {}) {
  const ownerPage = await openOwnerPage(browser);
  const r = { id, name: `Probe ${id}`, categories: ['Pizza'], address: '1 Probe St, Chicago, IL 60607', createdAt: Date.now(), menu: ['Cheese Slice', 'Pepperoni Pie'], ...extra };
  await injectRestaurants(ownerPage, [r]);
  await closeSession(ownerPage);
  return r;
}

async function openLogVisit(page, r) {
  await openListingDetail(page, r.id);
  await page.click('#logVisitBtn');
  await expect(page.locator('#saveLog')).toBeVisible();
}

function captureDialogs(page) {
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
  return dialogs;
}

test.describe('Log a Visit: validation', () => {
  test('rating, would-go-back, and (on a first visit) a username are each required', async ({ browser, signedInPage }) => {
    const r = await arrangeListing(browser, 'lv-validate');
    const dialogs = captureDialogs(signedInPage);
    await openLogVisit(signedInPage, r);

    await signedInPage.click('#saveLog');
    expect(dialogs.at(-1)).toBe('Pick a rating.');

    await signedInPage.click('#starPick span[data-n="3"]');
    await signedInPage.click('#saveLog');
    expect(dialogs.at(-1)).toContain("if you'd go back");

    await signedInPage.click('#wrNo');
    await signedInPage.click('#saveLog');
    expect(dialogs.at(-1)).toBe('Pick a reviewer username.');

    expect(await signedInPage.evaluate((id) => visits.filter((v) => v.restaurantId === id).length, r.id)).toBe(0);
  });
});

test.describe('Log a Visit: saving', () => {
  test('a full first visit saves everything, creates the reviewer profile, and adds a new dish to the menu', async ({ browser, signedInPage }) => {
    const r = await arrangeListing(browser, 'lv-full');
    await openLogVisit(signedInPage, r);

    await signedInPage.fill('#vReviewerNew', 'Probe Reviewer');
    await signedInPage.locator('.dish-check input[data-dish="Cheese Slice"]').check();
    await signedInPage.fill('#vAte', 'Garlic Knots'); // not on the menu yet
    await signedInPage.click('#starPick span[data-n="4"]');
    await signedInPage.click('#wrYes');
    await signedInPage.fill('#vNotes', 'Ask for extra crispy.');

    // Pick the 15th of the previous month from the calendar.
    await signedInPage.click('#dateDisplay');
    await signedInPage.click('#calPrev');
    const day15 = signedInPage.locator('#calGrid .cal-cell:not(.cal-blank)').nth(14);
    const chosenDate = await day15.getAttribute('data-date');
    await day15.click();

    await signedInPage.click('#saveLog');

    // Back on the detail modal, showing the new visit.
    const item = signedInPage.locator('.visit-item').first();
    await expect(item).toContainText('Probe Reviewer');
    await expect(item).toContainText('Ate: Cheese Slice, Garlic Knots');
    await expect(item).toContainText('Would return: Yes');
    await expect(item).toContainText('Notes: Ask for extra crispy.');
    await expect(signedInPage.locator('#menuChips')).toContainText('Garlic Knots');

    const uid = await signedInPage.evaluate(() => window.RoundsFirebase.auth.currentUser.uid);
    const saved = await signedInPage.evaluate((id) => visits.find((v) => v.restaurantId === id), r.id);
    expect(saved).toMatchObject({ rating: 4, wouldReturn: true, date: chosenDate, reviewer: 'Probe Reviewer', authorUid: uid });

    // Persisted to the shared ledger: the visit, and the menu addition — a
    // non-owner's menu-only update, which firestore.rules allows.
    await expect.poll(() => getDoc(`visits/${saved.id}`)).toMatchObject({ authorUid: uid, date: chosenDate });
    await expect.poll(async () => (await getDoc(`restaurants/${r.id}`))?.menu).toContain('Garlic Knots');

    // The first visit created this device's reviewer profile.
    await expect(signedInPage.locator('#profileBtn')).toContainText('Probe Reviewer');
  });

  test('once a profile exists, the form shows "Logging as …" instead of asking for a username', async ({ browser, signedInPage }) => {
    const r = await arrangeListing(browser, 'lv-second');
    await signedInPage.evaluate(async () => {
      profiles.push({ id: 'p-existing', name: 'Existing Reviewer' });
      activeProfileId = 'p-existing';
      await saveProfiles();
    });
    await openLogVisit(signedInPage, r);
    await expect(signedInPage.locator('.logged-by')).toContainText('Logging as Existing Reviewer');
    await expect(signedInPage.locator('#vReviewerNew')).toHaveCount(0);

    await signedInPage.click('#starPick span[data-n="5"]');
    await signedInPage.click('#wrYes');
    await signedInPage.click('#saveLog');
    await expect(signedInPage.locator('.visit-item').first()).toContainText('Existing Reviewer');
  });

  test('"switch" swaps in a reviewer picker without losing what was already entered', async ({ browser, signedInPage }) => {
    const r = await arrangeListing(browser, 'lv-switch');
    await signedInPage.evaluate(async () => {
      profiles.push({ id: 'p-a', name: 'Reviewer A' }, { id: 'p-b', name: 'Reviewer B' });
      activeProfileId = 'p-a';
      await saveProfiles();
    });
    await openLogVisit(signedInPage, r);
    await signedInPage.fill('#vNotes', 'keep me');
    await signedInPage.click('#switchReviewer');
    await signedInPage.selectOption('#vReviewer', 'p-b');
    await expect(signedInPage.locator('#vNotes')).toHaveValue('keep me');

    await signedInPage.click('#starPick span[data-n="4"]');
    await signedInPage.click('#wrYes');
    await signedInPage.click('#saveLog');
    await expect(signedInPage.locator('.visit-item').first()).toContainText('Reviewer B');
    // Switching here also makes B the active reviewer going forward.
    expect(await signedInPage.evaluate(() => activeProfileId)).toBe('p-b');
  });

  test('cancel returns to the listing without saving anything', async ({ browser, signedInPage }) => {
    const r = await arrangeListing(browser, 'lv-cancel');
    await openLogVisit(signedInPage, r);
    await signedInPage.click('#cancelLog');
    await expect(signedInPage.locator('.modal .detail-name')).toBeVisible();
    await expect(signedInPage.locator('.no-visits')).toBeVisible();
  });
});

// Element whose content is wider than its own box (the calendar bug: seven
// day columns ~122px each inside a ~444px window).
const overflowing = (page, selector) => page.locator(selector).evaluate((el) => el.scrollWidth - el.clientWidth);

test.describe('Log a Visit: layout', () => {
  test('desktop: two columns, the calendar always shown, and all seven days fit inside it', async ({ browser, signedInPage }) => {
    const r = await arrangeListing(browser, 'lv-desktop');
    await openLogVisit(signedInPage, r);
    await expect(signedInPage.locator('#miniCal')).toBeVisible(); // no click needed
    expect(await overflowing(signedInPage, '#calGrid')).toBeLessThanOrEqual(1);
    const calBox = await signedInPage.locator('#miniCal').boundingBox();
    const lastDay = await signedInPage.locator('#calGrid .cal-dow').nth(6).boundingBox();
    expect(lastDay.x + lastDay.width).toBeLessThanOrEqual(calBox.x + calBox.width);
    // The blank cells before the 1st are the same height as real days (they
    // once picked up the padded "No listings" style and made a giant row).
    const dayHeight = (await signedInPage.locator('#calGrid button.cal-cell').first().boundingBox()).height;
    for (const blank of await signedInPage.locator('#calGrid .cal-blank').all()) {
      expect(Math.abs((await blank.boundingBox()).height - dayHeight)).toBeLessThanOrEqual(1);
    }
    // The menu checklist sits in its own column beside the date.
    const date = await signedInPage.locator('.log-date').boundingBox();
    const ate = await signedInPage.locator('.log-ate').boundingBox();
    expect(ate.x).toBeGreaterThan(date.x + date.width - 1);
    expect((await signedInPage.locator('.log-modal').boundingBox()).width).toBeGreaterThan(800);
  });

  test('phone: one column; the calendar fits and a big menu stays inside the screen', async ({ browser }) => {
    const bigMenu = Array.from({ length: 45 }, (_, i) => `Phone Probe Dish Number ${i + 1}`);
    const r = await arrangeListing(browser, 'lv-phone', { menu: bigMenu });
    const page = await openSignedInPage(browser, { contextOptions: { viewport: { width: 390, height: 844 } } });
    try {
      await openLogVisit(page, r);
      await expect(page.locator('#miniCal')).toBeHidden(); // tap to open on phones
      await page.click('#dateDisplay');
      await expect(page.locator('#miniCal')).toBeVisible();
      expect(await overflowing(page, '#calGrid')).toBeLessThanOrEqual(1);
      // 45 dishes would be three columns on desktop — two on a phone, all tappable.
      expect(await overflowing(page, '.dish-checklist')).toBeLessThanOrEqual(1);
      const right = await page.locator('.dish-check').nth(1).evaluate((el) => el.getBoundingClientRect().right);
      expect(right).toBeLessThanOrEqual(390);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    } finally {
      await closeSession(page);
    }
  });
});

test.describe('Log a Visit: date', () => {
  // Regression: "today" came from toISOString() (UTC), so after 7pm in
  // Chicago the visit defaulted to tomorrow's date.
  test("defaults to today's date where the visitor is, even late in the evening", async ({ browser }) => {
    const r = await arrangeListing(browser, 'lv-evening');
    const page = await openSignedInPage(browser, {
      contextOptions: { timezoneId: 'America/Chicago' },
      // 10:30pm Oct 21 in Chicago = 03:30 Oct 22 UTC.
      contextSetup: (ctx) => ctx.clock.setFixedTime(new Date('2026-10-22T03:30:00Z')),
    });
    try {
      await openLogVisit(page, r);
      await expect(page.locator('#dateDisplay')).toHaveText('Oct 21, 2026');
      await expect(page.locator('#calGrid .cal-cell.today')).toHaveAttribute('data-date', '2026-10-21');
    } finally {
      await closeSession(page);
    }
  });
});
