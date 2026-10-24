import { eq } from "drizzle-orm";
import { db } from "@/db";
import { connection } from "@/db/schema";
import {
  answerJson,
  answerText,
  base64Bytes,
  DOCX_MIME,
  DRIVE_DOWNLOAD_TOOL,
  DRIVE_SEARCH_TOOL,
  GOOGLE_DOCS_PAGE,
  googleDocId,
  googleDocsAccess,
  googleDocsQuery,
  MAX_GOOGLE_DOCS,
  MAX_GOOGLE_DOCS_SEARCH,
  readDocList,
  readExport,
  type GoogleDoc,
  type GoogleDocsSource,
  type ToolAnswer,
} from "@/lib/import/google-docs";
import { IMPORT_LIMITS } from "@/lib/import/markdown";
import { ImportError, type ImportResult } from "@/lib/import/result";
import { redactError, redactText } from "@/lib/redact";
import { AccessError, requireMembership, requirePageAccess } from "@/server/access";
import { recordAudit } from "@/server/audit";
import type { WriteActor } from "@/server/collab/bridge";
import { callConnectionTool, classify, type ConnectionRow } from "@/server/connections/client";
import { inputSummary } from "@/server/connections/tools";
import { importDocx } from "./docx";

/**
 * Imports Google documents through a workspace's Google Drive connection: each is exported as a
 * Word document by the connection's `download_file_content` tool and read by the Word import
 * (server/import/docx.ts), so it comes in the same way, pictures included, all or nothing.
 *
 * A connection is one owner's Google account. Owners may import through any ready connection that
 * has the tool; members only through one whose `download_file_content` an owner let the workspace's
 * AI chat call (and search only with `search_files` allowed too), so the import reads nothing a
 * member's chat couldn't; guests never. Each call is recorded in the audit log as the chat's are.
 */

export class GoogleDocsError extends Error {
  constructor(
    /** noConnection: not one the person may use; unreachable / signIn: the connection; notFound: a document it can't read. */
    readonly code: "noConnection" | "unreachable" | "signIn" | "notFound" | "notADocument",
    message: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(message);
    this.name = "GoogleDocsError";
  }
}

/** The connections the person may import Google documents through, in the order they were added. */
export async function googleDocsSources(userId: string, workspaceId: string): Promise<GoogleDocsSource[]> {
  const { role } = await requireMembership(userId, workspaceId);
  if (role === "guest") return [];
  const rows = await db.select().from(connection).where(eq(connection.workspaceId, workspaceId)).orderBy(connection.createdAt);
  return rows.flatMap((row) => {
    const access = googleDocsAccess(row, role);
    return access.download ? [{ id: row.id, name: row.name, icon: row.icon, search: access.search }] : [];
  });
}

/** The connection, if the person may import through it (and search with it, for `need` "search"). */
async function usableConnection(userId: string, connectionId: string, need: "download" | "search"): Promise<ConnectionRow> {
  const [row] = typeof connectionId === "string" && connectionId ? await db.select().from(connection).where(eq(connection.id, connectionId)).limit(1) : [];
  const membership = row
    ? await requireMembership(userId, row.workspaceId).catch((error) => {
        if (error instanceof AccessError) return null;
        throw error;
      })
    : null;
  if (!row || !membership || !googleDocsAccess(row, membership.role)[need]) {
    throw new GoogleDocsError("noConnection", "That Google Drive connection can't be used");
  }
  return row;
}

/** Calls the connection's tool for the import, recording it in the audit log like the chat's calls. */
async function call(userId: string, row: ConnectionRow, tool: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const audit = (outcome: "done" | "failed", error?: string) =>
    recordAudit({
      workspaceId: row.workspaceId,
      actorId: userId,
      action: "connection.tool_called",
      target: { type: "connection", id: row.id, label: row.name },
      details: { tool, kind: "read", input: inputSummary(args), approvedBy: null, outcome, via: "import", ...(error ? { error: redactText(error).slice(0, 200) } : {}) },
    }).catch((e) => console.error("[google docs import] could not record a call", redactError(e)));
  let answer: ToolAnswer;
  try {
    answer = (await callConnectionTool(row, tool, args)) as ToolAnswer;
  } catch (error) {
    const failure = classify(error);
    await audit("failed", `${failure.code}: ${failure.message}`);
    if (failure.code === "unauthorized") throw new GoogleDocsError("signIn", `“${row.name}” needs signing in again`, { name: row.name });
    throw new GoogleDocsError("unreachable", `“${row.name}” could not be reached`, { name: row.name });
  }
  await audit(answer.isError ? "failed" : "done", answer.isError ? answerText(answer) : undefined);
  return answer;
}

