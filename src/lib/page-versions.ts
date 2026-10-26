/**
 * Names of saved page versions (page_snapshot.name). Someone who can edit a page saves a version
 * with a name, or names one already saved, so it is easy to find again in the page history; named
 * versions are never pruned (server/retention.ts). Shared by the history panel and the server.
 */

/** The longest name a version can have, in characters. */
export const MAX_VERSION_NAME = 100;

/**
 * A version's name as stored: trimmed, its runs of whitespace (line breaks included) made one
 * space, and null when nothing is left, which saves the version unnamed or clears its name.
 * Undefined when the value isn't text or is longer than MAX_VERSION_NAME.
 */
export function versionName(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const name = value.replace(/\s+/g, " ").trim();
  if (!name) return null;
  return [...name].length > MAX_VERSION_NAME ? undefined : name;
}

/** What saving a version found: nothing changed since `latest`, which can be named instead. */
export type VersionSaveState = {
  /** The newest saved version, or null when the page has none. */
  latest: { id: string; name: string | null; createdAt: Date } | null;
  /** Whether the title or body changed since `latest` (true when there is none). */
  changed: boolean;
};

/** Whether saving now would copy the newest version as it is (then naming it is offered instead). */
export function unchangedSince(
  latest: { title: string; contentMarkdown: string } | null | undefined,
  current: { title: string; markdown: string },
): boolean {
  return Boolean(latest) && latest!.title === current.title && latest!.contentMarkdown === current.markdown;
}
