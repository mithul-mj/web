// Shadow Swing — Service Worker
// Enables offline play and is required for PWA / Play Store packaging

const CACHE_NAME = 'shadow-swing-v1';

const urlsToCache = [
  '/',
  '/index.html',
  '/style.css',
  '/game.js',
  '/manifest.json',
  '/sheets/run.png',
  '/sheets/swing.png',
  '/sheets/bird.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Install — cache all game assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Caching game assets');
        return cache.addAll(urlsToCache);
      })
  );
  // Activate immediately without waiting for old SW to finish
  self.skipWaiting();
});

// Activate — clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    })
  );
  // Take control of all pages immediately
  self.clients.claim();
});

// Fetch — serve from cache first, fall back to network
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Cache hit — return cached response
        if (response) {
          return response;
        }
        // Not in cache — fetch from network
        return fetch(event.request).then(networkResponse => {
          // Optionally cache new requests dynamically
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        });
      })
      .catch(() => {
        // If both cache and network fail, return a fallback for HTML pages
        if (event.request.destination === 'document') {
          return caches.match('/index.html');
        }
      })
  );
});
