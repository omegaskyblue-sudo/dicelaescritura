// Service worker de YAiContenido: permite instalar la app y muestra una página
// «sin conexión». Las páginas y la API van siempre a la red (datos privados, nunca en caché).
const CACHE = 'yaicontenido-v1';
const ESTATICOS = ['/offline.html', '/plataforma.css', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ESTATICOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
        .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
    if (req.mode === 'navigate') {
        e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    } else if (ESTATICOS.includes(new URL(req.url).pathname)) {
        e.respondWith(fetch(req).catch(() => caches.match(req)));
    }
});
