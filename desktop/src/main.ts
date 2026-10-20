/**
 * Leafdesk's desktop app: a window on the person's own Leafdesk server, or on Leafdesk running on
 * this computer (local mode, local-server.ts). The pages come from the server, as in a browser, so
 * the app works with whatever version the server runs and offline use is the web app's own (its
 * service worker). The app adds a window of its own, menus, a screen to pick the server, and a way
 * to trust a server's self-signed certificate.
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  screen,
  session,
  shell,
  systemPreferences,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
  type Rectangle,
  type Session,
  type WebContents,
  type WebPreferences,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CertificateTrust, isCertificateError, type CertificateProblem } from "./certificates.ts";
import { showContextMenu } from "./context-menu.ts";
import { hasSession, signIn, startLocalServer, type BackupResult, type LocalServer } from "./local-server.ts";
import { buildMenu, WEBSITE } from "./menu.ts";
import { APP_SCHEME, decideNavigation, decideNewWindow, isServerPage, signInReturn } from "./navigation.ts";
import { addressCandidates, hostOf, isLeafdeskManifest } from "./server-address.ts";
import { loadSettings, saveSettings, type Settings } from "./settings.ts";
import { direction, isLocale, pickLocale, STRINGS, type Locale } from "./strings.ts";
import { startUpdates } from "./updates.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const PAGE = path.join(APP_DIR, "pages", "app.html");
const PAGES_URL = `${pathToFileURL(path.join(APP_DIR, "pages")).href}/`;
const PRELOAD = path.join(import.meta.dirname, "preload.cjs");
const ICON = path.join(APP_DIR, "build", "icon.png");
/**
 * The Leafdesk server local mode runs: the one shipped in the app's resources (scripts/bundle-server.ts),
 * or, run from the source, the repository's around the app's folder.
 */
const SERVER_DIR = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(APP_DIR, "..");
/** The web app's own background (src/lib/theme.ts), so a window doesn't flash before it paints. */
const BACKGROUND = { light: "#ffffff", dark: "#18191b" };
const PROBE_TIMEOUT_MS = 10_000;
/** The language picked in Leafdesk (src/i18n/config.ts); the app's own words follow it. */
const LOCALE_COOKIE = "NEXT_LOCALE";
/** What the server's pages may ask for: notifications, the clipboard, full screen and the microphone (voice notes). */
const PERMISSIONS = new Set(["notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen", "media"]);
/**
 * macOS: no title bar of its own; the window's buttons sit in the page's top-left corner, centered on
 * the web app's 44px header row. The preload marks the page (`<html data-window-controls>`) so the
 * web app keeps that corner clear and lets the top strip move the window (src/app/globals.css).
 */
const INSET_WINDOW_CONTROLS = process.platform === "darwin";
const TRAFFIC_LIGHTS = { x: 16, y: 16 };

/** What the app's own page shows. */
type View =
  | { view: "connect"; address?: string }
  | { view: "starting" }
  | { view: "problem"; server: string; detail: string; certificate?: CertificateProblem; local?: boolean };

type Probe =
  | { kind: "ok"; origin: string }
  | { kind: "not-leafdesk"; origin: string }
  | { kind: "certificate"; certificate: CertificateProblem }
  | { kind: "unreachable" };

export type ConnectReply =
  | { ok: true }
  | { error: "invalid" }
  | { error: "unreachable"; host: string }
  | { error: "not-leafdesk"; host: string }
  | { error: "certificate"; host: string; certificate: CertificateProblem };

let settings: Settings = { trustedCertificates: {} };
let locale: Locale = "en";
let mainWindow: BrowserWindow | null = null;
/** Leafdesk on this computer, once started (local mode). */
let localServer: Promise<LocalServer> | null = null;
let quitting = false;
/** A `leafdesk://` link that came before the app started. */
let waitingLink: string | undefined;
let started = false;
const views = new WeakMap<WebContents, View>();
const certificates = new CertificateTrust(() => settings.trustedCertificates);

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
const save = () => saveSettings(settingsFile(), settings);
const strings = () => STRINGS[locale];
const systemLocale = () => pickLocale(app.getPreferredSystemLanguages());
/** Whether this app can run Leafdesk itself: it has the server (a package built without it doesn't). */
const localAvailable = () => fs.existsSync(path.join(SERVER_DIR, app.isPackaged ? "server.mjs" : "server.ts"));
const isLocal = () => settings.mode === "local" && localAvailable();
/** The origin of the pages the app shows: the connected server's, or Leafdesk's on this computer once it runs. */
let localOrigin: string | undefined;
const currentOrigin = () => (isLocal() ? localOrigin : settings.server);