/** Google documents whose title has the words (the newest when there are none), a page at a time. */
export async function searchGoogleDocs(
  userId: string,
  input: { connectionId: string; words: string; pageToken?: string | null },
): Promise<{ docs: GoogleDoc[]; next: string | null }> {
  const row = await usableConnection(userId, input.connectionId, "search");
  const args: Record<string, unknown> = {
    query: googleDocsQuery(String(input.words ?? "").slice(0, MAX_GOOGLE_DOCS_SEARCH)),
    pageSize: GOOGLE_DOCS_PAGE,
    excludeContentSnippets: true,
  };
  if (typeof input.pageToken === "string" && input.pageToken) args.pageToken = input.pageToken.slice(0, 4_000);
  const answer = await call(userId, row, DRIVE_SEARCH_TOOL, args);
  // The server refused the search (a query it didn't take): it is reachable, so no documents.
  if (answer.isError) throw new GoogleDocsError("unreachable", `“${row.name}” could not search: ${answerText(answer).slice(0, 200)}`, { name: row.name });
  return readDocList(answerJson(answer));
}

export type GoogleDocsImportInput = {
  connectionId: string;
  workspaceId: string;
  /** The page the documents go under; null for the workspace's top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for private pages, undefined for the default teamspace. */
  teamspaceId?: string | null;
  /** Document ids (see googleDocId). */
  ids: string[];
};

const ZIP = [0x50, 0x4b, 0x03, 0x04];

export async function importGoogleDocs(actor: WriteActor, input: GoogleDocsImportInput): Promise<ImportResult> {
  const ids = [...new Set(input.ids)];
  const bad = ids.find((id) => googleDocId(id) !== id);
  if (bad) throw new GoogleDocsError("notADocument", `${bad.slice(0, 100)} isn't a Google document`, { id: bad.slice(0, 100) });
  if (!ids.length) throw new ImportError("There is no document to import", "nothingToImport");
  if (ids.length > MAX_GOOGLE_DOCS) throw new ImportError(`An import can take at most ${MAX_GOOGLE_DOCS} documents`, "tooManyFiles", { limit: MAX_GOOGLE_DOCS });
  const row = await usableConnection(actor.userId, input.connectionId, "download");
  // The documents stay in the connection's workspace.
  const workspaceId = input.parentId ? (await requirePageAccess(actor.userId, input.parentId, "edit")).workspaceId : input.workspaceId;
  if (row.workspaceId !== workspaceId) throw new GoogleDocsError("noConnection", "That Google Drive connection is in another workspace");

  // Every document is fetched before anything is created, so one that can't be stops the import.
  const files: { name: string; data: Uint8Array }[] = [];
  let total = 0;
  for (const id of ids) {
    const answer = await call(actor.userId, row, DRIVE_DOWNLOAD_TOOL, { fileId: id, exportMimeType: DOCX_MIME });
    if (answer.isError) throw new GoogleDocsError("notFound", `The document ${id} can't be read through “${row.name}”`, { id, name: row.name });
    const exported = readExport(answerJson(answer));
    if (!exported) throw new GoogleDocsError("notADocument", `${id} isn't a Google document`, { id });
    const name = `${(exported.title ?? id).replace(/[\\/]+/g, " ").trim() || id}.docx`;
    // Sized before decoding: base64 is a third larger than what it holds.
    total += base64Bytes(exported.content);
    if (total > IMPORT_LIMITS.uploadBytes) throw new ImportError("The documents are too large", "tooLarge", { limit: IMPORT_LIMITS.uploadBytes });
    const data = new Uint8Array(Buffer.from(exported.content, "base64"));
    if (!ZIP.every((byte, i) => data[i] === byte)) throw new GoogleDocsError("notADocument", `${id} isn't a Google document`, { id });
    files.push({ name, data });
  }
  return importDocx(actor, { workspaceId, parentId: input.parentId, teamspaceId: input.teamspaceId, files, format: "google-docs" });
}
