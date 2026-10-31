// Service worker v3: lets the app be installed, removes old offline caches, and makes sure every
// file is checked with the server on each load (cache: no-cache), so a newly published version is used at once.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(req.mode === 'navigate'
    ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).catch(() => fetch(req))
    : fetch(req, { cache: 'no-cache' }).catch(() => fetch(req)));
});
