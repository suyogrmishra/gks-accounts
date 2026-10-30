// Minimal service worker: lets the app be installed, and removes the old app's offline cache.
// It does not cache anything itself — every request goes to the network, so you always get the latest version.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', () => { /* network only */ });
