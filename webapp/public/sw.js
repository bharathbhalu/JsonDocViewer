// Accretion service worker: when the server isn't running, page loads show
// a "not running" page (with a Start button and auto-retry) instead of the
// browser's connection error. Nothing else is cached, so the app is never stale.
const CACHE = 'accretion-offline-v1';
const OFFLINE = ['/offline.html', '/icon.svg'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(OFFLINE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  const url = new URL(req.url);
  if (url.origin === location.origin && OFFLINE.includes(url.pathname)) {
    e.respondWith(fetch(req).catch(() => caches.match(url.pathname)));
  }
});
