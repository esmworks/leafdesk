"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import { MAX_SNIPPET_BODY, MAX_SNIPPET_TITLE, MAX_SNIPPET_TRIGGER, MAX_SNIPPETS, type SnippetInput, type SnippetSummary, type SnippetView } from "@/lib/snippets";
import { AccessError } from "@/server/access";
import { requireUserId } from "@/server/session";
import * as snippets from "@/server/snippets";

// Snippets (see server/snippets.ts): the editor's `;` menu and slash group, "Save as snippet" in
// the block menu, and Settings > Snippets. Expected failures come back translated: Next.js hides
// thrown messages in production. Importing goes through /api/snippets/import (files can be large).

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations("snippets.errors");
    if (error instanceof snippets.SnippetError) {
      const max = { triggerInvalid: MAX_SNIPPET_TRIGGER, titleTooLong: MAX_SNIPPET_TITLE, bodyTooLong: MAX_SNIPPET_BODY, tooMany: MAX_SNIPPETS }[
        error.code as string
      ];
      return { ok: false, error: t(error.code, { max: max ?? 0 }), code: error.code };
    }
    if (error instanceof AccessError) return { ok: false, error: t("accessDenied"), code: "accessDenied" };
    console.error("[snippet action]", error);
    const tc = await getTranslations("common");
    return { ok: false, error: tc("genericError") };
  }
}

/** Who a scope belongs to, from what the client sent. */
function ownerOf(workspaceId: string | null): snippets.SnippetOwner {
  return workspaceId ? { kind: "workspace", workspaceId: String(workspaceId) } : { kind: "personal" };
}

const input = (value: Partial<SnippetInput> | null | undefined): Partial<SnippetInput> => ({
  trigger: typeof value?.trigger === "string" ? value.trigger : "",
  title: typeof value?.title === "string" ? value.title : "",
  body: typeof value?.body === "string" ? value.body : "",
});

/** The editor's menus: personal snippets and the workspace's, without bodies. */
export async function usableSnippetsAction(
  workspaceId: string,
): Promise<ActionResult<{ snippets: SnippetSummary[]; manages: { id: string; name: string } | null }>> {
  return run((userId) => snippets.usableSnippets(userId, String(workspaceId)));
}

/** One snippet with its body, when it is inserted. */
export async function getSnippetAction(id: string): Promise<ActionResult<SnippetView>> {
  return run((userId) => snippets.getSnippet(userId, String(id)));
}

/** `workspaceId` null: the person's own snippets. */
export async function listSnippetsAction(workspaceId: string | null): Promise<ActionResult<SnippetView[]>> {
  return run((userId) => snippets.listSnippets(userId, ownerOf(workspaceId)));
}

export async function createSnippetAction(workspaceId: string | null, value: SnippetInput): Promise<ActionResult<SnippetView>> {
  return run((userId) => snippets.createSnippet(userId, ownerOf(workspaceId), input(value)));
}

export async function updateSnippetAction(id: string, value: SnippetInput): Promise<ActionResult<SnippetView>> {
  return run((userId) => snippets.updateSnippet(userId, String(id), input(value)));
}

export async function duplicateSnippetAction(id: string): Promise<ActionResult<SnippetView>> {
  const t = await getTranslations("snippets");
  return run((userId) => snippets.duplicateSnippet(userId, String(id), (title) => t("copyTitle", { title })));
}

export async function deleteSnippetAction(id: string): Promise<ActionResult<undefined>> {
  return run(async (userId) => {
    await snippets.deleteSnippet(userId, String(id));
    return undefined;
  });
}
