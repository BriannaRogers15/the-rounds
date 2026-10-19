# The Rounds — automated test suite

Dev-only tooling. The app itself still has zero build step — this is an
optional test suite for verifying it, not a dependency of running it.

## Running

```bash
npm install
npm test              # everything (rules + e2e)
npm run test:e2e       # Playwright UI flows only
npm run test:e2e:ui    # same, with Playwright's interactive UI runner
npm run test:rules     # Firestore security rules only
npm run test:emulators # start the Firebase emulators standalone, with the
                        # inspector UI at http://127.0.0.1:4000, for manual
                        # poking/debugging
```

`npm test`/`npm run test:e2e` start the Firebase Auth + Firestore Emulators
automatically (see `tests/global-setup.js`) and serve the app via the same
`python3 -m http.server 8741` command documented in `.claude/skills/verify`.
Nothing talks to the real `the-rounds-fc02a` Firebase project. Requires a
JRE on the machine (the emulators are Java).

## Why every test needs the Auth Emulator, even "zero-backend" ones

`auth-gate.js` unconditionally waits for `window.RoundsFirebase` before
showing anything but "Loading…" (no timeout, no fallback — see
`auth-gate.js` near the bottom, `if(window.RoundsFirebase) init(); else
window.addEventListener('rounds-firebase-ready', init, {once:true});`).
That object only exists once `firebase-init.js` successfully initializes
Firebase Auth. So even pure guest-mode tests need *some* working Auth
backend just to get past the loading screen — there's no way to reach any
part of this app, including guest mode, without it. The Auth Emulator makes
that instant and offline instead of depending on live internet + Google's
servers.

**Known constraint: `workers: 1`.** All tests share one local Auth +
Firestore emulator pair. Guest-only tests tolerated 2 workers, but once real
sign-in and live Firestore listeners entered the picture, anything above 1
was unreliable. Serial is slower but genuinely stable (full suite ~1–2 min).
Don't "fix" stalls by raising timeouts.

**Known gotcha: use `page.goto(url-with-hash)`, not `location.hash = X` then
`.reload()`, for cold-load hash tests.** The latter was observed to lose the
hash fragment somewhere in Playwright's reload path when run through the
test runner (reproducible, though the exact mechanism wasn't pinned down —
likely interacts with the custom `webServer` + fixture setup). A fresh
`goto()` with the hash already in the target URL is also a more faithful
simulation of "someone opened a bookmarked link" anyway.

## Signed-in test gotchas (learned the hard way in Phase 2)

- **`accounts:batchCreate` fails silently.** It requires an explicit
  `localId` per user and reports per-user failures as an `error` array
  inside an HTTP **200** response. `res.ok` alone is not success — see
  `batchCreateUser()` in `fixtures/auth-helpers.js`.
- **The owner account is one fixed uid.** Every owner session targets the
  same `OWNER_UID`, so `createOwnerTestUser()` uses fixed credentials and
  tolerates "already exists" rather than racing to create it per test.
- **Non-owners can't create restaurants — and a rejected write poisons the
  next test.** `firestore.rules` blocks it (correctly). A signed-in
  non-owner calling `injectRestaurants()` triggers a real, rejected
  Firestore write that left the emulator degraded for the *following*
  test. Have the owner create listings (`openOwnerPage(browser)`), then
  view them as the non-owner. Guest pages never write, so they're exempt.
- **One page-level session fixture per test.** `ownerPage`/`signedInPage`
  each open their own browser context, but a test needing *two* sessions
  should call `openOwnerPage(browser)` / `openSignedInPage(browser)`
  directly rather than relying on fixture combinations.
- **Migrations only run on a boot that starts already signed in.**
  `app.js`'s `init()` runs once per navigation and checks `isOwner()` near
  the top. `openOwnerPage` loads the page *then* signs in, so that first
  boot runs as a non-owner. The first owner boot is the next reload — see
  `e2e/00-boot-and-migrations.spec.js`.
- **Always wait for `rounds-app-ready`.** `canWriteLedger()` depends on
  `sharedLedgerReady`, which only flips once the Firestore watcher
  resolves. `openAppPage()` waits for it so write-gated UI doesn't render
  off a stale `false`.

## Test hook mechanism

The app's only test seam is `page.evaluate` into page-global state.
`restaurants`/`visits`/`profiles` are top-level `let` bindings in app.js (a
classic, non-module script) and do **not** attach to `window` — but
`saveRestaurants`/`renderAll`/`openDetail`/`openAddRestaurant` etc. are
top-level function declarations, which do. `page.evaluate` callbacks run in
that same global lexical scope, so bare identifiers work for both. See
`tests/fixtures/ledger-helpers.js`.

`app.js` dispatches a `rounds-app-ready` event once its async boot sequence
(data load → Firebase wait → shared-ledger resolution → `applyHash()`)
fully settles — `tests/fixtures/ledger-helpers.js`'s `waitForAppReady()`
waits on this rather than guessing with a fixed delay. This matters because
`applyHash()` runs *after* the shared-ledger watcher's `ready` promise
resolves, which can take a few real seconds when the Firestore Emulator
isn't running yet (Phase 1) and Firestore's SDK falls back to serving an
empty offline-cache snapshot.

## Coverage by phase

