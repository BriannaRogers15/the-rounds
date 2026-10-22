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
  try {
    await page.waitForFunction(() => window.__roundsAppReady === true, null, { timeout: 15000 });
  } catch (error) {
    throw new Error(`${error.message}\n${await describeBootState(page)}`);
  }
}

// When the app never reports ready, say how far its startup got (and what
// it logged) instead of a bare timeout — see openAppPage's console capture.
async function describeBootState(page) {
  let state;
  try {
    state = await page.evaluate(() => ({
      readyState: document.readyState,
      firebaseLoaded: !!window.RoundsFirebase,
      signedInUid: window.RoundsFirebase?.auth?.currentUser?.uid ?? null,
      dataLoaded: typeof dataLoaded !== 'undefined' ? dataLoaded : 'n/a',
      sharedLedgerReady: typeof sharedLedgerReady !== 'undefined' ? sharedLedgerReady : 'n/a',
      ledgerStatus: typeof sharedLedgerStatus !== 'undefined' ? sharedLedgerStatus : 'n/a',
      restaurants: typeof restaurants !== 'undefined' ? restaurants.length : 'n/a',
    }));
  } catch (e) {
    state = { evaluateFailed: e.message };
  }
  try {
    state.authStateReady = await page.evaluate(() => Promise.race([
      window.RoundsFirebase.authStateReady.then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('still pending'), 1000)),
    ]));
  } catch (e) { state.authStateReady = `probe failed: ${e.message}`; }
  // Is the emulator itself answering? (Node side, bypassing the page.)
  const t0 = Date.now();
  try {
    const res = await fetch('http://127.0.0.1:8080/v1/projects/the-rounds-fc02a/databases/(default)/documents/restaurants?pageSize=1', { signal: AbortSignal.timeout(5000) });
    state.emulatorRest = `${res.status} in ${Date.now() - t0}ms`;
  } catch (e) { state.emulatorRest = `failed after ${Date.now() - t0}ms: ${e.message}`; }
  const logs = (page.__roundsConsole || []).slice(-15).join('\n  ');
  return `Boot state: ${JSON.stringify(state)}\nLast console messages:\n  ${logs || '(none)'}`;
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

// Opens a listing's detail modal reliably even on a big, live grid. Owner
// sessions load the full curated dataset, and the grid re-renders on every
// Firestore snapshot, so a card can move between being located and being
// clicked — the click then lands on whatever is there (e.g. another card's
// address link, which opens Google Maps in a new tab). Searching for the
// name first leaves a single, stationary card; clicking its meta row avoids
// the name/address links inside the card.
async function openListingDetail(page, id) {
  if (!(await page.locator('#listingsLayout').isVisible())) await page.click('#browseAllBtn');
  // On a non-owner page the listing may still be arriving via snapshot.
  await page.waitForFunction((id) => restaurants.some((r) => r.id === id), id);
  const name = await page.evaluate((id) => restaurants.find((r) => r.id === id).name, id);
  await page.fill('#searchBox', name);
  await page.locator(`.ticket[data-id="${id}"] .ticket-meta`).click();
  await page.locator('.modal .detail-name').waitFor();
}

module.exports = { waitForAppReady, waitForBootSettled, injectRestaurants, injectVisits, resetLedger, openListingDetail };
