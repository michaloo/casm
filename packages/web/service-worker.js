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