**Phase 1 (done):** infra + zero-backend guest-mode tests. No signed-in
flows, no Firestore emulator (only Auth, and only because the auth gate
requires it to get past "Loading…").

| Feature | Spec file |
|---|---|
| Guest-mode access control | `e2e/01-auth-gate-access-control.spec.js` |
| Landing / neighborhoods page | `e2e/02-landing-areas.spec.js` |
| Area banner | `e2e/03-area-banner.spec.js` |
| Listings grid | `e2e/04-listings-grid.spec.js` |
| Map view (real Leaflet/OSM tiles) | `e2e/05-map-view.spec.js` |
| Search (incl. debounce) | `e2e/06-search.spec.js` |
| Sort: name/date/rating | `e2e/07-sort.spec.js` |
| Filter toggles | `e2e/08-filters.spec.js` |
| Guides/cuisine rail | `e2e/09-guides-rail.spec.js` |
| Menu system (read-only display) | `e2e/13-menu-system.spec.js` |
| URL hash routing | `e2e/16-hash-routing.spec.js` |
| View toggle persistence | `e2e/17-misc.spec.js` |

**Phase 2 (done):** Firestore Emulator wired in.

| Feature | Spec file |
|---|---|
| Sign-up, sign-in, wrong password, sign-out, password reset, rename | `e2e/01-auth-gate-access-control.spec.js` |
| Owner vs. signed-in non-owner UI gating | `e2e/01-auth-gate-access-control.spec.js` |
| Migration chain idempotency (owner boot, run twice) | `e2e/00-boot-and-migrations.spec.js` |

**Phase 3 (done):** Firestore security rules, run in Node (no browser) via
`@firebase/rules-unit-testing` against the real `firestore.rules`. 36
tests across `rules/users`, `rules/restaurants`, `rules/visits`. Each
restriction is checked as an allowed/denied pair on the same document, so
a rule that's too loose *or* too strict fails a test. Includes the
easy-to-assume-wrong case: the owner has **no** override on other people's
`users` docs or `visits` (author-only edit/delete, no exceptions).

**Phase 4 (done):** write flows, plus mocked Google Places / geolocation /
map tiles.

| Feature | Spec file |
|---|---|
| Add Listing — Places search (mocked), auto-tagging, chip edits, manual entry, address autocomplete, validation | `e2e/10-add-listing.spec.js` |
| Detail modal — links, owner tag add/remove, delete listing (cascade), who may remove a visit | `e2e/11-restaurant-detail.spec.js` |
| Log a Visit — validation, full save, calendar date, new dish joins the menu, reviewer switch | `e2e/12-log-visit.spec.js` |
| Reviewer profiles — add/switch/remove, duplicates, device-local | `e2e/14-reviewer-profiles.spec.js` |
| Backup export and owner restore (incl. bad files) | `e2e/15-backup-restore.spec.js` |
| Distance sort — location granted / denied / never answers | `e2e/07-sort.spec.js` |
| Map pin-map fallback when tiles hang | `e2e/05-map-view.spec.js` |
| Landing page when boundary data can't load | `e2e/02-landing-areas.spec.js` |

The Places mock (`fixtures/places-mock.js`) pre-defines
`google.maps.importLibrary` before page load; `index.html`'s Maps loader
leaves an existing definition alone, so no network interception is needed.

**Phase 5 (done):** `.github/workflows/test.yml` runs `npm test` on every
push and pull request (Node 22, Java 21 for the emulators, Chromium).

## Bugs these tests found in the app

- **Edits to existing listings never reached Firestore** (fixed in
  `firebase-init.js`). `syncSharedLedger` diffed against a cache that held
  the same objects the app edits in place, so tag changes, new dishes,
  enrichment and area stamping all looked "unchanged" and were skipped.
  Covered by `11-restaurant-detail`, `12-log-visit`, and the regression test
  in `00-boot-and-migrations`, which fails against the old code.
- **Not fixed — the map's offline fallback only triggers when tile requests
  hang.** Leaflet fires `load` even when tiles *error*, so a truly offline
  map (fast failures) keeps showing Leaflet with blank tiles and working
  markers instead of the pin map. Tested only for the hang case.

## Out of scope (by design, not an oversight)

1. **Real Google OAuth popup/redirect consent.** The Auth Emulator fakes
   the client-side call sequence only, never genuine Google identity.
   Permanently manual-only.
2. **Real Google Places Autocomplete network calls.** Referrer-blocked on
   localhost by Google's own API key restrictions, independent of any test
   framework — mocked instead (Phase 4), which validates the app's handling
   of Places responses, not Google's live service.
3. **Cross-browser/mobile matrix.** Chromium-only via Playwright.
4. **Real network dependencies still in play.** Neighborhood/suburb
   boundary data, the Firebase SDK (gstatic), Leaflet, map tiles and Google
   Fonts load from the real internet; the suite needs network access. The
   "boundaries unavailable" case is tested by blocking those requests.
5. **The PWA service-worker update-banner lifecycle.** Test fixtures
   disable service worker registration entirely (removes cache-staleness
   as a flakiness source for everything else) — this specific flow would
   need its own dedicated setup to test for real.
6. **The "Elsewhere in Chicago" ghost-neighborhood edge case.** Needs real
   neighborhood-geo assignment; not covered by lightweight probe data.
   Low priority — noted as a gap, not forced.
