const CACHE = "sepet2026-v16";
// Caches HTML, JS, PDF, and data so the app works offline.

const ASSETS = [
  "./",
  "index.html",
  "app.js",
  "data/data.json",
  "assets/2026-Trade-Show-Book.pdf",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Use individual adds so one failure doesn't block the rest
      Promise.all(ASSETS.map((u) => cache.add(u).catch((e) => console.warn("SW skip", u, e))))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only handle same-origin GETs
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Refresh in background (stale-while-revalidate)
        fetch(event.request).then((res) => {
          if (res.ok) {
            caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(event.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      }).catch(() => caches.match("./index.html"));
    })
  );
});
