const CACHE_NAME = 'the-rounds-v2';
const ASSETS = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
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

// Network-first for the app shell: when online, always serve the latest
// deployed files (and refresh the cache); the cached copy is only used
// offline. Cache-first would keep serving a stale index.html forever.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin requests pass through normally

  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok && event.request.method === 'GET') {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
