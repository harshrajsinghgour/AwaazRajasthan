const CACHE = "awaaz-rajasthan-v17";
const APP_SHELL = ["/", "/index.html", "/news-placeholder.svg", "/awaazrajasthan-logo.png", "/manifest.webmanifest"];

function safeNotificationUrl(value) {
  const fallback = "/";
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin) return fallback;
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/") || url.pathname.startsWith("/api/")) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(async (cache) => {
        const results = await Promise.allSettled(APP_SHELL.map((url) => cache.add(url)));
        if (results.every((result) => result.status === "rejected")) throw new Error("No app-shell asset could be cached");
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith("awaaz-rajasthan-") && key !== CACHE).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/") || url.pathname.startsWith("/api/")) return;

  const isStatic =
    url.pathname.startsWith("/assets/") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".webp") ||
    url.pathname.endsWith(".avif") ||
    url.pathname.endsWith(".ico") ||
    url.pathname.endsWith(".woff2");

  if (isStatic) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const network = fetch(event.request)
          .then((response) => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
            }
            return response;
          })
          .catch(() => cached || new Response("Offline", { status: 503, statusText: "Offline" }));
        return cached || network;
      })
    );
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(
      caches.match("/index.html").then((cached) => {
        const network = fetch(event.request)
          .then((response) => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put("/index.html", copy)).catch(() => {});
            }
            return response;
          })
          .catch(() => cached || new Response("Offline", { status: 503, statusText: "Offline" }));
        return cached || network;
      })
    );
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data?.text() };
  }

  const title = String(data.title || "आवाज़ राजस्थान").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) || "आवाज़ राजस्थान";
  const body = String(data.body || "नई खबर उपलब्ध है।").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 220) || "नई खबर उपलब्ध है।";
  const tag = String(data.tag || "awaaz-rajasthan-news").replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 100) || "awaaz-rajasthan-news";
  const url = safeNotificationUrl(data.url);

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/awaazrajasthan-logo.png",
      badge: "/awaazrajasthan-logo.png",
      tag,
      renotify: Boolean(data.renotify),
      data: { url },
      vibrate: [100, 50, 100]
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = safeNotificationUrl(event.notification.data?.url);
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true })
      .then(async (list) => {
        const sameOrigin = list.find((client) => {
          try { return new URL(client.url).origin === self.location.origin; } catch { return false; }
        });
        if (sameOrigin && "focus" in sameOrigin) {
          if ("navigate" in sameOrigin) await sameOrigin.navigate(target);
          return sameOrigin.focus();
        }
        return clients.openWindow(target);
      })
  );
});