// The app run from its source keeps its settings and its Leafdesk apart from an installed one's
// (unless it is given a folder of its own, --user-data-dir).
if (!app.isPackaged && !app.commandLine.hasSwitch("user-data-dir")) app.setPath("userData", path.join(app.getPath("appData"), "Leafdesk Dev"));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // macOS hands the app its `leafdesk://` links here, including the one that started it.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    followAppLink(url);
  });
  app.on("second-instance", (_event, argv) => {
    // Windows and Linux start the app again for a `leafdesk://` link.
    const link = appLinkIn(argv);
    if (link) return followAppLink(link);
    const window = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (!window) return openMainWindow();
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  // Leafdesk on this computer stops before the app does, so its pages' last edits are saved.
  app.on("before-quit", (event) => {
    if (!localServer) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void stopLocal().finally(() => app.quit());
  });
  void app.whenReady().then(start);
}

function start() {
  settings = loadSettings(settingsFile());
  locale = systemLocale();
  app.userAgentFallback = plainUserAgent(app.userAgentFallback);
  if (process.platform === "win32") app.setAppUserModelId("io.github.esmworks.leafdesk");
  // The app run from its source leaves the scheme to the installed one.
  if (app.isPackaged) app.setAsDefaultProtocolClient(APP_SCHEME);
  app.setAboutPanelOptions({ applicationName: "Leafdesk", applicationVersion: app.getVersion(), website: WEBSITE });

  const ses = session.defaultSession;
  certificates.install(ses);
  guardPermissions(ses);
  setSpellCheckerLanguages(ses);
  followLeafdeskLanguage(ses);
  registerPageBridge();
  refreshMenu();
  openMainWindow();
  started = true;
  const link = waitingLink ?? appLinkIn(process.argv);
  waitingLink = undefined;
  if (link) followAppLink(link);
  startUpdates(strings);

  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) openMainWindow();
  });
}

/**
 * The browser's user agent without the Electron and app tokens: some sign-in pages (Google's)
 * turn down embedded browsers by them, while this window is a full Chromium.
 */
function plainUserAgent(agent: string) {
  const names = [...new Set(["Electron", app.getName(), "leafdesk-desktop"])].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return agent.replace(new RegExp(` (?:${names.join("|")})/\\S+`, "g"), "");
}

function refreshMenu() {
  Menu.setApplicationMenu(
    buildMenu(strings(), {
      changeServer: () => {
        const window = mainWindow ?? openMainWindow();
        showView(window, { view: "connect", address: settings.server });
        window.focus();
      },
      goHome: (window) => {
        if (isLocal() || settings.server) openCurrent(window);
      },
      backups: localServer ? { now: () => void backUpNow(), show: showBackups, chooseFolder: () => void chooseBackupFolder() } : undefined,
    }),
  );
}

/** Where Leafdesk on this computer keeps its backups: the folder picked, or one in Documents. */
const backupFolder = () => settings.backupFolder ?? path.join(app.getPath("documents"), "Leafdesk Backups");

/** A backup asked for from the menu, and what came of it. */
async function backUpNow() {
  const server = await localServer?.catch(() => null);
  if (!server) return;
  const result = await server.backUp();
  lastBackupProblem = result.errors.length ? result.errors.join("\n") : undefined;
  const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
  const box = result.errors.length
    ? { type: "warning" as const, message: strings().backupFailed, detail: result.errors.join("\n") }
    : { type: "info" as const, message: strings().backupDone, detail: result.folder };
  if (window) await dialog.showMessageBox(window, box);
  else await dialog.showMessageBox(box);
}

