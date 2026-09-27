// 社用車管理 service worker
// - アプリの画面（HTML/CSS/JS/アイコン）は「新しいものを優先、つながらないときは保存済みを使う」
// - Firebase の SDK とフォントは一度読んだら保存済みを使う（版が固定のため）
// - データ（Firestore）と写真（Storage）は Firebase が自分で処理するので、ここでは触らない
const CACHE = "sharyo-v5"; // 版を上げると、スマホに保存した古い画面・アイコンを入れ替える
const SHELL = [
  "./", "./index.html", "./style.css", "./app.js", "./firebase-config.js", "./manifest.webmanifest",
  "./icons/icon-192.png?v=2", "./icons/icon-512.png?v=2", "./icons/icon-maskable-192.png?v=3", "./icons/icon-maskable-512.png?v=3",
  "./icons/apple-touch-icon.png?v=2", "./icons/favicon-32.png?v=2",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 自分のサイト（GitHub Pages）: 新しいものを優先
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req, { cache: "no-cache" }).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("./index.html")))
    );
    return;
  }
  // Firebase SDK（www.gstatic.com/firebasejs/版番号/…）とフォント: 保存済みを優先
  if ((url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) ||
      url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }))
    );
  }
});
