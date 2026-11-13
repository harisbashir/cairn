// Cairn service worker: makes the app installable and keeps the shell available when the network drops.
// Data is never cached here; pages always come from the server when it is reachable.
const SHELL = 'cairn-shell-v2';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.add('/')).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/mcp') || url.pathname.startsWith('/files') || url.pathname.startsWith('/oauth') || url.pathname.startsWith('/cal')) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(SHELL).then((c) => c.put('/', copy)); return res; }).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(req).then((hit) => hit ?? fetch(req).then((res) => { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); return res; })));
  }
});

// Push notifications (reminders, mentions, comments, assignments). The payload is { title, body, url, tag }.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  // Mentions arrive as "@[Name](cairn://user/id)"; show them as "@Name".
  const plain = (t) => String(t || '').replace(/@\[([^\]]*)\]\(cairn:\/\/(user|date|page)\/[^)\s]+\)/g, (_m, name, kind) => (kind === 'user' ? '@' + name : name));
  event.waitUntil(self.registration.showNotification(plain(data.title) || 'Cairn', {
    body: plain(data.body),
    tag: data.tag || undefined,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
    const open = list.find((c) => c.url === target) ?? list.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      if (open.url !== target && 'navigate' in open) await open.navigate(target).catch(() => {});
      return;
    }
    await self.clients.openWindow(target);
  }));
});
