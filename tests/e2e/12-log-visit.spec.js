const { test, expect, openOwnerPage, openSignedInPage, closeSession } = require('../fixtures/app-fixture');
const { injectRestaurants, openListingDetail } = require('../fixtures/ledger-helpers');
const { getDoc } = require('../fixtures/firestore-seed');
const { createRegularTestUser } = require('../fixtures/auth-helpers');
const { clearFirestore } = require('../fixtures/emulator-admin');
const { pickStars } = require('../fixtures/stars');

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
  test('a rating and would-go-back are each required', async ({ browser, signedInPage }) => {
    const r = await arrangeListing(browser, 'lv-validate');
    const dialogs = captureDialogs(signedInPage);
    await openLogVisit(signedInPage, r);

    await signedInPage.click('#saveLog');
    expect(dialogs.at(-1)).toBe('Pick a rating.');

    await pickStars(signedInPage.locator('#starPick'), 3);
    await signedInPage.click('#saveLog');
    expect(dialogs.at(-1)).toContain("if you'd go back");

    await signedInPage.click('#wrNo');
    await signedInPage.click('#saveLog');
    await expect(signedInPage.locator('.visit-item')).toHaveCount(1); // now it saves
    await signedInPage.evaluate(async (id) => { visits = visits.filter((v) => v.restaurantId !== id); await saveVisits(); }, r.id);

    expect(await signedInPage.evaluate((id) => visits.filter((v) => v.restaurantId === id).length, r.id)).toBe(0);
  });
});

test.describe('Log a Visit: saving', () => {
  test('a full visit saves everything under your username and adds a new dish to the menu', async ({ browser }) => {
    const r = await arrangeListing(browser, 'lv-full');
    const creds = await createRegularTestUser({ username: 'probe_reviewer', displayName: 'My Private Name' });
    const signedInPage = await openSignedInPage(browser, { creds });
    try {
      await openLogVisit(signedInPage, r);
      await expect(signedInPage.locator('.logged-by')).toContainText('Logging as probe_reviewer');
      await signedInPage.locator('.dish-check input[data-dish="Cheese Slice"]').check();
      await signedInPage.fill('#vAte', 'Garlic Knots'); // not on the menu yet
      await pickStars(signedInPage.locator('#starPick'), 4);
      await signedInPage.click('#wrYes');
      await signedInPage.fill('#vNotes', 'Ask for extra crispy.');

      // Pick the 15th of the previous month from the calendar.
      await signedInPage.click('#dateDisplay');
      await signedInPage.click('#calPrev');
      const day15 = signedInPage.locator('#calGrid .cal-cell:not(.cal-blank)').nth(14);
      const chosenDate = await day15.getAttribute('data-date');
      await day15.click();

      await signedInPage.click('#saveLog');

      // Back on the detail modal, showing the new visit — under the public
      // username, never the private display name.
      const item = signedInPage.locator('.visit-item').first();
      await expect(item.locator('.visit-who')).toHaveText('probe_reviewer');
      await expect(item).not.toContainText('My Private Name');
      await expect(item).toContainText('Ate Cheese Slice, Garlic Knots');
      await expect(item.locator('.return-pill')).toHaveText('Would go back');
      await expect(item).toContainText('Review Ask for extra crispy.');
      await expect(signedInPage.locator('#menuChips')).toContainText('Garlic Knots');

      const uid = await signedInPage.evaluate(() => window.RoundsFirebase.auth.currentUser.uid);
      const saved = await signedInPage.evaluate((id) => visits.find((v) => v.restaurantId === id), r.id);
      expect(saved).toMatchObject({ rating: 4, wouldReturn: true, date: chosenDate, reviewer: 'probe_reviewer', authorUid: uid });
      await expect.poll(() => getDoc(`visits/${saved.id}`)).toMatchObject({ authorUid: uid, date: chosenDate });
      await expect.poll(async () => (await getDoc(`restaurants/${r.id}`))?.menu).toContain('Garlic Knots');
      // The pill shows the private display name.
      await expect(signedInPage.locator('.signed-in-chip')).toContainText('My Private Name');
    } finally {
      await closeSession(signedInPage);
    }
  });

  test('changing your username on Profile changes the name on all your reviews, for everyone', async ({ browser }) => {
    const r = await arrangeListing(browser, 'lv-rename');
    const page = await openSignedInPage(browser, { creds: await createRegularTestUser({ username: 'old_name_probe' }) });
    try {
      await openLogVisit(page, r);
      await pickStars(page.locator('#starPick'), 4);
      await page.click('#wrYes');
      await page.click('#saveLog');
      const visitId = await page.evaluate((id) => visits.find((v) => v.restaurantId === id).id, r.id);
      await expect(page.locator(`.visit-item[data-vid="${visitId}"] .visit-who`)).toHaveText('old_name_probe');

      await page.click('#closeDet');
      await page.click('#chipProfileLink');
      await page.fill('#profileUsername', 'new_name_probe');
      await expect(page.locator('#profileUsernameStatus')).toHaveText('new_name_probe is available');
      await page.click('#profileUsernameSave');
      await expect(page.locator('#profileUsernameStatus')).toContainText('Saved');
      const uid = await page.evaluate(() => window.RoundsFirebase.auth.currentUser.uid);
      await expect.poll(() => getDoc(`profiles/${uid}`)).toEqual({ username: 'new_name_probe' });
      // The old name is free again; the new one is reserved.
      await expect.poll(() => getDoc('usernames/old_name_probe')).toBeNull();
      await expect.poll(async () => (await getDoc('usernames/new_name_probe'))?.uid).toBe(uid);

      // Another person sees the new name on the review.
      const other = await openSignedInPage(browser);
      try {
        await openListingDetail(other, r.id);
        await expect(other.locator(`.visit-item[data-vid="${visitId}"] .visit-who`)).toHaveText('new_name_probe');
      } finally {
        await closeSession(other);
      }
    } finally {
      await closeSession(page);
    }
  });

  test('cancel returns to the listing without saving anything', async ({ browser, signedInPage }) => {
    const r = await arrangeListing(browser, 'lv-cancel');
    await openLogVisit(signedInPage, r);
    await signedInPage.click('#cancelLog');
    await expect(signedInPage.locator('.modal .detail-name')).toBeVisible();
    await expect(signedInPage.locator('.no-visits')).toBeVisible();
  });
});