function showBackups() {
  const folder = backupFolder();
  fs.mkdirSync(folder, { recursive: true });
  void shell.openPath(folder);
}

async function chooseBackupFolder() {
  const options = { defaultPath: backupFolder(), properties: ["openDirectory" as const, "createDirectory" as const] };
  const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
  const { canceled, filePaths } = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  if (canceled || !filePaths[0]) return;
  settings.backupFolder = filePaths[0];
  save();
  (await localServer?.catch(() => null))?.setBackupFolder(filePaths[0]);
}

/** The last scheduled backup's problem, told once: the server tries again every hour. */
let lastBackupProblem: string | undefined;
function reportBackup(result: BackupResult) {
  const problem = result.errors.length ? result.errors.join("\n") : undefined;
  if (problem && problem !== lastBackupProblem && Notification.isSupported()) {
    new Notification({ title: strings().backupFailed, body: problem }).show();
  }
  lastBackupProblem = problem;
}

function webPreferences(): WebPreferences {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    spellcheck: true,
    additionalArguments: INSET_WINDOW_CONTROLS ? ["--leafdesk-window-controls=inset"] : [],
  };
}

/** The title bar: the system's, or on macOS none, with the window's buttons over the page. */
function titleBar(): BrowserWindowConstructorOptions {
  return INSET_WINDOW_CONTROLS ? { titleBarStyle: "hidden", trafficLightPosition: TRAFFIC_LIGHTS } : {};
}

/**
 * Tells the page when the window enters or leaves full screen, where macOS hides the window's
 * buttons; a page that loads asks (registerPageBridge), so it doesn't first draw room for them.
 */
function reportFullScreen(window: BrowserWindow) {
  if (!INSET_WINDOW_CONTROLS) return;
  const send = () => {
    if (!window.isDestroyed()) window.webContents.send("leafdesk:full-screen", window.isFullScreen());
  };
  window.on("enter-full-screen", send);
  window.on("leave-full-screen", send);
}

function createWindow(bounds?: Partial<Rectangle>) {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    ...bounds,
    minWidth: 420,
    minHeight: 480,
    show: false,
    title: "Leafdesk",
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    icon: process.platform === "linux" ? ICON : undefined,
    ...titleBar(),
    webPreferences: webPreferences(),
  });
  reportFullScreen(window);
  window.once("ready-to-show", () => window.show());
  // A page that never paints (a server that holds the connection open) still gets its window.
  setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) window.show();
  }, 3000);
  guard(window.webContents);
  return window;
}

