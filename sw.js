// Said It? — service worker (Phase 4 PWA). Offline app-shell + fresh daily content + web-push handler.
// Bump CACHE when the shell changes (forces a clean re-cache). No build step — plain SW.
const CACHE = "saidit-v7";
const SHELL = [
  "./", "./index.html", "./config.js", "./manifest.webmanifest",
  "./src/main.js", "./src/engine.js", "./src/store.js", "./src/data.js", "./src/api.js", "./src/state.js",
  "./icon.svg", "./icon-192.png", "./icon-512.png",
  "./apple-touch-icon.png", "./icon-maskable-512.png", "./icon-maskable.svg",   // referenced by index.html/manifest — precache for full offline install
];

self.addEventListener("install", (e) => {
  // best-effort precache (don't fail the install if one asset 404s)
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // don't touch CDN / Supabase / endpoint requests

  // daily content: NETWORK-FIRST so a new set always wins, fall back to the last cached set offline
  if (url.pathname.includes("/daily/")) {
    e.respondWith(
      fetch(req).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return r; })
        .catch(() => caches.match(req))
    );
    return;
  }
  // app shell: CACHE-FIRST with background revalidate (stale-while-revalidate)
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((r) => { if (r && r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); } return r; }).catch(() => cached);
      return cached || net;
    })
  );
});

// ── web push (Phase 4) ──
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  const title = d.title || "Said It?";
  const body = d.body || "New editions are live — keep your streak going.";
  e.waitUntil(self.registration.showNotification(title, {
    body, icon: "./icon-192.png", badge: "./icon-192.png", tag: "saidit-daily",
    data: { url: d.url || "./?src=push" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((wins) => {
    for (const w of wins) { if ("focus" in w) return w.focus(); }
    return self.clients.openWindow(target);
  }));
});
