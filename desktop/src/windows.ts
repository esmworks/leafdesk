/**
 * A window with tabs. The tab strip (pages/tabs.html, with the window's buttons in it) runs across
 * the top; each tab is a view of its own below it, showing a page of the server or one of the app's
 * own screens. On macOS (`stripOverPage`) the strip is a view of its own over the shown tab
 * instead: a page of the server with a sidebar fills the window and tells where its sidebar ends
 * (setRoom), the strip lies over the rest of its top and the sidebar runs the window's full height,
 * the window's buttons over its first row. Elsewhere the strip is the window's own page, where the
 * system's buttons are drawn over its end. Every tab shares the app's one session, so a sign-in
 * holds in all of them. What decides where a tab may go, and what it loads, stays in main.ts
 * (TabHooks); the order of the tabs and the keys that switch them are tabs.ts.
 */
import path from "node:path";
import { BrowserWindow, WebContentsView, type BrowserWindowConstructorOptions, type Rectangle, type WebContents, type WebPreferences } from "electron";
import { placeStrip, TabList, tabKey, tabTitle, type SavedTab, type SavedWindow, type StripRoom } from "./tabs.ts";

/**
 * The strip's height: room for the tabs, and for macOS's window buttons centered beside them; the
 * web app's header row (`--window-controls-height` in its globals.css) is as high.
 */
export const STRIP_HEIGHT = 44;

/**
 * A tab: its view, what the strip shows of it, until it is first shown the path it opens (a
 * restored tab), the room its page leaves the strip (undefined: not told since it loaded) and the
 * shade a dialog open in it lays over the window.
 */
type Tab = { id: number; view: WebContentsView; title: string; icon: string | null; loading: boolean; pending?: string; room?: StripRoom | null; shade?: string | null };

/** What the strip draws: pages/tabs.html reads it (src/pages/tabs.ts mirrors the shape). */
export type StripState = {
  /** `away`: where a tab off the server is (navigation.ts, awayHost), shown as an address bar would. */
  tabs: { id: number; title: string; icon: string | null; loading: boolean; away: string | null }[];
  active: number | null;
  strings: { newTab: string; closeTab: string; tabs: string };
  dir: "ltr" | "rtl";
  /** The strip starts past macOS's window buttons (beside the page's sidebar) and leaves them no room. */
  clearOfControls: boolean;
  /** The shown tab's page has a dialog open: the strip lays this color over itself, as the page does. */
  shade: string | null;
};

export type TabHooks = {
  /** The tab view's settings (the preload and the sandbox). */
  webPreferences: () => WebPreferences;
  /** The window's background, as the theme has it now. */
  background: () => string;
  /** The title bar's settings: macOS's buttons beside the tabs, elsewhere the system's over the strip's end. */
  titleBar: () => BrowserWindowConstructorOptions;
  /** Sets up a tab's page: where it may go, what opens in a new tab, its context menu. */
  prepare: (contents: WebContents) => void;
  /** Loads a path of the server the app is on (or the app's screen saying why it can't). */
  open: (contents: WebContents, path: string) => void;
  /** The strip's words and direction. */
  strings: () => Pick<StripState, "strings" | "dir">;
  /** Where a tab's page is when it is off the server (null on it, or on the app's own screens). */
  away: (url: string) => string | null;
  /** The window's tabs, their order, the one shown or a title changed: what is kept for the next start. */
  changed: () => void;
  /** A tab closed (not its window): for Reopen Closed Tab. */
  closed: (url: string, index: number) => void;
  /** The tab's right-click menu in the strip. */
  menu: (window: TabbedWindow, id: number) => void;
  /** The window came forward. */
  focused: (window: TabbedWindow) => void;
};

const STRIP_PAGE = path.join(import.meta.dirname, "..", "pages", "tabs.html");

let nextId = 1;
const windows = new Set<TabbedWindow>();
const owners = new Map<WebContents, TabbedWindow>();
/**
 * The room the last page with a sidebar left the strip: a page loading meanwhile is laid out so
 * until it tells its own, rather than jumping as it does. Forgotten with the server (forgetRoom).
 */
let lastRoom: StripRoom | null = null;

