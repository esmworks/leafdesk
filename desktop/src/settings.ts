import fs from "node:fs";
import path from "node:path";
import { readShortcut } from "./global-shortcut.ts";
import { readLastPage, type LastPage } from "./last-page.ts";
import { readSavedTabs, type SavedTabs } from "./tabs.ts";

export type WindowState = { x?: number; y?: number; width: number; height: number; maximized: boolean };

export type Settings = {
  /** The connected server's origin; unset until someone connects. */
  server?: string;
  /** Leafdesk runs on this computer (local-server.ts) instead of on `server`. */
  mode?: "local";
  /** The port Leafdesk on this computer had, kept while it is free (its pages' offline copies are its origin's). */
  localPort?: number;
  /** Certificates trusted for a host although this computer doesn't trust them: host → SHA-256 fingerprint. */
  trustedCertificates: Record<string, string>;
  /**
   * The servers' hosts seen with a certificate this computer trusts: one showing an untrusted
   * certificate later gets a stronger warning (certificates.ts, certificateChanged).
   */
  validCertificateHosts: string[];
  /** Servers allowed to use the microphone, by origin (main.ts asks once for each). */
  microphone?: Record<string, true>;
  window?: WindowState;
  /** Where Leafdesk on this computer keeps its backups; unset is the default (main.ts, backupFolder). */
  backupFolder?: string;
  /** The global shortcut to AI chat: one of global-shortcut.ts's choices, or "off"; unset is the default. */
  globalShortcut?: string;
  /** The page shown last, opened again at the next start when there are no tabs kept (last-page.ts). */
  lastPage?: LastPage;
  /** The windows' tabs, opened again at the next start on the same server (tabs.ts). */
  tabs?: SavedTabs;
};

/** Settings kept in a JSON file; a missing or unreadable file means a first start. */
export function loadSettings(file: string): Settings {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Settings>;
    return {
      server: typeof value.server === "string" ? value.server : undefined,
      mode: value.mode === "local" ? "local" : undefined,
      localPort: Number.isInteger(value.localPort) ? value.localPort : undefined,
      trustedCertificates: value.trustedCertificates && typeof value.trustedCertificates === "object" ? value.trustedCertificates : {},
      validCertificateHosts: Array.isArray(value.validCertificateHosts) ? value.validCertificateHosts.filter((host) => typeof host === "string") : [],
      microphone: readAllowed(value.microphone),
      window: value.window,
      backupFolder: typeof value.backupFolder === "string" && value.backupFolder ? value.backupFolder : undefined,
      globalShortcut: readShortcut(value.globalShortcut, process.platform),
      lastPage: readLastPage(value.lastPage),
      tabs: readSavedTabs(value.tabs),
    };
  } catch {
    return { trustedCertificates: {}, validCertificateHosts: [] };
  }
}

/** The origins allowed something, kept as `origin: true`. */
function readAllowed(value: unknown): Record<string, true> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const allowed = Object.entries(value).filter(([, answer]) => answer === true);
  return allowed.length ? Object.fromEntries(allowed.map(([origin]) => [origin, true as const])) : undefined;
}

/** Written to a temporary file first, so a crash midway leaves the old settings. */
export function saveSettings(file: string, settings: Settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2));
  fs.renameSync(temporary, file);
}
