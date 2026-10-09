/**
 * Checks public/sw.js in a real browser: headless Chrome with a throwaway profile, against a small
 * stand-in server that serves the worker and pages shaped like the app's (a signed-in page carries
 * <meta name="leafdesk-user">). The server can "go offline" (it drops every connection).
 * - a signed-in page opened before opens offline from the copy, with its scripts;
 * - a page never opened sends people to /offline, which works offline too; the app's start URL
 *   ("/") goes to the last page opened;
 * - pages are kept per user: another user's page coming in drops the previous user's copies, and
 *   a page that answers 404 is dropped;
 * - API responses and signed-out pages are never kept;
 * - a push message shows a notification (a generic one when its data is unusable), and opening it
 *   takes an open tab to the notification's page, never to another origin.
 *
 *   pnpm tsx scripts/sw-e2e.ts
 *
 * Env: CHROME_PATH (default: Google Chrome on macOS; CI uses /usr/bin/google-chrome). Needs no database.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

// ---------------------------------------------------------------------------------------------
// Stand-in app server.

let offline = false;
const gone = new Set<string>();
const hits: string[] = [];

function html(res: ServerResponse, body: string, status = 200) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8">${body}</head></html>`);
}

const register = `<script>navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });</script>`;
const signedIn = (userId: string, title: string) =>
  `<meta name="leafdesk-user" content="${userId}"><title>${title}</title>${register}<script src="/_next/static/chunks/app-1.js"></script><body><h1>${title}</h1></body>`;

const app = createServer((req, res) => {
  if (offline) {
    req.socket.destroy();
    return;
  }
  const path = new URL(req.url ?? "/", "http://x").pathname;
  hits.push(path);
  if (path === "/sw.js") {
    res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-cache" });
    return res.end(sw);
  }
  if (path.startsWith("/_next/static/")) {
    res.writeHead(200, { "content-type": "application/javascript", "cache-control": "public, max-age=31536000, immutable" });
    return res.end(`window.loadedFrom = ${JSON.stringify(path)};`);
  }
  if (path === "/manifest.webmanifest" || path.startsWith("/icons/")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end("{}");
  }
  if (path === "/offline") {
    return html(res, `<title>Offline</title><script src="/_next/static/chunks/offline-1.js"></script><body><h1>You're offline</h1></body>`);
  }
  if (path === "/api/data") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ at: Date.now() }));
  }
  if (path === "/") {
    res.writeHead(307, { location: "/w/ws1" });
    return res.end();
  }
  if (gone.has(path)) return html(res, "<title>Not found</title>", 404);
  const m = /^\/w\/(ws\d)(?:\/p\/([\w-]+))?$/.exec(path);
  if (m) {
    const [, ws, pageId] = m;
    // Pages of "ws2" are signed in as another user; "signed-out" is the sign-in form.
    if (pageId === "signed-out") return html(res, `<title>Sign in</title><body><h1>Sign in</h1></body>`);
    return html(res, signedIn(ws === "ws2" ? "user-2" : "user-1", `Page ${pageId ?? "home"}`));
  }
  html(res, "<title>?</title>", 404);
});
await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;

// ---------------------------------------------------------------------------------------------
// Headless Chrome over the DevTools protocol (Node's WebSocket, no dependencies).

const profile = mkdtempSync(join(tmpdir(), "leafdesk-sw-e2e-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
]);
const wsUrl = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Chrome did not start")), 15000);
  chrome.stderr.on("data", (chunk: Buffer) => {
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(chunk.toString());
    if (match) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  });
  chrome.on("exit", () => reject(new Error("Chrome exited")));
});

const socket = new WebSocket(wsUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const events: { method: string; sessionId?: string; params?: any }[] = [];
socket.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  } else if (msg.method) events.push({ method: msg.method, sessionId: msg.sessionId, params: msg.params });
});
function send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
}

const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sessionId);

async function go(path: string) {
  events.length = 0;
  await send("Page.navigate", { url: origin + path }, sessionId);
  const until = Date.now() + 10000;
  while (!events.some((e) => e.method === "Page.loadEventFired" && e.sessionId === sessionId)) {
    if (Date.now() > until) throw new Error(`${path} did not load`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function evaluate<T>(expression: string): Promise<T> {
  const { result, exceptionDetails } = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
  return result.value;
}
const page = () => evaluate<{ path: string; h1: string | null; script: string | null }>(
  `({ path: location.pathname + location.search, h1: document.querySelector("h1")?.textContent ?? null, script: window.loadedFrom ?? null })`,
);
const cacheKeys = () =>
  evaluate<Record<string, string[]>>(
    `(async () => { const out = {}; for (const name of await caches.keys()) out[name] = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname); return out; })()`,
  );
/** Keeping a page happens after the response; give the worker a moment. */
const settle = () => new Promise((r) => setTimeout(r, 400));