export class TabbedWindow {
  readonly window: BrowserWindow;
  /** The tab strip's page. */
  readonly strip: WebContents;
  readonly list = new TabList();
  private readonly tabs = new Map<number, Tab>();
  private readonly hooks: TabHooks;
  /** The strip's own view, over the shown tab (stripOverPage); else the strip is the window's page. */
  private readonly stripView: WebContentsView | null;
  private stripReady = false;
  private clearOfControls = false;

  /** Every window with tabs, in the order they opened. */
  static all() {
    return [...windows];
  }

  /** The window a tab's page or a strip belongs to. */
  static of(contents: WebContents | null | undefined) {
    return contents ? owners.get(contents) : undefined;
  }

  static fromBrowserWindow(window: unknown) {
    return [...windows].find((each) => each.window === window);
  }

  /** Another server: the room its pages leave the strip is not known yet. */
  static forgetRoom() {
    lastRoom = null;
  }

  constructor(
    hooks: TabHooks,
    options: { bounds?: Partial<Rectangle>; stripPreferences: WebPreferences; stripOverPage: boolean; minWidth: number; minHeight: number; icon?: string },
  ) {
    this.hooks = hooks;
    this.window = new BrowserWindow({
      width: 1200,
      height: 800,
      ...options.bounds,
      minWidth: options.minWidth,
      minHeight: options.minHeight,
      show: false,
      title: "Leafdesk",
      backgroundColor: hooks.background(),
      icon: options.icon,
      ...hooks.titleBar(),
      webPreferences: options.stripOverPage ? hooks.webPreferences() : options.stripPreferences,
    });
    windows.add(this);
    this.stripView = options.stripOverPage ? new WebContentsView({ webPreferences: options.stripPreferences }) : null;
    if (this.stripView) {
      this.stripView.setBackgroundColor(hooks.background());
      this.window.contentView.addChildView(this.stripView);
    }
    const strip = (this.strip = this.stripView?.webContents ?? this.window.webContents);
    owners.set(strip, this);
    strip.on("before-input-event", (event, input) => {
      if (this.handleKey(input)) event.preventDefault();
    });
    strip.on("did-finish-load", () => {
      this.stripReady = true;
      this.sendStrip();
      // The window's own page shows nothing when the strip is a view of its own.
      if (this.stripView && !this.window.isDestroyed() && !this.window.isVisible()) this.window.show();
    });
    // The strip's own page never goes anywhere else.
    strip.on("will-navigate", (event) => event.preventDefault());
    strip.setWindowOpenHandler(() => ({ action: "deny" }));
    void strip.loadFile(STRIP_PAGE).catch(() => undefined);

    if (!this.stripView) this.window.once("ready-to-show", () => this.window.show());
    // A page that never paints (a server that holds the connection open) still gets its window.
    setTimeout(() => {
      if (!this.window.isDestroyed() && !this.window.isVisible()) this.window.show();
    }, 3000);
    for (const event of ["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const) {
      this.window.on(event as "resize", () => this.layout());
    }
    this.window.on("focus", () => {
      this.activeContents()?.focus();
      hooks.focused(this);
    });
    this.window.on("closed", () => {
      windows.delete(this);
      owners.delete(strip);
      if (this.stripView && !strip.isDestroyed()) strip.close();
      for (const tab of this.tabs.values()) this.destroy(tab);
      this.tabs.clear();
    });
  }

  /**
   * Opens a tab: a path of the server (`path`, loaded now or, with `lazy`, when first shown) or a
   * full address on it (`url`). `show`: it becomes the shown tab; `fromActive`: it opens beside
   * the shown tab, as a link from it does. Returns the tab's page.
   */
  addTab(target: { path: string; lazy?: boolean; title?: string; icon?: string } | { url: string }, options: { show?: boolean; fromActive?: boolean; index?: number } = {}) {
    const id = nextId++;
    const view = new WebContentsView({ webPreferences: this.hooks.webPreferences() });
    view.setBackgroundColor(this.hooks.background());
    view.setVisible(false);
    const tab: Tab = { id, view, title: "title" in target && target.title ? target.title : "Leafdesk", icon: ("icon" in target && target.icon) || null, loading: false };
    this.tabs.set(id, tab);
    const contents = view.webContents;
    owners.set(contents, this);
    this.watch(tab);
    this.hooks.prepare(contents);
    this.window.contentView.addChildView(view);
    // Adding it again keeps the strip over every tab.
    if (this.stripView) this.window.contentView.addChildView(this.stripView);

    const show = options.show ?? true;
    this.list.open(id, { fromActive: options.fromActive, show });
    if (options.index !== undefined) this.list.move(id, options.index);
    if ("url" in target) contents.loadURL(target.url).catch(() => undefined);
    else if (target.lazy && !show) tab.pending = target.path;
    else this.hooks.open(contents, target.path);
    if (show) this.showTab(id);
    else this.layout();
    this.sendStrip();
    this.hooks.changed();
    return contents;
  }

  /** Opens the tabs kept from the last start, the one shown then shown again; the others load when picked. */
  restore(saved: SavedWindow) {
    saved.tabs.forEach((tab, index) => this.addTab({ ...tab, lazy: true }, { show: index === saved.active }));
  }

  /**
   * Shows a tab, loading it first if it was waiting (restored). `focus`: the keyboard goes to its
   * page; a tab pressed in the strip gets it once the press ends (the strip may be dragging it).
   */
  showTab(id: number, focus = true) {
    const tab = this.tabs.get(id);
    if (!tab || !this.list.show(id)) return;
    if (tab.pending !== undefined) {
      const page = tab.pending;
      tab.pending = undefined;
      this.hooks.open(tab.view.webContents, page);
    }
    this.layout();
    if (focus) tab.view.webContents.focus();
    this.sendStrip();
    this.hooks.changed();
  }

  /** Closes a tab; the window closes with its last one. */
  closeTab(id: number) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (this.list.ids.length === 1) {
      this.window.close();
      return;
    }
    const index = this.list.ids.indexOf(id);
    const url = tab.pending ?? tab.view.webContents.getURL();
    const next = this.list.close(id);
    this.tabs.delete(id);
    this.destroy(tab);
    if (url) this.hooks.closed(url, index);
    if (next !== null) this.showTab(next);
    this.sendStrip();
    this.hooks.changed();
  }

