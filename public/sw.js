/*
 * Leafdesk service worker: the installable app's shell and the offline copies of pages (#44, #10).
 * Registered in production builds only (components/offline/install-app.tsx).
 *
 * - Scripts, styles and fonts under /_next/static are content-hashed: served from the cache first.
 * - Icons, the manifest and the offline page: from the cache, refreshed in the background.
 * - Pages (/w/<workspace> and /w/<workspace>/p/<page>): always from the network while it answers.
 *   The HTML of the pages a signed-in user opens is kept per user (`leafdesk-pages-<user id>`, read
 *   from the page's <meta name="leafdesk-user">) and served only when the network fails. When a
 *   different user's page comes in, the previous user's copies are dropped; signing out deletes
 *   them from the page (components/offline/offline-store.ts).
 * - Everything else (API routes, uploads, server actions, RSC requests, the collab websocket) is
 *   never touched.
 * - Push messages (server/push.ts) show as notifications; opening one brings an open Leafdesk tab
 *   to the notification's page, or opens a new window; its Snooze button snoozes it for an hour.
 *
 * Bump VERSION when changing this file's caching of static files.
 */
const VERSION = "1";
const STATIC_CACHE = `leafdesk-static-${VERSION}`;
const META_CACHE = "leafdesk-meta";
const PAGE_CACHE_PREFIX = "leafdesk-pages-";
const OFFLINE_URL = "/offline";
const SHELL = ["/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png"];
const MAX_PAGES = 50;
const MAX_STATIC = 800;
// Keep in sync with src/lib/offline.ts (PAGE_PATH, readUserMarker); offline.test.ts compares them.
const PAGE_PATH = /^\/w\/[\w-]+(?:\/p\/[\w-]+)?\/?$/;
const USER_MARKER = /<meta\s+name="leafdesk-user"\s+content="([\w-]+)"/;
const ASSET = /\/_next\/static\/[^"'\s)\\]+/g;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
      await keepOfflinePage(cache).catch(() => {});
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("leafdesk-static-") && n !== STATIC_CACHE).map((n) => caches.delete(n)),
      );
      await trim(await caches.open(STATIC_CACHE));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(navigate(event, url));
  } else if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(event, request));
  } else if (SHELL.includes(url.pathname) || isAppIcon(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, request));
  }
});

function isAppIcon(pathname) {
  return pathname === "/favicon.ico" || pathname === "/icon.svg" || pathname === "/apple-icon.png";
}

/** The offline page and the scripts and styles it loads, so it works without the network. */
async function keepOfflinePage(cache) {
  const response = await fetch(OFFLINE_URL, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) return;
  const html = await response.clone().text();
  await cache.put(OFFLINE_URL, response);
  const assets = [...new Set(html.match(ASSET) || [])];
  await Promise.all(assets.map((url) => cache.add(url).catch(() => {})));
}

async function navigate(event, url) {
  try {
    const response = await fetch(event.request);
    if (PAGE_PATH.test(url.pathname)) event.waitUntil(keepPage(url.pathname, response.clone()).catch(() => {}));
    if (url.pathname === OFFLINE_URL && response.ok) {
      event.waitUntil(caches.open(STATIC_CACHE).then((c) => keepOfflinePage(c)).catch(() => {}));
    }
    return response;
  } catch {
    return offlineResponse(url);
  }
}

async function readMeta() {
  const cache = await caches.open(META_CACHE);
  const stored = await cache.match("/__leafdesk/meta");
  const meta = stored ? await stored.json().catch(() => null) : null;
  return { owner: (meta && meta.owner) || null, recent: (meta && Array.isArray(meta.recent) && meta.recent) || [] };
}

async function writeMeta(meta) {
  const cache = await caches.open(META_CACHE);
  await cache.put("/__leafdesk/meta", new Response(JSON.stringify(meta), { headers: { "content-type": "application/json" } }));
}

async function dropPageCaches() {
  const names = await caches.keys();
  await Promise.all(names.filter((n) => n.startsWith(PAGE_CACHE_PREFIX)).map((n) => caches.delete(n)));
}

/** Files a signed-in page's HTML under its user; a page that is gone (or no longer theirs) leaves. */
async function keepPage(path, response) {
  const meta = await readMeta();
  if (response.status === 404 || response.status === 403 || response.status === 410) {
    if (!meta.owner) return;
    await (await caches.open(PAGE_CACHE_PREFIX + meta.owner)).delete(path);
    await writeMeta({ owner: meta.owner, recent: meta.recent.filter((p) => p !== path) });
    return;
  }
  const type = response.headers.get("content-type") || "";
  if (!response.ok || response.type !== "basic" || response.redirected || !type.includes("text/html")) return;
  const html = await response.text();
  const marker = USER_MARKER.exec(html);
  if (!marker) return; // not a signed-in page (e.g. the sign-in form after a redirect)
  const owner = marker[1];
  let recent = meta.recent;
  if (meta.owner && meta.owner !== owner) {
    // Someone else signed in on this browser: nothing of the previous user stays.
    await dropPageCaches();
    recent = [];
  }
  const cache = await caches.open(PAGE_CACHE_PREFIX + owner);
  await cache.put(path, new Response(html, { headers: { "content-type": type } }));
  recent = [path, ...recent.filter((p) => p !== path)];
  await Promise.all(recent.slice(MAX_PAGES).map((p) => cache.delete(p)));
  await writeMeta({ owner, recent: recent.slice(0, MAX_PAGES) });
}