test.describe('Log a Visit: each dish gets its own stars and changes', () => {
  test('rate a dish and note a change; it shows on the visit and the menu, and reaches the ledger', async ({ browser, signedInPage }) => {
    const r = await arrangeListing(browser, 'lv-dish');
    await openLogVisit(signedInPage, r);
    // Nothing to rate until the dish is checked.
    await expect(signedInPage.locator('.dish-detail')).toHaveCount(0);
    await signedInPage.locator('.dish-check input[data-dish="Cheese Slice"]').check();
    const detail = signedInPage.locator('.dish-pick[data-dish="Cheese Slice"] .dish-detail');
    await expect(detail).toBeVisible();
    await pickStars(detail.locator('.star-slider'), 5);
    await expect(detail.locator('.star-slider')).toHaveAttribute('aria-valuenow', '5');
    await detail.locator('.dish-mod').fill('extra crispy, no oregano');
    await signedInPage.locator('.dish-check input[data-dish="Pepperoni Pie"]').check(); // had it, didn't rate it
    await expect(signedInPage.locator('label[for="vNotes"]')).toContainText('Overall review');
    await signedInPage.fill('#vNotes', 'Great spot, slow on weekends.');
    await pickStars(signedInPage.locator('#starPick'), 4);
    await signedInPage.click('#wrYes');
    await signedInPage.click('#saveLog');

    const item = signedInPage.locator('.visit-item').first();
    const cheese = item.locator('.ate-list li', { hasText: 'Cheese Slice' });
    await expect(cheese.locator('.stars')).toHaveAttribute('aria-label', '5 out of 5 stars');
    await expect(cheese.locator('.ate-mod')).toHaveText('extra crispy, no oregano');
    await expect(item.locator('.ate-list li', { hasText: 'Pepperoni Pie' }).locator('.stars')).toHaveCount(0);
    await expect(item).toContainText('Review Great spot, slow on weekends.');
    // The menu averages the dish's own stars.
    // (It also leads "Group favorites" now; check its own section's row.)
    const row = signedInPage.locator('#menuChips .menu-group:not([data-section="Group favorites"]) .menu-row', { hasText: 'Cheese Slice' });
    await expect(row.locator('.dish-avg')).toHaveText('5.0★');
    await expect(row.locator('.ordered-badge')).toHaveText('ordered 1×');

    const saved = await signedInPage.evaluate((id) => visits.find((v) => v.restaurantId === id), r.id);
    expect(saved.dishDetails).toEqual([{ dish: 'Cheese Slice', rating: 5, mod: 'extra crispy, no oregano' }]);
    expect(saved.ate).toEqual(['Cheese Slice', 'Pepperoni Pie']);
    await expect.poll(async () => (await getDoc(`visits/${saved.id}`))?.dishDetails).toEqual(saved.dishDetails);
  });

  test('editing your own visit: it opens filled in, and changes save to the same visit', async ({ browser, signedInPage }) => {
    const r = await arrangeListing(browser, 'lv-edit');
    await openLogVisit(signedInPage, r);
    await signedInPage.locator('.dish-check input[data-dish="Cheese Slice"]').check();
    await pickStars(signedInPage.locator('.dish-pick[data-dish="Cheese Slice"] .star-slider'), 2);
    await pickStars(signedInPage.locator('#starPick'), 2);
    await signedInPage.click('#wrNo');
    await signedInPage.fill('#vNotes', 'First take.');
    await signedInPage.click('#saveLog');
    await expect(signedInPage.locator('.visit-item')).toHaveCount(1); // saved, back on the listing
    const before = await signedInPage.evaluate((id) => visits.filter((v) => v.restaurantId === id), r.id);
    expect(before).toHaveLength(1);

    await signedInPage.locator(`.visit-item[data-vid="${before[0].id}"] .visit-edit`).click();
    await expect(signedInPage.locator('#logTitle')).toContainText('Edit visit');
    await expect(signedInPage.locator('#vNotes')).toHaveValue('First take.');
    await expect(signedInPage.locator('#wrNo')).toHaveAttribute('aria-pressed', 'true');
    await expect(signedInPage.locator('#starPick')).toHaveAttribute('aria-valuenow', '2');
    await expect(signedInPage.locator('.dish-check input[data-dish="Cheese Slice"]')).toBeChecked();
    const dishStars = signedInPage.locator('.dish-pick[data-dish="Cheese Slice"] .star-slider');
    await expect(dishStars).toHaveAttribute('aria-valuenow', '2');
    // Tapping the same value again clears that dish's rating.
    await pickStars(dishStars, 2);
    await expect(dishStars).toHaveAttribute('aria-valuenow', '0');
    await pickStars(signedInPage.locator('#starPick'), 5);
    await signedInPage.click('#wrYes');
    await signedInPage.fill('#vNotes', 'Second visit was better.');
    await signedInPage.click('#saveLog');
    await expect(signedInPage.locator('.visit-item').first()).toContainText('Second visit was better.');

    const after = await signedInPage.evaluate((id) => visits.filter((v) => v.restaurantId === id), r.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before[0].id, rating: 5, wouldReturn: true, notes: 'Second visit was better.', dishDetails: [], createdAt: before[0].createdAt });
    await expect.poll(async () => (await getDoc(`visits/${before[0].id}`))?.notes).toBe('Second visit was better.');
    expect((await getDoc(`visits/${before[0].id}`)).dishDetails).toEqual([]);
  });
});

