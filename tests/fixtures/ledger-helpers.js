// Wrappers around the app's only test hook: page.evaluate into page-global
// state. restaurants/visits/profiles are top-level `let` bindings in app.js
// (a classic, non-module script) and do NOT attach to `window` — but
// saveRestaurants/renderAll/openDetail/openAddRestaurant are top-level
// function declarations, which do. Playwright's page.evaluate callback runs
// in that same global lexical scope, so bare identifiers work for both.
// (Confirmed by reading app.js; see tests/README.md.)

// Waits for the 'rounds-app-ready' event (dispatched once in app.js's boot
// sequence, right after applyHash()). Requires app-fixture.js's
// addInitScript to have already registered the window.__roundsAppReady
// flag-setting listener before navigation, so this is race-safe regardless
// of how fast the app boots relative to when this is called.
async function waitForAppReady(page) {
  await page.waitForFunction(() => window.__roundsAppReady === true, null, { timeout: 15000 });
}

// Waits for 'rounds-boot-settled': boundary data loaded and, on a boot that
// started signed in as the owner, the background neighborhood writes
// finished. Use before reloading or closing such a page — doing either
// mid-write leaves the shared emulator stalled for the next test.
async function waitForBootSettled(page) {
  await page.waitForFunction(() => window.__roundsBootSettled === true, null, { timeout: 30000 });
}

// The saves are awaited: for a signed-in session they sync to Firestore,
// and a write still in flight when the test ends (page closes mid-write)
// can leave the shared emulator in a bad state for the next test. For guest
// sessions persistSharedLedger() returns immediately, so this costs nothing.
async function injectRestaurants(page, list) {
  await page.evaluate(async (list) => {
    restaurants.push(...list);
    await saveRestaurants();
    renderAll();
  }, list);
}

async function injectVisits(page, list) {
  await page.evaluate(async (list) => {
    visits.push(...list);
    await saveVisits();
    renderAll();
  }, list);
}

// Removes only the named probe ids, leaving any real/pre-existing data
// (e.g. from a shared emulator/localStorage state) untouched.
async function resetLedger(page, { restaurantIds = [], visitIds = [] } = {}) {
  await page.evaluate(async ({ restaurantIds, visitIds }) => {
    restaurants = restaurants.filter((r) => !restaurantIds.includes(r.id));
    visits = visits.filter((v) => !visitIds.includes(v.id) && !restaurantIds.includes(v.restaurantId));
    await saveRestaurants();
    await saveVisits();
    renderAll();
  }, { restaurantIds, visitIds });
}

module.exports = { waitForAppReady, waitForBootSettled, injectRestaurants, injectVisits, resetLedger };
