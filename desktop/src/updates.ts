import { app, dialog } from "electron";
import electronUpdater from "electron-updater";
import { fill, type Strings } from "./strings.ts";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Updates from the project's GitHub releases (electron-builder's `publish` setting): downloaded in
 * the background, installed on the next restart, or right away when the person agrees. Only in a
 * packaged app; a Linux build updates itself only as an AppImage.
 */
export function startUpdates(strings: () => Strings) {
  if (!app.isPackaged || process.env.LEAFDESK_DISABLE_UPDATES) return;
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-downloaded", async (info) => {
    const t = strings();
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: t.updateReadyTitle,
      detail: fill(t.updateReadyBody, { version: info.version }),
      buttons: [t.restartNow, t.later],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on("error", (error) => console.warn("Update check failed:", error.message));

  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
  check();
  setInterval(check, CHECK_EVERY_MS).unref();
}
