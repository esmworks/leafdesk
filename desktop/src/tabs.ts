/**
 * Tabs: several of the server's pages in one window (windows.ts draws them). What is here needs no
 * Electron: the order of a window's tabs and which one shows, the tabs closed lately, the keys that
 * switch tabs, and what of a window's tabs is kept for the next start.
 */

/** A window's tabs, by id, in the order the strip shows them, and the one shown. */
export class TabList {
  ids: number[] = [];
  active: number | null = null;
  /** Tabs opened from the shown one (a link opened in a new tab) since it was shown: the next goes after them. */
  private openedFromActive: number[] = [];

  /**
   * Adds a tab. A tab of its own (New Tab) goes last; one opened from a link on the shown tab goes
   * right after it, after the others opened from it. `show`: it becomes the shown tab.
   */
  open(id: number, { fromActive = false, show = true }: { fromActive?: boolean; show?: boolean } = {}) {
    let index = this.ids.length;
    if (fromActive && this.active !== null) {
      const after = [this.active, ...this.openedFromActive].map((tab) => this.ids.indexOf(tab)).filter((at) => at >= 0);
      index = Math.max(...after) + 1;
    }
    this.ids.splice(index, 0, id);
    if (show) this.show(id);
    else if (fromActive) this.openedFromActive.push(id);
  }

  /** Shows a tab; false when there is no such tab. */
  show(id: number) {
    if (!this.ids.includes(id)) return false;
    if (this.active !== id) this.openedFromActive = [];
    this.active = id;
    return true;
  }

  /**
   * Takes a tab out and returns the tab shown now: the one shown before, or, when the closed tab was
   * shown, its neighbour to the right, else to the left (null: no tab is left).
   */
  close(id: number): number | null {
    const index = this.ids.indexOf(id);
    if (index < 0) return this.active;
    this.ids.splice(index, 1);
    this.openedFromActive = this.openedFromActive.filter((tab) => tab !== id);
    if (this.active === id) {
      this.active = this.ids[Math.min(index, this.ids.length - 1)] ?? null;
      this.openedFromActive = [];
    }
    return this.active;
  }

  /** Moves a tab to `index` in the strip (clamped). */
  move(id: number, index: number) {
    const from = this.ids.indexOf(id);
    if (from < 0) return;
    this.ids.splice(from, 1);
    this.ids.splice(Math.max(0, Math.min(Math.trunc(index), this.ids.length)), 0, id);
  }

  /** The tab `step` places after the shown one (before it, for a negative step), going round. */
  neighbour(step: number): number | null {
    if (this.active === null || !this.ids.length) return null;
    const index = this.ids.indexOf(this.active);
    const length = this.ids.length;
    return this.ids[(((index + step) % length) + length) % length];
  }

  /** The tab Cmd/Ctrl+`number` shows: 1 to 8 by place, 9 the last one. */
  numbered(number: number): number | null {
    if (number === 9) return this.ids.at(-1) ?? null;
    return this.ids[number - 1] ?? null;
  }

  /** The other tabs, for Close Other Tabs. */
  others(id: number) {
    return this.ids.filter((tab) => tab !== id);
  }
}

/** A tab closed lately: what it showed and where it was in its window's strip, for Reopen Closed Tab. */
export type ClosedTab = { url: string; index: number };

/** The tabs closed lately, the last closed on top; only so many are kept. */
export class ClosedTabs {
  private stack: ClosedTab[] = [];
  private readonly limit: number;

  constructor(limit = 25) {
    this.limit = limit;
  }

  push(tab: ClosedTab) {
    this.stack.push(tab);
    if (this.stack.length > this.limit) this.stack.shift();
  }

  pop(): ClosedTab | undefined {
    return this.stack.pop();
  }

  get size() {
    return this.stack.length;
  }
}

/** What switches tabs from the keyboard, besides the menu's own shortcuts. */
export type TabKey = { kind: "next" } | { kind: "previous" } | { kind: "number"; number: number };

/** A key press as Electron's `before-input-event` tells it. */
export type KeyInput = { type: string; key: string; control: boolean; meta: boolean; shift: boolean; alt: boolean };

/**
 * The keys the app takes before the page: Ctrl+Tab and Ctrl+Shift+Tab everywhere, Ctrl+Page Down
 * and Ctrl+Page Up outside macOS, Cmd/Ctrl+1 to 9. The menu holds the rest (tabShortcuts).
 */
export function tabKey(input: KeyInput, platform: NodeJS.Platform): TabKey | null {
  if (input.type !== "keyDown" || input.alt) return null;
  const mac = platform === "darwin";
  if (input.control && !input.meta && input.key === "Tab") return input.shift ? { kind: "previous" } : { kind: "next" };
  if (!mac && input.control && !input.shift && !input.meta) {
    if (input.key === "PageDown") return { kind: "next" };
    if (input.key === "PageUp") return { kind: "previous" };
  }
  const modifier = mac ? input.meta && !input.control : input.control && !input.meta;
  if (modifier && !input.shift && /^[1-9]$/.test(input.key)) return { kind: "number", number: Number(input.key) };
  return null;
}

