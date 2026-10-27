/**
 * Leafdesk's desktop app: a window on the person's own Leafdesk server, or on Leafdesk running on
 * this computer (local mode, local-server.ts). The pages come from the server, as in a browser, so
 * the app works with whatever version the server runs and offline use is the web app's own (its
 * service worker). The app adds windows of its own with tabs (windows.ts), menus, a screen to pick
 * the server, and a way to trust a server's self-signed certificate.
 */
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
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
import { activeShortcut, aiChatPath, defaultShortcut, SHORTCUT_OFF, shortcutChoices, workspaceIn } from "./global-shortcut.ts";
import { pageToRemember, startPath } from "./last-page.ts";
import { hasSession, signIn, startLocalServer, type BackupResult, type LocalServer } from "./local-server.ts";
import { buildMenu, WEBSITE } from "./menu.ts";
import { allowsFrameRedirect, APP_SCHEME, awayHost, decideNavigation, decideNewWindow, isServerPage, openLinkTarget, showsFile, signInReturn } from "./navigation.ts";
import { addressCandidates, followsRedirect, hostOf, isLeafdeskManifest, needsHttpConfirmation } from "./server-address.ts";
import { loadSettings, saveSettings, type Settings } from "./settings.ts";
import { direction, fill, isLocale, pickLocale, STRINGS, type Locale } from "./strings.ts";
import { ClosedTabs, readIcon, readStripRoom, tabPath, windowsToRestore, type SavedWindow } from "./tabs.ts";
import { startUpdates } from "./updates.ts";
import { STRIP_HEIGHT, TabbedWindow } from "./windows.ts";

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
/** The web app's own background (src/lib/theme.ts), so a tab doesn't flash before it paints. */
const BACKGROUND = { light: "#ffffff", dark: "#18191b" };
/** The tab strip's background and text (the web app's shell and fg), for the window's buttons outside macOS. */
const STRIP = { light: { color: "#f0f0ee", symbolColor: "#1d1d1d" }, dark: { color: "#0f0f0f", symbolColor: "#ededed" } };
const PROBE_TIMEOUT_MS = 10_000;
/** The language picked in Leafdesk (src/i18n/config.ts); the app's own words follow it. */
const LOCALE_COOKIE = "NEXT_LOCALE";
/** The theme picked in Leafdesk (src/lib/theme.ts); the tab strip and the app's menus follow it. */
const THEME_COOKIE = "theme";
/**
 * What the server's pages may ask for: notifications, writing to the clipboard (never reading it:
 * pasting is the person's own doing), full screen and the microphone (voice notes), which the
 * person allows for each server (allowMicrophone).
 */
const PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write", "fullscreen", "media"]);
/** How long a tab may stay away from the server signing in at an identity provider (navigation.ts). */
const SIGN_IN_TRIP_MS = 15 * 60_000;
/**
 * macOS: no title bar of its own; the window's buttons sit at the window's top-left corner,
 * centered on the strip's height: over the first row of a page's sidebar, which the strip lies
 * beside (windows.ts), else at the strip's start. The preload marks the strip's page
 * (`<html data-window-controls>`) and the server's (`<html data-tab-strip>`) so they keep that room.
 */
const INSET_WINDOW_CONTROLS = process.platform === "darwin";
const TRAFFIC_LIGHTS = { x: 16, y: 16 };
const SAVE_DELAY_MS = 500;

/** What the app's own page shows. */
type View =
  | { view: "connect"; address?: string }
  | { view: "starting" }
  | { view: "problem"; server: string; detail: string; certificate?: CertificateProblem; local?: boolean };

type Probe =
  | { kind: "ok"; origin: string }
  | { kind: "not-leafdesk"; origin: string }
  /** It sends the app on to another host, or down to plain HTTP (`target`): the person says yes first. */
  | { kind: "redirect"; origin: string; target: string }
  | { kind: "certificate"; certificate: CertificateProblem }
  | { kind: "unreachable" };

/**
 * What connecting came to. `target` is an origin the page offers to connect to anyway: it comes
 * back in `accepted` when the person says yes (`confirm`: plain HTTP the app tried on its own, or a
 * redirect to another host).
 */
export type ConnectReply =
  | { ok: true }
  | { error: "invalid" }
  | { error: "unreachable"; host: string }
  | { error: "not-leafdesk"; host: string; target: string }
  | { error: "confirm"; reason: "http" | "redirect"; host: string; target: string }
  | { error: "certificate"; host: string; certificate: CertificateProblem };

