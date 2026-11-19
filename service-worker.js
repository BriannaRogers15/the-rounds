const CACHE_NAME = 'the-rounds-v130';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './firebase-init.js',
  './auth-gate.js',
  './data/address-lookup.js',
  './data/menu-lookup.js',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's HTTP cache. GitHub Pages lets
  // browsers reuse files for 10 minutes (max-age=600), so a plain fetch
  // here could install the previous version's app.js under the new name.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
  // No skipWaiting() here — a newly installed worker waits until the page
  // says nobody is mid-typing (see index.html), then the page asks it to
  // take over and reloads itself. That way an update never wipes a form.

  // Requests this worker never answers (the database's always-open
  // connection, sign-in, maps) go straight to the network instead of
  // through the worker. Otherwise each one wakes the worker, and one that
  // lands during an update's hand-over restarts the old version just as
  // Chrome stopped it, which leaves the update waiting for up to five
  // minutes (measured). Browsers without static routes skip this and use
  // the fetch handler below, which passes these requests through anyway.
  if (event.addRoutes) {
    const here = new URL(self.location.href);
    const throughWorker = [
      { protocol: here.protocol.replace(':', ''), hostname: here.hostname, port: here.port },
      ...CDN_HOSTS.map((hostname) => ({ hostname })),
    ];
    event.waitUntil(event.addRoutes([
      ...throughWorker.map((init) => ({ condition: { urlPattern: new URLPattern(init) }, source: 'fetch-event' })),
      { condition: { urlPattern: new URLPattern({}) }, source: 'network' },
    ]).catch((error) => console.warn('Static routes unavailable; using the fetch handler for everything.', error)));
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          // Only clean up this worker's own old versions ('the-rounds-*').
          // The page keeps its boundary data in 'rounds-geo-*' — deleting
          // that here would wipe the offline map every SW update.
          .filter((k) => k.startsWith('the-rounds-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// The page posts this when it's safe to switch to the new version (nobody
// is mid-typing) — see index.html's registration script.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

// Versioned CDN files (Leaflet), fonts, and the Firebase SDK are immutable,
// so cache-first is safe and makes the Map view, typography, and sign-in
// screen work offline. Map tiles, the Google Maps API, and Firebase's own
// Auth/Firestore endpoints are deliberately NOT cached (unbounded / must be
// fresh) — they're cross-origin requests to hosts not in this list, so the
// fetch handler below lets them pass straight through to the network.
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com'];

// Cache-first + background revalidation (stale-while-revalidate) for the
// app shell and cached CDN files: every load is instant from cache, and a
// fresh copy is fetched in the background to update the cache for next
// time. Replaces the old network-first approach, which blocked every load
// on refetching the whole app shell before falling back to cache offline.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) {
    if (CDN_HOSTS.includes(url.hostname) && event.request.method === 'GET') {
      event.respondWith(staleWhileRevalidate(event.request));
    }
    return; // other cross-origin requests (map tiles, Maps API) pass through normally
  }

  if (event.request.method === 'GET') {
    event.respondWith(staleWhileRevalidate(event.request));
  }
});

// Browsers refuse a redirected response for a page navigation, so a
// followed redirect is re-wrapped as a plain response.
function unredirect(response) {
  if (!response.redirected) return response;
  return response.blob().then((body) => new Response(body, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  }));
}

function staleWhileRevalidate(request) {
  // Same-origin refreshes ask the server (no-cache revalidates with the
  // ETag, so an unchanged file is a tiny 304) instead of reusing the
  // browser's 10-minute copy. Navigation requests can't be re-built with
  // options, so they're refetched by URL.
  const url = new URL(request.url);
  const fresh = url.origin === self.location.origin
    ? fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then(unredirect)
    : fetch(request);
  return caches.open(CACHE_NAME).then((cache) =>
    cache.match(request).then((cached) => {
      const network = fresh.then((response) => {
        // Script/stylesheet tags fetch in no-cors mode, which yields
        // "opaque" responses (ok === false, status 0). They're still
        // valid to serve from cache, and these hosts are trusted.
        if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
}
