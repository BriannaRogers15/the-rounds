# The Rounds — A Chicagoland Dining Ledger

A personal restaurant guide tracker for Chicago and the Chicagoland area. Log visits, ratings, and dishes for every spot across your guides — bars, steakhouses, sandwiches, desserts, and more — organized by the neighborhoods and suburbs they actually sit in.

## Features
- **Neighborhood-first landing** — pastel shape-cards carrying each Chicago neighborhood's real boundary silhouette (Chicago Data Portal) and each suburb's municipal outline (U.S. Census TIGERweb). Stocked areas lead, most-spots-first; unexplored neighborhoods sit behind a toggle. Tap an area to see its spots and cuisines.
- **Accurate neighborhoods** — landmark zones that aren't real neighborhoods (United Center, Museum Campus, Grant Park…) are folded into the neighborhoods around them; Douglas + Grand Boulevard merge into Bronzeville.
- **Per-restaurant menus** — add dishes one at a time or paste a whole menu; logging a visit is a tap-to-check list, so orders stay consistent. New dishes typed at log time join the menu automatically.
- **Reviewer profiles** — device-local usernames; every visit is stamped with who logged it.
- **Shared ledger** — restaurants and visits sync through Firestore across devices. Guests can browse the public ledger; signed-in users can log visits, and listing management is owner-only.
- **Multi-tag cuisines** with two-level grouping (e.g. Bars → Sports Bars, Tiki Bars, Cocktail Bars), search, sort (name/date/rating/distance), and a "haven't been yet" filter.
- **In-app website popups** — restaurant sites open in a large overlay with an always-available "Open in new tab" fallback.
- **Restaurant-only autocomplete** — new listings come from Google Places, restricted to food spots inside Chicagoland; manual entry requires a full address.
- **Grid and street-map views** per area (Leaflet loads lazily, only when the Map view is opened).
- **Backup & restore** — export the whole ledger to a JSON file and restore it on any device (landing page, bottom row).
- Installable as a home-screen app (PWA); the app shell, fonts, Leaflet, and boundary data all work offline after first use.

## Running locally
Just open `index.html` in a browser — no build step, no dependencies. (Serve it over HTTP for the service worker/offline features: `python3 -m http.server`.)

## Testing
The app itself needs nothing beyond a browser and a static file server. An optional, dev-only automated test suite lives in `tests/` and uses Node tooling (Playwright + the Firebase Emulator Suite) that never touches production data or the real Firebase project. To run it: `npm install && npm test`. See `tests/README.md` for coverage, phasing, and the handful of things that can't be automated (real Google OAuth consent, most notably).

## Installing on your phone
1. Host this repo somewhere with HTTPS (e.g. GitHub Pages — see below).
2. Open the site on your phone in Safari (iOS) or Chrome (Android).
3. iOS: tap Share → "Add to Home Screen". Android: tap the menu → "Install app".

## Hosting on GitHub Pages
1. Push this repo to GitHub.
2. In the repo settings, go to **Pages** and set the source to the `main` branch, root folder.
3. Your app will be live at `https://<your-username>.github.io/<repo-name>/`.
4. In the Firebase console, go to **Authentication → Settings → Authorized domains** and add `<your-username>.github.io` — Google sign-in will fail on the live site until this domain is added.

## Data storage
Restaurants and visits are shared in Firestore. The browser keeps a `localStorage` cache (keys prefixed `rounds:`) for faster startup and offline browsing; changes require an available shared connection. On first startup, the ledger owner's existing local data is uploaded if the shared collections are empty. **Export backup** remains available from the landing page. Reviewer display profiles stay device-local. Neighborhood/suburb boundary files are fetched once (Chicago Data Portal + Census TIGERweb) and kept in the Cache API for offline use.

Firestore rules allow public reads of restaurants and visits so guest browsing works. Writes remain authenticated: only the ledger owner can create/delete restaurants or edit restaurant metadata, while signed-in reviewers can add their own visits and update menus with dishes they have logged. Deploy updated rules with `firebase deploy --only firestore:rules` when the Firebase CLI is configured for this project.