let settings: Settings = { trustedCertificates: {}, validCertificateHosts: [] };
let locale: Locale = "en";
/** The window last in front: the global shortcut and `leafdesk://` links go to it. */
let lastWindow: TabbedWindow | null = null;
/** Leafdesk on this computer, once started (local mode). */
let localServer: Promise<LocalServer> | null = null;
/** Leafdesk on this computer answers: its tabs open its pages at once. */
let localReady = false;
let quitting = false;
/** The app is quitting: its windows close with it, and their tabs are kept as they were. */
let appQuitting = false;
/** A `leafdesk://` link that came before the app started. */
let waitingLink: string | undefined;
let started = false;
const views = new WeakMap<WebContents, View>();
/** The origins being tried by the connect screen now: their hosts' good certificates are remembered too. */
let connecting: string[] = [];
const certificates = new CertificateTrust({
  trusted: () => settings.trustedCertificates,
  validHosts: () => settings.validCertificateHosts,
  seenValid: rememberValidCertificate,
});
const closedTabs = new ClosedTabs();
/** Tabs signing in at an identity provider, away from the server: until when they may (navigation.ts). */
const signInTrips = new WeakMap<WebContents, number>();
/** The servers whose pages were refused the microphone in this run: asked again at the next start. */
const microphoneRefused = new Set<string>();
const microphoneAsked = new Map<string, Promise<boolean>>();

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
    const window = liveWindow();
    if (!window) return openWindows();
    bringForward(window);
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  // Leafdesk on this computer stops before the app does, so its pages' last edits are saved.
  app.on("before-quit", (event) => {
    appQuitting = true;
    rememberTabsNow();
    if (!localServer) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void stopLocal().finally(() => app.quit());
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
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
  followLeafdeskTheme(ses);
  registerPageBridge();
  registerTabBridge();
  refreshMenu();
  openWindows();
  applyShortcut();
  started = true;
  const link = waitingLink ?? appLinkIn(process.argv);
  waitingLink = undefined;
  if (link) followAppLink(link);
  startUpdates(strings);

  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) openWindows();
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

/** The window a menu item acts on: the one in front, if it has tabs. */
const tabbed = (window: BrowserWindow | undefined) => TabbedWindow.fromBrowserWindow(window);

function refreshMenu() {
  Menu.setApplicationMenu(
    buildMenu(strings(), {
      changeServer: () => {
        const window = liveWindow() ?? openWindow();
        const contents = window.activeContents();
        if (contents) showView(contents, { view: "connect", address: settings.server });
        bringForward(window);
      },
      forgetCertificates: Object.keys(settings.trustedCertificates).length ? forgetCertificates : undefined,
      goHome: (window) => {
        const contents = tabbed(window)?.activeContents();
        if (contents && (isLocal() || settings.server)) openCurrent(contents);
      },
      tab: (window) => tabbed(window)?.activeContents() ?? window.webContents,
      tabs: {
        newTab: (window) => {
          const owner = tabbed(window);
          if (owner) owner.addTab({ path: newTabPath(owner) });
          else openWindow({ tabs: [{ path: "/" }], active: 0 });
        },
        newWindow: () => openWindow({ tabs: [{ path: newTabPath(liveWindow()) }], active: 0 }),
        closeTab: (window) => {
          const owner = tabbed(window);
          if (owner?.list.active != null) owner.closeTab(owner.list.active);
          else window?.close();
        },
        reopenClosedTab: (window) => reopenClosedTab(tabbed(window)),
        nextTab: (window) => switchTab(tabbed(window), 1),
        previousTab: (window) => switchTab(tabbed(window), -1),
      },
      backups: localServer ? { now: () => void backUpNow(), show: showBackups, chooseFolder: () => void chooseBackupFolder() } : undefined,
      shortcut: {
        choices: shortcutChoices(process.platform),
        current: activeShortcut(settings.globalShortcut, process.platform),
        inUse: shortcutInUse,
        pick: (accelerator) => {
          settings.globalShortcut = accelerator === null ? SHORTCUT_OFF : accelerator === defaultShortcut(process.platform) ? undefined : accelerator;
          save();
          applyShortcut();
        },
      },
    }),
  );
}

function switchTab(window: TabbedWindow | undefined, step: number) {
  const target = window?.list.neighbour(step);
  if (window && target != null) window.showTab(target);
}

/** The global shortcut registered with the system now, and whether the one picked is another app's. */
let registeredShortcut: string | null = null;
let shortcutInUse = false;

/**
 * Registers the global shortcut picked in the menu in place of the one before, once there is a
 * server or Leafdesk on this computer to open. Keys another app holds are told in the menu.
 */
function applyShortcut() {
  if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
  registeredShortcut = null;
  shortcutInUse = false;
  const accelerator = activeShortcut(settings.globalShortcut, process.platform);
  if (accelerator && (isLocal() || settings.server)) {
    let registered = false;
    try {
      registered = globalShortcut.register(accelerator, openAiChat);
    } catch (error) {
      console.warn(`The global shortcut ${accelerator} couldn't be registered:`, error);
    }
    if (registered) registeredShortcut = accelerator;
    else {
      shortcutInUse = true;
      console.warn(`The global shortcut ${accelerator} is in use by another app.`);
    }
  }
  refreshMenu();
}

/** The window last in front, if it is still open. */
function liveWindow(): TabbedWindow | null {
  if (lastWindow && !lastWindow.window.isDestroyed()) return lastWindow;
  return TabbedWindow.all().at(-1) ?? null;
}

function bringForward(window: TabbedWindow) {
  if (window.window.isMinimized()) window.window.restore();
  window.window.show();
  window.window.focus();
}

/**
 * The global shortcut: Leafdesk comes forward on AI chat (the server's `/ai`, which sends a
 * workspace without AI to a quick note) in the workspace the shown tab is in. The app's own
 * screens (connecting, starting, a problem) only come forward.
 */
function openAiChat() {
  if (process.platform === "darwin") app.focus({ steal: true });
  const window = liveWindow();
  if (!window) {
    openWindow({ tabs: [{ path: aiChatPath() }], active: 0 });
    return;
  }
  bringForward(window);
  const origin = currentOrigin();
  const contents = window.activeContents();
  const url = contents?.getURL();
  if (!origin || !contents || views.has(contents) || !isServerPage(url, origin)) return;
  contents.loadURL(`${origin}${aiChatPath(workspaceIn(url!, origin))}`).catch(() => undefined);
}

/** Where a new tab opens: the home of the workspace the window's shown tab is in, else the server's. */
function newTabPath(window: TabbedWindow | null | undefined) {
  const origin = currentOrigin();
  const url = window?.activeContents()?.getURL();
  const workspace = origin && url ? workspaceIn(url, origin) : undefined;
  return workspace ? `/w/${encodeURIComponent(workspace)}` : "/";
}

/** Opens the tab closed last again, in the window in front (or a new one), where it was. */
function reopenClosedTab(window: TabbedWindow | undefined) {
  const closed = closedTabs.pop();
  if (!closed) return;
  const target = isServerPage(closed.url, currentOrigin()) ? { url: closed.url } : { path: "/" };
  if (window) window.addTab(target, { index: closed.index });
  else openWindow({ tabs: [{ path: tabPath(closed.url, currentOrigin()) }], active: 0 });
}

/** Where Leafdesk on this computer keeps its backups: the folder picked, or one in Documents. */
const backupFolder = () => settings.backupFolder ?? path.join(app.getPath("documents"), "Leafdesk Backups");

/** A backup asked for from the menu, and what came of it. */
async function backUpNow() {
  const server = await localServer?.catch(() => null);
  if (!server) return;
  const result = await server.backUp();
  lastBackupProblem = result.errors.length ? result.errors.join("\n") : undefined;
  const window = BrowserWindow.getFocusedWindow() ?? liveWindow()?.window;
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
  const window = BrowserWindow.getFocusedWindow() ?? liveWindow()?.window;
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

/**
 * A page's settings: the tab strip's or a tab's (both told where the window's buttons are), or a
 * window's of its own that shows one of the server's files.
 */
function webPreferences(page: "strip" | "tab" | "file"): WebPreferences {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    spellcheck: page !== "strip",
    additionalArguments: page !== "file" && INSET_WINDOW_CONTROLS ? ["--leafdesk-window-controls=inset"] : [],
  };
}

const dark = () => nativeTheme.shouldUseDarkColors;

/**
 * The title bar: none. On macOS the window's buttons sit at the tab strip's start; elsewhere the
 * system's buttons are drawn over the strip's end, in its colors.
 */
function titleBar(): BrowserWindowConstructorOptions {
  if (INSET_WINDOW_CONTROLS) return { titleBarStyle: "hidden", trafficLightPosition: TRAFFIC_LIGHTS };
  return { titleBarStyle: "hidden", titleBarOverlay: { ...STRIP[dark() ? "dark" : "light"], height: STRIP_HEIGHT } };
}

/**
 * Tells the strip and the tabs' pages when the window enters or leaves full screen, where macOS
 * hides the window's buttons; a page asks when it loads (registerPageBridge), so it doesn't first
 * draw room for them.
 */
function reportFullScreen(owner: TabbedWindow) {
  if (!INSET_WINDOW_CONTROLS) return;
  const { window } = owner;
  const send = () => {
    if (window.isDestroyed()) return;
    for (const page of owner.allPages()) page.send("leafdesk:full-screen", window.isFullScreen());
  };
  window.on("enter-full-screen", send);
  window.on("leave-full-screen", send);
}

/** Which server the remembered tabs belong to: the connected one's origin, or "local" (last-page.ts). */
const serverKey = () => (isLocal() ? "local" : settings.server);

/**
 * Opens the windows of the last start with their tabs (the one shown then, the others as they are
 * picked), or one window on the page last shown, else the server's home; the app's connect screen
 * when there is no server yet.
 */
function openWindows() {
  const restored = windowsToRestore(settings.tabs, serverKey(), startPath(settings.lastPage, serverKey()));
  restored.forEach((saved, index) => openWindow(saved, index === 0 ? restoredBounds() : undefined));
}

/** A window with tabs (`saved`), at `bounds`, else a little below and right of the one in front. */
function openWindow(saved: SavedWindow = { tabs: [{ path: "/" }], active: 0 }, bounds?: Partial<Rectangle>) {
  const front = liveWindow();
  const place = bounds ?? (front ? cascade(front.window.getBounds()) : restoredBounds());
  const window = new TabbedWindow(
    {
      webPreferences: () => webPreferences("tab"),
      background: () => BACKGROUND[dark() ? "dark" : "light"],
      titleBar,
      prepare: guard,
      open: (contents, page) => openCurrent(contents, page),
      strings: () => {
        const t = strings();
        return { strings: { newTab: t.newTab, closeTab: t.closeTab, tabs: t.tabs, back: t.goBack, forward: t.goForward }, dir: direction(locale) };
      },
      away: (url) => awayHost(url, currentOrigin()),
      changed: rememberTabs,
      closed: (url, index) => closedTabs.push({ url, index }),
      menu: showTabMenu,
      focused: (focused) => {
        lastWindow = focused;
      },
    },
    { bounds: place, stripPreferences: webPreferences("strip"), stripOverPage: INSET_WINDOW_CONTROLS, minWidth: 420, minHeight: 480, icon: process.platform === "linux" ? ICON : undefined },
  );
  lastWindow = window;
  reportFullScreen(window);
  if (!bounds && !front && settings.window?.maximized) window.window.maximize();
  window.window.on("close", () => {
    settings.window = { ...window.window.getNormalBounds(), maximized: window.window.isMaximized() };
    save();
  });
  window.window.on("closed", () => {
    if (lastWindow === window) lastWindow = null;
    // A window closed while others stay is forgotten; the last one's tabs are kept for the next start.
    if (!appQuitting && TabbedWindow.all().length) rememberTabs();
  });
  // Without a server yet, the tab shows the app's connect screen (openCurrent).
  window.restore(saved);
  return window;
}

function cascade(bounds: Rectangle): Partial<Rectangle> {
  return { x: bounds.x + 24, y: bounds.y + 24, width: bounds.width, height: bounds.height };
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Keeps the windows' tabs (and the page shown last, which older versions open) for the next start, soon. */
function rememberTabs() {
  if (appQuitting) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(rememberTabsNow, SAVE_DELAY_MS);
}

function rememberTabsNow() {
  clearTimeout(saveTimer);
  const server = serverKey();
  const origin = currentOrigin();
  const windows = TabbedWindow.all();
  if (!server || !origin || !windows.length) return;
  settings.tabs = { server, windows: windows.map((window) => window.saved((url) => tabPath(url, origin))) };
  const shown = liveWindow()?.activeContents()?.getURL();
  const page = shown ? pageToRemember(shown, origin, server) : null;
  if (page) settings.lastPage = page;
  save();
}

/** A tab's right-click menu in the strip. */
function showTabMenu(window: TabbedWindow, id: number) {
  const t = strings();
  const contents = window.contentsOf(id);
  if (!contents) return;
  Menu.buildFromTemplate([
    { label: t.newTab, click: () => window.addTab({ path: newTabPath(window) }) },
    {
      label: t.duplicateTab,
      click: () => {
        const url = contents.getURL();
        const target = isServerPage(url, currentOrigin()) ? { url } : { path: "/" };
        window.addTab(target, { index: window.list.ids.indexOf(id) + 1 });
      },
    },
    { type: "separator" },
    { label: t.closeTab, click: () => window.closeTab(id) },
    { label: t.closeOtherTabs, enabled: window.list.ids.length > 1, click: () => window.closeOthers(id) },
    { type: "separator" },
    { label: t.reopenClosedTab, enabled: closedTabs.size > 0, click: () => reopenClosedTab(window) },
  ]).popup({ window: window.window });
}

function appLinkIn(argv: string[]) {
  return argv.find((arg) => arg.startsWith(`${APP_SCHEME}:`));
}

/**
 * A `leafdesk://` link: the answer of a service the person signed in to in the system's browser
 * (navigation.ts), which the shown tab takes back to the server to finish under its session; or
 * a page of the server to open (`leafdesk://open?url=…`, from the web app), which gets a tab of
 * its own in the window in front.
 */
function followAppLink(link: string) {
  if (!started) {
    waitingLink = link;
    return;
  }
  const origin = currentOrigin();
  const page = openLinkTarget(link, origin);
  if (page) {
    const window = liveWindow() ?? openWindow();
    window.addTab({ url: page });
    bringForward(window);
    if (process.platform === "darwin") app.focus({ steal: true });
    return;
  }
  const target = signInReturn(link, origin);
  if (!target) return;
  const window = liveWindow() ?? openWindow();
  const contents = window.activeContents();
  if (!contents) return;
  views.delete(contents);
  contents.loadURL(target).catch(() => undefined);
  bringForward(window);
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

function openCurrent(contents: WebContents, page = "/") {
  if (isLocal()) void openLocal(contents, false, page);
  else if (settings.server) openServer(contents, page);
  else showView(contents, { view: "connect" });
}

function openServer(contents: WebContents, page = "/") {
  if (!settings.server) return;
  views.delete(contents);
  // A failed load is shown by did-fail-load (guard), not here.
  contents.loadURL(`${settings.server}${page}`).catch(() => undefined);
}

/**
 * Starts Leafdesk on this computer (once), signs in to its account, and opens its home (or `page`)
 * in a tab. `signedOut`: the tab came to the sign-in page, so the session is gone whatever the
 * cookies say.
 */
async function openLocal(contents: WebContents, signedOut = false, page = "/") {
  if (!localReady) showView(contents, { view: "starting" });
  try {
    const server = await startLocal();
    await signInLocally(server, signedOut);
    readLeafdeskLanguage(session.defaultSession);
    readLeafdeskTheme(session.defaultSession);
    if (contents.isDestroyed() || !isLocal()) return;
    views.delete(contents);
    contents.loadURL(`${server.origin}${page}`).catch(() => undefined);
  } catch (error) {
    console.error("Leafdesk on this computer didn't start:", error);
    if (!contents.isDestroyed()) showLocalProblem(contents, error instanceof Error ? error.message : String(error));
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
      localReady = true;
      server.onBackup(reportBackup);
      refreshMenu();
      if (settings.localPort !== server.port) {
        settings.localPort = server.port;
        save();
      }
      server.onExit((code) => {
        localServer = null;
        localReady = false;
        refreshMenu();
        void server.stop();
        for (const window of TabbedWindow.all()) {
          for (const contents of window.allContents()) {
            if (isServerPage(contents.getURL(), server.origin)) showLocalProblem(contents, `Leafdesk's server stopped with ${code}; see ${server.log}`);
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
  localReady = false;
  localOrigin = undefined;
  const server = await starting?.catch(() => null);
  if (server) refreshMenu();
  await server?.stop().catch((error: unknown) => console.error("Leafdesk on this computer didn't stop cleanly:", error));
}

function showLocalProblem(contents: WebContents, detail: string) {
  showView(contents, { view: "problem", server: "", detail, local: true });
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

/** Shows one of the app's own screens in a tab. */
function showView(contents: WebContents, view: View) {
  views.set(contents, view);
  contents.loadFile(PAGE).catch(() => undefined);
}

/**
 * Where a tab's page may go (navigation.ts): the server's pages, and other sites only while it
 * signs in at an identity provider, a trip that ends back on the server or after SIGN_IN_TRIP_MS.
 * Anything else opens in the system's browser instead.
 */
function followNavigation(contents: WebContents, event: Electron.Event<{ url: string }>) {
  const trip = signInTrips.get(contents);
  const signingIn = trip !== undefined && trip > Date.now();
  const decision = decideNavigation(event.url, PAGES_URL, currentOrigin(), { from: contents.getURL(), signingIn });
  if (decision === "sign-in" && !signingIn) signInTrips.set(contents, Date.now() + SIGN_IN_TRIP_MS);
  if (decision === "allow" || decision === "sign-in") return;
  event.preventDefault();
  if (decision === "external") void shell.openExternal(event.url);
}

/** Navigation, new windows and tabs, failed loads and the context menu of a tab's page. */
function guard(contents: WebContents) {
  contents.on("will-navigate", (event) => followNavigation(contents, event));
  contents.on("will-redirect", (event) => {
    if (event.isMainFrame) followNavigation(contents, event);
    else if (!allowsFrameRedirect(event.url)) event.preventDefault();
  });
  // Leafdesk's own pages open in a tab: Cmd/Ctrl+click and a middle click in one behind the shown
  // tab, Shift+click in a window of its own, anything else in a tab in front.
  contents.setWindowOpenHandler(({ url, disposition }) => {
    const decision = decideNewWindow(url, currentOrigin());
    if (decision === "tab" && showsFile(url)) {
      // A PDF, image or export: a plain window with the system's title bar and no tab strip, since
      // the browser's own viewer leaves no room for the window's buttons nor a strip to move it by.
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 1100,
          height: 800,
          backgroundColor: dark() ? BACKGROUND.dark : BACKGROUND.light,
          webPreferences: webPreferences("file"),
        },
      };
    }
    if (decision === "tab") {
      const owner = TabbedWindow.of(contents);
      if (disposition === "new-window" || !owner) openWindow().addTab({ url }, { index: 0 });
      else owner.addTab({ url }, { fromActive: owner.activeContents() === contents, show: disposition !== "background-tab" });
    }
    if (decision === "external") void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (child) => guard(child.webContents));
  // Signing out of Leafdesk on this computer leads to its sign-in page: the app signs in again.
  contents.on("did-navigate", (_event, url) => {
    // Back on the server (or on the app's own screen): a sign-in trip is over.
    if (!awayHost(url, currentOrigin())) signInTrips.delete(contents);
    if (isLocal() && localOrigin && isServerPage(url, localOrigin) && new URL(url).pathname === "/sign-in") void openLocal(contents, true);
  });
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 is a load that was cancelled, by a newer one for instance.
    if (!isMainFrame || code === -3) return;
    if (isLocal()) {
      if (localOrigin && isServerPage(url, localOrigin)) showLocalProblem(contents, description);
      return;
    }
    if (!settings.server || !isServerPage(url, settings.server)) return;
    const certificate = isCertificateError(description) ? certificates.problems.get(new URL(settings.server).hostname) : undefined;
    showView(contents, { view: "problem", server: settings.server, detail: description, certificate });
  });
  contents.on("context-menu", (_event, params) => {
    const owner = TabbedWindow.of(contents);
    const inApp = owner && isServerPage(params.linkURL, currentOrigin());
    showContextMenu(contents, params, strings(), inApp ? (url) => owner.addTab({ url }, { fromActive: true, show: false }) : undefined);
  });
  contents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") contents.reload();
  });
}

/** Only the connected server's pages get permissions, and only those it uses. */
function guardPermissions(ses: Session) {
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const origin = currentOrigin();
    if (!origin || !isServerPage(details.requestingUrl, origin) || !PERMISSIONS.has(permission)) return callback(false);
    if (permission !== "media") return callback(true);
    const types = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
    if (types.includes("video")) return callback(false);
    allowMicrophone(origin, contents).then(callback, () => callback(false));
  });
  // Checks only tell a page what it may do; the microphone itself is given by the request above.
  ses.setPermissionCheckHandler((_contents, permission, requesting) => {
    const origin = currentOrigin();
    if (!origin || !isServerPage(requesting, origin) || !PERMISSIONS.has(permission)) return false;
    return permission !== "media" || !microphoneRefused.has(origin);
  });
}

/**
 * Whether a server's pages may record from the microphone: the person is asked once for each
 * server (Leafdesk on this computer is the app's own), and on macOS the system asks for the app
 * too. A yes is kept; a no holds until the app starts again.
 */
async function allowMicrophone(origin: string, contents: WebContents) {
  if (!isLocal() && !settings.microphone?.[origin]) {
    if (microphoneRefused.has(origin)) return false;
    let asking = microphoneAsked.get(origin);
    if (!asking) {
      asking = askMicrophone(origin, contents).finally(() => microphoneAsked.delete(origin));
      microphoneAsked.set(origin, asking);
    }
    if (!(await asking)) return false;
  }
  return process.platform === "darwin" ? systemPreferences.askForMediaAccess("microphone") : true;
}

async function askMicrophone(origin: string, contents: WebContents) {
  const t = strings();
  const box = {
    type: "question" as const,
    message: fill(t.microphoneTitle, { host: hostOf(origin) }),
    detail: t.microphoneBody,
    buttons: [t.allow, t.dontAllow],
    defaultId: 0,
    cancelId: 1,
  };
  const window = TabbedWindow.of(contents)?.window ?? BrowserWindow.fromWebContents(contents);
  const { response } = window ? await dialog.showMessageBox(window, box) : await dialog.showMessageBox(box);
  if (response !== 0) {
    microphoneRefused.add(origin);
    return false;
  }
  settings.microphone = { ...settings.microphone, [origin]: true };
  save();
  return true;
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

/** Whether a changed cookie is the server's: the one the app is on. */
function isServerCookie(cookie: Electron.Cookie) {
  const origin = currentOrigin();
  return !!origin && cookie.domain?.replace(/^\./, "") === new URL(origin).hostname;
}

/** The app's menus, tab strip and own pages switch language with Leafdesk's language setting. */
function followLeafdeskLanguage(ses: Session) {
  ses.cookies.on("changed", (_event, cookie, cause, removed) => {
    if (cookie.name !== LOCALE_COOKIE || cause === "overwrite" || !isServerCookie(cookie)) return;
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
  for (const window of TabbedWindow.all()) window.refresh();
}

/**
 * The tab strip, the window's buttons and the app's menus are light or dark as Leafdesk is: its
 * theme setting (a cookie of the server's), else the system's.
 */
function followLeafdeskTheme(ses: Session) {
  ses.cookies.on("changed", (_event, cookie, cause, removed) => {
    if (cookie.name !== THEME_COOKIE || cause === "overwrite" || !isServerCookie(cookie)) return;
    applyTheme(removed ? undefined : cookie.value);
  });
  nativeTheme.on("updated", () => {
    const colors = STRIP[dark() ? "dark" : "light"];
    for (const window of TabbedWindow.all()) {
      window.setBackground(BACKGROUND[dark() ? "dark" : "light"]);
      if (!INSET_WINDOW_CONTROLS) window.window.setTitleBarOverlay({ ...colors, height: STRIP_HEIGHT });
    }
  });
  readLeafdeskTheme(ses);
}

function readLeafdeskTheme(ses: Session) {
  const origin = currentOrigin();
  if (!origin) return applyTheme(undefined);
  ses.cookies.get({ url: origin, name: THEME_COOKIE }).then(
    ([cookie]) => applyTheme(cookie?.value),
    () => undefined,
  );
}

function applyTheme(value: string | undefined) {
  const source = value === "light" || value === "dark" ? value : "system";
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
}

/**
 * Whether a server answers at an origin, and whether it is Leafdesk: its health check and manifest.
 * `accepted`: origins the person said yes to on the connect screen.
 */
async function probe(origin: string, accepted: readonly string[], redirects = 1): Promise<Probe> {
  const ses = session.defaultSession;
  const get = (url: string) => ses.fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  try {
    const health = await get(`${origin}/api/health`);
    const location = health.headers.get("location");
    // A server that sends plain HTTP on to HTTPS is kept by where it sends; another host, or plain
    // HTTP from HTTPS, only once the person said yes to it.
    if (health.status >= 300 && health.status < 400 && location && redirects > 0) {
      const target = new URL(location, `${origin}/`);
      if (target.protocol !== "https:" && target.protocol !== "http:") return { kind: "not-leafdesk", origin };
      if (!followsRedirect(origin, target.origin) && !accepted.includes(target.origin)) return { kind: "redirect", origin, target: target.origin };
      return probe(target.origin, accepted, redirects - 1);
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

/**
 * Looks for the server at an address typed on the connect screen. Returns the origin to keep only
 * when it is one the person typed, or said yes to (`accepted`): plain HTTP the app tried by itself
 * away from this computer, a redirect to another host, or a server that doesn't look like Leafdesk.
 */
async function connect(address: string, accepted: readonly string[]): Promise<{ reply: ConnectReply; origin?: string }> {
  const candidates = addressCandidates(address);
  if (!candidates) return { reply: { error: "invalid" } };
  let reply: ConnectReply = { error: "unreachable", host: hostOf(candidates[0]) };
  connecting = candidates;
  try {
    for (const origin of candidates) {
      const untrusted = await certificates.inspect(origin);
      if (untrusted) return { reply: { error: "certificate", host: untrusted.host, certificate: untrusted } };
      const result = await probe(origin, accepted);
      if (result.kind === "redirect") return { reply: { error: "confirm", reason: "redirect", host: hostOf(result.origin), target: result.target } };
      // Never falls back to plain HTTP past a certificate it couldn't check.
      if (result.kind === "certificate") return { reply: { error: "certificate", host: result.certificate.host, certificate: result.certificate } };
      if (result.kind === "unreachable") continue;
      const plain = needsHttpConfirmation(address, result.origin);
      if (result.kind === "ok") {
        if (plain && !accepted.includes(result.origin)) return { reply: { error: "confirm", reason: "http", host: hostOf(result.origin), target: result.origin } };
        return { reply: { ok: true }, origin: result.origin };
      }
      // Something else over plain HTTP the app tried by itself isn't offered: the HTTPS answer stands.
      if (plain) continue;
      if (accepted.includes(result.origin)) return { reply: { ok: true }, origin: result.origin };
      reply = { error: "not-leafdesk", host: hostOf(result.origin), target: result.origin };
    }
    return { reply };
  } finally {
    connecting = [];
  }
}

/** Remembers that the server (or one being connected to) had a certificate this computer trusts. */
function rememberValidCertificate(host: string) {
  const hosts = [settings.server, ...connecting].flatMap((origin) => (origin ? [new URL(origin).hostname] : []));
  if (!hosts.includes(host) || settings.validCertificateHosts.includes(host)) return;
  settings.validCertificateHosts.push(host);
  save();
}

/** Forgets every certificate trusted on the trust screen; the server's is checked again at once. */
function forgetCertificates() {
  const hosts = Object.keys(settings.trustedCertificates);
  settings.trustedCertificates = {};
  certificates.problems.clear();
  save();
  refreshMenu();
  const server = !isLocal() && settings.server ? new URL(settings.server).hostname : undefined;
  // Chromium keeps a certificate it was told to accept until the app restarts.
  if (server && hosts.includes(server)) relaunch();
  else void session.defaultSession.closeAllConnections();
}

/** Starts the app again, with its tabs as they are. */
function relaunch() {
  rememberTabsNow();
  save();
  app.relaunch();
  // Leaving without "before-quit": Leafdesk on this computer is stopped here.
  void stopLocal().finally(() => app.exit(0));
}

/** The bridge pages/app.html talks to (preload.cts); nothing else may call it. */
function registerPageBridge() {
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!event.senderFrame?.url.startsWith(PAGES_URL)) throw new Error("Not allowed");
      return listener(event, ...args);
    });

  // The preload of the tab strip and of the tabs' pages asks this: it tells nothing but the window's state.
  ipcMain.on("leafdesk:full-screen", (event) => {
    const window = TabbedWindow.of(event.sender)?.window ?? BrowserWindow.fromWebContents(event.sender);
    event.returnValue = window?.isFullScreen() ?? false;
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
    if (!localAvailable() || !TabbedWindow.of(event.sender)) return;
    settings.mode = "local";
    TabbedWindow.forgetRoom();
    save();
    applyShortcut();
    void openLocal(event.sender);
  });

  handle("leafdesk:connect", async (event, address, accepted) => {
    if (typeof address !== "string") return { error: "invalid" } satisfies ConnectReply;
    const yes = Array.isArray(accepted) ? accepted.filter((origin): origin is string => typeof origin === "string") : [];
    const { reply, origin } = await connect(address, yes);
    if (origin && TabbedWindow.of(event.sender)) {
      settings.server = origin;
      settings.mode = undefined;
      TabbedWindow.forgetRoom();
      save();
      void stopLocal();
      readLeafdeskLanguage(session.defaultSession);
      readLeafdeskTheme(session.defaultSession);
      applyShortcut();
      openServer(event.sender);
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
      refreshMenu();
      return { ok: true };
    }
    // Chromium already turned this certificate down and keeps that until the app restarts.
    if (problem.origin) {
      settings.server = problem.origin;
      settings.mode = undefined;
    }
    relaunch();
    return { ok: true };
  });

  handle("leafdesk:retry", (event) => {
    if (TabbedWindow.of(event.sender)) openCurrent(event.sender);
  });
}

/**
 * What the tab strip (pages/tabs.html) asks for, and the icon a server's page reports for its tab
 * and the room it leaves the strip (preload.cts). Only a window's own strip is heard for the first.
 */
function registerTabBridge() {
  ipcMain.on("leafdesk:tab", (event, action: unknown, id: unknown, index: unknown) => {
    const owner = TabbedWindow.of(event.sender);
    if (!owner || owner.strip !== event.sender || !event.senderFrame?.url.startsWith(PAGES_URL)) return;
    if (action === "add") {
      owner.addTab({ path: newTabPath(owner) });
      return;
    }
    if (action === "focus") {
      owner.activeContents()?.focus();
      return;
    }
    if (action === "back" || action === "forward") {
      const history = owner.activeContents()?.navigationHistory;
      if (action === "back" && history?.canGoBack()) history.goBack();
      if (action === "forward" && history?.canGoForward()) history.goForward();
      return;
    }
    if (typeof id !== "number" || !owner.contentsOf(id)) return;
    if (action === "show") owner.showTab(id, false);
    else if (action === "close") owner.closeTab(id);
    else if (action === "move" && typeof index === "number") owner.moveTab(id, index);
    else if (action === "menu") showTabMenu(owner, id);
  });

  ipcMain.on("leafdesk:page-icon", (event, icon: unknown) => {
    const owner = TabbedWindow.of(event.sender);
    if (!owner || owner.strip === event.sender) return;
    owner.setIcon(event.sender, isServerPage(event.sender.getURL(), currentOrigin()) ? readIcon(icon) : null);
  });

  ipcMain.on("leafdesk:strip-room", (event, value: unknown) => {
    const owner = TabbedWindow.of(event.sender);
    if (!owner || owner.strip === event.sender || !isServerPage(event.sender.getURL(), currentOrigin())) return;
    const room = readStripRoom(value);
    if (room) owner.setRoom(event.sender, room === "none" ? null : room);
  });
}
