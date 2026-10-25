import type { PageLevel } from "@/db/schema";

/** Longest message kept with an access request; longer ones are cut. */
export const ACCESS_REQUEST_MESSAGE_MAX = 500;

/**
 * How many times one person may ask for access within the window. Every ask counts, whether the
 * page exists or not and whether a request was already pending, so hitting the limit says nothing
 * about the pages asked for.
 */
export const ACCESS_REQUEST_LIMIT = { count: 10, windowMs: 60 * 60_000 } as const;

export type ApprovalLevel = Exclude<PageLevel, "none">;

export const APPROVAL_LEVELS: readonly ApprovalLevel[] = ["view", "comment", "content", "edit", "full"];

export const isApprovalLevel = (value: unknown): value is ApprovalLevel =>
  typeof value === "string" && (APPROVAL_LEVELS as readonly string[]).includes(value);

/**
 * What a request asks for: "view" is any access, from the "You don't have access" screen (the
 * approver picks the level); "comment" and "edit" are more than someone who can open the page has.
 */
export type RequestedLevel = "view" | "comment" | "edit";

/** The levels someone who can open a page may ask for on top of what they have. */
export const MORE_ACCESS_LEVELS = ["comment", "edit"] as const;
export type MoreAccessLevel = (typeof MORE_ACCESS_LEVELS)[number];

export const isMoreAccessLevel = (value: unknown): value is MoreAccessLevel =>
  typeof value === "string" && (MORE_ACCESS_LEVELS as readonly string[]).includes(value);

const RANK: Record<PageLevel, number> = { none: 0, view: 1, comment: 2, content: 3, edit: 4, full: 5 };

/** Whether `level` is more than `current`. */
export const isAbove = (level: PageLevel, current: PageLevel) => RANK[level] > RANK[current];

/** What someone with `current` access may ask for more of: none without access (they ask from the no-access screen) or with edit and above. */
export function levelsToAsk(current: PageLevel): MoreAccessLevel[] {
  if (current === "none") return [];
  return MORE_ACCESS_LEVELS.filter((level) => isAbove(level, current));
}

/**
 * The levels an approver may give: any for someone without access, only more than they have for
 * someone who can already open the page (sharing less would take access away, not answer them).
 */
export const approvalLevelsFor = (current: PageLevel): ApprovalLevel[] => APPROVAL_LEVELS.filter((level) => isAbove(level, current));

/**
 * The level an approver's picker starts at: the one asked for when someone asked for more, else
 * `fallback` (what sharing would give) when it is above what they have, else the least above.
 */
export function initialApprovalLevel(request: { level: RequestedLevel; current: PageLevel }, fallback: ApprovalLevel): ApprovalLevel {
  if (request.level !== "view") return request.level;
  const choices = approvalLevelsFor(request.current);
  return choices.includes(fallback) ? fallback : (choices[0] ?? fallback);
}

/**
 * The message to keep with a request: trimmed, tabs as spaces, without other control characters
 * than line breaks, at most ACCESS_REQUEST_MESSAGE_MAX characters; null when nothing is left.
 */
export function cleanRequestMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim();
  if (!text) return null;
  return [...text].slice(0, ACCESS_REQUEST_MESSAGE_MAX).join("").trimEnd();
}

/**
 * The page id when `path` (the requested path, see src/proxy.ts) is a page of the workspace:
 * `/w/<workspaceId>/p/<pageId>`, with or without a query. The workspace layout uses it to let
 * people outside the workspace reach the "You don't have access" screen, and nothing else.
 */
export function requestedPageId(path: string | null | undefined, workspaceId: string): string | null {
  if (!path) return null;
  const pathname = path.split(/[?#]/, 1)[0];
  const match = /^\/w\/([^/]+)\/p\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  let ws: string;
  let pageId: string;
  try {
    ws = decodeURIComponent(match[1]);
    pageId = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  return ws === workspaceId && pageId ? pageId : null;
}
