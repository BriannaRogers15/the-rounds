const CACHE_NAME = 'the-rounds-v97';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './data/address-lookup.js',
  './data/menu-lookup.js',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  // No skipWaiting() here — a newly installed worker sits "waiting" until
  // the open page confirms it's ready to reload (see the message listener
  // below), so an update never swaps the app shell out mid-visit.
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

// The page posts this once someone accepts the "Update available" prompt —
// see index.html's registration script.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

// Versioned CDN files (Leaflet) and fonts are immutable, so cache-first is
// safe and makes the Map view + typography work offline. Map tiles and the
// Google Maps API are deliberately NOT cached (unbounded / must be fresh).
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

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

function staleWhileRevalidate(request) {
  return caches.open(CACHE_NAME).then((cache) =>
    cache.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
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
