/* Kundali offline shell. Versioned by the build: the build replaces BUILD and PRECACHE.
 * Hashed assets: cache first. index.html: network first. Never touches the Model Hub or any other site. */
const BUILD = '__BUILD__'
const PRECACHE = '__PRECACHE__'.split(',').filter(Boolean)
const CACHE = 'ns-shell-' + BUILD
const scope = self.registration.scope

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE)
    // one file failing must not block the rest
    await Promise.all(['./', ...PRECACHE].map((u) => c.add(new Request(new URL(u, scope).href, { cache: 'reload' })).catch(() => {})))
  })())
})
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('ns-shell-') && k !== CACHE) await caches.delete(k)
    await self.clients.claim()
  })())
})
self.addEventListener('message', (e) => { if (e.data === 'skip') self.skipWaiting() })

self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url)
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/api/') || u.pathname.includes('/ws')) return
  if (/\/(assets|ort)\//.test(u.pathname)) { // hashed or versioned: the cache wins
    e.respondWith(caches.open(CACHE).then(async (c) => (await c.match(r)) || fetch(r).then((x) => { if (x.ok) c.put(r, x.clone()); return x })))
    return
  }
  if (r.mode === 'navigate' || u.pathname.endsWith('/') || u.pathname.endsWith('.html')) { // the page: the network wins, the cache is the fallback
    e.respondWith(fetch(r).then((x) => { if (x.ok) caches.open(CACHE).then((c) => c.put(new URL('./', scope).href, x.clone())); return x }).catch(async () => (await caches.match(new URL('./', scope).href, { cacheName: CACHE })) || Response.error()))
  }
})
