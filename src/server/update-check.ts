import { env } from "@/lib/env";
import { isNewerVersion, parseVersion, versionLabel } from "@/lib/release-version";
import { APP_INFO } from "@/server/app-info";
import { startSweep } from "@/server/sweep";

/**
 * Whether a newer Leafdesk is out, for the instance admin page. Every UPDATE_CHECK_HOURS the server
 * asks GitHub's public API for the project's latest release: a fixed address, no cookies, nothing
 * about the server or its people but the request itself. UPDATE_CHECK=off stops it, and the desktop
 * app's own server (local mode) never asks; the app updates itself.
 *
 * The answer lives in this process's memory on globalThis, since server.ts, which starts the check,
 * and Next's bundle, which renders the admin page, load this module apart.
 */

const LATEST_RELEASE_URL = "https://api.github.com/repos/esmworks/leafdesk/releases/latest";
const UPDATE_CHECK_HOURS = 12;
const TIMEOUT_MS = 5_000;

export type UpdateCheck = {
  /** The latest release's version, without its `v`. */
  latest: string;
  /** Its release notes. */
  url: string;
  /** Later than the version this server runs. */
  newer: boolean;
  checkedAt: string;
};

const holder = globalThis as { __leafdeskUpdateCheck?: UpdateCheck | null };

/** The last answer, or null before the first one, after failures only, or with the check off. */
export function latestRelease(): UpdateCheck | null {
  return holder.__leafdeskUpdateCheck ?? null;
}

/** Reads GitHub's answer: the tag of the latest release, or null for anything else. */
export function releaseOf(body: unknown, running: string, now = new Date()): UpdateCheck | null {
  const tag = (body as { tag_name?: unknown } | null)?.tag_name;
  if (typeof tag !== "string" || !parseVersion(tag)) return null;
  // The link is made here, not taken from the answer: only the project's own release page.
  return {
    latest: versionLabel(tag),
    url: `${APP_INFO.repository}/releases/tag/${encodeURIComponent(tag.trim())}`,
    newer: isNewerVersion(tag, running),
    checkedAt: now.toISOString(),
  };
}

/** Asks once; a failure keeps the earlier answer. */
export async function checkForUpdate(fetcher: typeof fetch = fetch) {
  const response = await fetcher(LATEST_RELEASE_URL, {
    headers: { accept: "application/vnd.github+json", "user-agent": "Leafdesk" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const release = releaseOf(await response.json(), APP_INFO.version);
  if (release) holder.__leafdeskUpdateCheck = release;
  return release;
}

export function startUpdateCheck() {
  if (env.localMode || !env.updateCheck) return;
  startSweep(UPDATE_CHECK_HOURS * 60 * 60_000, checkForUpdate, "[update check] could not ask for the latest release");
}
