# The Rounds — A Chicagoland Dining Ledger

A personal restaurant guide tracker for Chicago and the Chicagoland area. Log visits, ratings, notes, and "would I go back" for every spot across your Apple Maps guides — bars, steakhouses, sandwiches, desserts, and more.

## Features
- Multi-tag categories with two-level grouping (e.g. Bars → Sports Bars, Tiki Bars, Cocktail Bars)
- Grid and map views, with real Google Maps links per restaurant
- Search, sort (name/date/rating/distance), and "haven't been yet" filtering
- Visit logging with a custom calendar picker and a dish autocomplete that learns your past orders
- Installable as a home-screen app (PWA) — works offline once loaded

## Running locally
Just open `index.html` in a browser — no build step, no dependencies.

## Installing on your phone
1. Host this repo somewhere with HTTPS (e.g. GitHub Pages — see below).
2. Open the site on your phone in Safari (iOS) or Chrome (Android).
3. iOS: tap Share → "Add to Home Screen". Android: tap the menu → "Install app".

## Hosting on GitHub Pages
1. Push this repo to GitHub.
2. In the repo settings, go to **Pages** and set the source to the `main` branch, root folder.
3. Your app will be live at `https://<your-username>.github.io/<repo-name>/`.

## Data storage
Data is stored locally in the browser: `window.storage` inside Claude's preview, or `localStorage` once hosted standalone. Nothing is sent to a server. Note that these are separate storage backends — data you log in Claude's preview and data you log on the hosted/installed version won't sync with each other. Once you're using the hosted PWA day-to-day, that's your single source of truth.