try {
  // First visit registers the worker; it takes over this tab (clients.claim) once active.
  await go("/w/ws1/p/a");
  check(
    await evaluate<boolean>(`navigator.serviceWorker.ready.then(() => new Promise((r) => { if (navigator.serviceWorker.controller) r(true); else navigator.serviceWorker.oncontrollerchange = () => r(true); setTimeout(() => r(!!navigator.serviceWorker.controller), 5000); }))`),
    "the service worker installs and controls the page",
  );
  await go("/w/ws1/p/a");
  await go("/w/ws1/p/b");
  await go("/w/ws1/p/signed-out");
  await evaluate(`fetch("/api/data").then((r) => r.json())`);
  await settle();
  let keys = await cacheKeys();
  check(JSON.stringify(keys["leafdesk-pages-user-1"]?.sort()) === JSON.stringify(["/w/ws1/p/a", "/w/ws1/p/b"]), "signed-in pages are kept under their user", keys);
  check(!Object.values(keys).flat().some((p) => p.includes("signed-out") || p.startsWith("/api/")), "signed-out pages and API responses are not kept", keys);
  const statics = keys["leafdesk-static-1"] ?? [];
  check(statics.includes("/offline") && statics.includes("/_next/static/chunks/offline-1.js"), "the offline page and its scripts are ready", statics);
  check(statics.includes("/_next/static/chunks/app-1.js"), "the app's scripts are kept", statics);

  offline = true;
  await go("/w/ws1/p/a");
  let now = await page();
  check(now.path === "/w/ws1/p/a" && now.h1 === "Page a" && now.script === "/_next/static/chunks/app-1.js", "offline, a page opened before opens with its scripts", now);
  await go("/w/ws1/p/never-opened");
  now = await page();
  check(now.path === "/offline?from=%2Fw%2Fws1%2Fp%2Fnever-opened" && now.h1 === "You're offline", "a page never opened sends people to the offline page", now);
  check(now.script === "/_next/static/chunks/offline-1.js", "…whose scripts load offline", now);
  await go("/");
  now = await page();
  check(now.path === "/w/ws1/p/b" && now.h1 === "Page b", "the start URL opens the last page opened", now);

  offline = false;
  gone.add("/w/ws1/p/b");
  await go("/w/ws1/p/b");
  await settle();
  keys = await cacheKeys();
  check(JSON.stringify(keys["leafdesk-pages-user-1"]) === JSON.stringify(["/w/ws1/p/a"]), "a page that answers 404 (deleted, no access) is dropped", keys);

  // Someone else signs in on this browser: nothing of the first user stays.
  await go("/w/ws2/p/c");
  await settle();
  keys = await cacheKeys();
  check(!keys["leafdesk-pages-user-1"] && JSON.stringify(keys["leafdesk-pages-user-2"]) === JSON.stringify(["/w/ws2/p/c"]), "another user's page drops the previous user's copies", keys);
  offline = true;
  await go("/w/ws1/p/a");
  now = await page();
  check(now.path.startsWith("/offline"), "…so their pages no longer open offline", now);

  // Push notifications: the DevTools protocol delivers a message as a push service would.
  offline = false;
  await go("/w/ws2/p/c");
  await send("Browser.grantPermissions", { origin, permissions: ["notifications"] });
  events.length = 0;
  await send("ServiceWorker.enable", {}, sessionId);
  let registrationId: string | undefined;
  for (let i = 0; i < 100 && !registrationId; i++) {
    registrationId = events
      .filter((e) => e.method === "ServiceWorker.workerRegistrationUpdated")
      .flatMap((e) => e.params.registrations as { registrationId: string; scopeURL: string; isDeleted: boolean }[])
      .find((r) => r.scopeURL === `${origin}/` && !r.isDeleted)?.registrationId;
    if (!registrationId) await new Promise((r) => setTimeout(r, 25));
  }
  check(registrationId, "the worker's registration is found", events.map((e) => e.method));
  const notifications = (tag?: string) =>
    evaluate<{ title: string; body: string; tag: string; icon: string; url: string }[]>(
      `navigator.serviceWorker.ready.then((r) => r.getNotifications(${tag ? JSON.stringify({ tag }) : ""})).then((ns) => ns.map((n) => ({ title: n.title, body: n.body, tag: n.tag, icon: n.icon, url: n.data && n.data.url })))`,
    );
  const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean) => {
    let value = await read();
    for (let i = 0; i < 100 && !done(value); i++) {
      await new Promise((r) => setTimeout(r, 25));
      value = await read();
    }
    return value;
  };
  const message = { title: "Roadmap", body: "Ayşe mentioned you", url: `${origin}/w/ws2/p/d`, tag: "notification-1" };
  await send("ServiceWorker.deliverPushMessage", { origin, registrationId, data: JSON.stringify(message) }, sessionId);
  let shown = await until(() => notifications("notification-1"), (list) => list.length > 0);
  check(
    shown.length === 1 && shown[0].title === "Roadmap" && shown[0].body === "Ayşe mentioned you" && shown[0].url === message.url && shown[0].icon.endsWith("/icons/icon-192.png"),
    "a push message shows a notification with its title, text and link",
    shown,
  );
  await send("ServiceWorker.deliverPushMessage", { origin, registrationId, data: JSON.stringify({ ...message, body: "Ayşe mentioned you again" }) }, sessionId);
  shown = await until(() => notifications("notification-1"), (list) => list[0]?.body === "Ayşe mentioned you again");
  check(shown.length === 1 && shown[0].body === "Ayşe mentioned you again", "the same notification sent again replaces it", shown);
  await send("ServiceWorker.deliverPushMessage", { origin, registrationId, data: "not json" }, sessionId);
  const all = await until(() => notifications(), (list) => list.length > 1);
  const generic = all.find((n) => n.tag !== "notification-1");
  check(generic?.title === "Leafdesk" && generic.url === `${origin}/`, "a message it can't read still shows a notification, leading to the app", all);

  // Opening a notification (no click possible here): the worker's own handler, run in the worker.
  const { targetInfos } = await send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
  const worker = targetInfos.find((t) => t.type === "service_worker" && t.url === `${origin}/sw.js`);
  check(worker, "the worker can be reached", targetInfos);
  const { sessionId: workerSession } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  const inWorker = async <T>(expression: string) => {
    const { result, exceptionDetails } = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      workerSession,
    );
    if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
    return result.value;
  };
  check(
    (await inWorker<string>(`sameOriginUrl("https://elsewhere.example/w/x")`)) === `${origin}/` &&
      (await inWorker<string>(`sameOriginUrl("javascript:alert(1)")`)) === `${origin}/`,
    "a link to another origin leads to the app instead",
  );
  events.length = 0;
  await inWorker(`openFromNotification(${JSON.stringify(`${origin}/w/ws2/p/d`)})`);
  const deadline = Date.now() + 10000;
  while (!events.some((e) => e.method === "Page.loadEventFired" && e.sessionId === sessionId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  now = await page();
  check(now.path === "/w/ws2/p/d" && now.h1 === "Page d", "opening it takes the open tab to the notification's page", now);

  console.log(`\n${passed} checks passed`);
} finally {
  socket.close();
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
  app.closeAllConnections();
  app.close();
}
