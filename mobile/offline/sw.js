const CACHE = 'guandan-offline-v2';
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const base = self.registration.scope;
    const response = await fetch(base, { cache: 'reload' });
    if (!response.ok) throw new Error('无法缓存入口页面');
    const html = await response.clone().text();
    await cache.put(base, response);
    const resources = Array.from(html.matchAll(/(?:src|href)="(\.\/[^\"]+)"/g), match => new URL(match[1], base).href);
    if (html.includes('mobile.webmanifest')) {
      resources.push(new URL('./index.html', base).href);
      resources.push(new URL('./icon-192.png', base).href);
      resources.push(new URL('./icon-512.png', base).href);
    }
    await cache.addAll([...new Set(resources)]);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('guandan-offline-') && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      if (event.request.mode === 'navigate') return await cache.match(self.registration.scope) || Response.error();
      return Response.error();
    }
  })());
});
