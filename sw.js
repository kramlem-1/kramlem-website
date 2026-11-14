// Offline support for kramlem.com/holiday.
//
// The itinerary is one self-contained HTML file, so "offline" means: hold on to
// that document, the fonts and the icons, serve them when there is no network,
// and keep any photo the page has already shown. The page itself bulk-adds the
// photos when you tap "save the photos too" — it writes into this same cache.
const CACHE = 'kramlem-holiday-v1'; // keep in step with template.html
const SHELL = [
  '/holiday',
  '/manifest.webmanifest',
  '/favicon.png',
  '/icon-192.png',
  '/icon-512.png',
];
const FONTS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One slow asset should not fail the whole install, so no addAll here.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('kramlem-holiday-') && n !== CACHE)
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const mine = url.origin === self.location.origin;
  const font = FONTS.indexOf(url.origin) !== -1;
  if (!mine && !font) return;

  // The itinerary itself: newest wins when there is a network, cache when there
  // is not — so an updated page is never held back by an old copy.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        await cache.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        const cache = await caches.open(CACHE);
        return (await cache.match(req)) ||
          (await cache.match('/holiday')) ||
          Response.error();
      }
    })());
    return;
  }

  // Photos, fonts and icons never change under the same URL, so the cache is
  // the first stop and anything new is filed on the way past.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const fresh = await fetch(req);
      if (fresh && (fresh.ok || fresh.type === 'opaque')) {
        await cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      return Response.error();
    }
  })());
});
