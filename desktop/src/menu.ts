import { BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { shortcutLabel } from "./global-shortcut.ts";
import type { Strings } from "./strings.ts";

export const WEBSITE = "https://esmworks.github.io/leafdesk/";
export const ISSUES = "https://github.com/esmworks/leafdesk/issues";

type Actions = {
  changeServer: () => void;
  goHome: (window: BrowserWindow) => void;
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
        ? [...backupItems, { role: "close", label: t.menuCloseWindow }]
        : [changeServer, { type: "separator" }, ...backupItems, { role: "close", label: t.menuCloseWindow }, { role: "quit", label: t.menuQuit }],
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
        { role: "reload", label: t.reload },
        { role: "forceReload", label: t.forceReload },
        { role: "toggleDevTools", label: t.devTools },
        { type: "separator" },
        { role: "resetZoom", label: t.actualSize },
        { role: "zoomIn", label: t.zoomIn },
        { role: "zoomOut", label: t.zoomOut },
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
          click: focused((window) => window.webContents.navigationHistory.goBack()),
        },
        {
          label: t.goForward,
          accelerator: mac ? "Cmd+]" : "Alt+Right",
          click: focused((window) => window.webContents.navigationHistory.goForward()),
        },
        { type: "separator" },
        { label: t.goHome, accelerator: "CmdOrCtrl+Shift+H", click: focused(actions.goHome) },
        { type: "separator" },
        { label: t.menuAiShortcut, submenu: shortcutItems },
      ],
    },
    {
      label: t.menuWindow,
      submenu: mac
        ? [
            { role: "minimize", label: t.minimize },
            { role: "zoom", label: t.zoom },
            { type: "separator" },
            { role: "front", label: t.bringAllToFront },
          ]
        : [{ role: "minimize", label: t.minimize }],
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