/** The menu's shortcuts for tabs and windows, in Electron's accelerator form. */
export function tabShortcuts(platform: NodeJS.Platform) {
  const mac = platform === "darwin";
  return {
    newTab: "CmdOrCtrl+T",
    newWindow: "CmdOrCtrl+Shift+N",
    closeTab: "CmdOrCtrl+W",
    closeWindow: "CmdOrCtrl+Shift+W",
    reopenClosedTab: "CmdOrCtrl+Shift+T",
    nextTab: mac ? "Cmd+Shift+]" : "Ctrl+Tab",
    previousTab: mac ? "Cmd+Shift+[" : "Ctrl+Shift+Tab",
  };
}

/** One tab as it is kept for the next start: its path on the server, and its title and icon to show until it loads. */
export type SavedTab = { path: string; title?: string; icon?: string };
export type SavedWindow = { tabs: SavedTab[]; active: number };
/** The windows' tabs on one server: its origin, or "local" for Leafdesk on this computer (last-page.ts). */
export type SavedTabs = { server: string; windows: SavedWindow[] };

/** Paths a tab is restored on: Leafdesk's pages and screens in a workspace, and AI chat. */
const TAB_PATH = /^\/(?:w\/[\w-]{1,100}(?:\/[\w-]{1,100}){0,4}|ai)$/;
const MAX_SEARCH = 500;
const MAX_TITLE = 200;
const MAX_TABS = 50;
const MAX_WINDOWS = 10;

/**
 * The path (and query) to keep of a tab showing `url` from `origin`: one of Leafdesk's pages there,
 * else the server's home. Nothing from elsewhere is kept, so a saved tab only opens the server's pages.
 */
export function tabPath(url: string | undefined, origin: string | undefined): string {
  if (!url || !origin) return "/";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "/";
  }
  if (parsed.origin !== origin || !TAB_PATH.test(parsed.pathname)) return "/";
  return parsed.search.length <= MAX_SEARCH ? `${parsed.pathname}${parsed.search}` : parsed.pathname;
}

/** Whether a saved path is one a tab may open (tabPath's rule, read back from the settings file). */
function isTabPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (path === "/") return true;
  const query = path.indexOf("?");
  const pathname = query < 0 ? path : path.slice(0, query);
  return TAB_PATH.test(pathname) && path.length - pathname.length <= MAX_SEARCH && !path.includes("#");
}

function readTab(value: unknown): SavedTab | null {
  if (!value || typeof value !== "object") return null;
  const { path, title, icon } = value as Partial<SavedTab>;
  if (!isTabPath(path)) return null;
  const tab: SavedTab = { path };
  if (typeof title === "string" && title) tab.title = title.slice(0, MAX_TITLE);
  const saved = readIcon(icon);
  if (saved) tab.icon = saved;
  return tab;
}

/** The saved tabs from the settings file, if they are such: anything else in them is dropped. */
export function readSavedTabs(value: unknown): SavedTabs | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { server, windows } = value as Partial<SavedTabs>;
  if (typeof server !== "string" || !server || !Array.isArray(windows)) return undefined;
  const read = windows
    .map((window: unknown): SavedWindow | null => {
      if (!window || typeof window !== "object") return null;
      const { tabs: list, active: shown } = window as Partial<SavedWindow>;
      if (!Array.isArray(list)) return null;
      const tabs = list.map(readTab).filter((tab): tab is SavedTab => tab !== null).slice(0, MAX_TABS);
      if (!tabs.length) return null;
      const active = Number.isInteger(shown) && (shown as number) >= 0 && (shown as number) < tabs.length ? (shown as number) : 0;
      return { tabs, active };
    })
    .filter((window): window is SavedWindow => window !== null)
    .slice(0, MAX_WINDOWS);
  return read.length ? { server, windows: read } : undefined;
}

/** The windows to open at the start on `server`: the tabs saved there, else one tab on `fallback`. */
export function windowsToRestore(saved: SavedTabs | undefined, server: string | undefined, fallback: string): SavedWindow[] {
  if (saved && server && saved.server === server) return saved.windows;
  return [{ tabs: [{ path: fallback }], active: 0 }];
}

/**
 * A tab's title from its page's: Leafdesk ends every title with its name ("Page · Leafdesk"),
 * which a tab has no room for.
 */
export function tabTitle(title: string) {
  const trimmed = title.replace(/\s+[·|–—-]\s+Leafdesk$/u, "").trim();
  return trimmed || title.trim();
}

/** A page's icon as the page reports it: an emoji (lib/icon.ts on the server), else none. */
export function readIcon(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const icon = value.trim();
  return icon && [...icon].length <= 8 ? icon : null;
}
