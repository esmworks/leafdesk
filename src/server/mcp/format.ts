import type { CallToolResult } from "@modelcontextprotocol/server";
import { CommentError } from "@/lib/comments";
import { env } from "@/lib/env";
import { PAGE_LOCKED_MESSAGE } from "@/lib/page-lock";
import { PropertyValueError } from "@/lib/properties";
import { AccessError, ConnectedAppReadOnlyError } from "@/server/access";
import { GroupError } from "@/lib/groups";
import { TeamspaceError } from "@/lib/teamspace-error";

/** Max characters of page markdown returned in one get_page call. */
export const MAX_MARKDOWN_CHARS = 30_000;

/** A problem with the tool arguments the model can fix by itself. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export const pageUrl = (workspaceId: string, pageId: string) => `${env.appUrl}/w/${workspaceId}/p/${pageId}`;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A whole link into the app, on any host or none: `/w/<workspace>`, optionally `/p/<page>`, then `?…` / `#…`. */
const APP_LINK = new RegExp(`^(?:https?://[^/\\s]+)?/w/(${UUID})(?:/p/(${UUID}))?/?(?:[?#](\\S*))?$`, "i");

/**
 * The id a pasted Leafdesk link stands for in the argument `key`: the workspace for workspace_id,
 * the view in `?view=` for view_id, else the page. Anything that isn't a whole link, or names
 * nothing for that key, is returned as it is.
 */
export function idFromLink(key: string, value: string): string {
  const match = APP_LINK.exec(value.trim());
  if (!match) return value;
  const [, workspaceId, pageId, rest] = match;
  if (key === "workspace_id") return workspaceId;
  if (key === "view_id") return new URLSearchParams(rest?.split("#")[0] ?? "").get("view") ?? value;
  return pageId ?? value;
}

/**
 * Tool arguments with Leafdesk links in id arguments (`*_id`, and the items of `*_ids`) turned into
 * the ids they point at, so the model can pass on a link the user pasted. Other arguments
 * (Markdown bodies with page mentions, titles) are left alone.
 */
export function idsFromLinks<A>(args: A): A {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  let changed = false;
  const out = { ...args } as Record<string, unknown>;
  for (const [key, value] of Object.entries(out)) {
    let next = value;
    if (key.endsWith("_id") && typeof value === "string") next = idFromLink(key, value);
    else if (key.endsWith("_ids") && Array.isArray(value)) {
      const ids = value.map((v) => (typeof v === "string" ? idFromLink(key.slice(0, -1), v) : v));
      if (ids.some((v, i) => v !== value[i])) next = ids;
    }
    if (next !== value) {
      out[key] = next;
      changed = true;
    }
  }
  return changed ? (out as A) : args;
}

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Turns domain errors into tool errors the model can act on; unknown errors stay opaque. */
export function toolErrorFor(error: unknown): CallToolResult {
  if (error instanceof ToolInputError) return errorResult(error.message);
  if (error instanceof ConnectedAppReadOnlyError) {
    return errorResult(
      `${error.message}, so this change was refused. Reading still works; an owner can allow changes in the workspace's Settings → Security (Connected apps and API tokens).`,
    );
  }
  if (error instanceof AccessError) {
    return errorResult(
      `${error.message}. The id may be wrong, deleted, or in a workspace this user cannot access. ` +
        "Use search, list_workspaces or list_pages to find valid ids.",
    );
  }
  if (error instanceof CommentError) return errorResult(`${error.message}.`);
  if (error instanceof TeamspaceError) return errorResult(`${error.message} Call list_teamspaces to see which teamspaces the user is in.`);
  if (error instanceof GroupError) return errorResult(`${error.message} Call list_groups to see the workspace's groups.`);
  if (error instanceof PropertyValueError) {
    return errorResult(`${error.message}. Call get_database to see property names, types and select options.`);
  }
  if ((error as { code?: unknown } | null)?.code === "databaseLocked") {
    return errorResult(
      "The database is locked, so its properties and views can't be added, renamed, moved or removed. Rows, values and view filters and sorts can still change. Someone with full access can unlock it in the app.",
    );
  }
  if ((error as { code?: unknown } | null)?.code === "pageLocked") return errorResult(PAGE_LOCKED_MESSAGE);
  console.error("[mcp] tool failed", error);
  return errorResult("Something went wrong on the Leafdesk server while running this tool. Try again later.");
}

export async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await fn());
  } catch (error) {
    return toolErrorFor(error);
  }
}

/** Returns a window of `text` starting at `offset`, bounded to `max` characters. */
export function sliceText(text: string, offset = 0, max = MAX_MARKDOWN_CHARS) {
  const start = Math.max(0, Math.min(offset, text.length));
  const end = Math.min(text.length, start + max);
  const truncated = start > 0 || end < text.length;
  return {
    text: text.slice(start, end),
    truncated,
    totalChars: text.length,
    ...(end < text.length
      ? { note: `Showing characters ${start}-${end} of ${text.length}. Call again with offset=${end} to read more.` }
      : start > 0
        ? { note: `Showing characters ${start}-${end} of ${text.length}.` }
        : {}),
  };
}
