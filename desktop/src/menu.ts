import { BrowserWindow, Menu, shell, type MenuItemConstructorOptions, type WebContents } from "electron";
import { shortcutLabel } from "./global-shortcut.ts";
import type { Strings } from "./strings.ts";
import { tabShortcuts } from "./tabs.ts";

export const WEBSITE = "https://esmworks.github.io/leafdesk/";
export const ISSUES = "https://github.com/esmworks/leafdesk/issues";

/** What a menu item does to the window in front; undefined when no window is (macOS keeps running without one). */
type WindowAction = (window: BrowserWindow | undefined) => void;

type Actions = {
  changeServer: () => void;
  goHome: (window: BrowserWindow) => void;
  /** The page of the shown tab of a window. */
  tab: (window: BrowserWindow) => WebContents | undefined;
  tabs: Record<"newTab" | "newWindow" | "closeTab" | "reopenClosedTab" | "nextTab" | "previousTab", WindowAction>;
  /** Leafdesk on this computer's backups, while it runs. */
  backups?: { now: () => void; show: () => void; chooseFolder: () => void };
  /** The global shortcut to AI chat: the choices, the one picked (null: off), and whether another app has it. */
  shortcut: { choices: string[]; current: string | null; inUse: boolean; pick: (accelerator: string | null) => void };
};

/** The application menu, in the app's language; macOS gets its own app menu first. */
export function buildMenu(t: Strings, actions: Actions) {
  const mac = process.platform === "darwin";
  const focused = (run: (window: BrowserWindow) => void) => (_: unknown, window: unknown) => {
    if (window instanceof BrowserWindow) run(window);
  };
  const front = (run: WindowAction) => (_: unknown, window: unknown) => run(window instanceof BrowserWindow ? window : undefined);
  /** An item acting on the shown tab's page rather than on the page that has the keyboard (the strip, after a click on it). */
  const onTab = (run: (contents: WebContents) => void) =>
    focused((window) => {
      const contents = actions.tab(window);
      if (contents) run(contents);
    });
  const keys = tabShortcuts(process.platform);
  const { tabs } = actions;
  const tabItems: MenuItemConstructorOptions[] = [
    { label: t.newTab, accelerator: keys.newTab, click: front(tabs.newTab) },
    { label: t.newWindow, accelerator: keys.newWindow, click: front(tabs.newWindow) },
    { type: "separator" },
    { label: t.reopenClosedTab, accelerator: keys.reopenClosedTab, click: front(tabs.reopenClosedTab) },
    { type: "separator" },
  ];
  const closeItems: MenuItemConstructorOptions[] = [
    { label: t.closeTab, accelerator: keys.closeTab, click: front(tabs.closeTab) },
    { role: "close", label: t.menuCloseWindow, accelerator: keys.closeWindow },
  ];
  const changeServer: MenuItemConstructorOptions = { label: t.menuChangeServer, click: () => actions.changeServer() };
  const { backups } = actions;
  const backupItems: MenuItemConstructorOptions[] = backups
    ? [
        { label: t.menuBackUpNow, click: () => backups.now() },
        { label: t.menuShowBackups, click: () => backups.show() },
        { label: t.menuBackupFolder, click: () => backups.chooseFolder() },
        { type: "separator" },
      ]
    : [];
  const { shortcut } = actions;
  // The shortcuts are labels, not the items' accelerators: those would take the keys inside the app too.
  const shortcutItems: MenuItemConstructorOptions[] = [
    ...shortcut.choices.map(
      (accelerator): MenuItemConstructorOptions => ({
        label: shortcutLabel(accelerator, process.platform),
        type: "radio",
        checked: accelerator === shortcut.current,
        click: () => shortcut.pick(accelerator),
      }),
    ),
    { label: t.shortcutOff, type: "radio", checked: shortcut.current === null, click: () => shortcut.pick(null) },
    ...(shortcut.inUse ? [{ type: "separator" as const }, { label: t.shortcutInUse, enabled: false }] : []),
  ];

  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: "Leafdesk",
            submenu: [
              { role: "about", label: t.menuAbout },
              { type: "separator" },
              changeServer,
              { type: "separator" },
              { role: "services", label: t.menuServices },
              { type: "separator" },
              { role: "hide", label: t.menuHide },
              { role: "hideOthers", label: t.menuHideOthers },
              { role: "unhide", label: t.menuShowAll },
              { type: "separator" },
              { role: "quit", label: t.menuQuit },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: t.menuFile,
      submenu: mac
        ? [...tabItems, ...backupItems, ...closeItems]
        : [...tabItems, changeServer, { type: "separator" }, ...backupItems, ...closeItems, { role: "quit", label: t.menuQuit }],
    },
    {
      label: t.menuEdit,
      submenu: [
        { role: "undo", label: t.undo },
        { role: "redo", label: t.redo },
        { type: "separator" },
        { role: "cut", label: t.cut },
        { role: "copy", label: t.copy },
        { role: "paste", label: t.paste },
        { role: "pasteAndMatchStyle", label: t.pasteAndMatchStyle },
        { role: "selectAll", label: t.selectAll },
      ],
    },
    {
      label: t.menuView,
      submenu: [
        { label: t.reload, accelerator: "CmdOrCtrl+R", click: onTab((contents) => contents.reload()) },
        { label: t.forceReload, accelerator: "Shift+CmdOrCtrl+R", click: onTab((contents) => contents.reloadIgnoringCache()) },
        { label: t.devTools, accelerator: mac ? "Alt+Cmd+I" : "Ctrl+Shift+I", click: onTab((contents) => contents.toggleDevTools()) },
        { type: "separator" },
        { label: t.actualSize, accelerator: "CmdOrCtrl+0", click: onTab((contents) => contents.setZoomLevel(0)) },
        { label: t.zoomIn, accelerator: "CmdOrCtrl+Plus", click: onTab((contents) => contents.setZoomLevel(contents.getZoomLevel() + 0.5)) },
        { label: t.zoomOut, accelerator: "CmdOrCtrl+-", click: onTab((contents) => contents.setZoomLevel(contents.getZoomLevel() - 0.5)) },
        { type: "separator" },
        { role: "togglefullscreen", label: t.toggleFullScreen },
      ],
    },
    {
      label: t.menuGo,
      submenu: [
        {
          label: t.goBack,
          accelerator: mac ? "Cmd+[" : "Alt+Left",
          click: onTab((contents) => contents.navigationHistory.goBack()),
        },
        {
          label: t.goForward,
          accelerator: mac ? "Cmd+]" : "Alt+Right",
          click: onTab((contents) => contents.navigationHistory.goForward()),
        },
        { type: "separator" },
        { label: t.goHome, accelerator: "CmdOrCtrl+Shift+H", click: focused(actions.goHome) },
        { type: "separator" },
        { label: t.menuAiShortcut, submenu: shortcutItems },
      ],
    },
    {
      label: t.menuWindow,
      submenu: [
        { role: "minimize", label: t.minimize },
        ...(mac ? [{ role: "zoom", label: t.zoom } as const] : []),
        { type: "separator" },
        { label: t.nextTab, accelerator: keys.nextTab, click: front(tabs.nextTab) },
        { label: t.previousTab, accelerator: keys.previousTab, click: front(tabs.previousTab) },
        ...(mac ? [{ type: "separator" } as const, { role: "front", label: t.bringAllToFront } as const] : []),
      ],
    },
    {
      role: "help",
      label: t.menuHelp,
      submenu: [
        { label: t.website, click: () => void shell.openExternal(WEBSITE) },
        { label: t.reportIssue, click: () => void shell.openExternal(ISSUES) },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
