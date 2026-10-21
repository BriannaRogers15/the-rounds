# The Rounds — Feature Checklist

A running checklist of what's built vs. still open, so nothing gets lost across sessions. Update this whenever a feature ships or a new one is planned.

## Shipped

- [x] Neighborhood-first landing page with real boundary shapes (Chicago Data Portal + Census TIGERweb), stocked areas first
- [x] Landmark zones (United Center, Museum Campus, Grant Park, etc.) folded into their surrounding neighborhood; Douglas + Grand Boulevard merged into Bronzeville
- [x] Cuisine rail sidebar (Guides / Cuisines / Food & Drink / Occasions) with two-level tag grouping
- [x] Per-restaurant menus — curator-only (`MENU_LOOKUP`/`ADDRESS_LOOKUP` batches); friends can't add/edit/paste a menu, but can still note something they ate that isn't listed when logging a visit, which joins the menu
- [x] "Recently Added" filter chip — spots added in the last 30 days
- [x] New listings require at least one guide tag before saving (blocks the zero-tag save path, both manual and Google Places-sourced)
- [x] App shell split into `index.html` (shell) / `styles.css` / `app.js` / `data/address-lookup.js` / `data/menu-lookup.js` — was one 487KB `index.html`
- [x] Service worker rebuilt: cache-first + stale-while-revalidate, with an "Update available" reload prompt instead of blocking every load on a full refetch
- [x] Address autocomplete for manual-mode listings (`app.js` `#rAddr` suggestions) — also captures `lat`/`lng`, which manual adds never got before (fixed the gap where manual entries were invisible on Map view and couldn't be filed into a neighborhood). Confirmed working live by Brianna (the `includedPrimaryTypes: ['geocode']` → real Table A types fix was correct).
- [x] Restaurant-name search rebuilt as a custom dropdown, no longer capped at 5 hardcoded Google place types — queries unrestricted, filters client-side against all 60+ types `GOOGLE_TYPE_TAG` knows about (`FOOD_DRINK_TYPES` in `app.js`), so real food/drink businesses (ice cream shops, steakhouses, wine bars, etc.) stop getting force-routed into manual mode with no website/phone/coordinates. Confirmed working live by Brianna.
- [x] `refresh-listings` Claude Code skill (`.claude/skills/refresh-listings/`) — agent-assisted enrichment pass for missing/stale menus, missing Yelp links, and cuisine/Occasions tag correctness. Reviews seed data directly and live-added restaurants via a Backup & Restore export; drafts a batch with evidence for Brianna to review, never auto-applies. Chicago Gems stays fully manual by design.
- [x] Reviewer profiles (device-local usernames, visits stamped with who logged them)
- [x] Search, sort (name/date/rating/distance), "haven't been yet" filter
- [x] In-app website popups with "open in new tab" fallback
- [x] Add Listing via Google Places Autocomplete — search-by-name, restricted to Chicagoland bounds and restaurant/cafe/bar/bakery/takeout types; manual fallback ("Can't find it on Google Maps?") only appears on request or if the script fails to load
- [x] Grid and street-map views per area (Leaflet, lazy-loaded)
- [x] Backup & restore (export/import full ledger as JSON)
- [x] Installable PWA, offline-capable (app shell + boundary data cached)
- [x] `.gitignore` (excludes `.DS_Store`, `.claude/`, `.vscode/`, local settings)

## Test coverage

Automated test suite in `tests/` (Playwright + Firebase Emulator Suite, dev-only — see `tests/README.md`). Phase 1 (zero-backend guest-mode coverage) shipped 2026-10-03.

- [x] Guest-mode access control — `tests/e2e/01-auth-gate-access-control.spec.js`
- [x] Landing/neighborhoods page, area banner — `02-landing-areas`, `03-area-banner`
- [x] Listings grid, map view — `04-listings-grid`, `05-map-view`
- [x] Search (incl. debounce), sort (name/date/rating), filters — `06-search`, `07-sort`, `08-filters`
- [x] Guides/cuisine rail, menu display, URL hash routing — `09-guides-rail`, `13-menu-system`, `16-hash-routing`
- [x] Sign-up/in/out, wrong-password error, password reset, rename, owner-vs-non-owner UI — `01-auth-gate-access-control` (Phase 2)
- [x] Migration chain is idempotent across owner boots — `00-boot-and-migrations` (Phase 2)
- [x] Firestore security rules access-control matrix (users / restaurants / visits, 36 allow-deny checks) — `tests/rules/*` (Phase 3)
- [x] Add Listing, detail-modal writes, Log a Visit, reviewer profiles, backup/restore, distance sort, map + boundary fallbacks — `10`–`15`, `05`, `07`, `02` (Phase 4)
- [x] CI — `.github/workflows/test.yml` runs the full suite on every push/PR (Phase 5)
- [ ] Real Google OAuth consent — not automatable, manual-only by design

## In progress / needs a status check

- [ ] **Per-restaurant menu coverage** — confirmed by direct count: 162 of 249 restaurants have a curated `MENU_LOOKUP` entry, **91 have none yet**. The ongoing "Remediation: X sectioned" commits are cleaning up/expanding existing entries (Azul Mariscos, Pappadeaux, Crab Du Jour, Original Pancake House, etc.) — separate from the 91 that haven't been started at all.
- [x] **Apple Maps guide reconciliation** — re-verified 2026-10-03 by transcribing all 45 screenshots in `/Users/briannarogers/Desktop/guides` against the live data: 25 distinct guides, 269 places, only two real gaps found. "Selva" (Mexican) was confirmed missing but Brianna decided to drop it rather than add it. "MiMi's Tacos & French Fries" (1155 S Jefferson St) was added as a second, separate listing from MiMi's Craft Kitchen. Everything else that looked like a gap (Cesar's Killer Margaritas, El Potosi, Leonel's Market, El Salto, Soul Prime, Burp Catering) was already intentionally excluded/removed. The remaining 3 of Brianna's 28 Apple Maps guides were never screenshotted — presumed non-food guides, not a gap.
- [ ] **Menu QC pass** — batch 1 (Mexican + gems + test listings) seeded 2026-07-11; ~200 listings were pending quality-check as of that date. Status since then unconfirmed — there's no QC-tracking field in code, so this has to be confirmed from Brianna's own notes, not the app.

## Parked / not started

- [ ] **Enable GitHub Pages** — `develop` (the default branch) is pushed and ready; Pages still needs turning on in repo Settings → Pages (source: `develop`, root)
- [ ] **Tag taxonomy pass** — Brianna asked to revisit reorganizing tags later; current `PARENT_GROUPS` already shows some independent reorganization (regional umbrellas like Asian/Latin American/Caribbean/European removed, countries promoted to top-level guides) — worth confirming this is the final shape she wants before considering it done

## Known bugs

- [ ] **Duplicate/confusing autocomplete** — reported as "the autocompletion should be one." Needs reproduction steps to pin down exactly what's duplicating (e.g. two suggestion dropdowns, or the Google search box plus the "Filing under" tag-add box both auto-suggesting at once).
- [ ] **Add Listing search box slow to appear (~10s)** — the box only renders after `google.maps.importLibrary('places')` resolves, which is a real network fetch. Billing was disabled on the Google Cloud project until just now, which plausibly caused failed/retried requests and made this much worse than normal — re-verify now that billing is on before assuming this is still a live bug.
- [ ] **New adds sometimes save with no website** — `GOOGLE_TYPE_TAG` gaps used to also cause zero-tag saves; that half is now fixed (save is blocked until at least one guide tag is added — see Shipped). Missing website is likely just Google not having a `websiteURI` on file for that business, not a code bug — worth confirming with a specific example that's missing one it should have.

- [x] **Edits to existing listings never reached Firestore** — tag changes, friends' new dishes, enrichment, area stamps. Fixed in `firebase-init.js` (2026-10-18); regression-tested.
- [x] **Map offline fallback never triggered when tiles failed fast** — now keyed on a tile actually loading (`tileload`), not Leaflet's layer `load`. Fixed 2026-10-20.
- [x] **Owner startup only ran on a load that began signed in** — signing in as the owner now reloads once so seeding/upload happens without a manual refresh. Fixed 2026-10-20.

## Known rough edges

- Google Places Autocomplete has real per-keystroke network latency (~200–400ms) — inherent to calling a live API, not a bug
- **Tag *presence* is enforced at save time; tag *correctness* isn't checked automatically** — a listing can still save with a generic or wrong guide tag if that's all `GOOGLE_TYPE_TAG` or a rushed manual pick produces. The `refresh-listings` skill (see Shipped) now exists to catch and correct this via review, but nothing runs it automatically — it has to be invoked.
