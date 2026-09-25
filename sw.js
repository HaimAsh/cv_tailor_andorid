// Keeps the app working offline. Bump VERSION whenever any file changes.
const VERSION = "cvt-v4";
const SHELL = [
  "./", "index.html", "styles.css", "app.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png",
  "vendor/docx.umd.js", "vendor/mammoth.browser.min.js", "vendor/pdf.min.js", "vendor/pdf.worker.min.js",
  "fonts/heebo-hebrew-400-normal.woff2", "fonts/heebo-hebrew-500-normal.woff2", "fonts/heebo-hebrew-700-normal.woff2",
  "fonts/heebo-latin-400-normal.woff2", "fonts/heebo-latin-500-normal.woff2", "fonts/heebo-latin-700-normal.woff2",
  "fonts/frank-ruhl-libre-hebrew-700-normal.woff2", "fonts/frank-ruhl-libre-latin-700-normal.woff2"
];

self.addEventListener("install", e => {
  // Don't take over by itself: the page shows "new version" and asks us to (see message below).
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)));
});

self.addEventListener("message", e => {
  if (e.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Gemini calls go straight to the network
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return res;
    }))
  );
});
