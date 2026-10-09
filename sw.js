// 社用車管理 service worker
// - アプリの画面（HTML/CSS/JS/アイコン）は「新しいものを優先、つながらないときは保存済みを使う」
// - Firebase の SDK とフォントは一度読んだら保存済みを使う（版が固定のため）
// - 車・修理の写真（Firebase Storage）は、一度表示したら端末に保存して次からはそこから出す（最大200枚、古い順に消す）
//   写真を変えると写真のアドレスが変わるので、新しい写真は自動で取りに行く
// - データ（Firestore）は Firebase が自分で処理するので、ここでは触らない
// - プッシュ通知（Cloud Functions から Firebase Cloud Messaging で届く）を表示し、押したらアプリを開く
const CACHE = "sharyo-v23"; // 版を上げると、スマホに保存した古い画面・アイコンを入れ替える
const PHOTO_CACHE = "sharyo-photos-v1", PHOTO_MAX_ITEMS = 200; // 写真の置き場（画面の版を上げても消さない）
const SHELL = [
  "./", "./index.html", "./style.css", "./app.js", "./firebase-config.js", "./manifest.webmanifest",
  "./shop.html", "./shop.js", "./shop.css", "./shop.webmanifest", // トラストワン用ページ
  "./icons/icon-192.png?v=2", "./icons/icon-512.png?v=2", "./icons/icon-maskable-192.png?v=3", "./icons/icon-maskable-512.png?v=3",
  "./icons/apple-touch-icon.png?v=2", "./icons/favicon-32.png?v=2",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== PHOTO_CACHE).map(k => caches.delete(k))))
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
  // 車・修理の写真（写真そのもの。alt=media）: 保存済みを優先。なければ取りに行って保存する
  if (url.hostname === "firebasestorage.googleapis.com" && url.searchParams.get("alt") === "media" && /\/o\/(vehicles|repairs)%2F/.test(url.pathname)) {
    e.respondWith(caches.open(PHOTO_CACHE).then(c => c.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === "opaque") {
        const copy = res.clone();
        e.waitUntil(c.put(req, copy).then(() => c.keys()).then(keys => Promise.all(keys.slice(0, Math.max(0, keys.length - PHOTO_MAX_ITEMS)).map(k => c.delete(k)))));
      }
      return res;
    }))));
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

// プッシュ通知：届いたら表示する（中身は data の title / body / tag / url）
self.addEventListener("push", e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (err) { p = { data: { body: e.data ? e.data.text() : "" } }; }
  const d = { ...(p.notification || {}), ...(p.data || {}) };
  e.waitUntil(self.registration.showNotification(d.title || "社用車", {
    body: d.body || "",
    tag: d.tag || undefined, // 同じ通知は重ねない
    icon: "./icons/icon-192.png?v=2",
    data: { url: d.url || "./" },
  }));
});
// 通知を押したら：同じページ（社員用 / トラストワン用 shop.html）が開いていればそれを前に、なければ開く
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const shop = url.includes("shop.html");
    const open = list.find(c => c.url.startsWith(self.registration.scope) && c.url.includes("shop.html") === shop && "focus" in c);
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
