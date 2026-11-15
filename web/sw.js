// オフラインでも開けるようにするための Service Worker。
// 方針: まずネットから最新版を取りに行く。つながらない／遅いときだけ、保存してあるものを使う。
//       → アプリを更新したら、開き直すだけで新しい版になる。
// __BUILD__ は公開のたびに自動で書き換わる（.github/workflows/pages.yml）。
const CACHE = 'kintore-log-__BUILD__';
const FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const TIMEOUT_MS = 3000; // これ以上待たされたら、保存してあるものを表示する

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    if (!cached) return fresh;
    fresh.catch(() => {}); // 失敗しても下で保存版を返すので、エラー表示は不要
    const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), TIMEOUT_MS));
    return Promise.race([fresh.catch(() => cached), timeout]);
  })());
});