function openMainWindow() {
  const window = createWindow(restoredBounds());
  mainWindow = window;
  if (settings.window?.maximized) window.maximize();
  window.on("close", () => {
    settings.window = { ...window.getNormalBounds(), maximized: window.isMaximized() };
    save();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  if (isLocal() || settings.server) openCurrent(window);
  else showView(window, { view: "connect" });
  return window;
}

function appLinkIn(argv: string[]) {
  return argv.find((arg) => arg.startsWith(`${APP_SCHEME}:`));
}

/**
 * A `leafdesk://` link: the answer of a service the person signed in to in the system's browser
 * (navigation.ts), which the window takes back to the server to finish under its session.
 */
function followAppLink(link: string) {
  if (!started) {
    waitingLink = link;
    return;
  }
  const target = signInReturn(link, currentOrigin());
  if (!target) return;
  const window = mainWindow ?? openMainWindow();
  if (window.isMinimized()) window.restore();
  views.delete(window.webContents);
  window.loadURL(target).catch(() => undefined);
  window.focus();
}

/** The size and place the window had, unless that place is off every screen now. */
function restoredBounds(): Partial<Rectangle> | undefined {
  const saved = settings.window;
  if (!saved) return undefined;
  const { x, y, width, height } = saved;
  if (x === undefined || y === undefined) return { width, height };
  const onScreen = screen
    .getAllDisplays()
    .some(({ workArea: area }) => x < area.x + area.width - 100 && x + width > area.x + 100 && y >= area.y - 20 && y < area.y + area.height - 100);
  return onScreen ? { x, y, width, height } : { width, height };
}

function openCurrent(window: BrowserWindow) {
  if (isLocal()) void openLocal(window);
  else openServer(window);
}

function openServer(window: BrowserWindow) {
  if (!settings.server) return;
  views.delete(window.webContents);
  // A failed load is shown by did-fail-load (guard), not here.
  window.loadURL(`${settings.server}/`).catch(() => undefined);
}

/**
 * Starts Leafdesk on this computer (once), signs in to its account, and opens its home. `signedOut`:
 * the window came to the sign-in page, so the session is gone whatever the cookies say.
 */
async function openLocal(window: BrowserWindow, signedOut = false) {
  if (!localServer) showView(window, { view: "starting" });
  try {
    const server = await startLocal();
    await signInLocally(server, signedOut);
    readLeafdeskLanguage(session.defaultSession);
    if (window.isDestroyed() || !isLocal()) return;
    views.delete(window.webContents);
    window.loadURL(`${server.origin}/`).catch(() => undefined);
  } catch (error) {
    console.error("Leafdesk on this computer didn't start:", error);
    if (!window.isDestroyed()) showLocalProblem(window, error instanceof Error ? error.message : String(error));
  }
}

function startLocal(): Promise<LocalServer> {
  localServer ??= startLocalServer({
    serverDir: SERVER_DIR,
    root: path.join(app.getPath("userData"), "Local"),
    port: settings.localPort,
    // Electron's own Node runs the server.
    node: process.execPath,
    nodeEnv: { ELECTRON_RUN_AS_NODE: "1" },
    dev: !app.isPackaged,
    backupFolder: backupFolder(),
  }).then(
    (server) => {
      localOrigin = server.origin;
      server.onBackup(reportBackup);
      refreshMenu();
      if (settings.localPort !== server.port) {
        settings.localPort = server.port;
        save();
      }
      server.onExit((code) => {
        localServer = null;
        refreshMenu();
        void server.stop();
        for (const window of BrowserWindow.getAllWindows()) {
          if (isServerPage(window.webContents.getURL(), server.origin)) {
            showLocalProblem(window, `Leafdesk's server stopped with ${code}; see ${server.log}`);
          }
        }
      });
      return server;
    },
    (error: unknown) => {
      localServer = null;
      throw error;
    },
  );
  return localServer;
}

/** Stops Leafdesk on this computer, if it runs (or is starting). */
async function stopLocal() {
  const starting = localServer;
  localServer = null;
  localOrigin = undefined;
  const server = await starting?.catch(() => null);
  if (server) refreshMenu();
  await server?.stop().catch((error: unknown) => console.error("Leafdesk on this computer didn't stop cleanly:", error));
}

function showLocalProblem(window: BrowserWindow, detail: string) {
  showView(window, { view: "problem", server: "", detail, local: true });
}

/** The app's browser gets a session of the computer's account, unless it has one the server still knows. */
async function signInLocally(server: LocalServer, signedOut: boolean) {
  const ses = session.defaultSession;
  const cookies = await ses.cookies.get({ url: server.origin });
  if (!signedOut && (await hasSession(server.origin, cookies.map(({ name, value }) => `${name}=${value}`).join("; ")))) return;
  const now = Date.now() / 1000;
  for (const cookie of await signIn(server.origin, server.account)) {
    await ses.cookies.set({
      url: server.origin,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      expirationDate: cookie.maxAge === undefined ? undefined : now + cookie.maxAge,
    });
  }
}

function showView(window: BrowserWindow, view: View) {
  views.set(window.webContents, view);
  window.loadFile(PAGE).catch(() => undefined);
}

/** Navigation, new windows, failed loads and the context menu of a window's page. */
function guard(contents: WebContents) {
  contents.on("will-navigate", (event) => {
    const decision = decideNavigation(event.url, PAGES_URL, currentOrigin());
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") void shell.openExternal(event.url);
  });
  contents.on("will-redirect", (event) => {
    if (decideNavigation(event.url, PAGES_URL) !== "allow") event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    const decision = decideNewWindow(url, currentOrigin());
    if (decision === "window") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 1100,
          height: 800,
          backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
          ...titleBar(),
          webPreferences: webPreferences(),
        },
      };
    }
    if (decision === "external") void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (child) => {
    reportFullScreen(child);
    guard(child.webContents);
  });
  // Signing out of Leafdesk on this computer leads to its sign-in page: the app signs in again.
  contents.on("did-navigate", (_event, url) => {
    const window = BrowserWindow.fromWebContents(contents);
    if (window && isLocal() && localOrigin && isServerPage(url, localOrigin) && new URL(url).pathname === "/sign-in") void openLocal(window, true);
  });
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 is a load that was cancelled, by a newer one for instance.
    if (!isMainFrame || code === -3) return;
    const window = BrowserWindow.fromWebContents(contents);
    if (!window) return;
    if (isLocal()) {
      if (localOrigin && isServerPage(url, localOrigin)) showLocalProblem(window, description);
      return;
    }
    if (!settings.server || !isServerPage(url, settings.server)) return;
    const certificate = isCertificateError(description) ? certificates.problems.get(new URL(settings.server).hostname) : undefined;
    showView(window, { view: "problem", server: settings.server, detail: description, certificate });
  });
  contents.on("context-menu", (_event, params) => showContextMenu(contents, params, strings()));
  contents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") contents.reload();
  });
}

