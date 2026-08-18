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
- [x] Reviewer profiles (device-local usernames, visits stamped with who logged them)
- [x] Search, sort (name/date/rating/distance), "haven't been yet" filter
- [x] In-app website popups with "open in new tab" fallback
- [x] Add Listing via Google Places Autocomplete — search-by-name, restricted to Chicagoland bounds and restaurant/cafe/bar/bakery/takeout types; manual fallback ("Can't find it on Google Maps?") only appears on request or if the script fails to load
- [x] Grid and street-map views per area (Leaflet, lazy-loaded)
- [x] Backup & restore (export/import full ledger as JSON)
- [x] Installable PWA, offline-capable (app shell + boundary data cached)
- [x] `.gitignore` (excludes `.DS_Store`, `.claude/`, `.vscode/`, local settings)

## In progress / needs a status check

- [ ] **Per-restaurant menu coverage** — confirmed by direct count: 162 of 249 restaurants have a curated `MENU_LOOKUP` entry, **91 have none yet**. The ongoing "Remediation: X sectioned" commits are cleaning up/expanding existing entries (Azul Mariscos, Pappadeaux, Crab Du Jour, Original Pancake House, etc.) — separate from the 91 that haven't been started at all.
- [ ] **Apple Maps guide reconciliation** — per memory notes, ~22 of 28 guides reconciled as of 2026-07-11, 3 guides unaccounted, "Selva" specifically flagged open. Needs a fresh check — this note may be stale.
- [ ] **Menu QC pass** — batch 1 (Mexican + gems + test listings) seeded 2026-07-11; ~200 listings were pending quality-check as of that date. Status since then unconfirmed — there's no QC-tracking field in code, so this has to be confirmed from Brianna's own notes, not the app.

## Parked / not started

- [ ] **Merge `feature/dining-tracker` → `main`** and enable GitHub Pages hosting (still sitting on the feature branch as of this writing)
- [ ] **Tag taxonomy pass** — Brianna asked to revisit reorganizing tags later; current `PARENT_GROUPS` already shows some independent reorganization (regional umbrellas like Asian/Latin American/Caribbean/European removed, countries promoted to top-level guides) — worth confirming this is the final shape she wants before considering it done
- [ ] **Agent-assisted enrichment pipeline** — a Claude Code skill (e.g. `.claude/skills/refresh-listings/`) that reviews `restaurants` for missing/stale menus, missing Yelp links, and missing/wrong guide + Occasions tags (Rooftop, Happy Hour, Dinner Dates), fetches evidence (website, Google Places editorial summary/reviews), and drafts `MENU_LOOKUP`/`ADDRESS_LOOKUP` batches for review — same commit workflow as today's manual "Menus: X restaurants" passes, minus the manual research. Also the bridge for correcting live-added (non-seed) restaurants via the existing JSON export/import. Chicago Gems stays fully manual (it's Brianna's opinion, not a fact to look up). Not built yet — this is a new tool, not an `index.html`/`app.js` edit.

## Known bugs

- [ ] **Duplicate/confusing autocomplete** — reported as "the autocompletion should be one." Needs reproduction steps to pin down exactly what's duplicating (e.g. two suggestion dropdowns, or the Google search box plus the "Filing under" tag-add box both auto-suggesting at once).
- [ ] **Add Listing search box slow to appear (~10s)** — the box only renders after `google.maps.importLibrary('places')` resolves, which is a real network fetch. Billing was disabled on the Google Cloud project until just now, which plausibly caused failed/retried requests and made this much worse than normal — re-verify now that billing is on before assuming this is still a live bug.
- [ ] **New adds sometimes save with no website** — `GOOGLE_TYPE_TAG` gaps used to also cause zero-tag saves; that half is now fixed (save is blocked until at least one guide tag is added — see Shipped). Missing website is likely just Google not having a `websiteURI` on file for that business, not a code bug — worth confirming with a specific example that's missing one it should have.

## Known rough edges

- Google Places Autocomplete has real per-keystroke network latency (~200–400ms) — inherent to calling a live API, not a bug
- **Tag *presence* is now enforced, tag *correctness* isn't yet** — a new listing can still save with a generic or wrong guide tag if that's all `GOOGLE_TYPE_TAG` or a rushed manual pick produces. Real fix is an agent-assisted verification pass (cross-reference name/website/reviews against the guide vocabulary, propose corrections with evidence) — same category of follow-up as the menu/Yelp enrichment pipeline below, not yet built.
