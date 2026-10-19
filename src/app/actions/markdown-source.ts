"use server";

import { AccessError } from "@/server/access";
import { isPageSaveFailed } from "@/server/collab/bridge";
import type { MarkdownSource } from "@/server/markdown-source";
import { requireUserId } from "@/server/session";

/** Why the Markdown source view can't read or save the page. */
export type MarkdownSourceFailure = "noAccess" | "database" | "trashed" | "locked" | "saveFailed" | "failed";

export type MarkdownSourceResult<T> = { ok: true; data: T } | { ok: false; code: MarkdownSourceFailure };

function failure(error: unknown): { ok: false; code: MarkdownSourceFailure } {
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof AccessError) return { ok: false, code: "noAccess" };
  if (code === "database" || code === "trashed") return { ok: false, code };
  if (code === "pageLocked") return { ok: false, code: "locked" };
  if (code === "pageInTrash") return { ok: false, code: "trashed" };
  if (isPageSaveFailed(error)) return { ok: false, code: "saveFailed" };
  console.error("Markdown source failed", error);
  return { ok: false, code: "failed" };
}

/** The page body as Markdown, with its version and what a save from Markdown would drop (server/markdown-source). */
export async function readMarkdownSourceAction(pageId: string): Promise<MarkdownSourceResult<MarkdownSource>> {
  const userId = await requireUserId();
  try {
    // Loaded on demand: it brings the BlockNote server editor along.
    const { readMarkdownSource } = await import("@/server/markdown-source");
    return { ok: true, data: await readMarkdownSource(userId, String(pageId)) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Writes the body from Markdown while it still has `expectedVersion`. `conflict`: someone changed
 * it meanwhile and nothing was written; `version` is the body's version now.
 */
export async function saveMarkdownSourceAction(
  pageId: string,
  markdown: string,
  expectedVersion: string,
): Promise<MarkdownSourceResult<{ conflict: boolean; version: string }>> {
  const userId = await requireUserId();
  try {
    const { saveMarkdownSource } = await import("@/server/markdown-source");
    const write = await saveMarkdownSource({ userId }, String(pageId), String(markdown), String(expectedVersion));
    return { ok: true, data: { conflict: write.conflict, version: write.version } };
  } catch (error) {
    return failure(error);
  }
}
