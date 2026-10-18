const { test, expect, openOwnerPage } = require('../fixtures/app-fixture');
const { waitForAppReady } = require('../fixtures/ledger-helpers');
const { clearFirestore, clearAuthUsers } = require('../fixtures/emulator-admin');

// The owner-session boot sequence runs a chain of one-time-feeling but
// unconditionally-every-load migrations (migrateCategories, seedIfNeeded,
// enrichAddresses, renameCuisineTags, etc. — see app.js's init()). Each is
// written to be idempotent ("safe to re-run — no-op once already done"),
// but nothing had ever actually verified that claim. This test seeds a
// real owner session from an empty emulator Firestore (so seedIfNeeded
// really does seed the full real data/address-lookup.js dataset, exactly
// like production), then reloads the same session and confirms the
// migration chain running a second time doesn't change anything — no
// duplicate restaurants, no duplicate category tags.
test.describe('Boot sequence / migration chain idempotency', () => {
  test.beforeAll(async () => {
    await clearFirestore();
    await clearAuthUsers();
  });

  // This test writes the full real seed dataset into the shared emulator;
  // every other spec file reads that same Firestore (guest sessions load
  // shared.restaurants wholesale) and asserts exact counts against small
  // injected probe sets, so leaving it behind would break them.
  test.afterAll(async () => {
    await clearFirestore();
  });

  test('re-running the migration chain on reload produces no duplicates', async ({ browser }) => {
    // openOwnerPage navigates *then* signs in via the form — so the page's
    // very first boot (app.js's init() IIFE, which only ever runs once per
    // navigation) happens while still unauthenticated, and owner is false:
    // migrations correctly skip that first boot entirely. The first boot
    // that actually runs as the owner is the *next* one, once Firebase's
    // persisted session (browserLocalPersistence) makes auth.currentUser
    // available from the start — i.e. one reload after signing in.
    const ownerPage = await openOwnerPage(browser);
    await ownerPage.reload();
    await waitForAppReady(ownerPage);

    const firstLoadSnapshot = await ownerPage.evaluate(() => ({
      count: restaurants.length,
      // A cheap signature that would change if seedIfNeeded/enrichAddresses
      // ran a second time and mutated categories/addresses rather than
      // no-op'ing — not just a count, which duplicates would also inflate,
      // but mutation-without-duplication wouldn't.
      categoryTagTotal: restaurants.reduce((sum, r) => sum + (r.categories || []).length, 0),
    }));
    expect(firstLoadSnapshot.count).toBeGreaterThan(0);

    // Second owner-authenticated boot — re-runs app.js's entire init()
    // chain, including every migration, against the Firestore data the
    // first owner boot just wrote.
    await ownerPage.reload();
    await waitForAppReady(ownerPage);

    const secondLoadSnapshot = await ownerPage.evaluate(() => ({
      count: restaurants.length,
      categoryTagTotal: restaurants.reduce((sum, r) => sum + (r.categories || []).length, 0),
    }));

    expect(secondLoadSnapshot.count).toBe(firstLoadSnapshot.count);
    expect(secondLoadSnapshot.categoryTagTotal).toBe(firstLoadSnapshot.categoryTagTotal);

    // Also confirm no restaurant name appears twice — the specific shape a
    // seedIfNeeded regression (re-adding already-seeded entries) would take.
    const nameCounts = await ownerPage.evaluate(() => {
      const counts = {};
      restaurants.forEach((r) => {
        const key = r.name.toLowerCase();
        counts[key] = (counts[key] || 0) + 1;
      });
      return Object.values(counts).filter((c) => c > 1).length;
    });
    expect(nameCounts).toBe(0);

    await ownerPage.context().close();
  });
});