/** Only the connected server's pages get permissions, and only those it uses. */
function guardPermissions(ses: Session) {
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (!isServerPage(details.requestingUrl, currentOrigin()) || !PERMISSIONS.has(permission)) return callback(false);
    if (permission !== "media") return callback(true);
    const types = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
    if (types.includes("video")) return callback(false);
    if (process.platform !== "darwin") return callback(true);
    systemPreferences.askForMediaAccess("microphone").then(callback, () => callback(false));
  });
  ses.setPermissionCheckHandler((_contents, permission, origin) => isServerPage(origin, currentOrigin()) && PERMISSIONS.has(permission));
}

/** macOS and Windows check spelling in the system's languages; elsewhere the session needs them. */
function setSpellCheckerLanguages(ses: Session) {
  if (process.platform === "darwin" || process.platform === "win32") return;
  const available = ses.availableSpellCheckerLanguages;
  const base = (tag: string) => tag.toLowerCase().split(/[-_]/)[0];
  const languages = app
    .getPreferredSystemLanguages()
    .map((tag) => available.find((code) => code.toLowerCase() === tag.toLowerCase()) ?? available.find((code) => base(code) === base(tag)))
    .filter((code): code is string => !!code);
  if (languages.length) ses.setSpellCheckerLanguages([...new Set(languages)].slice(0, 3));
}

/** The app's menus and own pages switch language with Leafdesk's language setting. */
function followLeafdeskLanguage(ses: Session) {
  ses.cookies.on("changed", (_event, cookie, cause, removed) => {
    const origin = currentOrigin();
    if (cookie.name !== LOCALE_COOKIE || cause === "overwrite" || !origin) return;
    if (cookie.domain?.replace(/^\./, "") !== new URL(origin).hostname) return;
    applyLocale(removed ? undefined : cookie.value);
  });
  readLeafdeskLanguage(ses);
}

function readLeafdeskLanguage(ses: Session) {
  const origin = currentOrigin();
  if (!origin) return applyLocale(undefined);
  ses.cookies.get({ url: origin, name: LOCALE_COOKIE }).then(
    ([cookie]) => applyLocale(cookie?.value),
    () => undefined,
  );
}

function applyLocale(value: string | undefined) {
  const next = value && isLocale(value) ? value : systemLocale();
  if (next === locale) return;
  locale = next;
  refreshMenu();
}

