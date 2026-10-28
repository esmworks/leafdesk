import * as z from "zod";
import { ApiError } from "./errors";

/**
 * Cursors are opaque to clients: the position of the next item, base64url-encoded. Lists are read
 * in full and then cut, so a cursor stays valid as long as the list keeps its order; pages added or
 * removed between calls can shift what the next page starts with.
 */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  try {
    const { o } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown };
    if (typeof o === "number" && Number.isInteger(o) && o >= 0) return o;
  } catch {
    // Falls through to the error below.
  }
  throw new ApiError(400, "invalid_cursor", "The cursor is not valid. Pass next_cursor from the previous response as it is.");
}

export const cursorInput = z
  .string()
  .optional()
  .describe("next_cursor from the previous response, to read the next page.");

/** Where the next page starts, or null after the last one. */
export function nextCursor(offset: number, limit: number, total: number) {
  return offset + limit < total ? encodeCursor(offset + limit) : null;
}

/** One page of a list read in full. */
export function paginate<T>(items: T[], cursor: string | undefined, limit: number) {
  const offset = decodeCursor(cursor);
  const next = nextCursor(offset, limit, items.length);
  return { items: items.slice(offset, offset + limit), next_cursor: next, has_more: next !== null };
}

/** For lists read on from a time instead of a position (a database's history): that time, opaque. */
export function encodeTimeCursor(at: string): string {
  return Buffer.from(JSON.stringify({ t: at })).toString("base64url");
}

export function decodeTimeCursor(cursor: string | undefined): string | null {
  if (cursor === undefined || cursor === "") return null;
  try {
    const { t } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { t?: unknown };
    if (typeof t === "string" && !Number.isNaN(new Date(t).getTime())) return t;
  } catch {
    // Falls through to the error below.
  }
  throw new ApiError(400, "invalid_cursor", "The cursor is not valid. Pass next_cursor from the previous response as it is.");
}