  closeOthers(id: number) {
    this.showTab(id);
    for (const other of this.list.others(id)) this.closeTab(other);
  }

  moveTab(id: number, index: number) {
    this.list.move(id, index);
    this.sendStrip();
    this.hooks.changed();
  }

  /** The page of the shown tab. */
  activeContents(): WebContents | undefined {
    return this.list.active === null ? undefined : this.tabs.get(this.list.active)?.view.webContents;
  }

  contentsOf(id: number): WebContents | undefined {
    return this.tabs.get(id)?.view.webContents;
  }

  /** The tab showing a page, by the page. */
  idOf(contents: WebContents) {
    return [...this.tabs.values()].find((tab) => tab.view.webContents === contents)?.id;
  }

  /** Every tab's page, in the strip's order. */
  allContents() {
    return this.list.ids.map((id) => this.tabs.get(id)!.view.webContents);
  }

  /** The page's icon, as its page reported it. */
  setIcon(contents: WebContents, icon: string | null) {
    const tab = [...this.tabs.values()].find((each) => each.view.webContents === contents);
    if (!tab || tab.icon === icon) return;
    tab.icon = icon;
    this.sendStrip();
    this.hooks.changed();
  }

  /** The shade a dialog open in a tab's page lays over it (null: none). */
  setShade(contents: WebContents, shade: string | null) {
    const tab = [...this.tabs.values()].find((each) => each.view.webContents === contents);
    if (!tab || (tab.shade ?? null) === shade) return;
    tab.shade = shade;
    if (tab.id === this.list.active) this.sendStrip();
  }

  /** What is kept of the window's tabs: each tab's path (`pathOf` decides it), title and icon, and the one shown. */
  saved(pathOf: (url: string) => string): SavedWindow {
    const tabs = this.list.ids.map((id): SavedTab => {
      const tab = this.tabs.get(id)!;
      const saved: SavedTab = { path: tab.pending ?? pathOf(tab.view.webContents.getURL()) };
      if (tab.title !== "Leafdesk") saved.title = tab.title;
      if (tab.icon) saved.icon = tab.icon;
      return saved;
    });
    return { tabs, active: Math.max(0, this.list.active === null ? 0 : this.list.ids.indexOf(this.list.active)) };
  }

