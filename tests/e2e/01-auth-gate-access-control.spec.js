const { test, expect, openOwnerPage, closeSession } = require('../fixtures/app-fixture');
const { injectRestaurants, resetLedger, openListingDetail } = require('../fixtures/ledger-helpers');
const { probeRestaurants } = require('../fixtures/seed-data');
const { createRegularTestUser, randomTestEmail } = require('../fixtures/auth-helpers');
const { clearFirestore, clearAuthUsers } = require('../fixtures/emulator-admin');

// Guest mode is the zero-backend access tier, covered below with no
// Firebase dependency beyond what every test needs to clear the loading
// screen. Everything requiring real sign-in is further down (Phase 2).

// One clean slate for the whole file, not per-test: createOwnerTestUser/
// createRegularTestUser already use unique emails+uids per call, so
// per-test clearing isn't needed for isolation and was previously measured
// to add ~28 minutes of pure overhead for no isolation benefit — the real
// bug that looked like a contention/accumulation issue was actually
// accounts:batchCreate silently failing (see auth-helpers.js), unrelated
// to leftover state.
test.beforeAll(async () => {
  await clearFirestore();
  await clearAuthUsers();
});
// Owner sessions seed the full curated dataset into the shared emulator;
// guest-only specs assert exact card counts, so don't leave it behind.
test.afterAll(async () => { await clearFirestore(); });

test.describe('Access control: guest mode', () => {
  test('entering guest mode shows the read-only notice and hides owner-only controls', async ({ guestPage }) => {
    await expect(guestPage.locator('#guestNotice')).toBeVisible();
    await expect(guestPage.locator('#guestNotice')).toContainText('read only');
    await expect(guestPage.locator('body')).toHaveClass(/guest-mode/);
    await expect(guestPage.locator('#profileBtn')).toBeHidden();
  });

  test('"Sign in" in the guest notice returns to the auth gate', async ({ guestPage }) => {
    await guestPage.click('#guestSignInBtn');
    await expect(guestPage.locator('#authGate')).toBeVisible();
    await expect(guestPage.locator('.wrap')).toBeHidden();
  });

  test('Add Listing is hidden for guests, both on the areas page and in listings', async ({ guestPage }) => {
    await expect(guestPage.locator('#addFromAreas')).toHaveCount(0);
    await guestPage.click('#browseAllBtn');
    await expect(guestPage.locator('#addRestaurantBtn')).toBeHidden();
  });

  // Backup/restore was retired: everything lives in the shared ledger, and
  // a restore would have tried to replace it wholesale.
  test('there are no backup export/restore controls', async ({ guestPage }) => {
    await expect(guestPage.locator('#ledgerStatus')).toBeVisible();
    await expect(guestPage.locator('#importBtn, #exportBtn, #importFile')).toHaveCount(0);
  });

  test('a guest can open a listing\'s detail modal but sees no Log Visit or Delete Listing buttons', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.locator(`.ticket[data-id="${probes[0].id}"]`).click();
      await expect(listingsPage.locator('.modal .detail-name')).toContainText(probes[0].name);
      await expect(listingsPage.locator('#logVisitBtn')).toHaveCount(0);
      await expect(listingsPage.locator('#deleteRestBtn')).toHaveCount(0);
      // Read access still works: menu section renders regardless.
      await expect(listingsPage.locator('.menu-section')).toBeVisible();
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });

  test('a guest cannot edit tags on a listing (no add-tag input in the tag row)', async ({ listingsPage }) => {
    const probes = probeRestaurants();
    await injectRestaurants(listingsPage, probes);
    try {
      await listingsPage.locator(`.ticket[data-id="${probes[0].id}"]`).click();
      await expect(listingsPage.locator('#newTag')).toHaveCount(0);
      await expect(listingsPage.locator('.tag-pill .tag-x')).toHaveCount(0);
    } finally {
      await resetLedger(listingsPage, { restaurantIds: probes.map((r) => r.id) });
    }
  });
});

test.describe('Access control: signed-in owner (smoke check)', () => {
  test('signing in as the owner test user is actually recognized as owner', async ({ ownerPage }) => {
    const isOwner = await ownerPage.evaluate(() => window.RoundsFirebase.isOwner());
    expect(isOwner).toBe(true);
    await expect(ownerPage.locator('#addFromAreas')).toBeVisible();
  });
});

