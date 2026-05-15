// 极简 service worker：缓存壳, 数据始终走网络
const CACHE = 'ndx-shell-v1';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 行情数据走网络优先
  if (url.host.includes('finance.yahoo.com') || url.host.includes('corsproxy.io') || url.host.includes('allorigins.win')) {
    return; // 默认走网络
  }
  // 应用壳走缓存优先
  if (e.request.method === 'GET' && url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return resp;
      }))
    );
  }
});
