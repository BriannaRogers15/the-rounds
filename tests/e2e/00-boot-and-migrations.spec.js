const { test, expect, openOwnerPage, openAppPage, signInViaForm, closeSession, closeContext } = require('../fixtures/app-fixture');
const { waitForAppReady, waitForBootSettled } = require('../fixtures/ledger-helpers');
const { clearFirestore, clearAuthUsers } = require('../fixtures/emulator-admin');
const { seedDoc, getDoc } = require('../fixtures/firestore-seed');
const { createOwnerTestUser, createRegularTestUser } = require('../fixtures/auth-helpers');

// The owner's startup (app.js init()) runs a chain of migrations —
// migrateCategories, seedIfNeeded, enrichAddresses, renameCuisineTags,
// seedCuratedMenus, assignAreas, … — then uploads to the shared ledger.
// It runs once per page load, only on a load that starts signed in as the
// owner; signing in as the owner later reloads the page once so it runs.
test.describe('Boot sequence / owner startup', () => {
  test.beforeAll(async () => {
    await clearFirestore();
    await clearAuthUsers();
  });

  // Every other spec reads the same Firestore and asserts exact counts
  // against small probe sets, so the seeded dataset must not linger.
  test.afterAll(async () => {
    await clearFirestore();
  });

  test('signing in as the owner reloads once and fills an empty shared ledger, no manual refresh', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await openAppPage(context);
      expect(await page.evaluate(() => restaurants.length)).toBe(0); // empty ledger, signed out

      const reloaded = page.waitForEvent('load');
      await signInViaForm(page, await createOwnerTestUser());
      await reloaded;
      await waitForAppReady(page);

      expect(await page.evaluate(() => bootedAsOwner)).toBe(true);
      expect(await page.evaluate(() => restaurants.length)).toBeGreaterThan(0);
      // Uploaded to the shared ledger, so friends and guests see it too.
      const sampleId = await page.evaluate(() => restaurants[0].id);
      await expect.poll(() => getDoc(`restaurants/${sampleId}`)).not.toBeNull();
      await waitForBootSettled(page);
    } finally {
      await closeContext(context);
    }
  });

  test('a non-owner signing in does not reload the page', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await openAppPage(context);
      let navigations = 0;
      page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });
      await signInViaForm(page, await createRegularTestUser());
      await expect(page.locator('.signed-in-chip')).toBeVisible();
      await page.waitForTimeout(1500); // a reload would have started by now
      expect(navigations).toBe(0);
    } finally {
      await closeContext(context);
    }
  });

  test('re-running the migration chain on reload produces no duplicates', async ({ browser }) => {
    const ownerPage = await openOwnerPage(browser); // already one owner boot in
    const signature = () => ownerPage.evaluate(() => ({
      count: restaurants.length,
      // Would also change if a migration mutated records again rather than
      // no-op'ing, not just if it duplicated them.
      categoryTagTotal: restaurants.reduce((sum, r) => sum + (r.categories || []).length, 0),
    }));
    try {
      const first = await signature();
      expect(first.count).toBeGreaterThan(0);

      await ownerPage.reload();
      await waitForAppReady(ownerPage);
      expect(await signature()).toEqual(first);

      const duplicateNames = await ownerPage.evaluate(() => {
        const counts = {};
        restaurants.forEach((r) => { const k = r.name.toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
        return Object.values(counts).filter((c) => c > 1).length;
      });
      expect(duplicateNames).toBe(0);
      await waitForBootSettled(ownerPage);
    } finally {
      await closeSession(ownerPage);
    }
  });

  // Regression: curated listings were stamped with the moment they were
  // seeded, so on the live site all 248 showed under "Recently Added" and
  // "Date Added" sorting did nothing. They now share one fixed curated date;
  // ones already uploaded with the seeding time get re-dated once.
  test('curated listings carry the fixed curated date, not the upload time — including already-uploaded ones', async ({ browser }) => {
    const ownerPage = await openOwnerPage(browser);
    try {
      const curatedName = await ownerPage.evaluate(() => SEED_RESTAURANTS[0].name);
      const id = await ownerPage.evaluate((n) => restaurants.find((r) => r.name === n).id, curatedName);
      // Simulate a curated listing uploaded before the fix: seeding-time
      // createdAt, no `seeded` marker.
      await seedDoc(`restaurants/${id}`, { ...(await getDoc(`restaurants/${id}`)), createdAt: Date.now(), seeded: null });
      await ownerPage.reload();
      await waitForAppReady(ownerPage);
      const CURATED = await ownerPage.evaluate(() => CURATED_ADDED_AT);
      await expect.poll(async () => (await getDoc(`restaurants/${id}`))?.createdAt).toBe(CURATED);
      expect((await getDoc(`restaurants/${id}`)).seeded).toBe(true);
      const recent = await ownerPage.evaluate(() => restaurants.filter((r) => Date.now() - r.createdAt < 30 * 864e5).length);
      expect(recent).toBe(0);
      await waitForBootSettled(ownerPage);
    } finally {
      await closeSession(ownerPage);
    }
  });

  // Regression: migrations edit existing records in place (assignAreas sets
  // r.town / r.region on the object). syncSharedLedger used to diff against
  // a cache holding those same objects, so in-place edits never reached
  // Firestore — every device saw the enrichment locally, none persisted it.
  test('migration edits to a listing that already exists in Firestore are persisted', async ({ browser }) => {
    await seedDoc('restaurants/legacy-probe', {
      id: 'legacy-probe', name: 'Legacy Probe', categories: ['American'],
      address: '1 Legacy St, Chicago, IL 60607', createdAt: 1,
    });
    const ownerPage = await openOwnerPage(browser);
    try {
      const local = await ownerPage.evaluate(() => restaurants.find((r) => r.id === 'legacy-probe'));
      expect(local).toMatchObject({ town: 'Chicago', region: 'Chicago' });
      await expect.poll(() => getDoc('restaurants/legacy-probe')).toMatchObject({ town: 'Chicago', region: 'Chicago' });
    } finally {
      await closeSession(ownerPage);
    }
  });
});
