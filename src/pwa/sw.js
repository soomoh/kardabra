/**
 * Kardabra's service worker: keeps the app working offline. It only ever
 * fetches the app's own files, from its own origin; nothing else goes over
 * the network. Statements and stored data never pass through it. (The
 * page's CSP doesn't cover a worker's own fetches: the origin check below
 * is what keeps it that way.)
 *
 * The build (vite.config.ts, `pwa()`) fills in VERSION and FILES. A new
 * build is a new VERSION, so the browser installs the new worker beside
 * the old one; it takes over once every Kardabra tab or window has closed,
 * so a page never mixes two versions mid-session.
 */
const VERSION = '__KARDABRA_VERSION__';
const FILES = __KARDABRA_FILES__;
const CACHE = `kardabra-${VERSION}`;

/** Fills the cache from the server, past the HTTP cache: a host that
 * caches `/` for a while would otherwise hand the new worker the old page,
 * which names files this version doesn't have. */
function fill(cache) {
  return cache.addAll(
    FILES.map((url) => new Request(url, { cache: 'reload' })),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(fill));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('kardabra-') && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  // ignoreVary: hosts send `Vary: Origin`, and module scripts are requested
  // with an Origin header the install-time fetch didn't have, so a strict
  // match misses every script and the app fails to start offline.
  const options = { ignoreVary: true };
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, options);
      if (cached) return cached;
      if (request.mode !== 'navigate') return fetch(request);
      // Every page is the one app (hash routing): open it from the cache.
      const shell = await cache.match('/', options);
      if (shell) return shell;
      // The cache was cleared under a running worker: fill it again, so
      // the next visit works offline, and use the network this time.
      event.waitUntil(fill(cache).catch(() => {}));
      return fetch(request);
    }),
  );
});