/** Whether a server answers at an origin, and whether it is Leafdesk: its health check and manifest. */
async function probe(origin: string, redirects = 1): Promise<Probe> {
  const ses = session.defaultSession;
  const get = (url: string) => ses.fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  try {
    const health = await get(`${origin}/api/health`);
    const location = health.headers.get("location");
    // A server that sends plain HTTP on to HTTPS (or to another host) is kept by where it sends.
    if (health.status >= 300 && health.status < 400 && location && redirects > 0) {
      return probe(new URL(location, `${origin}/`).origin, redirects - 1);
    }
    const healthy = health.ok && ((await health.json().catch(() => null)) as { status?: unknown } | null)?.status === "ok";
    if (!healthy) return { kind: "not-leafdesk", origin };
    const manifest = await get(`${origin}/manifest.webmanifest`);
    const leafdesk = manifest.ok && isLeafdeskManifest(await manifest.json().catch(() => null));
    return leafdesk ? { kind: "ok", origin } : { kind: "not-leafdesk", origin };
  } catch (error) {
    const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
    console.warn(`No answer from ${origin}:`, message);
    const certificate = isCertificateError(message) ? certificates.problems.get(new URL(origin).hostname) : undefined;
    if (!certificate) return { kind: "unreachable" };
    certificate.origin = origin;
    return { kind: "certificate", certificate };
  }
}

async function connect(address: string, force: boolean): Promise<{ reply: ConnectReply; origin?: string }> {
  const candidates = addressCandidates(address);
  if (!candidates) return { reply: { error: "invalid" } };
  let reply: ConnectReply = { error: "unreachable", host: hostOf(candidates[0]) };
  for (const origin of candidates) {
    const untrusted = await certificates.inspect(origin);
    if (untrusted) return { reply: { error: "certificate", host: untrusted.host, certificate: untrusted } };
    const result = await probe(origin);
    if (result.kind === "ok") return { reply: { ok: true }, origin: result.origin };
    // Never falls back to plain HTTP past a certificate it couldn't check.
    if (result.kind === "certificate") return { reply: { error: "certificate", host: result.certificate.host, certificate: result.certificate } };
    if (result.kind === "not-leafdesk") {
      if (force) return { reply: { ok: true }, origin: result.origin };
      reply = { error: "not-leafdesk", host: hostOf(result.origin) };
    }
  }
  return { reply };
}

/** The bridge pages/app.html talks to (preload.cts); nothing else may call it. */
function registerPageBridge() {
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!event.senderFrame?.url.startsWith(PAGES_URL)) throw new Error("Not allowed");
      return listener(event, ...args);
    });
  const windowOf = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender);

  // Every page's preload asks this, the server's too: it tells nothing but the window's state.
  ipcMain.on("leafdesk:full-screen", (event) => {
    event.returnValue = BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false;
  });

  handle("leafdesk:state", (event) => ({
    locale,
    dir: direction(locale),
    strings: strings(),
    current: isLocal() ? "local" : settings.server,
    localAvailable: localAvailable(),
    ...(views.get(event.sender) ?? { view: "connect" }),
  }));

  handle("leafdesk:local", (event) => {
    const window = windowOf(event);
    if (!localAvailable() || !window) return;
    settings.mode = "local";
    save();
    void openLocal(window);
  });

  handle("leafdesk:connect", async (event, address, force) => {
    if (typeof address !== "string") return { error: "invalid" } satisfies ConnectReply;
    const { reply, origin } = await connect(address, force === true);
    const window = windowOf(event);
    if (origin && window) {
      settings.server = origin;
      settings.mode = undefined;
      save();
      void stopLocal();
      readLeafdeskLanguage(session.defaultSession);
      openServer(window);
    }
    return reply;
  });

  handle("leafdesk:trust", (_event, host, fingerprint) => {
    const problem = typeof host === "string" ? certificates.problems.get(host) : undefined;
    // Only the certificate the page showed: one that changed meanwhile has to be looked at again.
    if (!problem || problem.fingerprint !== fingerprint) return { ok: false };
    settings.trustedCertificates[problem.host] = problem.fingerprint;
    certificates.problems.delete(problem.host);
    if (!problem.seenByChromium) {
      save();
      return { ok: true };
    }
    // Chromium already turned this certificate down and keeps that until the app restarts.
    if (problem.origin) {
      settings.server = problem.origin;
      settings.mode = undefined;
    }
    save();
    app.relaunch();
    // Leaving without "before-quit": Leafdesk on this computer is stopped here.
    void stopLocal().finally(() => app.exit(0));
    return { ok: true };
  });

  handle("leafdesk:retry", (event) => {
    const window = windowOf(event);
    if (window) openCurrent(window);
  });
}
