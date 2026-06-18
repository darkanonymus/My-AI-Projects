/* Help me Learn — service worker.
   Network-FIRST on purpose: the app transpiles .jsx in the browser and a
   stale cache would serve old code (a known gotcha). So when online we always
   take the fresh response and merely keep a copy; the cache is used only as an
   offline fallback. API calls and non-GET requests are never touched. */
const CACHE = "hml-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                      // /api/tts, /api/llm … pass through
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return;          // health/state must stay live
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
