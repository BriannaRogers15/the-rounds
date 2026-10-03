# The Rounds — automated test suite

Dev-only tooling. The app itself still has zero build step — this is an
optional test suite for verifying it, not a dependency of running it.

## Running

```bash
npm install
npm test              # rules + e2e
npm run test:e2e       # Playwright UI flows only
npm run test:e2e:ui    # same, with Playwright's interactive UI runner
npm run test:rules     # Firestore security rules only (Phase 3)
npm run test:emulators # start the Firebase emulators standalone, with the
                        # inspector UI at http://127.0.0.1:4000, for manual
                        # poking/debugging
```

`npm test`/`npm run test:e2e` start the Firebase Auth Emulator automatically
(see `tests/global-setup.js`) and serve the app via the same
`python3 -m http.server 8741` command documented in `.claude/skills/verify`.
Nothing talks to the real `the-rounds-fc02a` Firebase project.

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

**Known constraint: cap `workers` at 2.** All tests share one local Auth
Emulator process. Too many parallel browser contexts initializing auth at
once starves it and stalls page loads on "Loading…" indefinitely — reproduced
directly: 2 of 5 tests hung with Playwright's default (CPU-count-based)
worker count on this machine, 0 of 50+ with `workers: 2` (see
`playwright.config.js`). This is a known characteristic of a single local
emulator instance under load, not app or test flakiness — don't "fix" it by
raising timeouts.

**Known gotcha: use `page.goto(url-with-hash)`, not `location.hash = X` then
`.reload()`, for cold-load hash tests.** The latter was observed to lose the
hash fragment somewhere in Playwright's reload path when run through the
test runner (reproducible, though the exact mechanism wasn't pinned down —
likely interacts with the custom `webServer` + fixture setup). A fresh
`goto()` with the hash already in the target URL is also a more faithful
simulation of "someone opened a bookmarked link" anyway.

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

**Phase 2 (next):** Firestore Emulator wired in; full sign-up/in/out,
password reset, persistence, rename-profile, owner-vs-non-owner UI
(`e2e/01-auth-gate-access-control.spec.js` extended); boot/migration-chain
idempotency for owner and no-firebase sessions (`e2e/00-boot-and-migrations.spec.js`).

**Phase 3:** Firestore security rules (`tests/rules/*`) via
`@firebase/rules-unit-testing` — the full access-control matrix, including
the easy-to-assume-wrong case that the owner has **no** override on
`visits` update/delete (author-only, no exceptions).

**Phase 4:** flows needing mocked Google Places / Geolocation / map tiles —
Add Listing (`e2e/10-add-listing.spec.js`), restaurant detail write paths
(`e2e/11-restaurant-detail.spec.js`), Log a Visit
(`e2e/12-log-visit.spec.js`), reviewer profiles being device-local
(`e2e/14-reviewer-profiles.spec.js`), backup & restore
(`e2e/15-backup-restore.spec.js`), distance sort, and the `tilesOk`
timeout → relative-map fallback.

**Phase 5:** CI workflow (`.github/workflows/test.yml`).

## Out of scope (by design, not an oversight)

1. **Real Google OAuth popup/redirect consent.** The Auth Emulator fakes
   the client-side call sequence only, never genuine Google identity.
   Permanently manual-only.
2. **Real Google Places Autocomplete network calls.** Referrer-blocked on
   localhost by Google's own API key restrictions, independent of any test
   framework — mocked instead (Phase 4), which validates the app's handling
   of Places responses, not Google's live service.
3. **Cross-browser/mobile matrix.** Chromium-only via Playwright.
4. **Real Census/Chicago Data Portal GeoJSON endpoints.** Mocked with
   committed fixtures for determinism (Phase 4); the "boundaries
   unavailable" fallback is tested against a simulated fetch failure, not a
   real one.
5. **The PWA service-worker update-banner lifecycle.** Test fixtures
   disable service worker registration entirely (removes cache-staleness
   as a flakiness source for everything else) — this specific flow would
   need its own dedicated setup to test for real.
6. **The "Elsewhere in Chicago" ghost-neighborhood edge case.** Needs real
   neighborhood-geo assignment; not covered by lightweight probe data.
   Low priority — noted as a gap, not forced.