test.describe('Log a Visit: half stars', () => {
  test('pick a half star by its left half, nudge it with the keyboard, and see a real half star after saving', async ({ browser, signedInPage }) => {
    const r = await arrangeListing(browser, 'lv-half');
    await openLogVisit(signedInPage, r);
    const overall = signedInPage.locator('#starPick');
    await pickStars(overall, 3.5);
    await expect(overall).toHaveAttribute('aria-valuenow', '3.5');
    await expect(overall).toHaveAttribute('aria-valuetext', '3.5 stars');
    await expect(overall.locator('.st-half')).toHaveCount(1);
    await expect(overall.locator('.st-full')).toHaveCount(3);
    await expect(overall.locator('.ss-value')).toHaveText('3.5');
    // Keyboard and screen readers move it in half steps.
    await overall.focus();
    await signedInPage.keyboard.press('ArrowRight');
    await expect(overall).toHaveAttribute('aria-valuenow', '4');
    await signedInPage.keyboard.press('ArrowLeft');
    await signedInPage.keyboard.press('ArrowLeft');
    await expect(overall).toHaveAttribute('aria-valuenow', '3');
    await pickStars(overall, 4.5);
    // A dish gets half stars too.
    await signedInPage.locator('.dish-check input[data-dish="Cheese Slice"]').check();
    await pickStars(signedInPage.locator('.dish-pick[data-dish="Cheese Slice"] .star-slider'), 2.5);
    await signedInPage.click('#wrYes');
    await signedInPage.click('#saveLog');

    const item = signedInPage.locator('.visit-item').first();
    await expect(item.locator('.visit-top .stars')).toHaveAttribute('aria-label', '4.5 out of 5 stars');
    await expect(item.locator('.visit-top .stars .st-half')).toHaveCount(1);
    expect(await item.innerText()).not.toContain('½');
    await expect(signedInPage.locator('#menuChips .menu-row', { hasText: 'Cheese Slice' }).locator('.dish-avg')).toHaveText('2.5★');
    const saved = await signedInPage.evaluate((id) => visits.find((v) => v.restaurantId === id), r.id);
    expect(saved.rating).toBe(4.5);
    expect(saved.dishDetails).toEqual([{ dish: 'Cheese Slice', rating: 2.5 }]);
    // The shared ledger accepts half stars (rules allow 0.5 steps).
    await expect.poll(async () => (await getDoc(`visits/${saved.id}`))?.rating).toBe(4.5);
  });

  test('hovering over the stars changes nothing; only a click sets them', async ({ browser, signedInPage }) => {
    const r = await arrangeListing(browser, 'lv-hover');
    await openLogVisit(signedInPage, r);
    const overall = signedInPage.locator('#starPick');
    const box = await overall.locator('.ss-icons').boundingBox();
    for (const f of [0.1, 0.5, 0.9]) {
      await signedInPage.mouse.move(box.x + box.width * f, box.y + box.height / 2);
    }
    await expect(overall).toHaveAttribute('aria-valuenow', '0');
    await expect(overall.locator('.st-full, .st-half')).toHaveCount(0);
    await signedInPage.mouse.move(box.x - 40, box.y - 40); // and leaving changes nothing either
    await expect(overall.locator('.st-full, .st-half')).toHaveCount(0);
    await pickStars(overall, 4);
    await expect(overall).toHaveAttribute('aria-valuenow', '4');
    await signedInPage.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
    await expect(overall.locator('.st-full')).toHaveCount(4); // hovering after picking doesn't move it
  });

  test('phone: the star row spans the screen, each star is a big target, and dragging picks', async ({ browser }) => {
    const r = await arrangeListing(browser, 'lv-half-phone');
    const page = await openSignedInPage(browser, { contextOptions: { viewport: { width: 390, height: 844 }, hasTouch: true } });
    try {
      await openLogVisit(page, r);
      const icons = page.locator('#starPick .ss-icons');
      const box = await icons.boundingBox();
      expect(box.width).toBeGreaterThan(260);
      expect(box.height).toBeGreaterThanOrEqual(44);
      // Drag from the first star to the middle of the fourth: 3.5.
      await page.mouse.move(box.x + 5, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 5 });
      await page.mouse.move(box.x + box.width * 0.68, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      await expect(page.locator('#starPick')).toHaveAttribute('aria-valuenow', '3.5');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    } finally {
      await closeSession(page);
    }
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
      // A big menu stays inside the screen: one column of dishes, all tappable.
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
