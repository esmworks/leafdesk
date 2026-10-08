import { pageLabel } from "@/lib/labels";
import { XLSX_MIME } from "@/lib/xlsx";
import { AccessError } from "@/server/access";
import { MAX_BULK_ROWS } from "@/server/databases";
import {
  archiveResponse,
  assertExportAllowed,
  attachment,
  databaseCsv,
  databaseXlsx,
  ExportError,
  exportErrorResponse,
  exportRunning,
  markdownFile,
  pageMarkdown,
  planExport,
  planSummary,
  recordExport,
  startExport,
} from "@/server/export";
import { exportLabels } from "@/server/export-labels";
import { getPage } from "@/server/pages";
import { blockedByWorkspacePolicy, getSession, policyRefusal } from "@/server/session";

function download(body: string, type: string, disposition: string) {
  return new Response(body, {
    headers: {
      "Content-Type": `${type}; charset=utf-8`,
      "Content-Disposition": disposition,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * The rows a POST asks for (`{ "rows": [ids] }`, the table's selection), in that order; null for
 * a GET, which exports every row. Ids of rows the user can't see simply match nothing.
 */
async function requestedRows(request: Request): Promise<string[] | null> {
  if (request.method !== "POST") return null;
  const body: unknown = await request.json().catch(() => null);
  const rows = (body as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows.filter((id): id is string => typeof id === "string").slice(0, MAX_BULK_ROWS) : [];
}

/**
 * A page as Markdown, or a database's rows as CSV (all of them, or with POST the selected ones);
 * `?format=xlsx` gives the rows as an Excel workbook instead.
 * With `?subpages=1`, the page or database with everything under it as a ZIP (see server/export);
 * adding `check=1` only answers whether that export can be made (JSON), so the page menu can say
 * why not before starting a download. Pages the user can't see are 404; with export turned off in
 * the workspace, every export is 403 (`{error: "disabled"}`).
 */
export async function GET(request: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const userId = session.user.id;
  const { pageId } = await params;
  const query = new URL(request.url).searchParams;
  try {
    const target = await getPage(userId, pageId);
    const hold = await blockedByWorkspacePolicy(session, target.workspaceId);
    if (hold) return new Response(policyRefusal(hold), { status: 403 });
    // Every export this route makes, before any of it is read (also asked by the ZIP and CSV code).
    await assertExportAllowed(target.workspaceId);
    const labels = await exportLabels();
    if (request.method === "GET" && query.get("subpages") === "1") {
      if (query.get("check") === "1") {
        if (exportRunning(userId)) throw new ExportError("busy");
        return Response.json(planSummary(await planExport(userId, { pageId }, labels)), { headers: { "Cache-Control": "no-store" } });
      }
      const release = startExport(userId);
      try {
        return await archiveResponse(userId, await planExport(userId, { pageId }, labels), labels, release);
      } catch (error) {
        release();
        throw error;
      }
    }

    if (target.kind === "database" && query.get("format") === "xlsx") {
      const { title, xlsx } = await databaseXlsx(userId, pageId, await requestedRows(request));
      return new Response(xlsx, {
        headers: { "Content-Type": XLSX_MIME, "Content-Disposition": attachment(title, "xlsx"), "Cache-Control": "no-store" },
      });
    }
    if (target.kind === "database") {
      const { title, csv } = await databaseCsv(userId, pageId, await requestedRows(request));
      return download(csv, "text/csv", attachment(title, "csv"));
    }
    const { title, body } = await pageMarkdown(userId, pageId, labels);
    const name = title || target.title;
    await recordExport(userId, { workspaceId: target.workspaceId, page: { id: pageId, title: name }, format: "markdown" });
    return download(markdownFile(name, body), "text/markdown", attachment(pageLabel(name, labels.untitled), "md"));
  } catch (error) {
    if (error instanceof AccessError) return new Response("Not found", { status: 404 });
    if (error instanceof ExportError) return exportErrorResponse(error);
    throw error;
  }
}

/** Exports the selected rows of a database: a POST, since a large selection would not fit in a URL. */
export const POST = GET;
