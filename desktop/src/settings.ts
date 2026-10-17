import fs from "node:fs";
import path from "node:path";

export type WindowState = { x?: number; y?: number; width: number; height: number; maximized: boolean };

export type Settings = {
  /** The connected server's origin; unset until someone connects. */
  server?: string;
  /** Certificates trusted for a host although this computer doesn't trust them: host → SHA-256 fingerprint. */
  trustedCertificates: Record<string, string>;
  window?: WindowState;
};

/** Settings kept in a JSON file; a missing or unreadable file means a first start. */
export function loadSettings(file: string): Settings {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Settings>;
    return {
      server: typeof value.server === "string" ? value.server : undefined,
      trustedCertificates: value.trustedCertificates && typeof value.trustedCertificates === "object" ? value.trustedCertificates : {},
      window: value.window,
    };
  } catch {
    return { trustedCertificates: {} };
  }
}

/** Written to a temporary file first, so a crash midway leaves the old settings. */
export function saveSettings(file: string, settings: Settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2));
  fs.renameSync(temporary, file);
}
