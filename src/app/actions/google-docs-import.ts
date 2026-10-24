"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import { formatBytes } from "@/lib/files";
import type { GoogleDoc, GoogleDocsSource } from "@/lib/import/google-docs";
import { ImportError, type ImportResult } from "@/lib/import/result";
import { AccessError } from "@/server/access";
import { GoogleDocsError, googleDocsSources, importGoogleDocs, searchGoogleDocs } from "@/server/import/google-docs";
import { requireUserId } from "@/server/session";
import { TeamspaceError } from "@/server/teamspaces";

// The import dialog's Google Docs tab (see server/import/google-docs). Expected failures come back
// translated: Next.js hides thrown messages.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations("import");
    if (error instanceof GoogleDocsError) return { ok: false, error: t(`googleDocs.errors.${error.code}`, error.params), code: error.code };
    if (error instanceof ImportError) {
      const params = { ...error.params };
      if (error.code === "tooLarge" && typeof params.limit === "number") params.limit = formatBytes(params.limit);
      const key = `errors.${error.code}` as "errors.badRequest";
      return { ok: false, error: t.has(key) ? t(key, params) : t("errors.badRequest"), code: error.code };
    }
    if (error instanceof AccessError || error instanceof TeamspaceError) return { ok: false, error: t("errors.noAccess"), code: "noAccess" };
    // Guards of the page written to (a parent in the trash, a locked page), as the import route answers them.
    if (error instanceof Error && error.constructor === Error) return { ok: false, error: t("errors.badRequest"), code: "badRequest" };
    console.error("[google docs import]", error);
    const tc = await getTranslations("common");
    return { ok: false, error: tc("genericError") };
  }
}

/** The Google Drive connections the person may import through in the workspace. */
export async function googleDocsSourcesAction(workspaceId: string): Promise<ActionResult<GoogleDocsSource[]>> {
  return run((userId) => googleDocsSources(userId, String(workspaceId ?? "")));
}

/** Google documents whose title has the words, a page at a time. */
export async function searchGoogleDocsAction(value: { connectionId: string; words: string; pageToken?: string | null }): Promise<ActionResult<{ docs: GoogleDoc[]; next: string | null }>> {
  return run((userId) =>
    searchGoogleDocs(userId, {
      connectionId: String(value?.connectionId ?? ""),
      words: typeof value?.words === "string" ? value.words : "",
      pageToken: typeof value?.pageToken === "string" ? value.pageToken : null,
    }),
  );
}

/** Imports the documents as pages (answered like any import). */
export async function importGoogleDocsAction(value: {
  connectionId: string;
  workspaceId: string;
  parentId: string | null;
  /** A teamspace id, "private", or undefined for the default teamspace (as the import route takes it). */
  teamspaceId?: string;
  ids: string[];
}): Promise<ActionResult<ImportResult>> {
  return run((userId) => {
    const space = value?.teamspaceId;
    return importGoogleDocs(
      { userId },
      {
        connectionId: String(value?.connectionId ?? ""),
        workspaceId: String(value?.workspaceId ?? ""),
        parentId: typeof value?.parentId === "string" && value.parentId ? value.parentId : null,
        teamspaceId: space === "private" ? null : typeof space === "string" && space ? space : undefined,
        ids: Array.isArray(value?.ids) ? value.ids.filter((id): id is string => typeof id === "string").slice(0, 100) : [],
      },
    );
  });
}
