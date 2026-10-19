const base = require('@playwright/test');
const { createOwnerTestUser, createRegularTestUser } = require('./auth-helpers');
const { waitForAppReady } = require('./ledger-helpers');

async function signInViaForm(page, { email, password }) {
  await page.fill('#authEmail', email);
  await page.fill('#authPassword', password);
  await page.click('#authSubmitBtn');
  await page.waitForSelector('.wrap:not([style*="display: none"])');
}

// Navigates a fresh page to the app with emulators + test hooks wired up,
// and waits for app.js's own async init chain to settle. Takes a
// BrowserContext (not just `page`) so a single test can open more than one
// independent signed-in session at once (see openOwnerPage/openSignedInPage
// below) — Playwright's per-test `page` fixture only ever gives you one.
async function openAppPage(context) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__ROUNDS_TEST__ = { useEmulators: true };
    if ('serviceWorker' in navigator) {
      Object.defineProperty(navigator.serviceWorker, 'register', {
        value: () => Promise.reject(new Error('disabled in tests')),
      });
    }
    window.addEventListener('rounds-app-ready', () => {
      window.__roundsAppReady = true;
    });
    window.addEventListener('rounds-boot-settled', () => {
      window.__roundsBootSettled = true;
    });
  });
  await page.goto('/index.html');
  // app.js's own async init chain (data load -> Firebase wait -> shared-
  // ledger watcher resolution -> sharedLedgerReady=true -> applyHash) runs
  // independently of the auth-gate UI, so this is safe to wait for before
  // any sign-in/guest interaction. Without it, canWriteLedger()/
  // canManageListings()-gated UI (e.g. #logVisitBtn) can render based on a
  // not-yet-true sharedLedgerReady immediately after sign-in — a real race
  // reproduced directly, not a hypothetical one.
  await waitForAppReady(page);
  return page;
}

async function openGuestPage(context) {
  const page = await openAppPage(context);
  await page.click('#authGuestLink');
  await page.waitForSelector('.wrap:not([style*="display: none"])');
  return page;
}

// Real sign-in via the Auth Emulator as a session whose uid is literally
// OWNER_UID (see auth-helpers.js) — isOwner() and firestore.rules both just
// work, unmodified. Takes `browser` (not a context/page) so callers that
// need a second, fully independent owner session in the same test (its own
// context, not sharing cookies/storage with another page) can just call
// this again.
// `contextSetup(context)` runs before the first navigation — the place to
// install init scripts (e.g. the Google Places mock, which must be defined
// before index.html's Maps bootstrap loader runs) or grant permissions.
// `creds` signs in as a specific existing user instead of a fresh one
// (e.g. the same account on two "devices").
async function openOwnerPage(browser, { contextSetup } = {}) {
  const context = await browser.newContext();
  if (contextSetup) await contextSetup(context);
  const page = await openAppPage(context);
  await signInViaForm(page, await createOwnerTestUser());
  return page;
}

async function openSignedInPage(browser, { contextSetup, creds } = {}) {
  const context = await browser.newContext();
  if (contextSetup) await contextSetup(context);
  const page = await openAppPage(context);
  await signInViaForm(page, creds || await createRegularTestUser());
  return page;
}

const test = base.test.extend({
  // A fresh page with the app loaded, service worker disabled (removes
  // cache-staleness as a source of flakiness entirely, rather than relying
  // on bumping CACHE_NAME or Playwright's fresh-context default), emulators
  // wired, and app.js's init chain already settled.
  appPage: async ({ context }, use) => {
    await use(await openAppPage(context));
  },

  // appPage, already past the auth gate via guest mode.
  guestPage: async ({ context }, use) => {
    await use(await openGuestPage(context));
  },

  // guestPage, already navigated past the neighborhoods landing page into
  // the searchable grid/map view — the single most important documented
  // gotcha for this app (it does NOT land on the list view by default).
  listingsPage: async ({ guestPage }, use) => {
    await guestPage.click('#browseAllBtn');
    await guestPage.waitForSelector('#content:not(.loading)');
    await use(guestPage);
  },

  // A fresh owner session. A test that also needs a second, independent
  // signed-in session (e.g. owner creates a listing, a different non-owner
  // views it) should use openOwnerPage/openSignedInPage(browser) directly
  // instead of combining two of these page-level fixtures — they all
  // resolve through the same single `page`/`context` fixture per test, so
  // requesting two in one test tries to sign in twice on an already-
  // signed-in page (reproduced directly, not hypothetical).
  // These open their own context (not Playwright's per-test one), so they
  // must close it themselves — otherwise every test leaves a page with live
  // Firestore listeners running against the shared emulator.
  ownerPage: async ({ browser }, use) => {
    const page = await openOwnerPage(browser);
    await use(page);
    await page.context().close();
  },

  // A fresh ordinary (non-owner) signed-in session. Same one-per-test
  // caveat as ownerPage above.
  signedInPage: async ({ browser }, use) => {
    const page = await openSignedInPage(browser);
    await use(page);
    await page.context().close();
  },
});

module.exports = { test, expect: base.expect, signInViaForm, openAppPage, openGuestPage, openOwnerPage, openSignedInPage };