  /** The keys that switch tabs, taken before the page sees them; true when one was. */
  handleKey(input: Electron.Input) {
    const key = tabKey(input, process.platform);
    if (!key) return false;
    const target = key.kind === "number" ? this.list.numbered(key.number) : this.list.neighbour(key.kind === "next" ? 1 : -1);
    if (target !== null) this.showTab(target);
    return true;
  }

  /** Tells the strip again what to draw (after the language changed, say). */
  refresh() {
    this.sendStrip();
  }

  /** Where a tab's page leaves the strip room beside its sidebar (null: none, the strip goes above it). */
  setRoom(contents: WebContents, room: StripRoom | null) {
    const tab = [...this.tabs.values()].find((each) => each.view.webContents === contents);
    if (!tab || !this.stripView) return;
    tab.room = room;
    if (room) lastRoom = room;
    if (tab.id === this.list.active) this.layout();
  }

  /** The strip's page, and every tab's page: told when the window enters or leaves full screen. */
  allPages() {
    return [this.strip, ...this.allContents()];
  }

  setBackground(color: string) {
    this.window.setBackgroundColor(color);
    this.stripView?.setBackgroundColor(color);
    for (const tab of this.tabs.values()) tab.view.setBackgroundColor(color);
  }

  private watch(tab: Tab) {
    const contents = tab.view.webContents;
    contents.on("page-title-updated", (_event, title) => {
      tab.title = tabTitle(title) || "Leafdesk";
      this.sendStrip();
      this.hooks.changed();
    });
    contents.on("did-start-loading", () => {
      tab.loading = true;
      this.sendStrip();
    });
    contents.on("did-stop-loading", () => {
      tab.loading = false;
      this.sendStrip();
    });
    // A page loaded anew reports its icon, and its room for the strip, again; the old ones are gone with it.
    contents.on("did-navigate", () => {
      tab.icon = null;
      tab.room = undefined;
      tab.shade = null;
      this.layout();
      this.sendStrip();
      this.hooks.changed();
    });
    contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (!isMainFrame) return;
      this.sendStrip();
      this.hooks.changed();
    });
    contents.on("before-input-event", (event, input) => {
      if (this.handleKey(input)) event.preventDefault();
    });
  }

  private destroy(tab: Tab) {
    const contents = tab.view.webContents;
    owners.delete(contents);
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
    if (!contents.isDestroyed()) contents.close();
  }

  /**
   * The shown tab fills the window below the strip, or, when its page leaves the strip room beside
   * its sidebar, the whole window under the strip; the others are hidden.
   */
  private layout() {
    if (this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    const shown = this.list.active === null ? undefined : this.tabs.get(this.list.active);
    const place = placeStrip(this.stripView && shown ? this.roomOf(shown) : null, width, height, STRIP_HEIGHT, shown?.view.webContents.getZoomFactor() ?? 1);
    this.stripView?.setBounds(place.strip);
    for (const tab of this.tabs.values()) {
      if (tab === shown) tab.view.setBounds(place.page);
      tab.view.setVisible(tab === shown);
    }
    if (place.clearOfControls !== this.clearOfControls) {
      this.clearOfControls = place.clearOfControls;
      this.sendStrip();
    }
  }

  /**
   * The room a tab's page leaves the strip: as it told, else, while a page of the server loads, as
   * the last page with a sidebar did. The app's own pages have none.
   */
  private roomOf(tab: Tab): StripRoom | null {
    if (tab.room !== undefined) return tab.room;
    const url = tab.pending === undefined ? tab.view.webContents.getURL() : "";
    return url.startsWith("file:") ? null : lastRoom;
  }

  private sendStrip() {
    if (!this.stripReady || this.window.isDestroyed()) return;
    const state: StripState = {
      tabs: this.list.ids.map((id) => {
        const { title, icon, loading, pending, view } = this.tabs.get(id)!;
        return { id, title, icon, loading, away: pending === undefined ? this.hooks.away(view.webContents.getURL()) : null };
      }),
      active: this.list.active,
      ...this.hooks.strings(),
      clearOfControls: this.clearOfControls,
      shade: (this.list.active === null ? null : this.tabs.get(this.list.active)?.shade) ?? null,
    };
    this.strip.send("leafdesk:tabs", state);
  }
}
