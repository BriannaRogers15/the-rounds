const { test, expect } = require('../fixtures/app-fixture');
const { injectRestaurants, resetLedger } = require('../fixtures/ledger-helpers');
const { probeRestaurants } = require('../fixtures/seed-data');

// Sign-up/sign-in/sign-out, password reset, persistence, and the
// owner-vs-signed-in-non-owner distinction all need the Firebase Auth
// Emulator wired for real sign-in (Phase 2) — this file covers the
// zero-backend guest-mode access tier, which is a pure client-side flag.

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

  test('Restore backup is hidden for guests; Export backup is not', async ({ guestPage }) => {
    await expect(guestPage.locator('#importBtn')).toHaveCount(0);
    await expect(guestPage.locator('#exportBtn')).toBeVisible();
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
