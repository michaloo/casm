/* Build substitutes these values; only public, generated app-shell files belong here. */
const CACHE = "casm-shell-__CASM_VERSION__";
const ASSETS = __CASM_ASSETS__;
const SHELL = new Set(ASSETS);
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(path =>
    new Request(path, { cache: "reload", credentials: "omit" })))));
  // No skipWaiting: don't replace a worker underneath an active chat.
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith("casm-shell-") && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  // No API, signed downloads, credentials in URLs, cross-origin traffic, or writes.
  // WebSockets are never handled by service-worker fetch events.
  if (request.method !== "GET" || url.origin !== self.location.origin || url.search) return;
  if (request.mode === "navigate") {
    if (!(url.pathname === "/" || url.pathname === "/index.html" || url.pathname.startsWith("/h/") || url.pathname.startsWith("/f/"))) return;
    event.respondWith(fetch(request).catch(async () => {
      const shell = await (await caches.open(CACHE)).match("/index.html");
      return shell ?? Response.error();
    }));
  } else if (SHELL.has(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.pathname)) ?? fetch(request)));
  }
});
// Web Push from casm notify: always shown (Safari revokes silent pushes). The
// app badge counts the notifications still in the notification center.
const badge = async () => {
  const count = (await self.registration.getNotifications()).length;
  if (!("setAppBadge" in self.navigator)) return;
  await (count ? self.navigator.setAppBadge(count) : self.navigator.clearAppBadge()).catch(() => {});
};
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(data.title || "casm", {
    body: data.body || "", tag: data.tag, icon: "/icon-192.png",
    data: { url: typeof data.url === "string" && /^\/(?!\/)/.test(data.url) ? data.url : "/" },
  }).then(badge));
});
// Opens the notification's view: in an open window (which routes in place), else a new one.
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find(client => client.focused) ?? windows[0];
    if (open) {
      open.postMessage({ type: "casm:navigate", url });
      await open.focus().catch(() => {});
    } else await self.clients.openWindow(url);
    await badge();
  })());
});