async function offlineResponse(url) {
  const meta = await readMeta();
  if (meta.owner) {
    const cache = await caches.open(PAGE_CACHE_PREFIX + meta.owner);
    const kept = await cache.match(url.pathname);
    if (kept) return kept;
    // The installed app starts at "/", which the server sends to a workspace: open the last page.
    if (url.pathname === "/" && meta.recent[0]) return Response.redirect(new URL(meta.recent[0], self.location.origin).href, 302);
  }
  if (url.pathname !== OFFLINE_URL) {
    const target = new URL(OFFLINE_URL, self.location.origin);
    target.searchParams.set("from", url.pathname + url.search);
    return Response.redirect(target.href, 302);
  }
  const page = await caches.match(OFFLINE_URL, { cacheName: STATIC_CACHE });
  return (
    page ||
    new Response("<!doctype html><meta charset=utf-8><title>Offline</title><p>You're offline.</p>", {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  );
}

let puts = 0;
async function cacheFirst(event, request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    const copy = response.clone();
    event.waitUntil(cache.put(request, copy).then(() => (++puts % 50 === 0 ? trim(cache) : undefined)).catch(() => {}));
  }
  return response;
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  const refresh = fetch(request).then(async (response) => {
    if (response.ok) await cache.put(request, response.clone());
    return response;
  });
  if (hit) {
    event.waitUntil(refresh.catch(() => {}));
    return hit;
  }
  return refresh;
}

/** Oldest files first: old builds' scripts go once the cache is over its size. */
async function trim(cache) {
  const keys = await cache.keys();
  const excess = keys.length - MAX_STATIC;
  if (excess <= 0) return;
  const shell = new Set([OFFLINE_URL, ...SHELL].map((p) => new URL(p, self.location.origin).href));
  await Promise.all(keys.filter((k) => !shell.has(k.url)).slice(0, excess).map((k) => cache.delete(k)));
}

// ---------------------------------------------------------------------------------------------
// Push notifications. The server sends { title, body, url, tag, snooze } for a new inbox notification;
// every message shows a notification (browsers require it), a generic one if the data is unusable.

self.addEventListener("push", (event) => {
  event.waitUntil(showPush(readPush(event.data)));
});

/** The message's fields, each checked; null when it carries no usable JSON. */
function readPush(data) {
  let message = null;
  try {
    message = data ? data.json() : null;
  } catch {
    return null;
  }
  if (!message || typeof message !== "object") return null;
  const text = (value) => (typeof value === "string" ? value : "");
  return { title: text(message.title), body: text(message.body), url: text(message.url), tag: text(message.tag), snooze: text(message.snooze) };
}

function showPush(message) {
  const options = {
    body: (message && message.body) || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: sameOriginUrl(message && message.url) },
  };
  // One notification per inbox item: a message sent again replaces it instead of adding another.
  if (message && message.tag) {
    options.tag = message.tag;
    options.data.id = message.tag;
    // The tag is the notification's id: its button snoozes it for an hour (see notificationclick).
    if (message.snooze) options.actions = [{ action: "snooze", title: message.snooze }];
  }
  return self.registration.showNotification((message && message.title) || "Leafdesk", options);
}

/** A link on this app's origin, else the app's start; a message can't send people elsewhere. */
function sameOriginUrl(url) {
  try {
    const target = new URL(url || "/", self.location.origin);
    if (target.origin === self.location.origin) return target.href;
  } catch {}
  return new URL("/", self.location.origin).href;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if (event.action === "snooze" && data.id) {
    event.waitUntil(snooze(data.id));
    return;
  }
  event.waitUntil(openFromNotification(data.url));
});

/** Snoozes the inbox item for an hour, as the signed-in user (the request carries their cookie). */
async function snooze(id) {
  try {
    await fetch(`/api/notifications/${encodeURIComponent(id)}/snooze`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-Leafdesk-Snooze": "1" },
    });
  } catch {}
}

/** Takes an open Leafdesk tab (the focused one first) to `url` and brings it forward, else opens a window there. */
async function openFromNotification(url) {
  const target = sameOriginUrl(url);
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const ours = windows
    .filter((client) => new URL(client.url).origin === self.location.origin)
    .sort((a, b) => Number(b.focused) - Number(a.focused));
  for (const client of ours) {
    try {
      // Only a tab this worker controls can be navigated; another one is tried next.
      const moved = (await client.navigate(target)) || client;
      await moved.focus().catch(() => {});
      return;
    } catch {}
  }
  if (self.clients.openWindow) await self.clients.openWindow(target);
}