test.describe('Sign-up / sign-in / sign-out', () => {
  test('sign-up creates an account and shows the signed-in chip with the chosen name', async ({ appPage }) => {
    await appPage.click('#authModeToggle'); // switch to signup mode
    const email = randomTestEmail('signup');
    await appPage.fill('#authEmail', email);
    await appPage.fill('#authPassword', 'testpass123');
    await appPage.fill('#authName', 'Test Signup User');
    await appPage.click('#authSubmitBtn');
    await appPage.waitForSelector('.signed-in-chip');
    await expect(appPage.locator('.signed-in-chip')).toContainText('Test Signup User');
    await expect(appPage.locator('.wrap')).toBeVisible();
  });

  test('signing in with the wrong password shows a friendly error, not a raw Firebase error', async ({ appPage }) => {
    const { email } = await createRegularTestUser({ password: 'correct-password' });
    await appPage.fill('#authEmail', email);
    await appPage.fill('#authPassword', 'definitely-wrong');
    await appPage.click('#authSubmitBtn');
    const error = appPage.locator('#authError');
    await expect(error).toBeVisible();
    const text = await error.textContent();
    expect(['Wrong password.', 'Email or password is wrong.']).toContain(text.trim());
  });

  test('signing out returns to the auth gate', async ({ signedInPage }) => {
    await signedInPage.click('#authSignOutBtn');
    await expect(signedInPage.locator('#authGate')).toBeVisible();
    await expect(signedInPage.locator('.wrap')).toBeHidden();
  });

  test('requesting a password reset shows a confirmation message', async ({ appPage }) => {
    const { email } = await createRegularTestUser();
    await appPage.fill('#authEmail', email);
    await appPage.click('#authForgotLink');
    await expect(appPage.locator('#authError')).toContainText('reset email sent');
  });

  test('renaming via the signed-in chip updates the displayed name', async ({ signedInPage }) => {
    signedInPage.once('dialog', (dialog) => dialog.accept('New Display Name'));
    await signedInPage.click('#authRenameBtn');
    await expect(signedInPage.locator('.signed-in-chip')).toContainText('New Display Name');
  });

  test('canceling the rename prompt leaves the name unchanged', async ({ signedInPage }) => {
    const before = await signedInPage.locator('.signed-in-chip').textContent();
    signedInPage.once('dialog', (dialog) => dialog.dismiss());
    await signedInPage.click('#authRenameBtn');
    await expect(signedInPage.locator('.signed-in-chip')).toHaveText(before);
  });
});

test.describe('Access control: owner vs. signed-in non-owner', () => {
  // ownerPage and signedInPage both resolve through the same underlying
  // `page` fixture, so a single test can't request both — the second
  // sign-in attempt would run on a page whose auth gate the first sign-in
  // already dismissed. Split into independent single-session tests instead.
  test('owner sees Add Listing controls', async ({ ownerPage }) => {
    await expect(ownerPage.locator('#addFromAreas')).toBeVisible();
  });

  test('a non-owner does not see Add Listing controls', async ({ signedInPage }) => {
    await expect(signedInPage.locator('#addFromAreas')).toHaveCount(0);
  });

  test('not even the owner gets backup export/restore controls', async ({ ownerPage }) => {
    await expect(ownerPage.locator('#ledgerStatus')).toBeVisible();
    await expect(ownerPage.locator('#importBtn, #exportBtn, #importFile')).toHaveCount(0);
  });

  test('a non-owner can log a visit but cannot edit listing tags or delete the listing', async ({ browser, signedInPage }) => {
    // firestore.rules only allows the owner to create restaurants — a
    // non-owner session writing one via saveRestaurants() gets rejected
    // (reproduced directly: the rejected write left the emulator in a bad
    // state that stalled the *next* test, not just this one). Create it
    // for real via an owner session, then view/interact as a non-owner,
    // same as the real app would actually be used.
    const probe = { id: 'probe-nonowner-1', name: 'Probe Nonowner Place', categories: ['American'], address: 'Chicago, IL', createdAt: Date.now() };
    const ownerPage = await openOwnerPage(browser);
    await injectRestaurants(ownerPage, [probe]);
    try {
      await openListingDetail(signedInPage, probe.id);
      await expect(signedInPage.locator('#logVisitBtn')).toBeVisible();
      await expect(signedInPage.locator('#deleteRestBtn')).toHaveCount(0);
      await expect(signedInPage.locator('#newTag')).toHaveCount(0);
    } finally {
      await resetLedger(ownerPage, { restaurantIds: [probe.id] }); // only the owner can delete
      await closeSession(ownerPage);
    }
  });

  test('the owner can edit listing tags and delete a listing', async ({ ownerPage }) => {
    const probe = { id: 'probe-owner-1', name: 'Probe Owner Place', categories: ['American'], address: 'Chicago, IL', createdAt: Date.now() };
    await injectRestaurants(ownerPage, [probe]);
    try {
      await openListingDetail(ownerPage, probe.id);
      await expect(ownerPage.locator('#newTag')).toBeVisible();
      await expect(ownerPage.locator('#deleteRestBtn')).toBeVisible();
    } finally {
      await resetLedger(ownerPage, { restaurantIds: [probe.id] });
    }
  });
});
