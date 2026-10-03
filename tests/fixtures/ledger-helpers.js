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

async function injectRestaurants(page, list) {
  await page.evaluate((list) => {
    restaurants.push(...list);
    saveRestaurants();
    renderAll();
  }, list);
}

async function injectVisits(page, list) {
  await page.evaluate((list) => {
    visits.push(...list);
    saveRestaurants();
    renderAll();
  }, list);
}

// Removes only the named probe ids, leaving any real/pre-existing data
// (e.g. from a shared emulator/localStorage state) untouched.
async function resetLedger(page, { restaurantIds = [], visitIds = [] } = {}) {
  await page.evaluate(({ restaurantIds, visitIds }) => {
    restaurants = restaurants.filter((r) => !restaurantIds.includes(r.id));
    visits = visits.filter((v) => !visitIds.includes(v.id));
    saveRestaurants();
    renderAll();
  }, { restaurantIds, visitIds });
}

module.exports = { waitForAppReady, injectRestaurants, injectVisits, resetLedger };
